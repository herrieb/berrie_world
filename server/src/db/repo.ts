import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  AdapterStatus, BlockView, BuildingType, Completeness, EntityKind, EntityView, EventType, Health,
  Lifecycle, Origin, Severity, WorldEvent,
} from '@berrie/shared';
import { BLOCK_PITCH } from '@berrie/shared';
import { migrate } from './migrations.js';
import { Users } from './users.js';
import { HostRegistry } from './hosts.js';

export interface EntityRow {
  id: string;
  kind: EntityKind;
  name: string;
  displayName: string | null;
  buildingType: BuildingType;
  parentId: string | null;
  hostId: string | null;
  origin: Origin;
  source: string;
  scope: string;
  lifecycle: Lifecycle;
  hostnames: string[];
  dependsOn: string[];
  meta: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string | null;
  missingSince: string | null;
  missingCount: number;
  removedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

export interface StatusRow {
  entityId: string;
  health: Health;
  lastKnownHealth: Health | null;
  reason: string | null;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  inventoryFailures: number;
  inventoryUncertain: boolean;
}

export interface LayoutRow { entityId: string; x: number; y: number; w: number; h: number; pinned: boolean }

export class OriginMismatchError extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

function rowToEntity(r: Raw): EntityRow {
  return {
    id: r.id, kind: r.kind, name: r.name, displayName: r.display_name, buildingType: r.building_type,
    parentId: r.parent_id, hostId: r.host_id, origin: r.origin, source: r.source, scope: r.scope,
    lifecycle: r.lifecycle, hostnames: JSON.parse(r.hostnames), dependsOn: JSON.parse(r.depends_on),
    meta: JSON.parse(r.meta), firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
    missingSince: r.missing_since, missingCount: r.missing_count, removedAt: r.removed_at,
    archivedAt: r.archived_at, updatedAt: r.updated_at,
  };
}

function rowToStatus(r: Raw): StatusRow {
  return {
    entityId: r.entity_id, health: r.health, lastKnownHealth: r.last_known_health, reason: r.reason,
    lastCheckAt: r.last_check_at, lastSuccessAt: r.last_success_at, lastChangeAt: r.last_change_at,
    consecutiveFailures: r.consecutive_failures, consecutiveSuccesses: r.consecutive_successes,
    inventoryFailures: r.inventory_failures, inventoryUncertain: !!r.inventory_uncertain,
  };
}

const ENTITY_COLS: Record<keyof Omit<EntityRow, 'id'>, string> = {
  kind: 'kind', name: 'name', displayName: 'display_name', buildingType: 'building_type', parentId: 'parent_id',
  hostId: 'host_id', origin: 'origin', source: 'source', scope: 'scope', lifecycle: 'lifecycle',
  hostnames: 'hostnames', dependsOn: 'depends_on', meta: 'meta', firstSeenAt: 'first_seen_at',
  lastSeenAt: 'last_seen_at', missingSince: 'missing_since', missingCount: 'missing_count',
  removedAt: 'removed_at', archivedAt: 'archived_at', updatedAt: 'updated_at',
};
const JSON_COLS = new Set(['hostnames', 'dependsOn', 'meta']);

const STATUS_COLS: Record<keyof Omit<StatusRow, 'entityId'>, string> = {
  health: 'health', lastKnownHealth: 'last_known_health', reason: 'reason', lastCheckAt: 'last_check_at',
  lastSuccessAt: 'last_success_at', lastChangeAt: 'last_change_at', consecutiveFailures: 'consecutive_failures',
  consecutiveSuccesses: 'consecutive_successes', inventoryFailures: 'inventory_failures',
  inventoryUncertain: 'inventory_uncertain',
};

/** Spacing between island centres, in tiles. An island grows at most 4 blocks from its centre, so 13 blocks keeps open water between neighbours. */
export const ISLAND_PITCH = 13 * BLOCK_PITCH;

/**
 * Pick a persistent origin for a new island: the nearest free slot on a grid, preferring the horizontal axis of the
 * isometric view (+x/-y) so islands line up left-to-right before stacking. Existing origins are never moved.
 */
export function islandSlot(existing: { x: number; y: number }[]): { x: number; y: number } {
  if (!existing.length) return { x: 0, y: 0 };
  const slots: { x: number; y: number; d: number }[] = [];
  for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) {
    const x = (i + j) * ISLAND_PITCH / 2 | 0, y = (j - i) * ISLAND_PITCH / 2 | 0;
    const sx = x - y, sy = (x + y) / 2;
    slots.push({ x: Math.round(x / BLOCK_PITCH) * BLOCK_PITCH, y: Math.round(y / BLOCK_PITCH) * BLOCK_PITCH, d: Math.hypot(sx, sy * 2.2) + (sx < 0 ? 0.5 : 0) });
  }
  slots.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);
  const clear = (s: { x: number; y: number }) => existing.every((e) => Math.max(Math.abs(e.x - s.x), Math.abs(e.y - s.y)) >= ISLAND_PITCH * 0.6);
  const s = slots.find(clear);
  return s ? { x: s.x, y: s.y } : { x: (existing.length + 1) * ISLAND_PITCH, y: -(existing.length + 1) * ISLAND_PITCH };
}

export function newId(): string {
  return `${Date.now().toString(36).padStart(9, '0')}-${randomBytes(5).toString('hex')}`;
}

export class Repo {
  readonly db: Database.Database;
  readonly users: Users;
  readonly hosts: HostRegistry;

  constructor(
    path: string,
    readonly mode: Origin,
    readonly clock: () => Date = () => new Date(),
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 3000');
    migrate(this.db);
    this.users = new Users(this.db, () => this.now());
    this.hosts = new HostRegistry(this.db, () => this.now());
    // A database belongs to exactly one mode; refuse to open the live DB in demo mode or vice versa.
    const stored = this.getSetting('origin');
    if (!stored) this.setSetting('origin', mode);
    else if (stored !== mode) throw new OriginMismatchError(`database at ${path} is a ${stored} database, not ${mode}`);
  }

  now(): string {
    return this.clock().toISOString();
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---------- settings ----------
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Raw;
    return r?.value ?? null;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------- entities ----------
  getEntity(id: string): EntityRow | undefined {
    const r = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    return r ? rowToEntity(r) : undefined;
  }

  listEntities(includeArchived = false): EntityRow[] {
    const sql = includeArchived ? 'SELECT * FROM entities' : "SELECT * FROM entities WHERE lifecycle != 'archived'";
    return (this.db.prepare(sql).all() as Raw[]).map(rowToEntity);
  }

  listArchived(limit = 200): EntityRow[] {
    return (this.db.prepare("SELECT * FROM entities WHERE lifecycle = 'archived' ORDER BY archived_at DESC LIMIT ?").all(limit) as Raw[]).map(rowToEntity);
  }

  listBySource(source: string, scope: string): EntityRow[] {
    return (this.db.prepare("SELECT * FROM entities WHERE source = ? AND scope = ? AND lifecycle != 'archived'").all(source, scope) as Raw[]).map(rowToEntity);
  }

  children(parentId: string): EntityRow[] {
    return (this.db.prepare("SELECT * FROM entities WHERE parent_id = ? AND lifecycle != 'archived'").all(parentId) as Raw[]).map(rowToEntity);
  }

  insertEntity(e: EntityRow): void {
    if (e.origin !== this.mode) throw new OriginMismatchError(`refusing to store ${e.origin} entity ${e.id} in ${this.mode} database`);
    const cols = ['id', ...Object.values(ENTITY_COLS)];
    const vals = [e.id, ...Object.keys(ENTITY_COLS).map((k) => {
      const v = e[k as keyof EntityRow];
      return JSON_COLS.has(k) ? JSON.stringify(v) : v;
    })];
    this.db.prepare(`INSERT INTO entities (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    this.db.prepare('INSERT INTO entity_status (entity_id) VALUES (?)').run(e.id);
  }

  updateEntity(id: string, patch: Partial<EntityRow>): void {
    if (patch.origin && patch.origin !== this.mode) throw new OriginMismatchError('origin change refused');
    const keys = Object.keys(patch).filter((k) => k !== 'id' && k in ENTITY_COLS) as (keyof typeof ENTITY_COLS)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${ENTITY_COLS[k]} = ?`);
    const vals = keys.map((k) => (JSON_COLS.has(k) ? JSON.stringify(patch[k]) : patch[k]));
    this.db.prepare(`UPDATE entities SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
  }

  // ---------- status ----------
  getStatus(id: string): StatusRow | undefined {
    const r = this.db.prepare('SELECT * FROM entity_status WHERE entity_id = ?').get(id);
    return r ? rowToStatus(r) : undefined;
  }

  updateStatus(id: string, patch: Partial<StatusRow>): void {
    const keys = Object.keys(patch).filter((k) => k in STATUS_COLS) as (keyof typeof STATUS_COLS)[];
    if (!keys.length) return;
    const vals = keys.map((k) => (k === 'inventoryUncertain' ? (patch[k] ? 1 : 0) : patch[k]));
    this.db.prepare(`UPDATE entity_status SET ${keys.map((k) => `${STATUS_COLS[k]} = ?`).join(', ')} WHERE entity_id = ?`).run(...vals, id);
  }

  // ---------- layout ----------
  getLayout(id: string): LayoutRow | undefined {
    const r = this.db.prepare('SELECT * FROM layout WHERE entity_id = ?').get(id) as Raw;
    return r ? { entityId: r.entity_id, x: r.x, y: r.y, w: r.w, h: r.h, pinned: !!r.pinned } : undefined;
  }
  listLayouts(): LayoutRow[] {
    return (this.db.prepare('SELECT * FROM layout').all() as Raw[]).map((r) => ({ entityId: r.entity_id, x: r.x, y: r.y, w: r.w, h: r.h, pinned: !!r.pinned }));
  }
  setLayout(l: LayoutRow): void {
    this.db.prepare(`INSERT INTO layout (entity_id, x, y, w, h, pinned, updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(entity_id) DO UPDATE SET x=excluded.x, y=excluded.y, w=excluded.w, h=excluded.h, pinned=excluded.pinned, updated_at=excluded.updated_at`)
      .run(l.entityId, l.x, l.y, l.w, l.h, l.pinned ? 1 : 0, this.now());
  }
  deleteLayout(id: string): void {
    this.db.prepare('DELETE FROM layout WHERE entity_id = ?').run(id);
  }

  /** District origin in tiles. Assigned once and persisted, so later changes never move buildings. */
  districtOrigin(key: string): { x: number; y: number } {
    const r = this.db.prepare('SELECT ox, oy FROM districts WHERE key = ?').get(key) as Raw;
    if (r) return { x: r.ox, y: r.oy };
    const idx = ((this.db.prepare('SELECT MAX(idx) m FROM districts').get() as Raw).m ?? -1) + 1;
    const existing = (this.db.prepare('SELECT ox, oy FROM districts').all() as Raw[]).map((d) => ({ x: d.ox as number, y: d.oy as number }));
    const o = islandSlot(existing);
    this.db.prepare('INSERT INTO districts (key, idx, ox, oy) VALUES (?, ?, ?, ?)').run(key, idx, o.x, o.y);
    return o;
  }
  listBlocksRaw(): { district: string; bx: number; by: number; groupKey: string }[] {
    return (this.db.prepare('SELECT * FROM blocks').all() as Raw[]).map((r) => ({ district: r.district, bx: r.bx, by: r.by, groupKey: r.group_key }));
  }
  claimBlock(district: string, bx: number, by: number, groupKey: string): void {
    this.db.prepare('INSERT INTO blocks (district, bx, by, group_key) VALUES (?,?,?,?)').run(district, bx, by, groupKey);
  }
  releaseEmptyBlocks(isEmpty: (district: string, bx: number, by: number) => boolean): void {
    for (const b of this.listBlocksRaw()) {
      if (isEmpty(b.district, b.bx, b.by)) this.db.prepare('DELETE FROM blocks WHERE district=? AND bx=? AND by=?').run(b.district, b.bx, b.by);
    }
  }
  blockViews(): BlockView[] {
    return this.listBlocksRaw().map((b) => {
      const o = this.districtOrigin(b.district);
      return { x: o.x + b.bx * BLOCK_PITCH, y: o.y + b.by * BLOCK_PITCH, size: BLOCK_PITCH, group: b.groupKey, district: b.district };
    });
  }

  // ---------- events ----------
  insertEvent(e: Omit<WorldEvent, 'id' | 'ts'> & { ts?: string }): WorldEvent {
    const ev: WorldEvent = { id: newId(), ts: e.ts ?? this.now(), ...e } as WorldEvent;
    this.db.prepare('INSERT INTO events (id, ts, type, entity_id, related_entity_id, severity, source, details) VALUES (?,?,?,?,?,?,?,?)')
      .run(ev.id, ev.ts, ev.type, ev.entityId, ev.relatedEntityId, ev.severity, ev.source, JSON.stringify(ev.details));
    return ev;
  }

  listEvents(opts: { limit?: number; entityId?: string; before?: string; types?: EventType[] } = {}): WorldEvent[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.entityId) { where.push('(entity_id = ? OR related_entity_id = ?)'); args.push(opts.entityId, opts.entityId); }
    if (opts.before) { where.push('ts < ?'); args.push(opts.before); }
    if (opts.types?.length) { where.push(`type IN (${opts.types.map(() => '?').join(',')})`); args.push(...opts.types); }
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(opts.limit ?? 50, 500)) as Raw[]).map((r) => ({
      id: r.id, ts: r.ts, type: r.type, entityId: r.entity_id, relatedEntityId: r.related_entity_id,
      severity: r.severity as Severity, source: r.source, details: JSON.parse(r.details),
    }));
  }

  // ---------- checks ----------
  insertCheckResult(r: { entityId: string; checkName: string; outcome: 'ok' | 'fail' | 'unknown'; latencyMs: number | null; statusCode: number | null; error: string | null }): void {
    this.db.prepare('INSERT INTO check_results (entity_id, check_name, ts, outcome, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)')
      .run(r.entityId, r.checkName, this.now(), r.outcome, r.latencyMs, r.statusCode, r.error);
  }
  checkHistory(entityId: string, limit = 100): Raw[] {
    return this.db.prepare('SELECT check_name, ts, outcome, latency_ms, status_code, error FROM check_results WHERE entity_id = ? ORDER BY ts DESC LIMIT ?').all(entityId, limit);
  }

  // ---------- adapters / observations ----------
  recordObservation(adapter: string, scope: string, completeness: Completeness, count: number, error: string | null): void {
    const now = this.now();
    this.db.prepare('INSERT INTO observations (adapter, scope, completeness, ts, entity_count, error) VALUES (?,?,?,?,?,?)').run(adapter, scope, completeness, now, count, error);
    this.db.prepare(`INSERT INTO adapter_state (adapter, scope, completeness, last_run_at, last_complete_at, error) VALUES (?,?,?,?,?,?)
      ON CONFLICT(adapter, scope) DO UPDATE SET completeness=excluded.completeness, last_run_at=excluded.last_run_at,
      last_complete_at=COALESCE(excluded.last_complete_at, adapter_state.last_complete_at), error=excluded.error`)
      .run(adapter, scope, completeness, now, completeness === 'complete' ? now : null, error);
  }
  getAdapterState(adapter: string, scope: string): AdapterStatus | undefined {
    const r = this.db.prepare('SELECT * FROM adapter_state WHERE adapter = ? AND scope = ?').get(adapter, scope) as Raw;
    return r ? { adapter: r.adapter, scope: r.scope, completeness: r.completeness, lastRunAt: r.last_run_at, lastCompleteAt: r.last_complete_at, error: r.error } : undefined;
  }
  listAdapterStates(): AdapterStatus[] {
    return (this.db.prepare('SELECT * FROM adapter_state ORDER BY adapter, scope').all() as Raw[]).map((r) => ({
      adapter: r.adapter, scope: r.scope, completeness: r.completeness, lastRunAt: r.last_run_at, lastCompleteAt: r.last_complete_at, error: r.error,
    }));
  }
  everConnected(): boolean {
    return !!this.db.prepare("SELECT 1 FROM adapter_state WHERE last_complete_at IS NOT NULL AND adapter != 'config' LIMIT 1").get();
  }

  // ---------- audit ----------
  audit(a: { actor: string; userId?: string | null; ip: string | null; action: string; entityId: string | null; params?: Record<string, unknown>; result: string }): void {
    this.db.prepare('INSERT INTO audit_log (ts, actor, user_id, ip, action, entity_id, params, result) VALUES (?,?,?,?,?,?,?,?)')
      .run(this.now(), a.actor, a.userId ?? null, a.ip, a.action, a.entityId, JSON.stringify(a.params ?? {}), a.result);
  }
  listAudit(limit = 100): Raw[] {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---------- retention ----------
  prune(r: { checkResultDays: number; eventDays: number; auditDays: number; archivedEntityDays: number | null }): Record<string, number> {
    const cutoff = (days: number) => new Date(this.clock().getTime() - days * 86400_000).toISOString();
    const out: Record<string, number> = {};
    out.checks = this.db.prepare('DELETE FROM check_results WHERE ts < ?').run(cutoff(r.checkResultDays)).changes;
    out.observations = this.db.prepare('DELETE FROM observations WHERE ts < ?').run(cutoff(r.checkResultDays)).changes;
    out.events = this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff(r.eventDays)).changes;
    out.audit = this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff(r.auditDays)).changes;
    if (r.archivedEntityDays !== null) {
      out.archived = this.db.prepare("DELETE FROM entities WHERE lifecycle = 'archived' AND archived_at < ?").run(cutoff(r.archivedEntityDays)).changes;
    }
    return out;
  }

  // ---------- views ----------
  toView(e: EntityRow, cache?: Map<string, EntityRow>): EntityView {
    const s = this.getStatus(e.id)!;
    const l = this.getLayout(e.id);
    const get = (id: string) => cache?.get(id) ?? this.getEntity(id);
    const host = e.hostId ? get(e.hostId) : undefined;
    const hostStatus = host && host.id !== e.id ? this.getStatus(host.id) : undefined;
    let health = s.health;
    let reason = s.reason;
    // A service with failing public endpoints is degraded even if its container is fine.
    if (e.kind === 'service' && health === 'healthy') {
      const bad = this.children(e.id).filter((c) => c.kind === 'endpoint' && c.lifecycle !== 'removed')
        .map((c) => ({ c, st: this.getStatus(c.id)! }))
        .filter(({ st }) => st.health === 'unreachable' || st.health === 'unhealthy');
      if (bad.length) {
        health = 'degraded';
        reason = `endpoint ${bad[0].c.name}: ${bad[0].st.reason ?? bad[0].st.health}`;
      }
    }
    return {
      id: e.id, kind: e.kind, name: e.name, displayName: e.displayName ?? e.name, buildingType: e.buildingType,
      parentId: e.parentId, hostId: e.hostId, origin: e.origin, lifecycle: e.lifecycle, health,
      lastKnownHealth: s.lastKnownHealth, healthReason: reason,
      inheritedHostOffline: hostStatus?.health === 'host_offline',
      inventoryUncertain: s.inventoryUncertain, hostnames: e.hostnames, dependsOn: e.dependsOn, meta: e.meta,
      firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt, missingSince: e.missingSince, removedAt: e.removedAt,
      archivedAt: e.archivedAt, lastCheckAt: s.lastCheckAt, lastSuccessAt: s.lastSuccessAt, lastChangeAt: s.lastChangeAt,
      layout: l ? { x: l.x, y: l.y, w: l.w, h: l.h, pinned: l.pinned } : null,
    };
  }

  views(includeArchived = false): EntityView[] {
    const all = this.listEntities(includeArchived);
    const cache = new Map(all.map((e) => [e.id, e]));
    return all.map((e) => this.toView(e, cache));
  }
}
