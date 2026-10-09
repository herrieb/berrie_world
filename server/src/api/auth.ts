import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Repo } from '../db/repo.js';

const COOKIE = 'bw_session';
const SESSION_HOURS = 12;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

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

export class Auth {
  private readonly secret: string;
  readonly loginLimiter = new RateLimiter(5, 60_000);

  constructor(private readonly cfg: AppConfig, repo: Repo) {
    let s = cfg.sessionSecret ?? repo.getSetting('session_secret');
    if (!s) { s = randomBytes(32).toString('hex'); repo.setSetting('session_secret', s); }
    this.secret = s;
  }

  get adminConfigured(): boolean {
    return !!this.cfg.adminToken;
  }

  private sign(v: string): string {
    return createHmac('sha256', this.secret).update(v).digest('base64url');
  }

  checkToken(token: unknown): boolean {
    return !!this.cfg.adminToken && typeof token === 'string' && token.length <= 512 && safeEqual(token, this.cfg.adminToken);
  }

  issue(reply: FastifyReply): void {
    const exp = String(Date.now() + SESSION_HOURS * 3600_000);
    reply.setCookie(COOKIE, `${exp}.${this.sign(exp)}`, {
      httpOnly: true, sameSite: 'strict', secure: this.cfg.secureCookies, path: '/', maxAge: SESSION_HOURS * 3600,
    });
  }

  clear(reply: FastifyReply): void {
    reply.clearCookie(COOKIE, { path: '/' });
  }

  isAdmin(req: FastifyRequest): boolean {
    if (!this.cfg.adminToken) return false;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ') && this.checkToken(h.slice(7))) return true;
    const c = req.cookies?.[COOKIE];
    if (!c) return false;
    const [exp, sig] = c.split('.');
    if (!exp || !sig || !safeEqual(sig, this.sign(exp))) return false;
    return Number(exp) > Date.now();
  }

  isIngest(req: FastifyRequest): boolean {
    const h = req.headers.authorization;
    return !!this.cfg.ingestToken && !!h?.startsWith('Bearer ') && safeEqual(h.slice(7), this.cfg.ingestToken);
  }
}
