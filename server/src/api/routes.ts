import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { statSync } from 'node:fs';
import type { AdapterStatus, BlockView, EntityView, EventType, HostnameHint, ServerMessage, Severity, WorldEvent, WorldSnapshot } from '@berrie/shared';
import type { AppConfig } from '../config.js';
import type { World } from '../core/world.js';
import type { Scheduler } from '../core/scheduler.js';
import { redactError, sanitizeDetails } from '../core/redact.js';
import { isBuildingType } from '../adapters/classify.js';
import { type Auth, type Principal, RateLimiter } from './auth.js';
import type { ConnectionView } from '@berrie/shared';
import { ConnectionStore } from '../db/connections.js';
import { impactOf, routeOf } from '../core/impact.js';
import type { IncidentEngine } from '../core/incidents.js';
import type { IncidentView, MaintenanceWindow } from '@berrie/shared';

const ACTIONS = ['start', 'stop', 'restart'] as const;
type Action = (typeof ACTIONS)[number];
const ACTION_IMPACT: Record<Action, string> = {
  start: 'Starts the stopped container.',
  stop: 'Stops the container. The service will be unavailable until started again.',
  restart: 'Stops and starts the container. Expect a short outage and dropped connections.',
};
const INGEST_TYPES: EventType[] = ['http.request', 'automation.executed', 'ai.request_started', 'ai.request_completed', 'task.executed', 'alert'];
const SEVERITIES: Severity[] = ['info', 'notice', 'warning', 'critical'];
const ID_PARAM = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 300 } } } as const;

interface Ctx {
  cfg: AppConfig;
  world: World;
  scheduler: Scheduler;
  auth: Auth;
  incidents: IncidentEngine;
  selfContainerId: string | null;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { cfg, world, scheduler, auth } = ctx;
  const repo = world.repo;
  const actionLimiter = new RateLimiter(10, 60_000);
  const ingestLimiter = new RateLimiter(600, 60_000);
  const runtimeCache = new Map<string, { at: number; data: unknown }>();
  const startedAt = Date.now();

  const operator = auth.require('operator');
  const admin = auth.require('admin');
  const me = (req: FastifyRequest): Principal => auth.principal(req)!;
  const actor = (req: FastifyRequest) => auth.actor(auth.principal(req));

  // Every API route needs a signed-in user unless listed here. Role and per-server checks happen per route.
  const PUBLIC = [
    '/api/auth/me', '/api/auth/setup', '/api/auth/login', '/api/auth/mfa', '/api/auth/logout', '/api/auth/reset',
    '/api/health', '/api/ingest/events', '/api/agent/',
  ];
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (PUBLIC.some((p) => path === p || (p.endsWith('/') && path.startsWith(p)))) return;
    if (/^\/api\/invitations\/[^/]+(\/accept)?$/.test(path) && (req.method === 'GET' || path.endsWith('/accept')) && !auth.principal(req)) return;
    if (!auth.principal(req)) return reply.code(401).send({ error: 'authentication required' });
  });

  // ---------- per-user visibility (server-side; the UI hiding things is not authorization) ----------
  const entityVisible = (p: Principal | null, e: { hostId: string | null }) => auth.canSee(p, e);
  const eventVisible = (p: Principal | null, ev: WorldEvent): boolean => {
    if (ev.entityId) {
      const e = repo.getEntity(ev.entityId);
      return e ? entityVisible(p, e) : auth.hasRole(p, 'admin');
    }
    const scope = typeof ev.details.scope === 'string' ? ev.details.scope : null;
    if (scope && repo.getEntity(`host:${scope}`)) return auth.canHost(p, `host:${scope}`);
    return auth.seesAllHosts(p);
  };
  const adapterVisible = (p: Principal | null, a: AdapterStatus) =>
    repo.getEntity(`host:${a.scope}`) ? auth.canHost(p, `host:${a.scope}`) : auth.seesAllHosts(p);
  const blockVisible = (p: Principal | null, b: BlockView) => auth.canHost(p, b.district === 'external' ? null : b.district);
  const hintVisible = (p: Principal | null, h: HostnameHint) => {
    if (auth.seesAllHosts(p)) return true;
    const e = h.entityId ? repo.getEntity(h.entityId) : undefined;
    return !!e && entityVisible(p, e);
  };
  const viewsFor = (p: Principal | null): EntityView[] => repo.views().filter((v) => entityVisible(p, v));
  /** A relationship is visible only if both of its ends are. */
  const connectionVisible = (p: Principal | null, c: ConnectionView) => {
    const a = repo.getEntity(c.src), b = repo.getEntity(c.dst);
    return !!a && !!b && entityVisible(p, a) && entityVisible(p, b);
  };
  const incidentVisible = (p: Principal | null, v: IncidentView): IncidentView | null => {
    const entities = v.entities.filter((x) => { const e = repo.getEntity(x.entityId); return !!e && entityVisible(p, e); });
    if (!entities.length) return null;
    const hidden = v.hypothesisEntityId && !entities.some((x) => x.entityId === v.hypothesisEntityId) && !(() => { const h = repo.getEntity(v.hypothesisEntityId!); return h && entityVisible(p, h); })();
    return { ...v, entities, ...(hidden ? { hypothesis: null, hypothesisEntityId: null } : {}) };
  };
  const windowVisible = (p: Principal | null, w: MaintenanceWindow): MaintenanceWindow | null => {
    const ids = w.entityIds.filter((id) => { const e = repo.getEntity(id); return !!e && entityVisible(p, e); });
    return ids.length ? { ...w, entityIds: ids } : null;
  };
  const opsFor = (p: Principal | null) => {
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const rows = repo.ops.incidents({ limit: 300 }).filter((i) => i.status !== 'resolved' || (i.resolvedAt ?? '') > weekAgo);
    return {
      incidents: rows.map((r) => incidentVisible(p, ctx.incidents.view(r))).filter((x): x is IncidentView => !!x),
      acks: repo.ops.acks().filter((a) => { const e = repo.getEntity(a.entityId); return !!e && entityVisible(p, e); }),
      maintenance: repo.ops.maintenance().map((w) => windowVisible(p, w)).filter((x): x is MaintenanceWindow => !!x),
    };
  };
  const connectionsFor = (p: Principal | null) => repo.connections.list().map(ConnectionStore.view).filter((c) => c.lifecycle !== 'archived' && connectionVisible(p, c));

  const snapshot = (p: Principal | null): WorldSnapshot => ({
    mode: cfg.mode, entities: viewsFor(p), connections: connectionsFor(p), ...opsFor(p), blocks: repo.blockViews().filter((b) => blockVisible(p, b)),
    adapters: repo.listAdapterStates().filter((a) => adapterVisible(p, a)),
    hints: scheduler.hints.filter((h) => hintVisible(p, h)),
    recentEvents: repo.listEvents({ limit: 120 }).filter((ev) => eventVisible(p, ev)).slice(0, 60),
    connected: repo.everConnected(), actionsEnabled: cfg.actionsEnabled && auth.hasRole(p, 'operator'), serverTime: new Date().toISOString(),
  });

  /** 404 for entities that do not exist *or* that this user may not see (no existence oracle). */
  const entityOr404 = (id: string, req: FastifyRequest, reply: FastifyReply) => {
    const e = repo.getEntity(id);
    if (!e || !entityVisible(auth.principal(req), e)) { void reply.code(404).send({ error: 'unknown entity' }); return null; }
    return e;
  };

  // ---------- health / self-monitoring ----------
  app.get('/api/health', async (req) => {
    // Unauthenticated callers (container healthcheck, uptime monitors) only learn that the process is up.
    if (!auth.principal(req)) return { ok: true, mode: cfg.mode };
    let dbBytes: number | null = null;
    try { dbBytes = statSync(cfg.dbPath).size + (statSync(`${cfg.dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0); } catch { /* in-memory */ }
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      ok: true, mode: cfg.mode, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      process: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000) },
      dbBytes, adapters: repo.listAdapterStates(), checks: scheduler.checkList().length, lastMonitoringAt: scheduler.lastMonitoringAt,
    };
  });

  // ---------- world ----------
  app.get('/api/snapshot', async (req) => snapshot(auth.principal(req)));

  app.get('/api/entities/:id', { schema: { params: ID_PARAM } }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, req, reply);
    if (!e) return;
    const p = me(req);
    return {
      entity: repo.toView(e),
      children: repo.children(e.id).filter((c) => entityVisible(p, c)).map((c) => repo.toView(c)),
      events: repo.listEvents({ entityId: e.id, limit: 40 }).filter((ev) => eventVisible(p, ev)),
      checks: repo.checkHistory(e.id, 60),
      actions: actionAvailability(e.id, p),
    };
  });

  app.get('/api/entities/:id/runtime', { schema: { params: ID_PARAM } }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, req, reply);
    if (!e) return;
    const d = scheduler.dockerFor(e.id);
    if (!d) return { available: false, reason: e.kind === 'service' ? 'no running Docker container is mapped to this service' : 'not a container' };
    const cached = runtimeCache.get(e.id);
    if (cached && Date.now() - cached.at < 10_000) return cached.data;
    try {
      const [details, metrics] = await Promise.all([
        d.adapter.details(d.containerId),
        e.meta.state === 'running' ? d.adapter.metrics(d.containerId) : Promise.resolve(null),
      ]);
      const data = { available: true, measuredAt: new Date().toISOString(), details, metrics };
      runtimeCache.set(e.id, { at: Date.now(), data });
      if (runtimeCache.size > 500) runtimeCache.clear();
      return data;
    } catch (err) {
      return { available: false, reason: redactError(err) };
    }
  });

  app.get('/api/entities/:id/logs', { schema: { params: ID_PARAM, querystring: { type: 'object', properties: { tail: { type: 'integer', minimum: 1, maximum: 500 } } } }, preHandler: operator }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, req, reply);
    if (!e) return;
    const d = scheduler.dockerFor(e.id);
    if (!d) return reply.code(404).send({ error: 'no container for this entity' });
    try {
      const lines = await d.adapter.logs(d.containerId, (req.query as { tail?: number }).tail ?? 200);
      repo.audit({ ...actor(req), ip: req.ip, action: 'logs.view', entityId: e.id, result: 'ok' });
      return { lines, redacted: true };
    } catch (err) {
      return reply.code(502).send({ error: redactError(err) });
    }
  });

  // ---------- topology: route explorer and impact analysis (read-only; simulation changes nothing) ----------
  app.get('/api/entities/:id/route', { schema: { params: ID_PARAM } }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, req, reply);
    if (!e) return;
    const p = me(req);
    const r = routeOf(cfg, repo, e.id);
    const ok = (id: string) => { const x = repo.getEntity(id); return !!x && entityVisible(p, x); };
    return {
      routes: r.routes.filter((hops) => hops.every((h) => ok(h.entityId))),
      upstream: r.upstream.filter((u) => ok(u.entityId)),
      downstream: r.downstream.filter((d) => ok(d.entityId)),
    };
  });

  app.get('/api/impact/:id', { schema: { params: ID_PARAM, querystring: { type: 'object', properties: { simulate: { type: 'boolean' } } } } }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, req, reply);
    if (!e) return;
    const p = me(req);
    const r = impactOf(cfg, repo, e.id, !!(req.query as { simulate?: boolean }).simulate);
    // Hidden dependents are not listed (and not counted), so the report never leaks other servers.
    const items = r.items.filter((i) => { const x = repo.getEntity(i.entityId); return !!x && entityVisible(p, x); });
    return { ...r, items };
  });

  // ---------- run discovery now (read-only: inventories, collectors, topology; nothing is changed on servers) ----------
  let lastManualRun = 0;
  app.post('/api/discovery/run', async (req, reply) => {
    const p = me(req);
    if (Date.now() - lastManualRun < 15_000) return reply.code(429).send({ error: 'discovery just ran — try again in a few seconds' });
    lastManualRun = Date.now();
    const started = Date.now();
    // Fresh collector pass for SSH servers (bounded), then a full discovery cycle.
    const ssh = scheduler.hosts.resolve().filter((h) => h.status === 'active' && h.method === 'ssh' && auth.canHost(p, h.entityId));
    await Promise.race([Promise.allSettled(ssh.map((h) => scheduler.hosts.collect(h))), new Promise((r) => setTimeout(r, 30_000))]);
    await scheduler.cycle();
    repo.audit({ ...auth.actor(p), ip: req.ip, action: 'discovery.run', entityId: null, result: 'ok' });
    return { ok: true, tookMs: Date.now() - started, at: new Date().toISOString() };
  });

  app.post('/api/layout/regenerate', {
    preHandler: operator,
    schema: { body: { type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: { type: 'string', enum: ['new map'] } } } },
  }, async (req) => {
    const p = me(req);
    const r = world.regenerateLayout(p.user.username);
    // Personal island arrangements referred to the old map; clear them so islands cannot end up overlapping.
    for (const u of repo.users.list()) {
      const prefs = repo.users.getPrefs(u.id);
      if (prefs.islandOffsets || prefs.camera) repo.users.setPrefs(u.id, { ...prefs, islandOffsets: undefined, camera: undefined });
    }
    repo.audit({ ...auth.actor(p), ip: req.ip, action: 'layout.regenerate', entityId: null, params: r, result: 'ok' });
    return { ok: true, ...r };
  });

  app.get('/api/archive', async (req) => {
    const p = me(req);
    return { entities: repo.listArchived(500).filter((e) => entityVisible(p, e)).map((e) => repo.toView(e)) };
  });

  app.get('/api/events', {
    schema: { querystring: { type: 'object', properties: { before: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, entity: { type: 'string', maxLength: 300 } } } },
  }, async (req) => {
    const q = req.query as { before?: string; limit?: number; entity?: string };
    const p = me(req);
    if (q.entity) { const e = repo.getEntity(q.entity); if (e && !entityVisible(p, e)) return { events: [] }; }
    // Over-fetch then filter, so restricted users still get a full page when possible.
    const limit = q.limit ?? 100;
    return { events: repo.listEvents({ before: q.before, limit: Math.min(500, limit * 3), entityId: q.entity }).filter((ev) => eventVisible(p, ev)).slice(0, limit) };
  });

  app.patch('/api/entities/:id', {
    preHandler: operator,
    schema: { params: ID_PARAM, body: { type: 'object', additionalProperties: false, properties: { displayName: { type: ['string', 'null'], maxLength: 60 }, buildingType: { type: ['string', 'null'], maxLength: 20 } } } },
  }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, req, reply);
    if (!e) return;
    const body = req.body as { displayName?: string | null; buildingType?: string | null };
    if (body.displayName !== undefined) {
      const name = body.displayName?.trim() || null;
      if (name && !/^[\p{L}\p{N} ._'()&+-]{1,60}$/u.test(name)) return reply.code(400).send({ error: 'invalid name' });
      repo.updateEntity(e.id, { displayName: name });
      world.emit({ type: 'service.renamed', entityId: e.id, source: actor(req).actor, details: { from: e.displayName ?? e.name, to: name ?? e.name } });
    }
    if (body.buildingType !== undefined) {
      if (body.buildingType !== null && !isBuildingType(body.buildingType)) return reply.code(400).send({ error: 'invalid building type' });
      const meta = { ...e.meta };
      if (body.buildingType) meta.typeOverride = body.buildingType; else delete meta.typeOverride;
      repo.updateEntity(e.id, { meta, ...(body.buildingType ? { buildingType: body.buildingType as never } : {}) });
    }
    repo.audit({ ...actor(req), ip: req.ip, action: 'entity.update', entityId: e.id, params: body as Record<string, unknown>, result: 'ok' });
    world.markDirty(e.id);
    world.flush();
    return { entity: repo.toView(repo.getEntity(e.id)!) };
  });

  app.put('/api/entities/:id/layout', {
    preHandler: operator,
    schema: { params: ID_PARAM, body: { type: 'object', required: ['x', 'y'], additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!entityOr404(id, req, reply)) return;
    const { x, y } = req.body as { x: number; y: number };
    const err = world.moveBuilding(id, x, y, actor(req).actor);
    repo.audit({ ...actor(req), ip: req.ip, action: 'layout.move', entityId: id, params: { x, y }, result: err ?? 'ok' });
    if (err) return reply.code(409).send({ error: err });
    return { ok: true };
  });

  // ---------- operations (allowlisted, admin only, audited) ----------
  function actionAvailability(id: string, p: Principal | null): { enabled: boolean; reason: string | null; allowed: { action: Action; impact: string }[] } {
    const e = repo.getEntity(id);
    const none = (reason: string) => ({ enabled: false, reason, allowed: [] });
    if (!cfg.actionsEnabled) return none('operations are disabled (read-only mode; set ENABLE_ACTIONS=true)');
    if (!auth.hasRole(p, 'operator')) return none('requires the operator or administrator role');
    if (!e || !entityVisible(p, e)) return none('no access to this server');
    if (!e || e.kind !== 'service' || e.source !== 'docker') return none('only Docker services support actions');
    if (e.lifecycle === 'removed' || e.lifecycle === 'archived') return none('service has been removed');
    const d = scheduler.dockerFor(e.id);
    if (!d) return none('no container currently mapped');
    if (e.meta.protected || cfg.protected.includes(e.id) || cfg.protected.includes(String(e.meta.containerName))) return none('service is protected');
    if (ctx.selfContainerId && d.containerId.startsWith(ctx.selfContainerId)) return none('Berrie World cannot control itself');
    const running = e.meta.state === 'running' || e.meta.state === 'restarting';
    const allowed: Action[] = running ? ['restart', 'stop'] : ['start'];
    return { enabled: true, reason: null, allowed: allowed.map((a) => ({ action: a, impact: ACTION_IMPACT[a] })) };
  }

  app.post('/api/entities/:id/actions', {
    preHandler: operator,
    schema: { params: ID_PARAM, body: { type: 'object', required: ['action', 'confirm'], additionalProperties: false, properties: { action: { type: 'string', enum: [...ACTIONS] }, confirm: { type: 'string', maxLength: 300 } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { action, confirm } = req.body as { action: Action; confirm: string };
    const p = me(req);
    const audit = (result: string) => repo.audit({ ...auth.actor(p), ip: req.ip, action: `container.${action}`, entityId: id, params: { action }, result });
    if (!actionLimiter.allow(`action:${p.user.id}`)) { audit('rate-limited'); return reply.code(429).send({ error: 'too many actions, wait a minute' }); }
    const avail = actionAvailability(id, p);
    if (!avail.enabled || !avail.allowed.some((a) => a.action === action)) { audit(`rejected: ${avail.reason ?? 'action not allowed in current state'}`); return reply.code(403).send({ error: avail.reason ?? 'action not allowed in current state' }); }
    // The client must echo the entity id to confirm it saw the impact for this exact service.
    if (confirm !== id) { audit('rejected: confirmation mismatch'); return reply.code(400).send({ error: 'confirmation does not match this service' }); }
    const d = scheduler.dockerFor(id)!;
    try {
      // Bounded: a hung Docker API must not leave the request (or the operator) waiting forever.
      await Promise.race([d.adapter.action(d.containerId, action), new Promise((_, rej) => setTimeout(() => rej(new Error('action timed out after 30 s; check the service state before retrying')), 30_000))]);
      audit('ok');
      world.emit({ type: 'action.performed', entityId: id, source: p.user.username, severity: 'notice', details: { action, by: p.user.username } });
      void scheduler.cycle();
      return { ok: true };
    } catch (err) {
      const msg = redactError(err);
      audit(`failed: ${msg}`);
      return reply.code(502).send({ error: msg });
    }
  });

  app.get('/api/audit', { preHandler: admin }, async () => ({ entries: repo.listAudit(200) }));

  // ---------- event ingestion (e.g. from n8n webhooks), token protected ----------
  app.post('/api/ingest/events', {
    schema: {
      body: {
        type: 'object', required: ['type', 'entity'], additionalProperties: false,
        properties: {
          type: { type: 'string', enum: INGEST_TYPES }, entity: { type: 'string', maxLength: 300 }, related: { type: 'string', maxLength: 300 },
          severity: { type: 'string', enum: SEVERITIES }, details: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    if (!auth.isIngest(req)) return reply.code(401).send({ error: 'invalid ingest token' });
    if (!ingestLimiter.allow(`ingest:${req.ip}`)) return reply.code(429).send({ error: 'rate limited' });
    const b = req.body as { type: EventType; entity: string; related?: string; severity?: Severity; details?: unknown };
    // Entities may be referenced by id or by public hostname; unknown references are rejected, never created.
    const resolve = (ref: string) => repo.getEntity(ref)?.id ?? repo.getEntity(`endpoint:${ref.toLowerCase()}`)?.id ?? null;
    const entityId = resolve(b.entity);
    if (!entityId) return reply.code(404).send({ error: 'unknown entity' });
    const relatedId = b.related ? resolve(b.related) : null;
    const ev = world.emit({ type: b.type, entityId, relatedEntityId: relatedId, severity: b.severity ?? 'info', source: 'ingest', details: sanitizeDetails(b.details) });
    // Reported traffic between two known entities is evidence of a relationship (labelled 'observed').
    if (relatedId && relatedId !== entityId && (b.type === 'http.request' || b.type === 'ai.request_started' || b.type === 'automation.executed')) world.observeTraffic(entityId, relatedId, ev.ts);
    return { id: ev.id };
  });

  // ---------- websocket ----------
  app.get('/ws', { websocket: true }, (socket, req) => {
    let p = auth.principal(req);
    if (!p) { socket.close(4401, 'authentication required'); return; }
    const send = (m: ServerMessage) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); };
    send({ t: 'snapshot', data: snapshot(p) });
    // Every pushed message is filtered for this user, exactly like the REST API.
    const unsub = world.subscribe({
      entity: (v) => { if (p && entityVisible(p, v)) send({ t: 'entity', data: v }); },
      event: (e) => { if (p && eventVisible(p, e)) send({ t: 'event', data: e }); },
      blocks: (b) => send({ t: 'blocks', data: b.filter((x) => blockVisible(p, x)) }),
      connection: (c) => { if (p && connectionVisible(p, c)) send({ t: 'connection', data: c }); },
      ops: (m) => {
        if (!p) return;
        if (m.t === 'notification') { if (m.userId === p.user.id) send({ t: 'notification', data: m.data }); return; }
        if (m.t === 'incident') { const v = incidentVisible(p, m.data); if (v) send({ t: 'incident', data: v }); return; }
        if (m.t === 'maintenance') { const w = windowVisible(p, m.data); if (w) send({ t: 'maintenance', data: w }); return; }
        if (m.t === 'ack') { const e = repo.getEntity(m.data.entityId); if (e && entityVisible(p, e)) send({ t: 'ack', data: m.data }); }
      },
    });
    const extra = setInterval(() => {
      // Sessions can be revoked, users disabled or their server access changed: re-check regularly.
      p = p ? auth.stillValid(p) : null;
      if (!p) { socket.close(4401, 'session ended'); return; }
      send({ t: 'adapters', data: repo.listAdapterStates().filter((a) => adapterVisible(p, a)) });
      send({ t: 'hints', data: scheduler.hints.filter((h) => hintVisible(p, h)) });
    }, 15_000);
    socket.on('close', () => { unsub(); clearInterval(extra); });
    socket.on('message', () => { /* clients do not send commands over the socket */ });
  });
}
