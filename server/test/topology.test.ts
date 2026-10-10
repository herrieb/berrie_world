import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionView, ImpactReport, RouteHop, WorldSnapshot } from '@berrie/shared';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/app.js';
import type { InventoryResult, ObservedEntity } from '../src/core/world.js';
import { signIn } from './helpers.js';
import { ISLAND_PITCH } from '../src/db/repo.js';

const svc = (host: string, name: string, deps: string[] = [], type: ObservedEntity['buildingType'] = 'house'): ObservedEntity => ({
  id: `docker:${host}:app/${name}`, kind: 'service', name, buildingType: type, parentId: `host:${host}`, hostId: `host:${host}`,
  dependsOn: deps.map((d) => `docker:${host}:app/${d}`), meta: { containerId: `cid-${name}`, state: 'running', composeProject: 'app', composeService: name },
  health: { health: 'healthy', reason: 'running' },
});
const dockerInv = (host: string, entities: ObservedEntity[]): InventoryResult => ({ adapter: 'docker', scope: host, completeness: 'complete', entities });

let dir: string;
let app: App;
let admin: string;

const get = async (url: string, cookie = admin) => app.http.inject({ method: 'GET', url, headers: { cookie } });
const snapshot = async (cookie = admin) => (await get('/api/snapshot', cookie)).json() as WorldSnapshot;
const conn = (s: WorldSnapshot, type: string, a: string, b: string) => s.connections.find((c) => c.type === type && ((c.src === a && c.dst === b) || (c.src === b && c.dst === a)));
const report = (host: string, x: { cloudflared?: string; peers?: Record<string, unknown> }) =>
  app.scheduler.hosts.extras.set(host, { cloudflared: x.cloudflared ?? 'unknown', tailscale: x.peers ? { Peer: x.peers } : null, ts: new Date().toISOString() });
const cycle = async () => { await app.scheduler.cycle(); await app.scheduler.cycle(); };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'berrie-topo-'));
  const base = loadConfig({ DATA_DIR: dir, CONFIG_PATH: join(dir, 'none.json') });
  const cfg = {
    ...base,
    removal: { confirmations: 2, minMissingSeconds: 0, archiveAfterHours: 24 },
    hosts: [{ id: 'alpha', name: 'alpha' }, { id: 'beta', name: 'beta' }, { id: 'gamma', name: 'gamma' }],
    gateways: [{ id: 'cloudflared', name: 'Cloudflare Tunnel', host: 'alpha', kind: 'cloudflare-tunnel' as const, routes: ['*.example.com'] }],
    endpoints: [{ hostname: 'shop.example.com', service: 'compose:app/web', check: false as const }],
    connections: [{ from: 'beta', to: 'gamma', type: 'lan' as const, description: 'same switch (not verified)' }],
  };
  app = await buildApp(cfg, { startScheduler: false, logger: false });
  admin = await signIn(app, 'admin');
  await cycle();
  app.world.reconcile(dockerInv('alpha', [svc('alpha', 'web', ['db']), svc('alpha', 'db', [], 'silo')]));
  app.world.reconcile(dockerInv('beta', [svc('beta', 'api')]));
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('topology: bridges, ferries, gateways and impact', () => {
  it('L2. a verified private connection (tailscale status on the host) creates a bridge; reachability alone does not', async () => {
    report('alpha', { peers: { k1: { HostName: 'beta', DNSName: 'beta.tail1234.ts.net.', TailscaleIPs: ['100.64.0.2'], Online: true, CurAddr: '192.168.1.20:41641' } } });
    await cycle();
    const s = await snapshot();
    const vpn = conn(s, 'vpn', 'host:alpha', 'host:beta')!;
    expect(vpn).toBeDefined();
    expect(vpn.verification).toBe('verified');
    expect(vpn.health).toBe('healthy');
    expect(vpn.meta.direct).toBe(true);
    expect(vpn.evidence[0]).toMatch(/tailscale status on alpha/);
    // gamma is a registered host too, but nothing reports a network relationship with it: no bridge.
    expect(s.connections.some((c) => c.type === 'vpn' && (c.src === 'host:gamma' || c.dst === 'host:gamma'))).toBe(false);
    // Reported by both ends → still one record.
    report('beta', { peers: { k2: { HostName: 'alpha', Online: true } } });
    await cycle();
    expect((await snapshot()).connections.filter((c) => c.type === 'vpn')).toHaveLength(1);
  });

  it('L3. a known public-internet route creates a ferry: Cloudflare edge → tunnel gateway → service', async () => {
    report('alpha', { cloudflared: 'active' });
    await cycle();
    const s = await snapshot();
    expect(s.entities.find((e) => e.id === 'external:cloudflare-edge')?.kind).toBe('external');
    const gw = s.entities.find((e) => e.id === 'gateway:alpha:cloudflared')!;
    expect(gw.kind).toBe('gateway');
    expect(gw.hostId).toBe('host:alpha');
    expect(gw.health).toBe('healthy');
    const ferry = conn(s, 'internet', 'external:cloudflare-edge', 'gateway:alpha:cloudflared')!;
    expect(ferry.verification).toBe('verified');
    expect(ferry.meta.hostnames).toContain('shop.example.com');
    const hop = conn(s, 'proxy', 'gateway:alpha:cloudflared', 'docker:alpha:app/web')!;
    expect(hop.meta.hostnames).toEqual(['shop.example.com']);
    const route = (await get(`/api/entities/${encodeURIComponent('endpoint:shop.example.com')}/route`)).json() as { routes: RouteHop[][] };
    expect(route.routes[0].map((h) => h.entityId)).toEqual(['endpoint:shop.example.com', 'external:cloudflare-edge', 'gateway:alpha:cloudflared', 'docker:alpha:app/web']);
  });

  it('L4. uncertain relationships are labelled: configured and observed links are never shown as verified', async () => {
    await cycle();
    const s = await snapshot();
    const lan = conn(s, 'lan', 'host:beta', 'host:gamma')!;
    expect(lan.verification).toBe('configured');
    expect(lan.health).toBe('unknown');
    // Without a collector report, the tunnel is only configured, not verified.
    expect(conn(s, 'internet', 'external:cloudflare-edge', 'gateway:alpha:cloudflared')!.verification).toBe('configured');
    // Traffic reported via ingest is labelled observed.
    app.world.observeTraffic('docker:beta:app/api', 'docker:alpha:app/web', new Date().toISOString());
    const obs = conn(await snapshot(), 'api', 'docker:beta:app/api', 'docker:alpha:app/web')!;
    expect(obs.verification).toBe('observed');
    expect(obs.lastActivityAt).not.toBeNull();
    // Compose depends_on is a configured database dependency.
    expect(conn(s, 'database', 'docker:alpha:app/web', 'docker:alpha:app/db')!.verification).toBe('configured');
  });

  it('a gateway failure highlights its routes without declaring dependent applications down', async () => {
    report('alpha', { cloudflared: 'active' });
    await cycle();
    report('alpha', { cloudflared: 'inactive' });
    await cycle();
    const s = await snapshot();
    expect(s.entities.find((e) => e.id === 'gateway:alpha:cloudflared')!.health).toBe('unhealthy');
    expect(conn(s, 'internet', 'external:cloudflare-edge', 'gateway:alpha:cloudflared')!.health).toBe('unreachable');
    expect(conn(s, 'proxy', 'gateway:alpha:cloudflared', 'docker:alpha:app/web')!.health).toBe('unreachable');
    // The application itself keeps its own, verified state.
    expect(s.entities.find((e) => e.id === 'docker:alpha:app/web')!.health).toBe('healthy');
    const impact = (await get(`/api/impact/${encodeURIComponent('gateway:alpha:cloudflared')}`)).json() as ImpactReport;
    const ep = impact.items.find((i) => i.entityId === 'endpoint:shop.example.com')!;
    expect(ep.class).toBe('likely');
    expect(impact.items.some((i) => i.entityId === 'docker:alpha:app/web')).toBe(false);
    expect(impact.items.some((i) => i.class === 'confirmed')).toBe(false);
    expect(app.repo.listEvents({ types: ['connection.degraded'] }).length).toBeGreaterThan(0);
  });

  it('impact analysis separates confirmed, likely and unknown impact; cause is only a hypothesis', async () => {
    // db fails; web depends on it (configured) and is itself failing → confirmed; an observed-only caller → unknown.
    app.world.reconcile(dockerInv('alpha', [{ ...svc('alpha', 'web', ['db']), health: { health: 'unhealthy', reason: 'exited' } }, { ...svc('alpha', 'db', [], 'silo'), health: { health: 'unhealthy', reason: 'exited' } }]));
    app.world.observeTraffic('docker:beta:app/api', 'docker:alpha:app/db', new Date().toISOString());
    await cycle();
    const r = (await get(`/api/impact/${encodeURIComponent('docker:alpha:app/db')}`)).json() as ImpactReport;
    const cls = (id: string) => r.items.find((i) => i.entityId === id)?.class;
    expect(cls('docker:alpha:app/web')).toBe('confirmed');
    // The endpoint has no check of its own: it relies on a failing service, but its own failure is not verified.
    expect(cls('endpoint:shop.example.com')).toBe('likely');
    expect(['unknown', 'unaffected']).toContain(cls('docker:beta:app/api'));
    expect(r.summary).toMatch(/Hypothesis \(not verified\)/);
    const sim = (await get(`/api/impact/${encodeURIComponent('docker:beta:app/api')}?simulate=true`)).json() as ImpactReport;
    expect(sim.simulated).toBe(true);
    expect(sim.summary).toMatch(/nothing was changed/);
  });

  it('relationships are removed only after repeated complete reports — a missing report removes nothing', async () => {
    report('alpha', { peers: { k1: { HostName: 'beta', Online: true } } });
    await cycle();
    expect(conn(await snapshot(), 'vpn', 'host:alpha', 'host:beta')!.lifecycle).not.toBe('removed');
    // Report goes stale (collector silent): no tailscale inventory → the bridge stays.
    app.scheduler.hosts.extras.set('alpha', { cloudflared: 'unknown', tailscale: { Peer: {} }, ts: new Date(Date.now() - 3600_000).toISOString() });
    for (let i = 0; i < 4; i++) await cycle();
    expect(conn(await snapshot(), 'vpn', 'host:alpha', 'host:beta')!.lifecycle).toBe('active');
    // Peer offline: still there, health unreachable.
    report('alpha', { peers: { k1: { HostName: 'beta', Online: false } } });
    await cycle();
    expect(conn(await snapshot(), 'vpn', 'host:alpha', 'host:beta')!.health).toBe('unreachable');
    // Fresh complete reports without the peer: missing, then removed after confirmations.
    report('alpha', { peers: {} });
    await app.scheduler.cycle();
    expect(conn(await snapshot(), 'vpn', 'host:alpha', 'host:beta')!.lifecycle).toBe('missing');
    report('alpha', { peers: {} });
    await app.scheduler.cycle();
    expect(conn(await snapshot(), 'vpn', 'host:alpha', 'host:beta')!.lifecycle).toBe('removed');
  });

  it('"redraw the map" runs discovery now, is rate limited, audited and needs a session', async () => {
    const viewer = await signIn(app, 'viewer');
    expect((await app.http.inject({ method: 'POST', url: '/api/discovery/run' })).statusCode).toBe(401);
    const r = await app.http.inject({ method: 'POST', url: '/api/discovery/run', headers: { cookie: viewer } });
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect((await app.http.inject({ method: 'POST', url: '/api/discovery/run', headers: { cookie: viewer } })).statusCode).toBe(429);
    expect(app.repo.listAudit(20).some((a: { action: string }) => a.action === 'discovery.run')).toBe(true);
  });

  it('"new map" re-places every island and building with proper spacing, keeping entities and history', async () => {
    report('alpha', { cloudflared: 'active' });
    await cycle();
    // Simulate an island placed by the old 35-tile spacing, overlapping alpha's island.
    app.repo.db.prepare("UPDATE districts SET ox = 35, oy = -35 WHERE key = 'external'").run();
    const before = { entities: app.repo.listEntities(true).length, events: app.repo.listEvents({ limit: 500 }).length };
    const viewer = await signIn(app, 'viewer');
    const op = await signIn(app, 'operator');
    await app.http.inject({ method: 'PUT', url: '/api/account/prefs', headers: { cookie: viewer }, payload: { islandOffsets: { 'host:alpha': { dx: 7, dy: 0 } } } });
    expect((await app.http.inject({ method: 'POST', url: '/api/layout/regenerate', headers: { cookie: viewer }, payload: { confirm: 'new map' } })).statusCode).toBe(403);
    expect((await app.http.inject({ method: 'POST', url: '/api/layout/regenerate', headers: { cookie: op }, payload: {} })).statusCode).toBe(400);
    const r = await app.http.inject({ method: 'POST', url: '/api/layout/regenerate', headers: { cookie: op }, payload: { confirm: 'new map' } });
    expect(r.statusCode).toBe(200);
    const origins = (app.repo.db.prepare('SELECT ox, oy FROM districts').all() as { ox: number; oy: number }[]);
    for (let i = 0; i < origins.length; i++) for (let j = i + 1; j < origins.length; j++) {
      expect(Math.max(Math.abs(origins[i].ox - origins[j].ox), Math.abs(origins[i].oy - origins[j].oy))).toBeGreaterThanOrEqual(ISLAND_PITCH * 0.6);
    }
    const s = await snapshot();
    const placed = s.entities.filter((e) => e.kind !== 'project' && !(e.kind === 'endpoint' && e.parentId && s.entities.find((p) => p.id === e.parentId)?.kind === 'service'));
    expect(placed.every((e) => e.layout)).toBe(true);
    const rects = placed.map((e) => e.layout!);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
    expect(app.repo.listEntities(true).length).toBe(before.entities);
    expect(app.repo.listEvents({ limit: 500 }).length).toBeGreaterThan(before.events);
    expect((await app.http.inject({ method: 'GET', url: '/api/account/prefs', headers: { cookie: viewer } })).json().prefs.islandOffsets).toBeUndefined();
    expect(app.repo.listAudit(20).some((a: { action: string }) => a.action === 'layout.regenerate')).toBe(true);
  });

  it('users only see relationships whose both ends they may see', async () => {
    report('alpha', { peers: { k1: { HostName: 'beta', Online: true } }, cloudflared: 'active' });
    await cycle();
    const viewer = await signIn(app, 'viewer', { hostScope: 'list', hosts: ['host:alpha'] });
    const s = await snapshot(viewer);
    expect(s.connections.some((c: ConnectionView) => c.type === 'vpn')).toBe(false);
    expect(s.connections.some((c) => c.type === 'internet')).toBe(true); // edge (external) + own gateway
    const route = (await get(`/api/entities/${encodeURIComponent('docker:alpha:app/web')}/route`, viewer)).json();
    expect(JSON.stringify(route)).not.toContain('beta');
  });
});
