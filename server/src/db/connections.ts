import type Database from 'better-sqlite3';
import type { ConnectionType, ConnectionView, Health, Lifecycle, Verification } from '@berrie/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export interface ConnectionRow extends ConnectionView {
  scope: string;
  missingSince: string | null;
  missingCount: number;
  removedAt: string | null;
  archivedAt: string | null;
}

const parse = <T,>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

function toRow(r: Raw): ConnectionRow {
  return {
    id: r.id, src: r.src, dst: r.dst, type: r.type as ConnectionType, source: r.source, scope: r.scope, verification: r.verification as Verification,
    lifecycle: r.lifecycle as Lifecycle, health: r.health as Health, reason: r.reason, evidence: parse(r.evidence, []), meta: parse(r.meta, {}),
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, lastActivityAt: r.last_activity_at, missingSince: r.missing_since,
    missingCount: r.missing_count, removedAt: r.removed_at, archivedAt: r.archived_at,
  };
}

const COLS: Record<string, string> = {
  src: 'src', dst: 'dst', type: 'type', source: 'source', scope: 'scope', verification: 'verification', lifecycle: 'lifecycle', health: 'health',
  reason: 'reason', evidence: 'evidence', meta: 'meta', lastSeenAt: 'last_seen_at', lastActivityAt: 'last_activity_at', missingSince: 'missing_since',
  missingCount: 'missing_count', removedAt: 'removed_at', archivedAt: 'archived_at',
};
const JSON_COLS = new Set(['evidence', 'meta']);

/** Relationships between entities: first-class records with lifecycle, verification and evidence. */
export class ConnectionStore {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  get(id: string): ConnectionRow | undefined {
    const r = this.db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
    return r ? toRow(r) : undefined;
  }
  list(includeArchived = false): ConnectionRow[] {
    const sql = includeArchived ? 'SELECT * FROM connections' : "SELECT * FROM connections WHERE lifecycle != 'archived'";
    return (this.db.prepare(sql).all() as Raw[]).map(toRow);
  }
  bySource(source: string, scope: string): ConnectionRow[] {
    return (this.db.prepare("SELECT * FROM connections WHERE source = ? AND scope = ? AND lifecycle != 'archived'").all(source, scope) as Raw[]).map(toRow);
  }
  touching(entityId: string): ConnectionRow[] {
    return (this.db.prepare("SELECT * FROM connections WHERE (src = ? OR dst = ?) AND lifecycle != 'archived'").all(entityId, entityId) as Raw[]).map(toRow);
  }
  insert(c: Omit<ConnectionRow, 'missingSince' | 'missingCount' | 'removedAt' | 'archivedAt' | 'firstSeenAt' | 'lastActivityAt'> & { lastActivityAt?: string | null }): void {
    const now = this.now();
    this.db.prepare(`INSERT INTO connections (id, src, dst, type, source, scope, verification, lifecycle, health, reason, evidence, meta, first_seen_at, last_seen_at, last_activity_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(c.id, c.src, c.dst, c.type, c.source, c.scope, c.verification, c.lifecycle, c.health, c.reason,
      JSON.stringify(c.evidence), JSON.stringify(c.meta), now, c.lastSeenAt, c.lastActivityAt ?? null, now);
  }
  update(id: string, patch: Partial<ConnectionRow>): void {
    const keys = Object.keys(patch).filter((k) => k in COLS && (patch as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return JSON_COLS.has(k) ? JSON.stringify(v) : v; });
    this.db.prepare(`UPDATE connections SET ${keys.map((k) => `${COLS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
  }

  static view(c: ConnectionRow): ConnectionView {
    const { scope: _s, missingSince: _m, missingCount: _c, removedAt: _r, archivedAt: _a, ...v } = c;
    return v;
  }
}
