import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@berrie/shared';
import { ROLE_RANK } from '@berrie/shared';
import type { AppConfig } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { SessionRow, UserRow } from '../db/users.js';
import { randomToken, safeEqual, sha256 } from '../core/secrets.js';

const COOKIE = 'bw_sid';

/** Fixed-window in-memory rate limiter keyed by IP + bucket. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
}

export interface Principal {
  user: UserRow;
  session: SessionRow | null;
}

/** Anything that belongs to a server: entities, events, adapters. `hostId` null = not tied to a server. */
export interface HostScoped { hostId: string | null }

export class Auth {
  readonly loginLimiter = new RateLimiter(10, 60_000);
  readonly userLimiter = new RateLimiter(10, 15 * 60_000);
  private cache = new WeakMap<FastifyRequest, { full: Principal | null; pending: SessionRow | null }>();

  constructor(private readonly cfg: AppConfig, private readonly repo: Repo) {}

  get users() {
    return this.repo.users;
  }

  get setupRequired(): boolean {
    return this.users.count() === 0;
  }

  /** The bootstrap token (ADMIN_TOKEN) is only used to create the first administrator. */
  checkBootstrapToken(token: unknown): boolean {
    return !!this.cfg.adminToken && typeof token === 'string' && token.length <= 512 && safeEqual(token, this.cfg.adminToken);
  }

  // ---------------------------------------------------------------- sessions

  issueSession(req: FastifyRequest, reply: FastifyReply, userId: string, mfaPending: boolean): void {
    const token = randomToken(32);
    const now = Date.now();
    this.users.createSession({
      id: sha256(token), userId, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (mfaPending ? 10 * 60_000 : this.cfg.session.maxDays * 86400_000)).toISOString(),
      lastSeenAt: new Date(now).toISOString(), ip: req.ip ?? null, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200), mfaPending,
    });
    reply.setCookie(COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: this.cfg.secureCookies, path: '/',
      maxAge: mfaPending ? 600 : this.cfg.session.maxDays * 86400,
    });
    this.cache.delete(req);
  }

  endSession(req: FastifyRequest, reply: FastifyReply): void {
    const s = this.sessionFromCookie(req);
    if (s) this.users.deleteSession(s.id);
    reply.clearCookie(COOKIE, { path: '/' });
    this.cache.delete(req);
  }

  private sessionFromCookie(req: FastifyRequest): SessionRow | null {
    const token = req.cookies?.[COOKIE];
    if (!token || token.length > 100) return null;
    const s = this.users.getSession(sha256(token));
    if (!s) return null;
    const now = Date.now();
    const idleLimit = now - this.cfg.session.idleHours * 3600_000;
    if (Date.parse(s.expiresAt) < now || Date.parse(s.lastSeenAt) < idleLimit) {
      this.users.deleteSession(s.id);
      return null;
    }
    if (now - Date.parse(s.lastSeenAt) > 60_000) this.users.touchSession(s.id, new Date(now).toISOString());
    return s;
  }

  private resolve(req: FastifyRequest): { full: Principal | null; pending: SessionRow | null } {
    const hit = this.cache.get(req);
    if (hit) return hit;
    let out: { full: Principal | null; pending: SessionRow | null } = { full: null, pending: null };
    const s = this.sessionFromCookie(req);
    if (s) {
      const user = this.users.get(s.userId);
      if (user && user.status === 'active') out = s.mfaPending ? { full: null, pending: s } : { full: { user, session: s }, pending: null };
      else this.users.deleteSession(s.id);
    }
    this.cache.set(req, out);
    return out;
  }

  /** Signed-in user with completed MFA, or null. */
  principal(req: FastifyRequest): Principal | null {
    return this.resolve(req).full;
  }

  /** Session that has passed the password step but still needs a TOTP code. */
  pendingMfa(req: FastifyRequest): SessionRow | null {
    return this.resolve(req).pending;
  }

  /** Re-check a long-lived principal (WebSocket) against the database. */
  stillValid(p: Principal): Principal | null {
    if (!p.session) return null;
    const s = this.users.getSession(p.session.id);
    if (!s || s.mfaPending || Date.parse(s.expiresAt) < Date.now()) return null;
    const user = this.users.get(s.userId);
    return user && user.status === 'active' ? { user, session: s } : null;
  }

  // ---------------------------------------------------------------- authorization

  hasRole(p: Principal | null, role: Role): boolean {
    return !!p && ROLE_RANK[p.user.role] >= ROLE_RANK[role];
  }

  /** Per-server access. Administrators and 'all'-scope users see every server. */
  canHost(p: Principal | null, hostId: string | null): boolean {
    if (!p) return false;
    if (hostId === null) return true;
    if (p.user.role === 'admin' || p.user.hostScope === 'all') return true;
    return p.user.hosts.includes(hostId);
  }

  /** True for administrators and users whose access is not limited to a server list. */
  seesAllHosts(p: Principal | null): boolean {
    return !!p && (p.user.role === 'admin' || p.user.hostScope === 'all');
  }

  canSee(p: Principal | null, e: HostScoped): boolean {
    return this.canHost(p, e.hostId);
  }

  /** Fastify preHandler: require a signed-in user with at least `role`. */
  require(role: Role) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const p = this.principal(req);
      if (!p) return reply.code(401).send({ error: 'authentication required' });
      if (!this.hasRole(p, role)) return reply.code(403).send({ error: `requires ${role} role` });
    };
  }

  isIngest(req: FastifyRequest): boolean {
    const h = req.headers.authorization;
    return !!this.cfg.ingestToken && !!h?.startsWith('Bearer ') && safeEqual(h.slice(7), this.cfg.ingestToken);
  }

  /** Actor string for audit records. */
  actor(p: Principal | null): { actor: string; userId: string | null } {
    return p ? { actor: p.user.username, userId: p.user.id } : { actor: 'anonymous', userId: null };
  }
}
