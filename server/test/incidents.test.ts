import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncidentView, NotificationView, TimelineEntry, WorldSnapshot } from '@berrie/shared';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/app.js';
import type { InventoryResult, ObservedEntity } from '../src/core/world.js';
import { signIn } from './helpers.js';

const host = (id: string): ObservedEntity => ({ id: `host:${id}`, kind: 'host', name: id, buildingType: 'server', parentId: null, hostId: `host:${id}` });
const svc = (h: string, name: string, health: 'healthy' | 'unhealthy', deps: string[] = []): ObservedEntity => ({
  id: `docker:${h}:app/${name}`, kind: 'service', name, buildingType: name === 'db' ? 'silo' : 'house', parentId: `host:${h}`, hostId: `host:${h}`,
  dependsOn: deps.map((d) => `docker:${h}:app/${d}`), meta: { containerId: `cid-${h}-${name}`, state: health === 'healthy' ? 'running' : 'exited' },
  health: { health, reason: health === 'healthy' ? 'running' : 'stopped — Exited (1)' },
});
const inv = (h: string, s: ObservedEntity[]): InventoryResult => ({ adapter: 'docker', scope: h, completeness: 'complete', entities: s });

let dir: string;
let app: App;
let admin: string;
const req = async (method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: unknown, cookie = admin) => app.http.inject({ method, url, headers: { cookie }, payload: payload as object });
const incidents = async (cookie = admin) => ((await req('GET', '/api/incidents', undefined, cookie)).json() as { incidents: IncidentView[] }).incidents;
const notifications = async (cookie: string) => ((await req('GET', '/api/notifications', undefined, cookie)).json() as { notifications: NotificationView[] }).notifications;

function state(alpha: { web: 'healthy' | 'unhealthy'; db: 'healthy' | 'unhealthy' }, beta: 'healthy' | 'unhealthy' = 'healthy') {
  app.world.reconcile(inv('alpha', [svc('alpha', 'web', alpha.web, ['db']), svc('alpha', 'db', alpha.db)]));
  app.world.reconcile(inv('beta', [svc('beta', 'api', beta)]));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'berrie-inc-'));
  const cfg = { ...loadConfig({ DATA_DIR: dir, CONFIG_PATH: join(dir, 'none.json') }), hosts: [] };
  app = await buildApp(cfg, { startScheduler: false, logger: false });
  admin = await signIn(app, 'admin', { username: 'ada' });
  app.world.reconcile({ adapter: 'config', scope: 'config', completeness: 'complete', entities: [host('alpha'), host('beta')] });
  state({ web: 'healthy', db: 'healthy' });
  await (async () => { const t = app.scheduler; void t; })();
  // Compose links exist before the failure (the topology pass normally runs every cycle).
  await app.scheduler.cycle();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('incidents, maintenance and notifications', () => {
  it('related failures are grouped into one incident, with one notification and a labelled hypothesis', async () => {
    const op = await signIn(app, 'operator', { username: 'olly' });
    state({ web: 'healthy', db: 'unhealthy' });
    state({ web: 'unhealthy', db: 'unhealthy' });
    const list = await incidents();
    expect(list).toHaveLength(1);
    const inc = list[0];
    expect(inc.entities.map((e) => e.entityId)).toEqual(expect.arrayContaining(['docker:alpha:app/db', 'docker:alpha:app/web']));
    expect(inc.status).toBe('open');
    const detail = (await req('GET', `/api/incidents/${inc.id}`)).json() as { incident: IncidentView; timeline: TimelineEntry[] };
    expect(detail.incident.hypothesisEntityId).toBe('docker:alpha:app/db');
    expect(detail.incident.hypothesisVerified).toBe(false);
    expect(detail.timeline.some((t) => t.text.startsWith('Hypothesis (not verified)'))).toBe(true);
    // One notification per person for the incident, not one per failing service.
    expect((await notifications(op)).filter((n) => n.incidentId === inc.id)).toHaveLength(1);
    // An unrelated failure on another server is a separate incident.
    state({ web: 'unhealthy', db: 'unhealthy' }, 'unhealthy');
    expect(await incidents()).toHaveLength(2);
  });

  it('recovery needs confirmation; viewers cannot resolve; regressions reopen', async () => {
    const viewer = await signIn(app, 'viewer');
    const op = await signIn(app, 'operator');
    state({ web: 'healthy', db: 'unhealthy' });
    const id = (await incidents())[0].id;
    state({ web: 'healthy', db: 'healthy' });
    expect((await incidents())[0].status).toBe('monitoring');
    state({ web: 'healthy', db: 'unhealthy' });
    expect((await incidents())[0].status).toBe('open');
    state({ web: 'healthy', db: 'healthy' });
    expect((await req('POST', `/api/incidents/${id}/resolve`, { note: 'restarted db' }, viewer)).statusCode).toBe(403);
    const r = await req('POST', `/api/incidents/${id}/resolve`, { note: 'restarted db' }, op);
    expect(r.statusCode).toBe(200);
    expect(r.json().incident.status).toBe('resolved');
    expect(r.json().timeline.some((t: TimelineEntry) => /Recovery confirmed/.test(t.text))).toBe(true);
    expect(app.repo.listAudit(50).some((a: { action: string }) => a.action === 'incident.resolve')).toBe(true);
  });

  it('maintenance windows suppress incidents and notifications but never hide raw health', async () => {
    const op = await signIn(app, 'operator');
    const now = Date.now();
    const w = await req('POST', '/api/maintenance', { title: 'DB upgrade', entityIds: ['host:alpha'], startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 3600_000).toISOString() }, op);
    expect(w.statusCode).toBe(200);
    state({ web: 'unhealthy', db: 'unhealthy' });
    expect(await incidents()).toHaveLength(0);
    expect(await notifications(op)).toHaveLength(0);
    const snap = (await req('GET', '/api/snapshot')).json() as WorldSnapshot;
    expect(snap.entities.find((e) => e.id === 'docker:alpha:app/db')!.health).toBe('unhealthy');
    expect(snap.maintenance.map((m) => m.title)).toContain('DB upgrade');
    // Cancelled window: the next failure creates an incident again.
    await req('DELETE', `/api/maintenance/${w.json().window.id}`, undefined, op);
    state({ web: 'healthy', db: 'healthy' });
    state({ web: 'healthy', db: 'unhealthy' });
    expect(await incidents()).toHaveLength(1);
  });

  it('notifications follow personal preferences and server access', async () => {
    const quiet = await signIn(app, 'operator', { username: 'quiet' });
    await req('PUT', '/api/account/prefs', { notifications: { inApp: true, browser: false, minSeverity: 'critical', favoritesOnly: false } }, quiet);
    const betaOnly = await signIn(app, 'viewer', { username: 'bea', hostScope: 'list', hosts: ['host:beta'] });
    const loud = await signIn(app, 'viewer', { username: 'loud' });
    state({ web: 'healthy', db: 'unhealthy' });
    expect(await notifications(quiet)).toHaveLength(0); // warning < critical
    expect(await notifications(betaOnly)).toHaveLength(0); // cannot see alpha
    expect(await notifications(loud)).toHaveLength(1);
    expect(await incidents(betaOnly)).toHaveLength(0);
    await req('POST', '/api/notifications/read', { ids: 'all' }, loud);
    expect((await notifications(loud))[0].readAt).not.toBeNull();
  });

  it('assignment, acknowledgement and notes are audited and restricted', async () => {
    const op = await signIn(app, 'operator', { username: 'opal' });
    const viewer = await signIn(app, 'viewer', { username: 'vic' });
    state({ web: 'healthy', db: 'unhealthy' });
    const id = (await incidents())[0].id;
    const opal = app.repo.users.byUsername('opal')!;
    const vic = app.repo.users.byUsername('vic')!;
    expect((await req('POST', `/api/incidents/${id}/assign`, { userId: vic.id }, op)).statusCode).toBe(400);
    expect((await req('POST', `/api/incidents/${id}/assign`, { userId: opal.id })).json().incident.assignee.name).toBe('opal');
    expect((await notifications(op)).some((n) => n.title.startsWith('Assigned to you'))).toBe(true);
    expect((await req('POST', `/api/incidents/${id}/notes`, { text: 'looking into it' }, viewer)).statusCode).toBe(403);
    expect((await req('POST', `/api/incidents/${id}/notes`, { text: 'looking into it' }, op)).statusCode).toBe(200);
    const db = (await req('GET', '/api/snapshot')).json().entities.find((e: { id: string }) => e.id === 'docker:alpha:app/db');
    expect((await req('POST', `/api/alerts/${encodeURIComponent(db.id)}/ack`, { since: db.lastChangeAt }, op)).statusCode).toBe(200);
    const snap = (await req('GET', '/api/snapshot')).json() as WorldSnapshot;
    expect(snap.acks.find((a) => a.entityId === db.id)!.since).toBe(db.lastChangeAt);
    const tl = (await req('GET', `/api/incidents/${id}`)).json().timeline as TimelineEntry[];
    expect(tl.map((t) => t.kind)).toEqual(expect.arrayContaining(['opened', 'assign', 'note', 'ack']));
    // Removing the person keeps the shared timeline intact.
    await req('DELETE', `/api/users/${opal.id}`);
    const after = (await req('GET', `/api/incidents/${id}`)).json() as { incident: IncidentView; timeline: TimelineEntry[] };
    expect(after.timeline.some((t) => t.actor === 'opal' && t.kind === 'note')).toBe(true);
    expect(after.incident.assignee!.name).toBe('(removed user)');
  });

  it('replay returns the starting state and every recorded change', async () => {
    state({ web: 'healthy', db: 'unhealthy' });
    state({ web: 'unhealthy', db: 'unhealthy' });
    state({ web: 'healthy', db: 'healthy' });
    const id = (await incidents())[0].id;
    const r = (await req('GET', `/api/incidents/${id}/replay`)).json() as { entities: string[]; events: { type: string; entityId: string }[]; initial: Record<string, string | null> };
    expect(r.entities).toEqual(expect.arrayContaining(['docker:alpha:app/db', 'docker:alpha:app/web']));
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['service.unhealthy', 'service.recovered']));
    expect(Object.keys(r.initial)).toContain('docker:alpha:app/db');
  });
});
