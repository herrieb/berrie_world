import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Health, IncidentView, MaintenanceWindow, Severity, WorldEvent } from '@berrie/shared';
import type { Repo } from '../db/repo.js';
import type { World } from '../core/world.js';
import { type IncidentEngine, userCanSee } from '../core/incidents.js';
import type { Auth, Principal } from './auth.js';

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 300 } } } as const;
const SEVERITIES: Severity[] = ['info', 'notice', 'warning', 'critical'];
const HEALTH_EVENTS = new Set(['service.healthy', 'service.degraded', 'service.unhealthy', 'service.unreachable', 'service.recovered', 'service.health_unknown', 'host.offline', 'host.online']);

interface Ctx { repo: Repo; world: World; auth: Auth; incidents: IncidentEngine }

export async function registerOpsRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { repo, world, auth, incidents } = ctx;
  const ops = repo.ops;
  const operator = auth.require('operator');
  const me = (req: FastifyRequest): Principal => auth.principal(req)!;
  const visible = (p: Principal, id: string) => { const e = repo.getEntity(id); return !!e && auth.canSee(p, e); };
  const audit = (req: FastifyRequest, action: string, entityId: string | null, params: Record<string, unknown> = {}) =>
    repo.audit({ ...auth.actor(auth.principal(req)), ip: req.ip, action, entityId, params, result: 'ok' });

  /** A restricted user sees an incident if any of its entities is visible, and only those entities. */
  const incidentFor = (p: Principal, v: IncidentView): IncidentView | null => {
    const entities = v.entities.filter((x) => visible(p, x.entityId));
    if (!entities.length) return null;
    const hyp = v.hypothesisEntityId && !visible(p, v.hypothesisEntityId);
    return { ...v, entities, ...(hyp ? { hypothesis: null, hypothesisEntityId: null } : {}) };
  };
  const loadIncident = (req: FastifyRequest, id: string) => {
    const row = ops.incident(id);
    return row ? incidentFor(me(req), incidents.view(row)) : null;
  };
  const maintenanceFor = (p: Principal, w: MaintenanceWindow) => (w.entityIds.some((id) => visible(p, id)) ? { ...w, entityIds: w.entityIds.filter((id) => visible(p, id)) } : null);

  // ---------------------------------------------------------------- incidents

  app.get('/api/incidents', { schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: ['active', 'resolved', 'all'] } } } } }, async (req) => {
    const q = (req.query as { status?: string }).status ?? 'all';
    const rows = ops.incidents({ status: q === 'active' ? ['open', 'monitoring'] : q === 'resolved' ? ['resolved'] : undefined, limit: 300 });
    return { incidents: rows.map((r) => incidentFor(me(req), incidents.view(r))).filter(Boolean) };
  });

  app.get('/api/incidents/:id', { schema: { params: ID } }, async (req, reply) => {
    const v = loadIncident(req, (req.params as { id: string }).id);
    if (!v) return reply.code(404).send({ error: 'unknown incident' });
    return { incident: v, timeline: ops.timeline(v.id) };
  });

  app.post('/api/incidents', {
    preHandler: operator,
    schema: { body: { type: 'object', additionalProperties: false, required: ['title', 'entityIds'], properties: {
      title: { type: 'string', minLength: 3, maxLength: 120 }, entityIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 300 } },
      severity: { type: 'string', enum: SEVERITIES }, note: { type: 'string', maxLength: 2000 },
    } } },
  }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { title: string; entityIds: string[]; severity?: Severity; note?: string };
    if (!b.entityIds.every((id) => visible(p, id))) return reply.code(400).send({ error: 'unknown entity' });
    const inc = ops.createIncident({ title: b.title.trim(), status: 'open', severity: b.severity ?? 'warning', rootEntityId: b.entityIds[0], hypothesis: null, hypothesisEntityId: null, assignee: null, createdBy: p.user.id });
    for (const id of b.entityIds) ops.addIncidentEntity(inc.id, id, 'affected');
    ops.addTimeline(inc.id, 'opened', p.user.username, p.user.id, b.note?.trim() || 'Opened manually');
    audit(req, 'incident.create', b.entityIds[0], { incident: inc.id });
    incidents.push(inc.id);
    return { incident: loadIncident(req, inc.id) };
  });

  const mutate = (path: string, schema: object, fn: (req: FastifyRequest, inc: IncidentView, p: Principal) => string | { error: string }) =>
    app.post(`/api/incidents/:id/${path}`, { preHandler: operator, schema: { params: ID, body: schema } }, async (req, reply) => {
      const inc = loadIncident(req, (req.params as { id: string }).id);
      if (!inc) return reply.code(404).send({ error: 'unknown incident' });
      const r = fn(req, inc, me(req));
      if (typeof r !== 'string') return reply.code(400).send(r);
      audit(req, `incident.${path}`, inc.rootEntityId, { incident: inc.id, result: r });
      incidents.push(inc.id);
      return { incident: loadIncident(req, inc.id), timeline: ops.timeline(inc.id) };
    });

  mutate('notes', { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } } }, (req, inc, p) => {
    ops.addTimeline(inc.id, 'note', p.user.username, p.user.id, (req.body as { text: string }).text.trim());
    return 'note';
  });

  mutate('ack', { type: 'object', additionalProperties: false, properties: {} }, (_req, inc, p) => {
    ops.addTimeline(inc.id, 'ack', p.user.username, p.user.id, `${p.user.displayName} acknowledged the incident`);
    return 'ack';
  });

  mutate('assign', { type: 'object', additionalProperties: false, required: ['userId'], properties: { userId: { type: ['string', 'null'], maxLength: 64 } } }, (req, inc, p) => {
    const uid = (req.body as { userId: string | null }).userId;
    if (uid) {
      const u = repo.users.get(uid);
      const root = inc.rootEntityId ? repo.getEntity(inc.rootEntityId) : undefined;
      if (!u || u.status !== 'active' || u.role === 'viewer' || (root && !userCanSee(u, root))) return { error: 'assignee must be an active operator or administrator with access to this server' };
      ops.updateIncident(inc.id, { assignee: u.id });
      ops.addTimeline(inc.id, 'assign', p.user.username, p.user.id, `Assigned to ${u.displayName}`);
      if (u.id !== p.user.id) {
        const n = ops.notify(u.id, { severity: inc.severity, title: `Assigned to you: ${inc.title}`, text: `by ${p.user.displayName}`, entityId: inc.rootEntityId, incidentId: inc.id });
        world.publishOps({ t: 'notification', data: n, userId: u.id });
      }
    } else {
      repo.db.prepare('UPDATE incidents SET assignee = NULL WHERE id = ?').run(inc.id);
      ops.addTimeline(inc.id, 'assign', p.user.username, p.user.id, 'Unassigned');
    }
    return 'assign';
  });

  mutate('hypothesis', { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', enum: ['confirm', 'reject'] }, note: { type: 'string', maxLength: 2000 } } }, (req, inc, p) => {
    const b = req.body as { verdict: 'confirm' | 'reject'; note?: string };
    if (!inc.hypothesis) return { error: 'there is no hypothesis to review' };
    if (b.verdict === 'confirm') ops.updateIncident(inc.id, { hypothesisVerified: true });
    else repo.db.prepare('UPDATE incidents SET hypothesis = NULL, hypothesis_entity_id = NULL, hypothesis_verified = 0 WHERE id = ?').run(inc.id);
    ops.addTimeline(inc.id, 'hypothesis', p.user.username, p.user.id, `${p.user.displayName} ${b.verdict === 'confirm' ? 'confirmed' : 'rejected'} the suggested cause${b.note ? `: ${b.note}` : ''}`);
    return b.verdict;
  });

  mutate('resolve', { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 2000 } } }, (req, inc, p) => {
    if (inc.status === 'resolved') return { error: 'already resolved' };
    const note = (req.body as { note?: string }).note?.trim();
    ops.updateIncident(inc.id, { status: 'resolved', resolvedAt: repo.now(), resolvedBy: p.user.username });
    ops.addTimeline(inc.id, 'resolved', p.user.username, p.user.id, `${inc.status === 'monitoring' ? 'Recovery confirmed' : 'Resolved while items were still failing'} by ${p.user.displayName}${note ? `: ${note}` : ''}`);
    world.emit({ type: 'incident.resolved', entityId: inc.rootEntityId, source: p.user.username, severity: 'notice', details: { incident: inc.id, title: inc.title, by: p.user.username } });
    return 'resolved';
  });

  /** Everything needed to replay an incident on the map: states at the start and every change during it. */
  app.get('/api/incidents/:id/replay', { schema: { params: ID } }, async (req, reply) => {
    const inc = loadIncident(req, (req.params as { id: string }).id);
    if (!inc) return reply.code(404).send({ error: 'unknown incident' });
    const p = me(req);
    const from = new Date(Date.parse(inc.openedAt) - 10 * 60_000).toISOString();
    const to = inc.resolvedAt ?? new Date().toISOString();
    const ids = new Set(inc.entities.map((e) => e.entityId));
    for (const id of [...ids]) for (const c of repo.connections.touching(id)) { if (visible(p, c.src)) ids.add(c.src); if (visible(p, c.dst)) ids.add(c.dst); }
    const initial: Record<string, Health | null> = {};
    const events: WorldEvent[] = [];
    for (const id of ids) {
      const evs = repo.listEvents({ entityId: id, limit: 500 }).filter((e) => HEALTH_EVENTS.has(e.type) && e.entityId === id);
      const before = evs.find((e) => e.ts < from);
      initial[id] = before ? ((before.details.to as Health) ?? (before.type === 'host.offline' ? 'host_offline' : before.type === 'host.online' ? 'healthy' : null)) : null;
      events.push(...evs.filter((e) => e.ts >= from && e.ts <= to));
    }
    events.sort((a, b) => a.ts.localeCompare(b.ts));
    return { from, to, entities: [...ids], initial, events: events.slice(0, 2000) };
  });

  // ---------------------------------------------------------------- alert acknowledgements

  app.post('/api/alerts/:id/ack', {
    preHandler: operator,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['since'], properties: { since: { type: 'string', maxLength: 40 }, note: { type: 'string', maxLength: 500 } } } },
  }, async (req, reply) => {
    const p = me(req);
    const id = (req.params as { id: string }).id;
    if (!visible(p, id)) return reply.code(404).send({ error: 'unknown entity' });
    const b = req.body as { since: string; note?: string };
    if (Number.isNaN(Date.parse(b.since))) return reply.code(400).send({ error: 'invalid since' });
    const a = ops.ack(id, b.since, p.user.username, p.user.id, b.note?.trim() || null);
    for (const i of ops.activeFor(id)) { ops.addTimeline(i.id, 'ack', p.user.username, p.user.id, `${p.user.displayName} acknowledged the alert on ${repo.getEntity(id)?.name ?? id}`); incidents.push(i.id); }
    audit(req, 'alert.ack', id, { since: b.since });
    world.publishOps({ t: 'ack', data: a });
    return { ack: a };
  });

  // ---------------------------------------------------------------- maintenance windows

  app.get('/api/maintenance', async (req) => {
    const p = me(req);
    return { windows: ops.maintenance(true).map((w) => maintenanceFor(p, w)).filter(Boolean) };
  });

  app.post('/api/maintenance', {
    preHandler: operator,
    schema: { body: { type: 'object', additionalProperties: false, required: ['title', 'entityIds', 'startsAt', 'endsAt'], properties: {
      title: { type: 'string', minLength: 3, maxLength: 120 }, description: { type: 'string', maxLength: 2000 }, entityIds: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 300 } },
      startsAt: { type: 'string', maxLength: 40 }, endsAt: { type: 'string', maxLength: 40 }, suppress: { type: 'boolean' },
    } } },
  }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { title: string; description?: string; entityIds: string[]; startsAt: string; endsAt: string; suppress?: boolean };
    const s = Date.parse(b.startsAt), e = Date.parse(b.endsAt);
    if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return reply.code(400).send({ error: 'invalid time range' });
    if (e - s > 14 * 86400_000) return reply.code(400).send({ error: 'maintenance windows are limited to 14 days' });
    if (!b.entityIds.every((id) => visible(p, id))) return reply.code(400).send({ error: 'unknown entity' });
    const w = ops.addWindow({ title: b.title.trim(), description: b.description?.trim() || null, entityIds: b.entityIds, startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), suppress: b.suppress !== false, createdBy: p.user.username });
    audit(req, 'maintenance.create', b.entityIds[0], { window: w.id, startsAt: w.startsAt, endsAt: w.endsAt, suppress: w.suppress });
    world.publishOps({ t: 'maintenance', data: w });
    incidents.tick();
    return { window: w };
  });

  app.delete('/api/maintenance/:id', { preHandler: operator, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    const w = ops.window((req.params as { id: string }).id);
    if (!w || !maintenanceFor(p, w)) return reply.code(404).send({ error: 'unknown maintenance window' });
    ops.cancelWindow(w.id);
    audit(req, 'maintenance.cancel', w.entityIds[0] ?? null, { window: w.id });
    world.publishOps({ t: 'maintenance', data: ops.window(w.id)! });
    incidents.tick();
    return { ok: true };
  });

  // ---------------------------------------------------------------- notifications (personal) and assignees

  app.get('/api/notifications', async (req) => ({ notifications: ops.notifications(me(req).user.id, 100) }));
  app.post('/api/notifications/read', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { anyOf: [{ type: 'string', enum: ['all'] }, { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 64 } }] } } } },
  }, async (req) => {
    ops.markRead(me(req).user.id, (req.body as { ids: string[] | 'all' }).ids);
    return { ok: true };
  });

  app.get('/api/assignees', { preHandler: operator }, async (req) => {
    const p = me(req);
    void p;
    return { users: repo.users.list().filter((u) => u.status === 'active' && u.role !== 'viewer').map((u) => ({ id: u.id, name: u.displayName, role: u.role, hostScope: u.hostScope, hosts: u.hosts })) };
  });
}
