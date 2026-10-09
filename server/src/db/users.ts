import type Database from 'better-sqlite3';
import type { Avatar, Role, SavedView, UserPrefs, UserTask, UserView } from '@berrie/shared';
import { newId } from './repo.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export interface UserRow extends UserView {
  passwordHash: string | null;
  totpSecret: string | null;
  totpLastStep: number | null;
}

export interface SessionRow {
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
  mfaPending: boolean;
}

export interface InvitationRow {
  id: string;
  role: Role;
  hostScope: 'all' | 'list';
  hosts: string[];
  email: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedBy: string | null;
  revokedAt: string | null;
}

const parse = <T,>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

/** Accounts, sessions and personal state. Separate from infrastructure state by design. */
export class Users {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  private toUser(r: Raw): UserRow {
    const hosts = (this.db.prepare('SELECT host_id FROM user_hosts WHERE user_id = ? ORDER BY host_id').all(r.id) as Raw[]).map((h) => h.host_id as string);
    return {
      id: r.id, username: r.username, displayName: r.display_name, email: r.email, role: r.role, hostScope: r.host_scope, hosts,
      status: r.status, totpEnabled: !!r.totp_enabled, avatar: parse<Avatar | null>(r.avatar, null), createdAt: r.created_at,
      lastLoginAt: r.last_login_at, passwordHash: r.password_hash, totpSecret: r.totp_secret, totpLastStep: r.totp_last_step,
    };
  }

  static view(u: UserRow): UserView {
    const { passwordHash: _p, totpSecret: _t, totpLastStep: _s, ...v } = u;
    return v;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM users WHERE status != 'deleted'").get() as Raw).n;
  }
  countActiveAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM users WHERE status = 'active' AND role = 'admin'").get() as Raw).n;
  }

  get(id: string): UserRow | undefined {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return r ? this.toUser(r) : undefined;
  }
  byUsername(username: string): UserRow | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ? AND status != 'deleted'").get(username);
    return r ? this.toUser(r) : undefined;
  }
  list(): UserRow[] {
    return (this.db.prepare("SELECT * FROM users WHERE status != 'deleted' ORDER BY username").all() as Raw[]).map((r) => this.toUser(r));
  }

  create(u: { username: string; displayName: string; email?: string | null; passwordHash: string; role: Role; hostScope: 'all' | 'list'; hosts: string[]; avatar?: Avatar | null }): UserRow {
    const id = newId();
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, host_scope, avatar, created_at, updated_at, password_changed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, u.username, u.displayName, u.email ?? null, u.passwordHash, u.role, u.hostScope,
        JSON.stringify(u.avatar ?? { seed: Math.floor(Math.random() * 1e6), color: '#4aa8ff', style: 0 }), now, now, now);
      this.setHosts(id, u.hosts);
    })();
    return this.get(id)!;
  }

  update(id: string, patch: Partial<{ displayName: string; email: string | null; role: Role; hostScope: 'all' | 'list'; status: UserView['status']; avatar: Avatar; passwordHash: string | null; totpSecret: string | null; totpEnabled: boolean; totpLastStep: number | null; lastLoginAt: string }>): void {
    const map: Record<string, string> = {
      displayName: 'display_name', email: 'email', role: 'role', hostScope: 'host_scope', status: 'status', avatar: 'avatar',
      passwordHash: 'password_hash', totpSecret: 'totp_secret', totpEnabled: 'totp_enabled', totpLastStep: 'totp_last_step', lastLoginAt: 'last_login_at',
    };
    const keys = Object.keys(patch).filter((k) => k in map && (patch as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => {
      const v = (patch as Record<string, unknown>)[k];
      if (k === 'avatar') return JSON.stringify(v);
      if (k === 'totpEnabled') return v ? 1 : 0;
      return v;
    });
    const extra = keys.includes('passwordHash') ? ', password_changed_at = ?' : '';
    const extraVals = keys.includes('passwordHash') ? [this.now()] : [];
    this.db.prepare(`UPDATE users SET ${keys.map((k) => `${map[k]} = ?`).join(', ')}, updated_at = ?${extra} WHERE id = ?`).run(...vals, this.now(), ...extraVals, id);
  }

  setHosts(id: string, hosts: string[]): void {
    this.db.prepare('DELETE FROM user_hosts WHERE user_id = ?').run(id);
    const ins = this.db.prepare('INSERT OR IGNORE INTO user_hosts (user_id, host_id) VALUES (?, ?)');
    for (const h of hosts) ins.run(id, h);
  }

  /**
   * Remove a person. Their account becomes an inert tombstone (so audit entries keep a readable actor) and all
   * personal state is deleted. Shared infrastructure history (events, audit, incidents) is never touched.
   */
  remove(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE users SET status = 'deleted', password_hash = NULL, totp_secret = NULL, totp_enabled = 0, email = NULL,
        username = username || '#deleted-' || id, updated_at = ? WHERE id = ?`).run(this.now(), id);
      for (const t of ['sessions', 'user_hosts', 'user_prefs', 'favorites', 'saved_views', 'user_tasks', 'password_resets']) {
        this.db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
      }
    })();
  }

  // ---------- sessions ----------
  createSession(s: SessionRow): void {
    this.db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent, mfa_pending) VALUES (?,?,?,?,?,?,?,?)')
      .run(s.id, s.userId, s.createdAt, s.expiresAt, s.lastSeenAt, s.ip, s.userAgent, s.mfaPending ? 1 : 0);
  }
  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Raw;
    return r ? { id: r.id, userId: r.user_id, createdAt: r.created_at, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent, mfaPending: !!r.mfa_pending } : undefined;
  }
  touchSession(id: string, at: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id);
  }
  completeMfa(id: string): void {
    this.db.prepare('UPDATE sessions SET mfa_pending = 0 WHERE id = ?').run(id);
  }
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
  deleteSessionsFor(userId: string, exceptId?: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId ?? '');
  }
  listSessions(userId: string): SessionRow[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId) as Raw[]).map((r) => ({
      id: r.id, userId: r.user_id, createdAt: r.created_at, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at, ip: r.ip, userAgent: r.user_agent, mfaPending: !!r.mfa_pending,
    }));
  }
  pruneSessions(now: string, idleBefore: string): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?').run(now, idleBefore).changes;
  }

  // ---------- invitations ----------
  createInvitation(tokenHash: string, inv: Omit<InvitationRow, 'id' | 'createdAt' | 'usedAt' | 'usedBy' | 'revokedAt'>): InvitationRow {
    const id = newId();
    this.db.prepare('INSERT INTO invitations (id, token_hash, role, host_scope, hosts, email, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, tokenHash, inv.role, inv.hostScope, JSON.stringify(inv.hosts), inv.email, inv.note, inv.createdBy, this.now(), inv.expiresAt);
    return this.listInvitations().find((i) => i.id === id)!;
  }
  private toInvitation(r: Raw): InvitationRow {
    return { id: r.id, role: r.role, hostScope: r.host_scope, hosts: parse(r.hosts, []), email: r.email, note: r.note, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by, revokedAt: r.revoked_at };
  }
  invitationByToken(tokenHash: string): InvitationRow | undefined {
    const r = this.db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(tokenHash);
    return r ? this.toInvitation(r) : undefined;
  }
  listInvitations(): InvitationRow[] {
    return (this.db.prepare('SELECT * FROM invitations ORDER BY created_at DESC LIMIT 100').all() as Raw[]).map((r) => this.toInvitation(r));
  }
  markInvitationUsed(id: string, userId: string): boolean {
    return this.db.prepare('UPDATE invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(this.now(), userId, id).changes === 1;
  }
  revokeInvitation(id: string): boolean {
    return this.db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(this.now(), id).changes === 1;
  }

  // ---------- password resets ----------
  createReset(tokenHash: string, userId: string, createdBy: string, expiresAt: string): void {
    this.db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(userId);
    this.db.prepare('INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)').run(tokenHash, userId, createdBy, this.now(), expiresAt);
  }
  /** Atomically consume a reset token. Returns the user id if it was valid. */
  consumeReset(tokenHash: string): string | null {
    const r = this.db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(tokenHash) as Raw;
    if (!r || r.used_at || r.expires_at < this.now()) return null;
    const ok = this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(this.now(), tokenHash).changes === 1;
    return ok ? r.user_id : null;
  }

  // ---------- personal state ----------
  getPrefs(userId: string): UserPrefs {
    const r = this.db.prepare('SELECT prefs FROM user_prefs WHERE user_id = ?').get(userId) as Raw;
    return parse<UserPrefs>(r?.prefs ?? null, {});
  }
  setPrefs(userId: string, prefs: UserPrefs): void {
    this.db.prepare('INSERT INTO user_prefs (user_id, prefs, updated_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify(prefs), this.now());
  }

  favorites(userId: string): string[] {
    return (this.db.prepare('SELECT entity_id FROM favorites WHERE user_id = ? ORDER BY created_at').all(userId) as Raw[]).map((r) => r.entity_id);
  }
  setFavorite(userId: string, entityId: string, on: boolean): void {
    if (on) this.db.prepare('INSERT OR IGNORE INTO favorites (user_id, entity_id, created_at) VALUES (?,?,?)').run(userId, entityId, this.now());
    else this.db.prepare('DELETE FROM favorites WHERE user_id = ? AND entity_id = ?').run(userId, entityId);
  }

  savedViews(userId: string): SavedView[] {
    return (this.db.prepare('SELECT * FROM saved_views WHERE user_id = ? ORDER BY created_at').all(userId) as Raw[]).map((r) => ({ id: r.id, name: r.name, view: parse(r.view, { filters: { text: '', health: 'all', type: 'all', host: 'all' } }), createdAt: r.created_at }));
  }
  addSavedView(userId: string, name: string, view: SavedView['view']): SavedView {
    const id = newId();
    this.db.prepare('INSERT INTO saved_views (id, user_id, name, view, created_at) VALUES (?,?,?,?,?)').run(id, userId, name, JSON.stringify(view), this.now());
    return this.savedViews(userId).find((v) => v.id === id)!;
  }
  deleteSavedView(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM saved_views WHERE id = ? AND user_id = ?').run(id, userId).changes === 1;
  }

  tasks(userId: string): UserTask[] {
    return (this.db.prepare('SELECT * FROM user_tasks WHERE user_id = ? ORDER BY done_at IS NOT NULL, COALESCE(due_at, created_at)').all(userId) as Raw[]).map((r) => ({
      id: r.id, title: r.title, notes: r.notes, entityId: r.entity_id, dueAt: r.due_at, doneAt: r.done_at, createdAt: r.created_at,
    }));
  }
  addTask(userId: string, t: { title: string; notes?: string | null; entityId?: string | null; dueAt?: string | null }): UserTask {
    const id = newId();
    this.db.prepare('INSERT INTO user_tasks (id, user_id, title, notes, entity_id, due_at, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, t.title, t.notes ?? null, t.entityId ?? null, t.dueAt ?? null, this.now());
    return this.tasks(userId).find((x) => x.id === id)!;
  }
  updateTask(userId: string, id: string, patch: { title?: string; notes?: string | null; dueAt?: string | null; done?: boolean }): boolean {
    const cur = this.tasks(userId).find((t) => t.id === id);
    if (!cur) return false;
    this.db.prepare('UPDATE user_tasks SET title = ?, notes = ?, due_at = ?, done_at = ? WHERE id = ? AND user_id = ?').run(
      patch.title ?? cur.title, patch.notes !== undefined ? patch.notes : cur.notes, patch.dueAt !== undefined ? patch.dueAt : cur.dueAt,
      patch.done === undefined ? cur.doneAt : patch.done ? this.now() : null, id, userId);
    return true;
  }
  deleteTask(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM user_tasks WHERE id = ? AND user_id = ?').run(id, userId).changes === 1;
  }
}
