import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorldSnapshot } from '@berrie/shared';
import { loadConfig } from '../src/config.js';
import { buildApp, type App } from '../src/app.js';
import { totpCode } from '../src/core/secrets.js';
import type { InventoryResult, ObservedEntity } from '../src/core/world.js';
import { signIn } from './helpers.js';

const hostEnt = (id: string): ObservedEntity => ({ id: `host:${id}`, kind: 'host', name: id, buildingType: 'server', parentId: null, hostId: `host:${id}` });
const svcEnt = (host: string, name: string): ObservedEntity => ({
  id: `docker:${host}:app/${name}`, kind: 'service', name, buildingType: 'house', parentId: `host:${host}`, hostId: `host:${host}`,
  meta: { containerId: `cid-${host}-${name}`, state: 'running' }, health: { health: 'healthy', reason: 'running' },
});
const configInv = (): InventoryResult => ({ adapter: 'config', scope: 'config', completeness: 'complete', entities: [hostEnt('alpha'), hostEnt('beta')] });
const dockerInv = (host: string, names: string[]): InventoryResult => ({ adapter: 'docker', scope: host, completeness: 'complete', entities: names.map((n) => svcEnt(host, n)) });

let dir: string;
let app: App;

async function start(env: Record<string, string> = {}) {
  const cfg = { ...loadConfig({ DATA_DIR: dir, ADMIN_TOKEN: 'bootstrap-token-for-tests', CONFIG_PATH: join(dir, 'none.json'), ENABLE_ACTIONS: 'true', ...env }), hosts: [] };
  app = await buildApp(cfg, { startScheduler: false, logger: false });
  app.world.reconcile(configInv());
  app.world.reconcile(dockerInv('alpha', ['web', 'db']));
  app.world.reconcile(dockerInv('beta', ['secret-app']));
}

const get = async (url: string, cookie?: string) => app.http.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
const send = async (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string | undefined, payload?: unknown) =>
  app.http.inject({ method, url, headers: cookie ? { cookie } : {}, payload: payload as object });
const snapshot = async (cookie: string) => (await get('/api/snapshot', cookie)).json() as WorldSnapshot;
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => `bw_sid=${res.cookies.find((c) => c.name === 'bw_sid')!.value}`;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'berrie-acct-'));
  await start();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('accounts and authorization', () => {
  it('first-run setup needs the bootstrap token and works exactly once', async () => {
    expect((await get('/api/auth/me')).json().setupRequired).toBe(true);
    expect((await get('/api/snapshot')).statusCode).toBe(401);
    const bad = await send('POST', '/api/auth/setup', undefined, { bootstrapToken: 'nope', username: 'root', displayName: 'Root', password: 'a-long-admin-password' });
    expect(bad.statusCode).toBe(401);
    const ok = await send('POST', '/api/auth/setup', undefined, { bootstrapToken: 'bootstrap-token-for-tests', username: 'root', displayName: 'Root', password: 'a-long-admin-password' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.role).toBe('admin');
    expect((await snapshot(cookieOf(ok))).entities.length).toBeGreaterThan(0);
    const again = await send('POST', '/api/auth/setup', undefined, { bootstrapToken: 'bootstrap-token-for-tests', username: 'root2', displayName: 'Root', password: 'a-long-admin-password' });
    expect(again.statusCode).toBe(409);
  });

  it('L10. per-server permissions restrict what a user sees and can operate', async () => {
    const alphaViewer = await signIn(app, 'viewer', { hostScope: 'list', hosts: ['host:alpha'] });
    const snap = await snapshot(alphaViewer);
    const ids = snap.entities.map((e) => e.id);
    expect(ids).toContain('docker:alpha:app/web');
    expect(ids).not.toContain('docker:beta:app/secret-app');
    expect(ids).not.toContain('host:beta');
    expect(snap.recentEvents.every((ev) => !String(ev.entityId).includes('beta'))).toBe(true);
    // Direct requests for hidden entities look exactly like unknown ones.
    const beta = encodeURIComponent('docker:beta:app/secret-app');
    expect((await get(`/api/entities/${beta}`, alphaViewer)).statusCode).toBe(404);
    expect((await get(`/api/events?entity=${beta}`, alphaViewer)).json().events).toHaveLength(0);
    // Viewers cannot operate or administer.
    const web = encodeURIComponent('docker:alpha:app/web');
    expect((await send('POST', `/api/entities/${web}/actions`, alphaViewer, { action: 'restart', confirm: 'docker:alpha:app/web' })).statusCode).toBe(403);
    expect((await send('PATCH', `/api/entities/${web}`, alphaViewer, { displayName: 'x' })).statusCode).toBe(403);
    expect((await get('/api/users', alphaViewer)).statusCode).toBe(403);
    expect((await get('/api/audit', alphaViewer)).statusCode).toBe(403);
    // An operator limited to alpha cannot reach beta's services either.
    const alphaOp = await signIn(app, 'operator', { hostScope: 'list', hosts: ['host:alpha'] });
    expect((await send('POST', `/api/entities/${beta}/actions`, alphaOp, { action: 'restart', confirm: 'docker:beta:app/secret-app' })).statusCode).toBe(403);
    expect((await send('PATCH', `/api/entities/${beta}`, alphaOp, { displayName: 'x' })).statusCode).toBe(404);
    expect((await send('PATCH', `/api/entities/${web}`, alphaOp, { displayName: 'Shop' })).statusCode).toBe(200);
  });

  it('L10. the WebSocket stream is filtered per user too', async () => {
    const alphaViewer = await signIn(app, 'viewer', { hostScope: 'list', hosts: ['host:alpha'] });
    await app.http.ready();
    const msgs: { t: string; data: { id?: string; entities?: { id: string }[] } }[] = [];
    const ws = await app.http.injectWS('/ws', { headers: { cookie: alphaViewer } }, { onInit: (s) => s.on('message', (d: Buffer) => msgs.push(JSON.parse(d.toString()))) });
    await new Promise((r) => setTimeout(r, 50));
    app.world.reconcile(dockerInv('beta', ['secret-app', 'secret-new']));
    app.world.reconcile(dockerInv('alpha', ['web', 'db', 'new-alpha']));
    await new Promise((r) => setTimeout(r, 50));
    ws.terminate();
    const snap = msgs.find((m) => m.t === 'snapshot')!;
    expect(snap.data.entities!.some((e) => e.id.includes('beta'))).toBe(false);
    const pushed = msgs.filter((m) => m.t === 'entity').map((m) => m.data.id!);
    expect(pushed).toContain('docker:alpha:app/new-alpha');
    expect(pushed.some((id) => id.includes('beta'))).toBe(false);
  });

  it('L11. shared infrastructure state is identical across authorized sessions', async () => {
    const a = await signIn(app, 'operator');
    const b = await signIn(app, 'viewer');
    const web = encodeURIComponent('docker:alpha:app/web');
    await send('PATCH', `/api/entities/${web}`, a, { displayName: 'Storefront' });
    app.world.reconcile({ ...dockerInv('alpha', ['web', 'db']), entities: [{ ...svcEnt('alpha', 'web'), health: { health: 'unhealthy', reason: 'stopped' } }, svcEnt('alpha', 'db')] });
    const sa = await snapshot(a), sb = await snapshot(b);
    const pick = (s: WorldSnapshot) => s.entities.map((e) => [e.id, e.displayName, e.health, e.lifecycle, e.layout]).sort();
    expect(pick(sa)).toEqual(pick(sb));
    expect(sb.entities.find((e) => e.id === 'docker:alpha:app/web')!.displayName).toBe('Storefront');
  });

  it('L12. personal layout, preferences and favorites stay user-specific', async () => {
    const a = await signIn(app, 'viewer');
    const b = await signIn(app, 'viewer');
    await send('PUT', '/api/account/prefs', a, { camera: { x: 10, y: 20, zoom: 2 }, islandOffsets: { 'host:beta': { dx: 30, dy: -4 } }, daylight: 'night' });
    await send('PUT', `/api/account/favorites/${encodeURIComponent('docker:alpha:app/web')}`, a);
    await send('POST', '/api/account/views', a, { name: 'Problems', view: { filters: { text: '', health: 'problems', type: 'all', host: 'all' } } });
    expect((await get('/api/account/prefs', a)).json().prefs.islandOffsets['host:beta']).toEqual({ dx: 30, dy: -4 });
    expect((await get('/api/account/prefs', b)).json().prefs).toEqual({});
    expect((await get('/api/account/favorites', a)).json().favorites).toEqual(['docker:alpha:app/web']);
    expect((await get('/api/account/favorites', b)).json().favorites).toEqual([]);
    expect((await get('/api/account/views', b)).json().views).toEqual([]);
    // Personal arrangement never changes the shared layout.
    const la = (await snapshot(a)).entities.map((e) => [e.id, e.layout]);
    const lb = (await snapshot(b)).entities.map((e) => [e.id, e.layout]);
    expect(la).toEqual(lb);
    // Unknown preference keys are dropped.
    const res = await send('PUT', '/api/account/prefs', a, { evil: '<script>', camera: { x: 'NaN' } });
    expect(res.json().prefs.evil).toBeUndefined();
  });

  it('L13. removing a user does not delete infrastructure history', async () => {
    const admin = await signIn(app, 'admin', { username: 'boss' });
    const op = await signIn(app, 'operator', { username: 'olly' });
    const web = encodeURIComponent('docker:alpha:app/web');
    await send('PATCH', `/api/entities/${web}`, op, { displayName: 'Renamed by olly' });
    await send('POST', '/api/account/tasks', op, { title: 'Check backups', entityId: 'docker:alpha:app/web' });
    const before = { events: app.repo.listEvents({ limit: 500 }).length, entities: app.repo.listEntities(true).length, audit: app.repo.listAudit(500).length };
    const olly = app.repo.users.byUsername('olly')!;
    expect((await send('DELETE', `/api/users/${olly.id}`, admin)).statusCode).toBe(200);
    expect(app.repo.listEvents({ limit: 500 }).length).toBe(before.events);
    expect(app.repo.listEntities(true).length).toBe(before.entities);
    expect(app.repo.listAudit(500).length).toBe(before.audit + 1);
    expect(app.repo.listAudit(500).some((a: { actor: string; action: string }) => a.actor === 'olly' && a.action === 'entity.update')).toBe(true);
    expect(app.repo.getEntity('docker:alpha:app/web')!.displayName).toBe('Renamed by olly');
    // Their session and personal data are gone.
    expect((await get('/api/snapshot', op)).statusCode).toBe(401);
    expect(app.repo.db.prepare('SELECT COUNT(*) n FROM user_tasks WHERE user_id = ?').get(olly.id)).toEqual({ n: 0 });
    // The username can be reused, and the last administrator cannot be removed.
    expect(app.repo.users.byUsername('olly')).toBeUndefined();
    const boss = app.repo.users.byUsername('boss')!;
    expect((await send('DELETE', `/api/users/${boss.id}`, admin)).statusCode).toBe(409);
  });

  it('TOTP: enabling requires a valid code, login then needs a fresh code, replays are refused', async () => {
    const cookie = await signIn(app, 'viewer', { username: 'mfa-user' });
    const setup = (await send('POST', '/api/account/totp/setup', cookie, { password: 'a-long-test-password' })).json() as { secret: string };
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    const step = Math.floor(Date.now() / 30_000);
    expect((await send('POST', '/api/account/totp/enable', cookie, { code: '000000' === totpCode(setup.secret, step) ? '111111' : '000000' })).statusCode).toBe(400);
    expect((await send('POST', '/api/account/totp/enable', cookie, { code: totpCode(setup.secret, step) })).statusCode).toBe(200);
    // Stored encrypted, never as the plain seed.
    const raw = app.repo.db.prepare('SELECT totp_secret FROM users WHERE username = ?').get('mfa-user') as { totp_secret: string };
    expect(raw.totp_secret).not.toContain(setup.secret);
    const login = await send('POST', '/api/auth/login', undefined, { username: 'mfa-user', password: 'a-long-test-password' });
    expect(login.json().mfaRequired).toBe(true);
    const pending = cookieOf(login);
    expect((await get('/api/snapshot', pending)).statusCode).toBe(401);
    // The code already used to enable MFA cannot be replayed.
    expect((await send('POST', '/api/auth/mfa', pending, { code: totpCode(setup.secret, step) })).statusCode).toBe(401);
    const next = await send('POST', '/api/auth/mfa', pending, { code: totpCode(setup.secret, step + 1) });
    expect(next.statusCode).toBe(200);
    expect((await get('/api/snapshot', cookieOf(next))).statusCode).toBe(200);
  });

  it('invitations and password reset links are single-use and grant only what was set', async () => {
    const admin = await signIn(app, 'admin');
    const inv = (await send('POST', '/api/invitations', admin, { role: 'viewer', hostScope: 'list', hosts: ['host:beta'] })).json() as { token: string };
    expect((await get(`/api/invitations/${inv.token}`)).json().role).toBe('viewer');
    const accepted = await send('POST', `/api/invitations/${inv.token}/accept`, undefined, { username: 'newbie', displayName: 'New Bie', password: 'fresh-member-pass-1' });
    expect(accepted.statusCode).toBe(200);
    const ids = (await snapshot(cookieOf(accepted))).entities.map((e) => e.id);
    expect(ids).toContain('docker:beta:app/secret-app');
    expect(ids).not.toContain('docker:alpha:app/web');
    expect((await send('POST', `/api/invitations/${inv.token}/accept`, undefined, { username: 'second', displayName: 'Second', password: 'second-password-123' })).statusCode).toBe(404);
    expect((await send('POST', '/api/invitations', admin, { role: 'viewer', hostScope: 'list', hosts: ['host:nonexistent'] })).statusCode).toBe(400);

    const newbie = app.repo.users.byUsername('newbie')!;
    const reset = (await send('POST', `/api/users/${newbie.id}/reset`, admin)).json() as { token: string };
    expect((await send('POST', '/api/auth/reset', undefined, { token: reset.token, password: 'short' })).statusCode).toBe(400);
    expect((await send('POST', '/api/auth/reset', undefined, { token: reset.token, password: 'a-brand-new-password' })).statusCode).toBe(200);
    expect((await send('POST', '/api/auth/reset', undefined, { token: reset.token, password: 'another-new-password' })).statusCode).toBe(404);
    // Old sessions were ended by the reset.
    expect((await get('/api/snapshot', cookieOf(accepted))).statusCode).toBe(401);
    expect((await send('POST', '/api/auth/login', undefined, { username: 'newbie', password: 'a-brand-new-password' })).statusCode).toBe(200);
  });

  it('disabling a user or changing their access ends their sessions immediately', async () => {
    const admin = await signIn(app, 'admin');
    const v = await signIn(app, 'viewer', { username: 'victor' });
    expect((await get('/api/snapshot', v)).statusCode).toBe(200);
    const victor = app.repo.users.byUsername('victor')!;
    await send('PATCH', `/api/users/${victor.id}`, admin, { status: 'disabled' });
    expect((await get('/api/snapshot', v)).statusCode).toBe(401);
    expect((await send('POST', '/api/auth/login', undefined, { username: 'victor', password: 'a-long-test-password' })).statusCode).toBe(401);
  });

  it('cross-origin state changes are refused', async () => {
    const cookie = await signIn(app, 'operator');
    const res = await app.http.inject({ method: 'PATCH', url: `/api/entities/${encodeURIComponent('docker:alpha:app/web')}`, headers: { cookie, origin: 'https://evil.example', host: 'world.example' }, payload: { displayName: 'pwned' } });
    expect(res.statusCode).toBe(403);
  });
});
