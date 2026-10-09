import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repo, OriginMismatchError } from '../src/db/repo.js';
import { World, type InventoryResult, type ObservedEntity } from '../src/core/world.js';
import { DockerAdapter, containerIdentity } from '../src/adapters/docker.js';
import { DemoAdapter } from '../src/adapters/demo.js';
import { DockerClient } from '../src/adapters/dockerClient.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { signIn } from './helpers.js';

// ---------- helpers ----------

class Clock {
  t = Date.parse('2026-01-01T00:00:00Z');
  now = () => new Date(this.t);
  advance(seconds: number) { this.t += seconds * 1000; }
}

const OPTS = { removal: { confirmations: 3, minMissingSeconds: 120, archiveAfterHours: 24 }, unknownAfterInventoryFailures: 2 };

function setup(path = ':memory:', clock = new Clock()) {
  const repo = new Repo(path, 'live', clock.now);
  const world = new World(repo, OPTS);
  return { repo, world, clock };
}

const host: ObservedEntity = { id: 'host:local', kind: 'host', name: 'local', buildingType: 'server', parentId: null, hostId: 'host:local' };
const configInv = (): InventoryResult => ({ adapter: 'config', scope: 'config', completeness: 'complete', entities: [host] });

function svc(name: string, opts: { health?: ObservedEntity['health']; containerId?: string } = {}): ObservedEntity {
  return {
    id: `docker:local:app/${name}`, kind: 'service', name, buildingType: 'house', parentId: 'docker:local:project/app', hostId: 'host:local',
    meta: { containerId: opts.containerId ?? `cid-${name}`, image: `img/${name}` },
    health: opts.health ?? { health: 'healthy', reason: 'running' },
  };
}
const project: ObservedEntity = { id: 'docker:local:project/app', kind: 'project', name: 'app', buildingType: 'townhall', parentId: 'host:local', hostId: 'host:local' };

function dockerInv(services: ObservedEntity[], completeness: InventoryResult['completeness'] = 'complete'): InventoryResult {
  return { adapter: 'docker', scope: 'local', completeness, entities: completeness === 'unavailable' ? [] : [project, ...services], error: completeness === 'complete' ? null : 'docker API timeout' };
}

const visible = (repo: Repo) => repo.views().filter((v) => v.lifecycle !== 'archived');

/** Fake Docker client: serves a mutable container list, or fails. */
class FakeDocker extends DockerClient {
  containers: unknown[] = [];
  fail = false;
  constructor() { super({ socketPath: '/nonexistent' }); }
  override async get<T>(path: string): Promise<T> {
    if (this.fail) throw Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' });
    if (path.startsWith('/info')) return { Name: 'test' } as T;
    return this.containers as T;
  }
}
const container = (name: string, id: string, state = 'running', status = 'Up 1 minute') => ({
  Id: id, Names: [`/${name}`], Image: `img/${name}`, ImageID: `sha-${name}`, Created: 1700000000, State: state, Status: status,
  Labels: { 'com.docker.compose.project': 'app', 'com.docker.compose.service': name, 'com.docker.compose.container-number': '1' },
});

// ---------- tests ----------

describe('lifecycle reconciliation', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); t.world.reconcile(configInv()); });

  it('1. a newly discovered service creates one entity and one building', () => {
    t.world.reconcile(dockerInv([svc('web')]));
    const services = t.repo.views().filter((v) => v.kind === 'service');
    expect(services).toHaveLength(1);
    expect(services[0].lifecycle).toBe('discovered');
    expect(services[0].layout).not.toBeNull();
    expect(t.repo.listLayouts().filter((l) => l.entityId === services[0].id)).toHaveLength(1);
    expect(t.repo.listEvents({ types: ['service.discovered'] }).some((e) => e.entityId === services[0].id)).toBe(true);
  });

  it('2. a healthy service becomes unhealthy but remains visible', () => {
    t.world.reconcile(dockerInv([svc('web')]));
    t.world.reconcile(dockerInv([svc('web', { health: { health: 'unhealthy', reason: 'healthcheck failing' } })]));
    const v = t.repo.toView(t.repo.getEntity('docker:local:app/web')!);
    expect(v.health).toBe('unhealthy');
    expect(v.lifecycle).toBe('active');
    expect(v.layout).not.toBeNull();
  });

  it('3. a stopped container remains visible', async () => {
    const fake = new FakeDocker();
    const adapter = new DockerAdapter({ id: 'local', name: 'local', docker: {} }, fake);
    fake.containers = [container('web', 'a1')];
    t.world.reconcile(await adapter.inventory());
    fake.containers = [container('web', 'a1', 'exited', 'Exited (137) 5 seconds ago')];
    t.world.reconcile(await adapter.inventory());
    const v = t.repo.toView(t.repo.getEntity('docker:local:app/web')!);
    expect(v.lifecycle).toBe('active');
    expect(v.health).toBe('unhealthy');
    expect(v.healthReason).toMatch(/stopped/);
    expect(v.layout).not.toBeNull();
  });

  it('4. a server outage does not delete its children', () => {
    t.world.reconcile(dockerInv([svc('web'), svc('db')]));
    t.world.setHostSignal('host:local', { probe: 'host_offline' });
    for (let i = 0; i < 10; i++) { t.clock.advance(60); t.world.reconcile(dockerInv([], 'unavailable')); }
    const web = t.repo.toView(t.repo.getEntity('docker:local:app/web')!);
    expect(['discovered', 'active']).toContain(web.lifecycle);
    expect(web.inheritedHostOffline).toBe(true);
    expect(web.lastKnownHealth).toBe('healthy'); // individual state preserved
    expect(t.repo.toView(t.repo.getEntity('host:local')!).health).toBe('host_offline');
    expect(t.repo.listEvents({ types: ['service.removal_confirmed'] })).toHaveLength(0);
  });

  it('5. an unavailable Docker API does not mark every container as removed', () => {
    t.world.reconcile(dockerInv([svc('web'), svc('db')]));
    for (let i = 0; i < 10; i++) { t.clock.advance(300); t.world.reconcile(dockerInv([], 'unavailable')); }
    const svcs = visible(t.repo).filter((v) => v.kind === 'service');
    expect(svcs).toHaveLength(2);
    for (const s of svcs) {
      expect(['discovered', 'active']).toContain(s.lifecycle);
      expect(s.inventoryUncertain).toBe(true);
      expect(s.health).toBe('unknown'); // the monitor cannot know; it does not fabricate
      expect(s.lastKnownHealth).toBe('healthy');
    }
    expect(t.repo.listEvents({ types: ['inventory.uncertain'] })).toHaveLength(1);
  });

  it('6. an incomplete inventory does not trigger deletion', () => {
    t.world.reconcile(dockerInv([svc('web'), svc('db')]));
    for (let i = 0; i < 10; i++) { t.clock.advance(300); t.world.reconcile(dockerInv([svc('web')], 'incomplete')); }
    const db = t.repo.getEntity('docker:local:app/db')!;
    expect(db.lifecycle).not.toBe('missing');
    expect(db.lifecycle).not.toBe('removed');
    expect(t.repo.getStatus(db.id)!.inventoryUncertain).toBe(true);
  });

  it('7. completed inventories confirm absence: missing, then removed, then archived with history', () => {
    t.world.reconcile(dockerInv([svc('web'), svc('db')]));
    t.clock.advance(30); t.world.reconcile(dockerInv([svc('web')]));
    expect(t.repo.getEntity('docker:local:app/db')!.lifecycle).toBe('missing');
    t.clock.advance(30); t.world.reconcile(dockerInv([svc('web')]));
    // Two absences in 60s is not enough (needs 3 confirmations and 120s).
    expect(t.repo.getEntity('docker:local:app/db')!.lifecycle).toBe('missing');
    t.clock.advance(120); t.world.reconcile(dockerInv([svc('web')]));
    const db = t.repo.getEntity('docker:local:app/db')!;
    expect(db.lifecycle).toBe('removed');
    expect(t.repo.getLayout(db.id)).toBeDefined(); // ruins stay visible until archived
    t.clock.advance(25 * 3600); t.world.archivePass();
    expect(t.repo.getEntity(db.id)!.lifecycle).toBe('archived');
    expect(t.repo.getLayout(db.id)).toBeUndefined();
    expect(t.repo.listArchived().map((e) => e.id)).toContain(db.id);
    const types = t.repo.listEvents({ entityId: db.id }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['service.discovered', 'service.missing', 'service.removal_confirmed', 'service.archived']));
  });

  it('8. a recreated container updates the existing logical entity', async () => {
    const fake = new FakeDocker();
    const adapter = new DockerAdapter({ id: 'local', name: 'local', docker: {} }, fake);
    fake.containers = [container('web', 'old-container-id')];
    t.world.reconcile(await adapter.inventory());
    const before = t.repo.getLayout('docker:local:app/web')!;
    fake.containers = [container('web', 'new-container-id')];
    t.world.reconcile(await adapter.inventory());
    const svcs = t.repo.listEntities().filter((e) => e.kind === 'service');
    expect(svcs).toHaveLength(1);
    expect(svcs[0].meta.containerId).toBe('new-container-id');
    expect(t.repo.getLayout(svcs[0].id)).toEqual(before);
    expect(t.repo.listEvents({ types: ['deployment.changed'] })).toHaveLength(1);
    // identity ignores container id entirely
    expect(containerIdentity('local', { 'com.docker.compose.project': 'p', 'com.docker.compose.service': 's' }, 'x')).toBe('docker:local:p/s');
  });

  it('9. repeated discovery cycles do not create duplicates', () => {
    for (let i = 0; i < 20; i++) { t.clock.advance(30); t.world.reconcile(configInv()); t.world.reconcile(dockerInv([svc('web'), svc('db')])); }
    expect(t.repo.listEntities(true)).toHaveLength(4); // host, project, 2 services
    expect(t.repo.listLayouts()).toHaveLength(3); // host + 2 services
    expect(t.repo.listEvents({ types: ['service.discovered'] })).toHaveLength(4);
  });

  it('10. existing building positions remain stable as the world grows', () => {
    t.world.reconcile(dockerInv([svc('a'), svc('b')]));
    const snap = new Map(t.repo.listLayouts().map((l) => [l.entityId, `${l.x},${l.y}`]));
    const more = Array.from({ length: 12 }, (_, i) => svc(`n${i}`));
    t.world.reconcile(dockerInv([svc('a'), svc('b'), ...more]));
    t.world.reconcile(dockerInv([svc('b'), ...more])); // 'a' goes missing; nothing else should move
    for (const [id, pos] of snap) {
      const l = t.repo.getLayout(id)!;
      expect(`${l.x},${l.y}`).toBe(pos);
    }
    // no overlaps
    const ls = t.repo.listLayouts();
    for (const a of ls) for (const b of ls) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `${a.entityId} overlaps ${b.entityId}`).toBe(false);
    }
  });

  it('10b. multiple host districts never overlap as they grow', () => {
    const hostB: ObservedEntity = { id: 'host:b', kind: 'host', name: 'b', buildingType: 'server', parentId: null, hostId: 'host:b' };
    t.world.reconcile({ adapter: 'config', scope: 'config', completeness: 'complete', entities: [host, hostB] });
    const many = (h: string, n: number): InventoryResult => ({
      adapter: 'docker', scope: h, completeness: 'complete',
      entities: Array.from({ length: n }, (_, i) => ({ ...svc(`${h}${i}`), id: `docker:${h}:p${i % 5}/s${i}`, parentId: `docker:${h}:project/p${i % 5}`, hostId: `host:${h}` })),
    });
    t.world.reconcile(many('local', 60));
    t.world.reconcile(many('b', 60));
    const blocks = t.repo.blockViews();
    for (const a of blocks) for (const b of blocks) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.size && b.x < a.x + a.size && a.y < b.y + b.size && b.y < a.y + a.size;
      expect(overlap, `${a.district}:${a.x},${a.y} overlaps ${b.district}:${b.x},${b.y}`).toBe(false);
    }
    const ls = t.repo.listLayouts();
    expect(ls.length).toBe(122);
    for (const a of ls) for (const b of ls) {
      if (a === b) continue;
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });

  it('11. a recovered service returns to healthy (probe hysteresis)', () => {
    t.world.reconcile(configInv());
    t.world.reconcile({ adapter: 'config', scope: 'config', completeness: 'complete', entities: [host, { id: 'manual:ollama', kind: 'service', name: 'ollama', buildingType: 'lab', parentId: 'host:local', hostId: 'host:local' }] });
    const id = 'manual:ollama';
    const probe = (ok: boolean) => t.world.recordProbe(id, { checkName: 'tcp', outcome: ok ? 'ok' : 'fail', failHealth: 'unreachable', reason: ok ? 'open' : 'ECONNREFUSED', failureThreshold: 3 });
    probe(true);
    expect(t.repo.getStatus(id)!.health).toBe('healthy');
    probe(false); probe(false);
    expect(t.repo.getStatus(id)!.health).toBe('healthy'); // below threshold: no flicker
    probe(false);
    expect(t.repo.getStatus(id)!.health).toBe('unreachable');
    probe(true);
    expect(t.repo.getStatus(id)!.health).toBe('healthy');
    expect(t.repo.listEvents({ types: ['service.recovered'] }).map((e) => e.entityId)).toContain(id);
  });
});

describe('persistence and safety', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bw-test-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('12. historical events and layout survive a restart', () => {
    const path = join(dir, 'w.sqlite');
    const a = setup(path);
    a.world.reconcile(configInv());
    a.world.reconcile(dockerInv([svc('web')]));
    const events = a.repo.listEvents().length;
    const layout = a.repo.getLayout('docker:local:app/web');
    a.repo.close();
    const b = setup(path);
    expect(b.repo.listEvents().length).toBe(events);
    expect(b.repo.getLayout('docker:local:app/web')).toEqual(layout);
    b.world.reconcile(dockerInv([svc('web')]));
    expect(b.repo.listEntities().filter((e) => e.kind === 'service')).toHaveLength(1);
    b.repo.close();
  });

  it('13. operational actions reject unauthorized requests', async () => {
    const cfg = { ...loadConfig({ DATA_DIR: dir, ADMIN_TOKEN: 'correct-horse-battery-staple', ENABLE_ACTIONS: 'true', CONFIG_PATH: join(dir, 'none.json') }), hosts: [] };
    const app = await buildApp(cfg, { startScheduler: false, logger: false });
    try {
      app.world.reconcile(configInv());
      const id = encodeURIComponent('host:local');
      const noAuth = await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, payload: { action: 'restart', confirm: 'host:local' } });
      expect(noAuth.statusCode).toBe(401);
      const badToken = await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, headers: { authorization: 'Bearer wrong' }, payload: { action: 'restart', confirm: 'host:local' } });
      expect(badToken.statusCode).toBe(401);
      const forged = await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, cookies: { bw_sid: 'forged-session-token' }, payload: { action: 'restart', confirm: 'host:local' } });
      expect(forged.statusCode).toBe(401);
      // The bootstrap token is not an API credential.
      expect((await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, headers: { authorization: 'Bearer correct-horse-battery-staple' }, payload: { action: 'restart', confirm: 'host:local' } })).statusCode).toBe(401);
      // A viewer may not operate anything.
      const viewer = { cookie: await signIn(app, 'viewer') };
      expect((await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, headers: viewer, payload: { action: 'restart', confirm: 'host:local' } })).statusCode).toBe(403);
      // Authorized operator, but a host is not an allowlisted target and arbitrary actions fail validation.
      const auth = { cookie: await signIn(app, 'operator') };
      expect((await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, headers: auth, payload: { action: 'restart', confirm: 'host:local' } })).statusCode).toBe(403);
      expect((await app.http.inject({ method: 'POST', url: `/api/entities/${id}/actions`, headers: auth, payload: { action: 'exec', confirm: 'host:local' } })).statusCode).toBe(400);
      expect((await app.http.inject({ method: 'GET', url: `/api/entities/${id}/logs` })).statusCode).toBe(401);
      expect((await app.http.inject({ method: 'PATCH', url: `/api/entities/${id}`, payload: { displayName: 'x' } })).statusCode).toBe(401);
      expect(app.repo.listAudit().some((a: { result: string }) => a.result.startsWith('rejected'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('14. demo fixtures never appear as real services', () => {
    const live = setup();
    const demo = new DemoAdapter();
    for (const inv of demo.inventory()) expect(() => live.world.reconcile(inv)).toThrow(/refusing demo/);
    expect(live.repo.listEntities(true)).toHaveLength(0);
    expect(() => live.repo.insertEntity({ ...live.repo.getEntity('x')!, id: 'demo:x', origin: 'demo' } as never)).toThrow(OriginMismatchError);
    // A demo database cannot be opened as the live database.
    const path = join(dir, 'demo.sqlite');
    const d = new Repo(path, 'demo');
    const dw = new World(d, OPTS);
    for (const inv of demo.inventory()) dw.reconcile(inv);
    expect(d.listEntities().every((e) => e.origin === 'demo')).toBe(true);
    d.close();
    expect(() => new Repo(path, 'live')).toThrow(OriginMismatchError);
    // ...and live inventories are refused in a demo world.
    const d2 = new Repo(':memory:', 'demo');
    expect(() => new World(d2, OPTS).reconcile(configInv())).toThrow(/refusing config/);
  });
});

describe('docker health mapping', () => {
  it('maps container states to health without implying existence changes', async () => {
    const fake = new FakeDocker();
    const adapter = new DockerAdapter({ id: 'local', name: 'local', docker: {} }, fake);
    fake.containers = [
      container('a', '1', 'running', 'Up 2 hours (healthy)'),
      container('b', '2', 'running', 'Up 2 hours (unhealthy)'),
      container('c', '3', 'restarting', 'Restarting (1) 3 seconds ago'),
      container('d', '4', 'running', 'Up 3 seconds (health: starting)'),
      container('e', '5', 'exited', 'Exited (0) 1 hour ago'),
    ];
    const inv = await adapter.inventory();
    const h = Object.fromEntries(inv.entities.filter((e) => e.kind === 'service').map((e) => [e.name, e.health!.health]));
    expect(h).toEqual({ a: 'healthy', b: 'unhealthy', c: 'restarting', d: 'starting', e: 'unhealthy' });
    fake.fail = true;
    const down = await adapter.inventory();
    expect(down.completeness).toBe('unavailable');
    expect(down.entities).toHaveLength(0);
  });
});
