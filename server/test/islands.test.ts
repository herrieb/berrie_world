import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { HostFacts, WorldSnapshot } from '@berrie/shared';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/app.js';
import type { Transport } from '../src/adapters/ssh.js';
import { SshTransport, HostKeyMismatchError } from '../src/adapters/ssh.js';
import { ISLAND_PITCH } from '../src/db/repo.js';
import { signIn } from './helpers.js';

// ---------- fakes: a Docker API server and an SSH transport that runs a canned collector ----------

const container = (name: string, project = 'shop', state = 'running') => ({
  Id: `${name}-cid`.padEnd(64, '0'), Names: [`/${project}-${name}-1`], Image: `img/${name}`, ImageID: `sha-${name}`, Created: 1700000000, State: state, Status: state === 'running' ? 'Up 1 hour' : 'Exited (1) 2 minutes ago',
  Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': name, 'com.docker.compose.container-number': '1' }, Ports: [],
});

class FakeDocker {
  containers: unknown[] = [];
  down = false;
  server = http.createServer((req, res) => {
    if (this.down) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/containers/json')) res.end(JSON.stringify(this.containers));
    else if (req.url?.startsWith('/info')) res.end(JSON.stringify({ Name: 'fake', OperatingSystem: 'Debian GNU/Linux 12', KernelVersion: '6.1', Architecture: 'x86_64', NCPU: 4, MemTotal: 8e9, Containers: this.containers.length, ContainersRunning: this.containers.length, ContainersStopped: 0 }));
    else if (req.url?.startsWith('/events')) { res.writeHead(200); /* keep open */ }
    else { res.statusCode = 404; res.end('{}'); }
  });
  port = 0;
  async start() { await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r())); this.port = (this.server.address() as AddressInfo).port; }
  async stop() { this.server.closeAllConnections(); await new Promise((r) => this.server.close(r)); }
}

const COLLECTOR_OUTPUT = (opts: { meminfo?: boolean } = {}) => [
  '', '@@hostname', 'srv-a', '@@os', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', 'NAME="Debian GNU/Linux"', 'VERSION_ID="12"',
  '@@uname', 'Linux 6.1.0-18-amd64 x86_64', '@@uptime', '86400.5 300000.1', '@@loadavg', '0.42 0.30 0.25 1/300 12345',
  '@@meminfo', ...(opts.meminfo === false ? ['cat: /proc/meminfo: Permission denied'] : ['MemTotal:        8000000 kB', 'MemFree:         1000000 kB', 'MemAvailable:    6000000 kB', 'SwapTotal:       1000000 kB', 'SwapFree:         900000 kB']),
  '@@cpuinfo', '4', 'model name\t: AMD EPYC', '@@stat1', 'cpu  100 0 100 800 0 0 0 0 0 0',
  '@@net1', 'Inter-|   Receive', ' face |bytes', '  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0',
  '@@stat2', 'cpu  150 0 150 900 0 0 0 0 0 0', '@@net2', 'Inter-|   Receive', ' face |bytes', '  eth0: 6000 10 0 0 0 0 0 0 4000 20 0 0 0 0 0 0',
  '@@df', 'Filesystem Type 1-blocks Used Available Capacity Mounted on', '/dev/sda1 ext4 100000000000 42000000000 58000000000 42% /',
  '@@docker', 'permission denied while trying to connect to the Docker daemon socket', '@@cloudflared', 'inactive', '@@tailscale', '__NA__', '@@end', '',
].join('\n');

class FakeSsh implements Transport {
  static fail: null | 'network' | 'auth' = null;
  static meminfo = true;
  constructor(private readonly dockerPort: () => number) {}
  async exec() {
    if (FakeSsh.fail === 'network') throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:22'), { code: 'ECONNREFUSED' });
    if (FakeSsh.fail === 'auth') throw new Error('All configured authentication methods failed');
    return { code: 0, stdout: COLLECTOR_OUTPUT({ meminfo: FakeSsh.meminfo }), stderr: '' };
  }
  async forwardSocket() {
    if (FakeSsh.fail) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return net.connect(this.dockerPort(), '127.0.0.1');
  }
  async forwardTcp() { return this.forwardSocket(); }
  close() {}
}

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGoIFVnl58o5lw/UYMC1XzRR9kHKxUjBBlIOmvZDon4K';
// A throwaway test key (generated for this test suite only).
const TEST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBttx7O6svDvjP58tecB4+Z0fn7vba6MRjY9189l6emWgAAAKBsP8T4bD/E
+AAAAAtzc2gtZWQyNTUxOQAAACBttx7O6svDvjP58tecB4+Z0fn7vba6MRjY9189l6emWg
AAAEDjpTl8/gaVUbUvdMyhEWpFtOUPRplQOs0L/S40UYYTim23Hs7qy8O+M/ny15wHj5nR
+fu9troxGNj3Xz2Xp6ZaAAAAF3Rlc3RAYmVycmllLXdvcmxkLXRlc3RzAQIDBAUG
-----END OPENSSH PRIVATE KEY-----`;

let dir: string;
let app: App;
let docker: FakeDocker;
let docker2: FakeDocker;
let admin: string;

const req = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) =>
  app.http.inject({ method, url, headers: { cookie }, payload: payload as object });
const snapshot = async (cookie = admin) => (await req('GET', '/api/snapshot', undefined, cookie)).json() as WorldSnapshot;
const cycle = async () => { app.scheduler.hosts.sync(); await app.scheduler.cycle(); await app.scheduler.cycle(); };

async function registerSsh(id: string, dockerMode: 'socket' | 'none' = 'socket') {
  return req('POST', '/api/harbor/hosts', {
    id, name: id.toUpperCase(), method: 'ssh', tags: ['test'],
    settings: { address: '10.0.0.5', port: 22, username: 'berrie', docker: dockerMode },
    credential: { kind: 'key', privateKey: TEST_KEY }, hostKey: HOST_KEY, hostKeyConfirmed: true,
  });
}
async function registerDocker(id: string, port: number) {
  return req('POST', '/api/harbor/hosts', { id, name: id.toUpperCase(), method: 'docker', settings: { dockerUrl: `http://127.0.0.1:${port}` } });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'berrie-isl-'));
  docker = new FakeDocker(); docker2 = new FakeDocker();
  await docker.start(); await docker2.start();
  docker.containers = [container('web'), container('db')];
  docker2.containers = [container('api', 'billing')];
  FakeSsh.fail = null; FakeSsh.meminfo = true;
  const cfg = { ...loadConfig({ DATA_DIR: dir, CONFIG_PATH: join(dir, 'none.json'), BERRIE_MASTER_KEY: 'a'.repeat(64) }), hosts: [] };
  app = await buildApp(cfg, { startScheduler: false, logger: false, transportFactory: () => new FakeSsh(() => docker.port) });
  admin = await signIn(app, 'admin');
});
afterEach(async () => {
  await app.close();
  await docker.stop(); await docker2.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('server islands and Server Harbor', () => {
  it('L1/L5. two registered servers produce two separate islands — registered at runtime, no code change', async () => {
    expect((await registerSsh('srv-a')).statusCode).toBe(200);
    expect((await registerDocker('srv-b', docker2.port)).statusCode).toBe(200);
    await cycle();
    const snap = await snapshot();
    const hosts = snap.entities.filter((e) => e.kind === 'host');
    expect(hosts.map((h) => h.id).sort()).toEqual(['host:srv-a', 'host:srv-b']);
    const districts = new Set(snap.blocks.map((b) => b.district));
    expect(districts).toEqual(new Set(['host:srv-a', 'host:srv-b']));
    const a = app.repo.districtOrigin('host:srv-a'), b = app.repo.districtOrigin('host:srv-b');
    expect(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))).toBeGreaterThanOrEqual(ISLAND_PITCH * 0.6);
    // every building sits on its own server's island
    for (const e of snap.entities.filter((x) => x.layout && x.hostId)) {
      const own = app.repo.districtOrigin(e.hostId!), other = app.repo.districtOrigin(e.hostId === 'host:srv-a' ? 'host:srv-b' : 'host:srv-a');
      const d = (o: { x: number; y: number }) => Math.hypot(e.layout!.x - o.x, e.layout!.y - o.y);
      expect(d(own)).toBeLessThan(d(other));
    }
    expect(snap.entities.filter((e) => e.kind === 'service').map((e) => e.id).sort()).toEqual(['docker:srv-a:shop/db', 'docker:srv-a:shop/web', 'docker:srv-b:billing/api']);
  });

  it('L6. re-running discovery never duplicates entities', async () => {
    await registerSsh('srv-a');
    await cycle();
    const first = app.repo.listEntities(true).map((e) => e.id).sort();
    for (let i = 0; i < 3; i++) await cycle();
    await req('POST', '/api/harbor/hosts/srv-a/discover');
    await cycle();
    expect(app.repo.listEntities(true).map((e) => e.id).sort()).toEqual(first);
    expect(app.repo.listLayouts().length).toBe(new Set(app.repo.listLayouts().map((l) => l.entityId)).size);
  });

  it('L7/L8. an unreachable server and temporary SSH failures never delete the island', async () => {
    await registerSsh('srv-a');
    await cycle();
    await app.scheduler.hosts.collect(app.scheduler.hosts.get('srv-a')!);
    const before = (await snapshot()).entities.filter((e) => e.hostId === 'host:srv-a').map((e) => e.id).sort();
    FakeSsh.fail = 'network';
    docker.down = true;
    for (let i = 0; i < 6; i++) { await cycle(); await app.scheduler.hosts.collect(app.scheduler.hosts.get('srv-a')!); }
    const snap = await snapshot();
    const after = snap.entities.filter((e) => e.hostId === 'host:srv-a');
    expect(after.map((e) => e.id).sort()).toEqual(before);
    expect(after.every((e) => e.lifecycle === 'active' || e.lifecycle === 'discovered')).toBe(true);
    expect(after.filter((e) => e.kind !== 'project').every((e) => e.layout)).toBe(true);
    const host = after.find((e) => e.kind === 'host')!;
    expect(host.health).toBe('host_offline');
    expect(after.filter((e) => e.kind === 'service').every((e) => e.inheritedHostOffline && e.inventoryUncertain)).toBe(true);
    // Facts stay visible as stale, never erased or zeroed.
    const facts = host.meta.facts as HostFacts;
    expect(facts.memory.status).toBe('stale');
    expect(facts.memory.value?.usedPct).toBeCloseTo(25, 0);
    // Recovery: the same buildings come back, no duplicates.
    FakeSsh.fail = null; docker.down = false;
    await app.scheduler.hosts.collect(app.scheduler.hosts.get('srv-a')!);
    await cycle();
    const rec = (await snapshot()).entities.filter((e) => e.hostId === 'host:srv-a');
    expect(rec.map((e) => e.id).sort()).toEqual(before);
    expect(rec.find((e) => e.kind === 'host')!.health).toBe('healthy');
  });

  it('auth failures make a host degraded (reachable), never offline', async () => {
    await registerSsh('srv-a');
    await cycle();
    FakeSsh.fail = 'auth';
    await app.scheduler.hosts.collect(app.scheduler.hosts.get('srv-a')!);
    const host = (await snapshot()).entities.find((e) => e.id === 'host:srv-a')!;
    expect(host.health).not.toBe('host_offline');
    expect(host.healthReason).toMatch(/authentication failed/);
  });

  it('L9. new services appear automatically on their existing island', async () => {
    await registerSsh('srv-a');
    await cycle();
    const origin = app.repo.districtOrigin('host:srv-a');
    docker.containers = [...docker.containers, container('cache')];
    await cycle();
    const svc = (await snapshot()).entities.find((e) => e.id === 'docker:srv-a:shop/cache')!;
    expect(svc).toBeDefined();
    expect(svc.layout).not.toBeNull();
    expect(Math.abs(svc.layout!.x - origin.x)).toBeLessThan(ISLAND_PITCH / 2);
    expect(app.repo.blockViews().filter((b) => b.district !== 'host:srv-a')).toHaveLength(0);
  });

  it('L14. archived servers leave the map but remain accessible in history', async () => {
    await registerSsh('srv-a');
    await registerDocker('srv-b', docker2.port);
    await cycle();
    const events = app.repo.listEvents({ limit: 500 }).length;
    expect((await req('POST', '/api/harbor/hosts/srv-a/archive', { confirm: 'wrong' })).statusCode).toBe(400);
    expect((await req('POST', '/api/harbor/hosts/srv-a/archive', { confirm: 'srv-a' })).statusCode).toBe(200);
    await cycle(); await cycle();
    const snap = await snapshot();
    expect(snap.entities.some((e) => e.hostId === 'host:srv-a')).toBe(false);
    expect(snap.blocks.some((b) => b.district === 'host:srv-a')).toBe(false);
    expect(snap.entities.some((e) => e.id === 'host:srv-b')).toBe(true);
    const archive = (await req('GET', '/api/archive')).json().entities as { id: string }[];
    expect(archive.map((e) => e.id)).toEqual(expect.arrayContaining(['host:srv-a', 'docker:srv-a:shop/web', 'docker:srv-a:shop/db']));
    expect(app.repo.listEvents({ limit: 500 }).length).toBeGreaterThan(events);
    // The stored credential is destroyed on archive; the id stays reserved.
    expect(app.repo.hosts.get('srv-a')!.credential).toBeNull();
    expect((await registerSsh('srv-a')).statusCode).toBe(409);
  });

  it('L15. metrics are never fabricated: unconfigured, unavailable and unknown stay distinct', async () => {
    await req('POST', '/api/harbor/hosts', { id: 'nas', name: 'NAS', method: 'manual', settings: {} });
    await registerDocker('srv-b', docker2.port);
    FakeSsh.meminfo = false;
    await registerSsh('srv-a', 'none');
    await cycle();
    await app.scheduler.hosts.collect(app.scheduler.hosts.get('srv-a')!);
    const snap = await snapshot();
    const facts = (id: string) => snap.entities.find((e) => e.id === id)!.meta.facts as HostFacts;
    // Manual server: nothing collects anything.
    expect(Object.values(facts('host:nas')).every((f) => f.status === 'unconfigured' && f.value === null)).toBe(true);
    expect(app.repo.hosts.metricNames('host:nas')).toEqual([]);
    // Docker-only server: memory size is known, usage is not.
    const mb = facts('host:srv-b').memory;
    expect(mb.status).toBe('confirmed');
    expect(mb.value!.totalBytes).toBe(8e9);
    expect(mb.value!.usedPct).toBeNull();
    expect(facts('host:srv-b').storage.status).toBe('unconfigured');
    // SSH server whose meminfo is unreadable: unavailable with a reason, no memory metric stored.
    const ma = facts('host:srv-a').memory;
    expect(ma.status).toBe('unavailable');
    expect(ma.value).toBeNull();
    expect(ma.error).toMatch(/meminfo/);
    expect(app.repo.hosts.metricNames('host:srv-a')).not.toContain('mem.pct');
    expect(app.repo.hosts.metricNames('host:srv-a')).toEqual(expect.arrayContaining(['cpu.pct', 'disk.pct:/', 'load1']));
    // Containers: the SSH user may not query Docker → unavailable with the reason, not "0 containers".
    expect(facts('host:srv-a').containers.status).toBe('unavailable');
    expect(facts('host:srv-a').containers.error).toMatch(/docker group/);
    const cpu = (await req('GET', `/api/entities/${encodeURIComponent('host:srv-a')}/metrics?metric=cpu.pct&range=1h`)).json();
    expect(cpu.points).toHaveLength(1);
    expect(cpu.points[0].value).toBeCloseTo(50, 0);
    expect(cpu.source).toBe('ssh:srv-a');
  });

  it('SSH host keys are mandatory and credentials are encrypted, never returned', async () => {
    const noKey = await req('POST', '/api/harbor/hosts', { id: 'srv-x', name: 'X', method: 'ssh', settings: { address: '10.0.0.9', username: 'berrie' }, credential: { kind: 'password', password: 'hunter2-very-secret' }, hostKey: HOST_KEY });
    expect(noKey.statusCode).toBe(400);
    expect(() => new SshTransport({ address: 'x', port: 22, username: 'u' }, { kind: 'password', password: 'p' }, '')).toThrow(HostKeyMismatchError);
    const pub = await req('POST', '/api/harbor/hosts', { id: 'srv-y', name: 'Y', method: 'ssh', settings: { address: '10.0.0.9', username: 'berrie' }, credential: { kind: 'key', privateKey: HOST_KEY }, hostKey: HOST_KEY, hostKeyConfirmed: true });
    expect(pub.statusCode).toBe(400);
    const ok = await req('POST', '/api/harbor/hosts', { id: 'srv-z', name: 'Z', method: 'ssh', settings: { address: '10.0.0.9', username: 'berrie' }, credential: { kind: 'password', password: 'hunter2-very-secret' }, hostKey: HOST_KEY, hostKeyConfirmed: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain('hunter2');
    const raw = app.repo.db.prepare("SELECT credential FROM hosts WHERE id = 'srv-z'").get() as { credential: string };
    expect(raw.credential).toMatch(/^v1\./);
    expect(raw.credential).not.toContain('hunter2');
    const list = await req('GET', '/api/harbor/hosts');
    expect(list.body).not.toContain('hunter2');
    expect(list.json().hosts.find((h: { id: string }) => h.id === 'srv-z').hostKeyFingerprint).toMatch(/^SHA256:/);
    // Non-admins cannot use Harbor at all.
    const op = await signIn(app, 'operator');
    expect((await req('GET', '/api/harbor/hosts', undefined, op)).statusCode).toBe(403);
    expect((await req('POST', '/api/harbor/hosts', { id: 'evil', name: 'Evil', method: 'manual', settings: {} }, op)).statusCode).toBe(403);
  });

  it('Harbor can generate a dedicated key per server; only the public half is ever returned', async () => {
    const r = await req('POST', '/api/harbor/keypair');
    const { keyId, publicKey } = r.json() as { keyId: string; publicKey: string };
    expect(publicKey).toMatch(/^ssh-ed25519 /);
    expect(r.body).not.toMatch(/PRIVATE KEY/);
    const create = await req('POST', '/api/harbor/hosts', { id: 'gen', name: 'Gen', method: 'ssh', settings: { address: '10.0.0.9', username: 'berrie' }, credential: { kind: 'generated', keyId }, hostKey: HOST_KEY, hostKeyConfirmed: true });
    expect(create.statusCode).toBe(200);
    const sealed = app.repo.hosts.get('gen')!.credential!;
    expect(JSON.parse(app.box.open(sealed, 'host:gen')).privateKey).toMatch(/PRIVATE KEY/);
    // Single use, and bound to the admin who generated it.
    expect((await req('POST', '/api/harbor/hosts', { id: 'gen2', name: 'Gen2', method: 'ssh', settings: { address: '10.0.0.9', username: 'berrie' }, credential: { kind: 'generated', keyId }, hostKey: HOST_KEY, hostKeyConfirmed: true })).statusCode).toBe(400);
    const other = await signIn(app, 'admin');
    const k2 = (await req('POST', '/api/harbor/keypair')).json() as { keyId: string };
    expect((await req('POST', '/api/harbor/hosts', { id: 'gen3', name: 'Gen3', method: 'ssh', settings: { address: '10.0.0.9', username: 'berrie' }, credential: { kind: 'generated', keyId: k2.keyId }, hostKey: HOST_KEY, hostKeyConfirmed: true }, other)).statusCode).toBe(400);
  });

  it('the push agent reports with its own token; containers it reports become services', async () => {
    const r = (await req('POST', '/api/harbor/hosts', { id: 'pi', name: 'Pi', method: 'agent', settings: {} })).json() as { agentToken: string };
    expect(r.agentToken).toBeTruthy();
    await cycle();
    const bad = await app.http.inject({ method: 'POST', url: '/api/agent/report', headers: { authorization: 'Bearer nope', 'content-type': 'text/plain' }, payload: COLLECTOR_OUTPUT() });
    expect(bad.statusCode).toBe(401);
    const ok = await app.http.inject({ method: 'POST', url: '/api/agent/report', headers: { authorization: `Bearer ${r.agentToken}`, 'content-type': 'text/plain' }, payload: COLLECTOR_OUTPUT() });
    expect(ok.statusCode).toBe(200);
    const c = await app.http.inject({ method: 'POST', url: '/api/agent/containers', headers: { authorization: `Bearer ${r.agentToken}`, 'content-type': 'application/json' }, payload: JSON.stringify([container('homeassistant', 'ha')]) });
    expect(c.json().containers).toBe(1);
    const snap = await snapshot();
    expect(snap.entities.find((e) => e.id === 'docker:pi:ha/homeassistant')).toBeDefined();
    const facts = snap.entities.find((e) => e.id === 'host:pi')!.meta.facts as HostFacts;
    expect(facts.os.status).toBe('confirmed');
    expect(facts.os.source).toBe('agent:pi');
    expect(snap.entities.find((e) => e.id === 'host:pi')!.health).toBe('healthy');
  });

  it('suspending monitoring keeps the island and marks state unknown instead of guessing', async () => {
    await registerSsh('srv-a');
    await cycle();
    await req('POST', '/api/harbor/hosts/srv-a/suspend', { suspend: true });
    docker.containers = [];
    await cycle(); await cycle(); await cycle();
    const ents = (await snapshot()).entities.filter((e) => e.hostId === 'host:srv-a');
    expect(ents.filter((e) => e.kind === 'service')).toHaveLength(2);
    expect(ents.every((e) => e.lifecycle !== 'missing' && e.lifecycle !== 'removed')).toBe(true);
    expect(ents.filter((e) => e.kind === 'service').every((e) => e.health === 'unknown')).toBe(true);
  });
});
