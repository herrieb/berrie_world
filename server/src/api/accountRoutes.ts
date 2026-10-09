import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Avatar, Me, NotificationPrefs, Role, SavedView, Severity, UserPrefs } from '@berrie/shared';
import { ROLES } from '@berrie/shared';
import type { AppConfig } from '../config.js';
import type { Repo } from '../db/repo.js';
import { Users } from '../db/users.js';
import {
  hashPassword, newTotpSecret, otpauthUrl, passwordProblem, randomToken, sha256, verifyPassword, verifyTotp, type SecretBox,
} from '../core/secrets.js';
import type { Auth, Principal } from './auth.js';

const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;
const DISPLAY_NAME = /^[\p{L}\p{N} ._'()&+-]{1,60}$/u;
const SEVERITIES: Severity[] = ['info', 'notice', 'warning', 'critical'];
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 300 } } } as const;
const TOKEN = { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 10, maxLength: 100 } } } as const;

interface Ctx { cfg: AppConfig; repo: Repo; auth: Auth; box: SecretBox; knownHosts: () => string[] }

export function sanitizeAvatar(a: unknown): Avatar | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const seed = Number(o.seed), style = Number(o.style);
  const color = typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : null;
  if (!Number.isInteger(seed) || seed < 0 || seed > 1e9 || !Number.isInteger(style) || style < 0 || style > 7 || !color) return null;
  return { seed, style, color };
}

/** Whitelist personal preferences; unknown keys are dropped. */
export function sanitizePrefs(p: unknown): UserPrefs {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const out: UserPrefs = {};
  if (o.daylight === 'auto' || o.daylight === 'day' || o.daylight === 'night') out.daylight = o.daylight;
  if (o.labelDensity === 'less' || o.labelDensity === 'auto' || o.labelDensity === 'more') out.labelDensity = o.labelDensity;
  const cam = o.camera as Record<string, unknown> | undefined;
  if (cam && [cam.x, cam.y, cam.zoom].every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v as number) < 1e6)) {
    out.camera = { x: cam.x as number, y: cam.y as number, zoom: Math.max(0.3, Math.min(8, cam.zoom as number)) };
  }
  if (o.islandOffsets && typeof o.islandOffsets === 'object') {
    out.islandOffsets = {};
    for (const [k, v] of Object.entries(o.islandOffsets as Record<string, unknown>).slice(0, 200)) {
      const d = v as { dx?: unknown; dy?: unknown };
      if (k.length <= 200 && Number.isInteger(d?.dx) && Number.isInteger(d?.dy) && Math.abs(d.dx as number) <= 2000 && Math.abs(d.dy as number) <= 2000) {
        out.islandOffsets[k] = { dx: d.dx as number, dy: d.dy as number };
      }
    }
  }
  const n = o.notifications as Record<string, unknown> | undefined;
  if (n && typeof n === 'object') {
    out.notifications = {
      inApp: n.inApp !== false, browser: n.browser === true, favoritesOnly: n.favoritesOnly === true,
      minSeverity: SEVERITIES.includes(n.minSeverity as Severity) ? (n.minSeverity as Severity) : 'warning',
    } satisfies NotificationPrefs;
  }
  return out;
}

export async function registerAccountRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { cfg, repo, auth, box } = ctx;
  const users = repo.users;
  const audit = (req: FastifyRequest, p: Principal | null, action: string, result: string, params?: Record<string, unknown>, entityId: string | null = null) =>
    repo.audit({ ...auth.actor(p), ip: req.ip, action, entityId, params, result });
  const me = (req: FastifyRequest): Principal => auth.principal(req)!;
  const validHosts = (hosts: unknown): string[] | null => {
    if (!Array.isArray(hosts) || hosts.length > 200) return null;
    const known = new Set(ctx.knownHosts());
    return hosts.every((h) => typeof h === 'string' && known.has(h)) ? [...new Set(hosts as string[])] : null;
  };

  const meView = (req: FastifyRequest): Me => {
    const p = auth.principal(req);
    return {
      user: p ? Users.view(p.user) : null, setupRequired: auth.setupRequired, mfaPending: !!auth.pendingMfa(req),
      actionsEnabled: cfg.actionsEnabled,
    };
  };

  /** Response right after a session was issued (the request itself still carries no cookie). */
  const signedIn = (userId: string): Me => ({ user: Users.view(users.get(userId)!), setupRequired: false, mfaPending: false, actionsEnabled: cfg.actionsEnabled });

  const limited = (req: FastifyRequest, reply: FastifyReply, username?: string): boolean => {
    if (!auth.loginLimiter.allow(`login:${req.ip}`) || (username && !auth.userLimiter.allow(`user:${username.toLowerCase()}`))) {
      void reply.code(429).send({ error: 'too many attempts, wait a minute' });
      return true;
    }
    return false;
  };

  // ---------------------------------------------------------------- public: session lifecycle

  app.get('/api/auth/me', async (req) => meView(req));

  app.post('/api/auth/setup', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['bootstrapToken', 'username', 'displayName', 'password'], properties: {
      bootstrapToken: { type: 'string', maxLength: 512 }, username: { type: 'string', maxLength: 32 }, displayName: { type: 'string', maxLength: 60 }, password: { type: 'string', maxLength: 200 },
    } } },
  }, async (req, reply) => {
    const b = req.body as { bootstrapToken: string; username: string; displayName: string; password: string };
    if (limited(req, reply)) return;
    if (!auth.setupRequired) return reply.code(409).send({ error: 'setup has already been completed' });
    if (!cfg.adminToken) return reply.code(400).send({ error: 'set ADMIN_TOKEN on the server to create the first administrator' });
    if (!auth.checkBootstrapToken(b.bootstrapToken)) { audit(req, null, 'setup', 'rejected: bad bootstrap token'); return reply.code(401).send({ error: 'invalid bootstrap token' }); }
    if (!USERNAME.test(b.username)) return reply.code(400).send({ error: 'username: 3–32 letters, digits, dot, dash or underscore' });
    if (!DISPLAY_NAME.test(b.displayName.trim())) return reply.code(400).send({ error: 'invalid display name' });
    const pw = passwordProblem(b.password, b.username);
    if (pw) return reply.code(400).send({ error: pw });
    const u = users.create({ username: b.username, displayName: b.displayName.trim(), passwordHash: await hashPassword(b.password), role: 'admin', hostScope: 'all', hosts: [] });
    audit(req, { user: u, session: null }, 'setup', 'ok');
    users.update(u.id, { lastLoginAt: repo.now() });
    auth.issueSession(req, reply, u.id, false);
    return signedIn(u.id);
  });

  app.post('/api/auth/login', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const { username, password } = req.body as { username: string; password: string };
    if (limited(req, reply, username)) return;
    const u = users.byUsername(username);
    const ok = await verifyPassword(password, u && u.status === 'active' ? u.passwordHash : null);
    if (!u || !ok) {
      repo.audit({ actor: u?.username ?? 'anonymous', userId: u?.id ?? null, ip: req.ip, action: 'login', entityId: null, result: 'rejected' });
      return reply.code(401).send({ error: 'invalid username or password' });
    }
    auth.issueSession(req, reply, u.id, u.totpEnabled);
    if (!u.totpEnabled) users.update(u.id, { lastLoginAt: repo.now() });
    audit(req, { user: u, session: null }, 'login', u.totpEnabled ? 'password ok, awaiting MFA' : 'ok');
    return { mfaRequired: u.totpEnabled };
  });

  app.post('/api/auth/mfa', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const s = auth.pendingMfa(req);
    if (!s) return reply.code(401).send({ error: 'sign in with your password first' });
    const u = users.get(s.userId);
    if (!u || limited(req, reply, u.username)) return;
    const step = u.totpSecret ? verifyTotp(box.open(u.totpSecret, `totp:${u.id}`), (req.body as { code: string }).code.trim()) : null;
    if (step === null || (u.totpLastStep !== null && step <= u.totpLastStep)) {
      audit(req, { user: u, session: null }, 'login.mfa', 'rejected');
      return reply.code(401).send({ error: 'invalid code' });
    }
    users.update(u.id, { totpLastStep: step, lastLoginAt: repo.now() });
    // Replace the pending session with a full one (fresh token after privilege change).
    users.deleteSession(s.id);
    auth.issueSession(req, reply, u.id, false);
    audit(req, { user: u, session: null }, 'login.mfa', 'ok');
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const p = auth.principal(req);
    auth.endSession(req, reply);
    if (p) audit(req, p, 'logout', 'ok');
    return { ok: true };
  });

  // ---------------------------------------------------------------- public: invitations & resets

  app.get('/api/invitations/:token', { schema: { params: TOKEN } }, async (req, reply) => {
    if (limited(req, reply)) return;
    const inv = users.invitationByToken(sha256((req.params as { token: string }).token));
    if (!inv || inv.usedAt || inv.revokedAt || inv.expiresAt < repo.now()) return reply.code(404).send({ error: 'invitation is invalid or has expired' });
    return { role: inv.role, hostScope: inv.hostScope, hosts: inv.hosts, email: inv.email, expiresAt: inv.expiresAt };
  });

  app.post('/api/invitations/:token/accept', {
    schema: { params: TOKEN, body: { type: 'object', additionalProperties: false, required: ['username', 'displayName', 'password'], properties: {
      username: { type: 'string', maxLength: 32 }, displayName: { type: 'string', maxLength: 60 }, password: { type: 'string', maxLength: 200 },
    } } },
  }, async (req, reply) => {
    if (limited(req, reply)) return;
    const inv = users.invitationByToken(sha256((req.params as { token: string }).token));
    if (!inv || inv.usedAt || inv.revokedAt || inv.expiresAt < repo.now()) return reply.code(404).send({ error: 'invitation is invalid or has expired' });
    const b = req.body as { username: string; displayName: string; password: string };
    if (!USERNAME.test(b.username)) return reply.code(400).send({ error: 'username: 3–32 letters, digits, dot, dash or underscore' });
    if (users.byUsername(b.username)) return reply.code(409).send({ error: 'username is taken' });
    if (!DISPLAY_NAME.test(b.displayName.trim())) return reply.code(400).send({ error: 'invalid display name' });
    const pw = passwordProblem(b.password, b.username);
    if (pw) return reply.code(400).send({ error: pw });
    const hash = await hashPassword(b.password);
    let created: ReturnType<typeof users.create> | null = null;
    repo.tx(() => {
      // Re-check inside the transaction so an invitation can only be used once.
      const fresh = users.listInvitations().find((i) => i.id === inv.id);
      if (!fresh || fresh.usedAt || fresh.revokedAt) return;
      const known = new Set(ctx.knownHosts());
      created = users.create({ username: b.username, displayName: b.displayName.trim(), email: inv.email, passwordHash: hash, role: inv.role, hostScope: inv.hostScope, hosts: inv.hosts.filter((h) => known.has(h)) });
      users.markInvitationUsed(inv.id, created.id);
    });
    if (!created) return reply.code(409).send({ error: 'invitation was already used' });
    const u = created as ReturnType<typeof users.create>;
    audit(req, { user: u, session: null }, 'invitation.accept', 'ok', { invitation: inv.id, role: inv.role });
    users.update(u.id, { lastLoginAt: repo.now() });
    auth.issueSession(req, reply, u.id, false);
    return signedIn(u.id);
  });

  app.post('/api/auth/reset', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['token', 'password'], properties: { token: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    if (limited(req, reply)) return;
    const { token, password } = req.body as { token: string; password: string };
    const tokenHash = sha256(token);
    // Validate the password before consuming the token so a typo does not burn the link.
    const pending = repo.db.prepare('SELECT user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, repo.now()) as { user_id: string } | undefined;
    const target = pending ? users.get(pending.user_id) : undefined;
    if (!target || target.status !== 'active') return reply.code(404).send({ error: 'reset link is invalid or has expired' });
    const pw = passwordProblem(password, target.username);
    if (pw) return reply.code(400).send({ error: pw });
    const userId = users.consumeReset(tokenHash);
    if (!userId) return reply.code(404).send({ error: 'reset link is invalid or has expired' });
    users.update(userId, { passwordHash: await hashPassword(password) });
    users.deleteSessionsFor(userId);
    audit(req, { user: target, session: null }, 'password.reset', 'ok');
    return { ok: true };
  });

  // ---------------------------------------------------------------- account (any signed-in user)

  const anyone = auth.require('viewer');

  app.patch('/api/account', {
    preHandler: anyone,
    schema: { body: { type: 'object', additionalProperties: false, properties: { displayName: { type: 'string', maxLength: 60 }, email: { type: ['string', 'null'], maxLength: 200 }, avatar: { type: 'object' } } } },
  }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { displayName?: string; email?: string | null; avatar?: unknown };
    const patch: Parameters<typeof users.update>[1] = {};
    if (b.displayName !== undefined) {
      if (!DISPLAY_NAME.test(b.displayName.trim())) return reply.code(400).send({ error: 'invalid display name' });
      patch.displayName = b.displayName.trim();
    }
    if (b.email !== undefined) {
      if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return reply.code(400).send({ error: 'invalid email address' });
      patch.email = b.email || null;
    }
    if (b.avatar !== undefined) {
      const a = sanitizeAvatar(b.avatar);
      if (!a) return reply.code(400).send({ error: 'invalid avatar' });
      patch.avatar = a;
    }
    users.update(p.user.id, patch);
    return { user: Users.view(users.get(p.user.id)!) };
  });

  app.post('/api/account/password', {
    preHandler: anyone,
    schema: { body: { type: 'object', additionalProperties: false, required: ['current', 'next'], properties: { current: { type: 'string', maxLength: 200 }, next: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const p = me(req);
    const { current, next } = req.body as { current: string; next: string };
    if (limited(req, reply, p.user.username)) return;
    if (!(await verifyPassword(current, p.user.passwordHash))) { audit(req, p, 'password.change', 'rejected'); return reply.code(401).send({ error: 'current password is wrong' }); }
    const pw = passwordProblem(next, p.user.username);
    if (pw) return reply.code(400).send({ error: pw });
    users.update(p.user.id, { passwordHash: await hashPassword(next) });
    users.deleteSessionsFor(p.user.id, p.session?.id);
    audit(req, p, 'password.change', 'ok');
    return { ok: true };
  });

  app.post('/api/account/totp/setup', {
    preHandler: anyone,
    schema: { body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', maxLength: 200 } } } },
  }, async (req, reply) => {
    const p = me(req);
    if (limited(req, reply, p.user.username)) return;
    if (!(await verifyPassword((req.body as { password: string }).password, p.user.passwordHash))) return reply.code(401).send({ error: 'password is wrong' });
    if (p.user.totpEnabled) return reply.code(409).send({ error: 'two-factor authentication is already enabled' });
    const secret = newTotpSecret();
    users.update(p.user.id, { totpSecret: box.seal(secret, `totp:${p.user.id}`), totpEnabled: false, totpLastStep: null });
    // The secret is returned exactly once so it can be added to an authenticator app.
    return { secret, otpauthUrl: otpauthUrl(secret, p.user.username) };
  });

  app.post('/api/account/totp/enable', {
    preHandler: anyone,
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const p = me(req);
    if (limited(req, reply, p.user.username)) return;
    if (!p.user.totpSecret || p.user.totpEnabled) return reply.code(409).send({ error: 'start setup first' });
    const step = verifyTotp(box.open(p.user.totpSecret, `totp:${p.user.id}`), (req.body as { code: string }).code.trim());
    if (step === null) return reply.code(400).send({ error: 'invalid code — check the time on your device' });
    users.update(p.user.id, { totpEnabled: true, totpLastStep: step });
    audit(req, p, 'mfa.enable', 'ok');
    return { ok: true };
  });

  app.post('/api/account/totp/disable', {
    preHandler: anyone,
    schema: { body: { type: 'object', additionalProperties: false, required: ['password', 'code'], properties: { password: { type: 'string', maxLength: 200 }, code: { type: 'string', maxLength: 10 } } } },
  }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { password: string; code: string };
    if (limited(req, reply, p.user.username)) return;
    if (!p.user.totpEnabled || !p.user.totpSecret) return reply.code(409).send({ error: 'two-factor authentication is not enabled' });
    const pwOk = await verifyPassword(b.password, p.user.passwordHash);
    const step = verifyTotp(box.open(p.user.totpSecret, `totp:${p.user.id}`), b.code.trim());
    if (!pwOk || step === null) { audit(req, p, 'mfa.disable', 'rejected'); return reply.code(401).send({ error: 'password or code is wrong' }); }
    users.update(p.user.id, { totpEnabled: false, totpSecret: null, totpLastStep: null });
    audit(req, p, 'mfa.disable', 'ok');
    return { ok: true };
  });

  app.get('/api/account/sessions', { preHandler: anyone }, async (req) => {
    const p = me(req);
    // Session ids are hashes of the cookie; exposing a short prefix is enough to identify and revoke them.
    return { sessions: users.listSessions(p.user.id).map((s) => ({ id: s.id.slice(0, 16), current: s.id === p.session?.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent })) };
  });
  app.delete('/api/account/sessions/:id', { preHandler: anyone, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    const s = users.listSessions(p.user.id).find((x) => x.id.startsWith((req.params as { id: string }).id) && (req.params as { id: string }).id.length >= 16);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    users.deleteSession(s.id);
    audit(req, p, 'session.revoke', 'ok');
    return { ok: true };
  });

  app.get('/api/account/prefs', { preHandler: anyone }, async (req) => ({ prefs: users.getPrefs(me(req).user.id) }));
  app.put('/api/account/prefs', { preHandler: anyone, schema: { body: { type: 'object' } } }, async (req) => {
    const p = me(req);
    // Merge so independent UI parts (camera, notifications) do not overwrite each other.
    const merged = sanitizePrefs({ ...users.getPrefs(p.user.id), ...(req.body as object) });
    users.setPrefs(p.user.id, merged);
    return { prefs: merged };
  });

  app.get('/api/account/favorites', { preHandler: anyone }, async (req) => ({ favorites: users.favorites(me(req).user.id) }));
  app.put('/api/account/favorites/:id', { preHandler: anyone, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    const e = repo.getEntity((req.params as { id: string }).id);
    if (!e || !auth.canSee(p, e)) return reply.code(404).send({ error: 'unknown entity' });
    users.setFavorite(p.user.id, e.id, true);
    return { favorites: users.favorites(p.user.id) };
  });
  app.delete('/api/account/favorites/:id', { preHandler: anyone, schema: { params: ID } }, async (req) => {
    const p = me(req);
    users.setFavorite(p.user.id, (req.params as { id: string }).id, false);
    return { favorites: users.favorites(p.user.id) };
  });

  app.get('/api/account/views', { preHandler: anyone }, async (req) => ({ views: users.savedViews(me(req).user.id) }));
  app.post('/api/account/views', {
    preHandler: anyone,
    schema: { body: { type: 'object', additionalProperties: false, required: ['name', 'view'], properties: { name: { type: 'string', minLength: 1, maxLength: 60 }, view: { type: 'object' } } } },
  }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { name: string; view: Record<string, unknown> };
    if (users.savedViews(p.user.id).length >= 50) return reply.code(400).send({ error: 'too many saved views' });
    const f = (b.view.filters ?? {}) as Record<string, unknown>;
    const str = (v: unknown, d: string) => (typeof v === 'string' && v.length <= 100 ? v : d);
    const view: SavedView['view'] = { filters: { text: str(f.text, ''), health: str(f.health, 'all'), type: str(f.type, 'all'), host: str(f.host, 'all') } };
    const cam = sanitizePrefs({ camera: b.view.camera }).camera;
    if (cam) view.camera = cam;
    return { view: users.addSavedView(p.user.id, b.name.trim(), view) };
  });
  app.delete('/api/account/views/:id', { preHandler: anyone, schema: { params: ID } }, async (req, reply) => {
    if (!users.deleteSavedView(me(req).user.id, (req.params as { id: string }).id)) return reply.code(404).send({ error: 'unknown view' });
    return { ok: true };
  });

  const TASK_BODY = { type: 'object', additionalProperties: false, properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 }, notes: { type: ['string', 'null'], maxLength: 2000 },
    entityId: { type: ['string', 'null'], maxLength: 300 }, dueAt: { type: ['string', 'null'], maxLength: 40 }, done: { type: 'boolean' },
  } } as const;
  const validDue = (d: string | null | undefined) => d === undefined || d === null || !Number.isNaN(Date.parse(d));
  app.get('/api/account/tasks', { preHandler: anyone }, async (req) => ({ tasks: users.tasks(me(req).user.id) }));
  app.post('/api/account/tasks', { preHandler: anyone, schema: { body: { ...TASK_BODY, required: ['title'] } } }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { title: string; notes?: string | null; entityId?: string | null; dueAt?: string | null };
    if (!validDue(b.dueAt)) return reply.code(400).send({ error: 'invalid due date' });
    if (b.entityId) { const e = repo.getEntity(b.entityId); if (!e || !auth.canSee(p, e)) return reply.code(400).send({ error: 'unknown entity' }); }
    if (users.tasks(p.user.id).length >= 500) return reply.code(400).send({ error: 'too many tasks' });
    return { task: users.addTask(p.user.id, { ...b, title: b.title.trim() }) };
  });
  app.patch('/api/account/tasks/:id', { preHandler: anyone, schema: { params: ID, body: TASK_BODY } }, async (req, reply) => {
    const b = req.body as { title?: string; notes?: string | null; dueAt?: string | null; done?: boolean };
    if (!validDue(b.dueAt)) return reply.code(400).send({ error: 'invalid due date' });
    if (!users.updateTask(me(req).user.id, (req.params as { id: string }).id, b)) return reply.code(404).send({ error: 'unknown task' });
    return { ok: true };
  });
  app.delete('/api/account/tasks/:id', { preHandler: anyone, schema: { params: ID } }, async (req, reply) => {
    if (!users.deleteTask(me(req).user.id, (req.params as { id: string }).id)) return reply.code(404).send({ error: 'unknown task' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- user management (administrators)

  const admin = auth.require('admin');

  app.get('/api/users', { preHandler: admin }, async () => ({ users: users.list().map(Users.view), knownHosts: ctx.knownHosts() }));

  app.patch('/api/users/:id', {
    preHandler: admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, properties: {
      role: { type: 'string', enum: ROLES }, hostScope: { type: 'string', enum: ['all', 'list'] }, hosts: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 300 } },
      status: { type: 'string', enum: ['active', 'disabled'] }, displayName: { type: 'string', maxLength: 60 },
    } } },
  }, async (req, reply) => {
    const p = me(req);
    const id = (req.params as { id: string }).id;
    const target = users.get(id);
    if (!target || target.status === 'deleted') return reply.code(404).send({ error: 'unknown user' });
    const b = req.body as { role?: Role; hostScope?: 'all' | 'list'; hosts?: string[]; status?: 'active' | 'disabled'; displayName?: string };
    const losesAdmin = target.role === 'admin' && target.status === 'active' && ((b.role && b.role !== 'admin') || b.status === 'disabled');
    if (losesAdmin && users.countActiveAdmins() <= 1) return reply.code(409).send({ error: 'cannot remove the last active administrator' });
    if (b.displayName !== undefined && !DISPLAY_NAME.test(b.displayName.trim())) return reply.code(400).send({ error: 'invalid display name' });
    let hosts: string[] | null = null;
    if (b.hosts !== undefined) { hosts = validHosts(b.hosts); if (!hosts) return reply.code(400).send({ error: 'unknown server in host list' }); }
    repo.tx(() => {
      users.update(id, { role: b.role, hostScope: b.hostScope, status: b.status, displayName: b.displayName?.trim() });
      if (hosts) users.setHosts(id, hosts);
      if (b.status === 'disabled' || b.role || b.hostScope || hosts) users.deleteSessionsFor(id, id === p.user.id ? p.session?.id : undefined);
    });
    audit(req, p, 'user.update', 'ok', { target: target.username, ...b });
    return { user: Users.view(users.get(id)!) };
  });

  app.delete('/api/users/:id', { preHandler: admin, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    const id = (req.params as { id: string }).id;
    const target = users.get(id);
    if (!target || target.status === 'deleted') return reply.code(404).send({ error: 'unknown user' });
    if (target.id === p.user.id) return reply.code(409).send({ error: 'you cannot remove your own account' });
    if (target.role === 'admin' && target.status === 'active' && users.countActiveAdmins() <= 1) return reply.code(409).send({ error: 'cannot remove the last active administrator' });
    users.remove(id);
    audit(req, p, 'user.remove', 'ok', { target: target.username });
    return { ok: true };
  });

  app.post('/api/users/:id/reset', { preHandler: admin, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    const target = users.get((req.params as { id: string }).id);
    if (!target || target.status !== 'active') return reply.code(404).send({ error: 'unknown or inactive user' });
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    users.createReset(sha256(token), target.id, p.user.id, expiresAt);
    audit(req, p, 'password.reset_link', 'ok', { target: target.username });
    // Shown once to the administrator, who passes it on out of band.
    return { token, expiresAt };
  });

  app.post('/api/users/:id/mfa-reset', { preHandler: admin, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    const target = users.get((req.params as { id: string }).id);
    if (!target || target.status === 'deleted') return reply.code(404).send({ error: 'unknown user' });
    users.update(target.id, { totpEnabled: false, totpSecret: null, totpLastStep: null });
    users.deleteSessionsFor(target.id);
    audit(req, p, 'mfa.reset', 'ok', { target: target.username });
    return { ok: true };
  });

  app.get('/api/invitations', { preHandler: admin }, async () => ({
    invitations: users.listInvitations().map((i) => ({ ...i, usedBy: i.usedBy ? users.get(i.usedBy)?.username ?? null : null, createdBy: users.get(i.createdBy)?.username ?? i.createdBy })),
  }));

  app.post('/api/invitations', {
    preHandler: admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['role'], properties: {
      role: { type: 'string', enum: ROLES }, hostScope: { type: 'string', enum: ['all', 'list'] }, hosts: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 300 } },
      email: { type: ['string', 'null'], maxLength: 200 }, note: { type: ['string', 'null'], maxLength: 200 }, days: { type: 'integer', minimum: 1, maximum: 30 },
    } } },
  }, async (req, reply) => {
    const p = me(req);
    const b = req.body as { role: Role; hostScope?: 'all' | 'list'; hosts?: string[]; email?: string | null; note?: string | null; days?: number };
    const hosts = validHosts(b.hosts ?? []);
    if (!hosts) return reply.code(400).send({ error: 'unknown server in host list' });
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return reply.code(400).send({ error: 'invalid email address' });
    const token = randomToken(24);
    const inv = users.createInvitation(sha256(token), {
      role: b.role, hostScope: b.role === 'admin' ? 'all' : b.hostScope ?? 'all', hosts, email: b.email ?? null, note: b.note ?? null,
      createdBy: p.user.id, expiresAt: new Date(Date.now() + (b.days ?? 7) * 86400_000).toISOString(),
    });
    audit(req, p, 'invitation.create', 'ok', { role: b.role, hostScope: inv.hostScope, hosts });
    return { invitation: inv, token };
  });

  app.delete('/api/invitations/:id', { preHandler: admin, schema: { params: ID } }, async (req, reply) => {
    const p = me(req);
    if (!users.revokeInvitation((req.params as { id: string }).id)) return reply.code(404).send({ error: 'invitation not found or already used' });
    audit(req, p, 'invitation.revoke', 'ok');
    return { ok: true };
  });
}
