import type { Role } from '@berrie/shared';
import type { App } from '../src/app.js';
import { hashPassword } from '../src/core/secrets.js';

/** Create a user directly and sign in through the real login endpoint; returns the session cookie. */
export async function signIn(app: App, role: Role, opts: { username?: string; hostScope?: 'all' | 'list'; hosts?: string[] } = {}): Promise<string> {
  const username = opts.username ?? `${role}-${Math.random().toString(36).slice(2, 8)}`;
  app.repo.users.create({ username, displayName: username, passwordHash: await hashPassword('a-long-test-password'), role, hostScope: opts.hostScope ?? 'all', hosts: opts.hosts ?? [] });
  const res = await app.http.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'a-long-test-password' } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'bw_sid')!;
  return `bw_sid=${c.value}`;
}

