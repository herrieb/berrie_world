import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { statSync } from 'node:fs';
import type { EventType, ServerMessage, Severity, WorldSnapshot } from '@berrie/shared';
import type { AppConfig } from '../config.js';
import type { World } from '../core/world.js';
import type { Scheduler } from '../core/scheduler.js';
import { redactError, sanitizeDetails } from '../core/redact.js';
import { isBuildingType } from '../adapters/classify.js';
import { Auth, RateLimiter } from './auth.js';

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
  selfContainerId: string | null;
}

export async function registerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { cfg, world, scheduler, auth } = ctx;
  const repo = world.repo;
  const actionLimiter = new RateLimiter(10, 60_000);
  const ingestLimiter = new RateLimiter(600, 60_000);
  const runtimeCache = new Map<string, { at: number; data: unknown }>();
  const startedAt = Date.now();

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!auth.isAdmin(req)) return reply.code(401).send({ error: 'authentication required' });
  };
  if (cfg.requireAuthForView) {
    app.addHook('onRequest', async (req, reply) => {
      const open = ['/api/auth/login', '/api/auth/me', '/api/health', '/api/ingest/events'];
      if (req.url.startsWith('/api/') && !open.some((p) => req.url.startsWith(p)) && !auth.isAdmin(req)) {
        return reply.code(401).send({ error: 'authentication required' });
      }
    });
  }

  const snapshot = (): WorldSnapshot => ({
    mode: cfg.mode, entities: repo.views(), blocks: repo.blockViews(), adapters: repo.listAdapterStates(),
    hints: scheduler.hints, recentEvents: repo.listEvents({ limit: 60 }), connected: repo.everConnected(),
    actionsEnabled: cfg.actionsEnabled && auth.adminConfigured, serverTime: new Date().toISOString(),
  });

  const entityOr404 = (id: string, reply: FastifyReply) => {
    const e = repo.getEntity(id);
    if (!e) { void reply.code(404).send({ error: 'unknown entity' }); return null; }
    return e;
  };

  // ---------- health / self-monitoring ----------
  app.get('/api/health', async () => {
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

  // ---------- auth ----------
  app.get('/api/auth/me', async (req) => ({ admin: auth.isAdmin(req), adminConfigured: auth.adminConfigured, actionsEnabled: cfg.actionsEnabled && auth.adminConfigured }));
  app.post('/api/auth/login', {
    schema: { body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 512 } }, additionalProperties: false } },
  }, async (req, reply) => {
    if (!auth.loginLimiter.allow(`login:${req.ip}`)) return reply.code(429).send({ error: 'too many attempts, wait a minute' });
    if (!auth.adminConfigured) return reply.code(400).send({ error: 'no ADMIN_TOKEN configured on the server' });
    const ok = auth.checkToken((req.body as { token: string }).token);
    repo.audit({ actor: 'anonymous', ip: req.ip, action: 'login', entityId: null, result: ok ? 'ok' : 'rejected' });
    if (!ok) return reply.code(401).send({ error: 'invalid token' });
    auth.issue(reply);
    return { admin: true };
  });
  app.post('/api/auth/logout', async (_req, reply) => { auth.clear(reply); return { admin: false }; });

  // ---------- world ----------
  app.get('/api/snapshot', async () => snapshot());

  app.get('/api/entities/:id', { schema: { params: ID_PARAM } }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, reply);
    if (!e) return;
    return {
      entity: repo.toView(e),
      children: repo.children(e.id).map((c) => repo.toView(c)),
      events: repo.listEvents({ entityId: e.id, limit: 40 }),
      checks: repo.checkHistory(e.id, 60),
      actions: actionAvailability(e.id),
    };
  });

  app.get('/api/entities/:id/runtime', { schema: { params: ID_PARAM } }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, reply);
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

  app.get('/api/entities/:id/logs', { schema: { params: ID_PARAM, querystring: { type: 'object', properties: { tail: { type: 'integer', minimum: 1, maximum: 500 } } } }, preHandler: requireAdmin }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, reply);
    if (!e) return;
    const d = scheduler.dockerFor(e.id);
    if (!d) return reply.code(404).send({ error: 'no container for this entity' });
    try {
      const lines = await d.adapter.logs(d.containerId, (req.query as { tail?: number }).tail ?? 200);
      repo.audit({ actor: 'admin', ip: req.ip, action: 'logs.view', entityId: e.id, result: 'ok' });
      return { lines, redacted: true };
    } catch (err) {
      return reply.code(502).send({ error: redactError(err) });
    }
  });

  app.get('/api/archive', async () => ({ entities: repo.listArchived().map((e) => repo.toView(e)) }));

  app.get('/api/events', {
    schema: { querystring: { type: 'object', properties: { before: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 500 }, entity: { type: 'string', maxLength: 300 } } } },
  }, async (req) => {
    const q = req.query as { before?: string; limit?: number; entity?: string };
    return { events: repo.listEvents({ before: q.before, limit: q.limit ?? 100, entityId: q.entity }) };
  });

  app.patch('/api/entities/:id', {
    preHandler: requireAdmin,
    schema: { params: ID_PARAM, body: { type: 'object', additionalProperties: false, properties: { displayName: { type: ['string', 'null'], maxLength: 60 }, buildingType: { type: ['string', 'null'], maxLength: 20 } } } },
  }, async (req, reply) => {
    const e = entityOr404((req.params as { id: string }).id, reply);
    if (!e) return;
    const body = req.body as { displayName?: string | null; buildingType?: string | null };
    if (body.displayName !== undefined) {
      const name = body.displayName?.trim() || null;
      if (name && !/^[\p{L}\p{N} ._'()&+-]{1,60}$/u.test(name)) return reply.code(400).send({ error: 'invalid name' });
      repo.updateEntity(e.id, { displayName: name });
      world.emit({ type: 'service.renamed', entityId: e.id, source: 'admin', details: { from: e.displayName ?? e.name, to: name ?? e.name } });
    }
    if (body.buildingType !== undefined) {
      if (body.buildingType !== null && !isBuildingType(body.buildingType)) return reply.code(400).send({ error: 'invalid building type' });
      const meta = { ...e.meta };
      if (body.buildingType) meta.typeOverride = body.buildingType; else delete meta.typeOverride;
      repo.updateEntity(e.id, { meta, ...(body.buildingType ? { buildingType: body.buildingType as never } : {}) });
    }
    repo.audit({ actor: 'admin', ip: req.ip, action: 'entity.update', entityId: e.id, params: body as Record<string, unknown>, result: 'ok' });
    world.markDirty(e.id);
    world.flush();
    return { entity: repo.toView(repo.getEntity(e.id)!) };
  });

  app.put('/api/entities/:id/layout', {
    preHandler: requireAdmin,
    schema: { params: ID_PARAM, body: { type: 'object', required: ['x', 'y'], additionalProperties: false, properties: { x: { type: 'integer' }, y: { type: 'integer' } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!entityOr404(id, reply)) return;
    const { x, y } = req.body as { x: number; y: number };
    const err = world.moveBuilding(id, x, y, 'admin');
    repo.audit({ actor: 'admin', ip: req.ip, action: 'layout.move', entityId: id, params: { x, y }, result: err ?? 'ok' });
    if (err) return reply.code(409).send({ error: err });
    return { ok: true };
  });

  // ---------- operations (allowlisted, admin only, audited) ----------
  function actionAvailability(id: string): { enabled: boolean; reason: string | null; allowed: { action: Action; impact: string }[] } {
    const e = repo.getEntity(id);
    const none = (reason: string) => ({ enabled: false, reason, allowed: [] });
    if (!cfg.actionsEnabled) return none('operations are disabled (read-only mode; set ENABLE_ACTIONS=true)');
    if (!auth.adminConfigured) return none('no ADMIN_TOKEN configured');
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
    preHandler: requireAdmin,
    schema: { params: ID_PARAM, body: { type: 'object', required: ['action', 'confirm'], additionalProperties: false, properties: { action: { type: 'string', enum: [...ACTIONS] }, confirm: { type: 'string', maxLength: 300 } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { action, confirm } = req.body as { action: Action; confirm: string };
    const audit = (result: string) => repo.audit({ actor: 'admin', ip: req.ip, action: `container.${action}`, entityId: id, params: { action }, result });
    if (!actionLimiter.allow(`action:${req.ip}`)) { audit('rate-limited'); return reply.code(429).send({ error: 'too many actions, wait a minute' }); }
    const avail = actionAvailability(id);
    if (!avail.enabled || !avail.allowed.some((a) => a.action === action)) { audit(`rejected: ${avail.reason ?? 'action not allowed in current state'}`); return reply.code(403).send({ error: avail.reason ?? 'action not allowed in current state' }); }
    // The client must echo the entity id to confirm it saw the impact for this exact service.
    if (confirm !== id) { audit('rejected: confirmation mismatch'); return reply.code(400).send({ error: 'confirmation does not match this service' }); }
    const d = scheduler.dockerFor(id)!;
    try {
      await d.adapter.action(d.containerId, action);
      audit('ok');
      world.emit({ type: 'action.performed', entityId: id, source: 'admin', severity: 'notice', details: { action } });
      void scheduler.cycle();
      return { ok: true };
    } catch (err) {
      const msg = redactError(err);
      audit(`failed: ${msg}`);
      return reply.code(502).send({ error: msg });
    }
  });

  app.get('/api/audit', { preHandler: requireAdmin }, async () => ({ entries: repo.listAudit(200) }));

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
    const ev = world.emit({ type: b.type, entityId, relatedEntityId: b.related ? resolve(b.related) : null, severity: b.severity ?? 'info', source: 'ingest', details: sanitizeDetails(b.details) });
    return { id: ev.id };
  });

  // ---------- websocket ----------
  app.get('/ws', { websocket: true }, (socket, req) => {
    if (cfg.requireAuthForView && !auth.isAdmin(req)) { socket.close(4401, 'authentication required'); return; }
    const send = (m: ServerMessage) => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); };
    send({ t: 'snapshot', data: snapshot() });
    const unsub = world.subscribe({
      entity: (v) => send({ t: 'entity', data: v }),
      event: (e) => send({ t: 'event', data: e }),
      blocks: (b) => send({ t: 'blocks', data: b }),
    });
    const extra = setInterval(() => {
      send({ t: 'adapters', data: repo.listAdapterStates() });
      send({ t: 'hints', data: scheduler.hints });
    }, 15_000);
    socket.on('close', () => { unsub(); clearInterval(extra); });
    socket.on('message', () => { /* clients do not send commands over the socket */ });
  });
}
