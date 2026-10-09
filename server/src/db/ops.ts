import type Database from 'better-sqlite3';
import type { AlertAck, IncidentStatus, IncidentView, MaintenanceWindow, NotificationView, Severity, TimelineEntry } from '@berrie/shared';
import { newId } from './repo.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;
const parse = <T,>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export interface IncidentRow {
  id: string; title: string; status: IncidentStatus; severity: Severity; rootEntityId: string | null;
  hypothesis: string | null; hypothesisEntityId: string | null; hypothesisVerified: boolean; assignee: string | null;
  createdBy: string; openedAt: string; recoveredAt: string | null; resolvedAt: string | null; resolvedBy: string | null;
}

/** Shared operational records: incidents and their timelines, alert acknowledgements, maintenance, notifications. */
export class OpsStore {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  // ---------- incidents ----------
  private toIncident(r: Raw): IncidentRow {
    return {
      id: r.id, title: r.title, status: r.status, severity: r.severity, rootEntityId: r.root_entity_id, hypothesis: r.hypothesis,
      hypothesisEntityId: r.hypothesis_entity_id, hypothesisVerified: !!r.hypothesis_verified, assignee: r.assignee, createdBy: r.created_by,
      openedAt: r.opened_at, recoveredAt: r.recovered_at, resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    };
  }
  incident(id: string): IncidentRow | undefined {
    const r = this.db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
    return r ? this.toIncident(r) : undefined;
  }
  incidents(opts: { status?: IncidentStatus[]; limit?: number } = {}): IncidentRow[] {
    const where = opts.status?.length ? `WHERE status IN (${opts.status.map(() => '?').join(',')})` : '';
    return (this.db.prepare(`SELECT * FROM incidents ${where} ORDER BY opened_at DESC LIMIT ?`).all(...(opts.status ?? []), opts.limit ?? 200) as Raw[]).map((r) => this.toIncident(r));
  }
  /** Open or monitoring incidents that involve an entity. */
  activeFor(entityId: string): IncidentRow[] {
    return (this.db.prepare(`SELECT i.* FROM incidents i JOIN incident_entities e ON e.incident_id = i.id WHERE e.entity_id = ? AND i.status != 'resolved' ORDER BY i.opened_at`).all(entityId) as Raw[]).map((r) => this.toIncident(r));
  }
  createIncident(i: Omit<IncidentRow, 'id' | 'openedAt' | 'recoveredAt' | 'resolvedAt' | 'resolvedBy' | 'hypothesisVerified'> & { hypothesisVerified?: boolean }): IncidentRow {
    const id = newId(), now = this.now();
    this.db.prepare(`INSERT INTO incidents (id, title, status, severity, root_entity_id, hypothesis, hypothesis_entity_id, hypothesis_verified, assignee, created_by, opened_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, i.title, i.status, i.severity, i.rootEntityId, i.hypothesis, i.hypothesisEntityId, i.hypothesisVerified ? 1 : 0, i.assignee, i.createdBy, now, now);
    return this.incident(id)!;
  }
  updateIncident(id: string, patch: Partial<IncidentRow>): void {
    const map: Record<string, string> = {
      title: 'title', status: 'status', severity: 'severity', rootEntityId: 'root_entity_id', hypothesis: 'hypothesis', hypothesisEntityId: 'hypothesis_entity_id',
      hypothesisVerified: 'hypothesis_verified', assignee: 'assignee', recoveredAt: 'recovered_at', resolvedAt: 'resolved_at', resolvedBy: 'resolved_by',
    };
    const keys = Object.keys(patch).filter((k) => k in map && (patch as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return k === 'hypothesisVerified' ? (v ? 1 : 0) : v; });
    this.db.prepare(`UPDATE incidents SET ${keys.map((k) => `${map[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
  }
  incidentEntities(id: string): IncidentView['entities'] {
    return (this.db.prepare('SELECT entity_id, role, added_at FROM incident_entities WHERE incident_id = ? ORDER BY added_at').all(id) as Raw[]).map((r) => ({ entityId: r.entity_id, role: r.role, addedAt: r.added_at }));
  }
  addIncidentEntity(id: string, entityId: string, role: 'affected' | 'suspected' | 'impact'): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO incident_entities (incident_id, entity_id, role, added_at) VALUES (?,?,?,?)').run(id, entityId, role, this.now()).changes === 1;
  }
  timeline(id: string): TimelineEntry[] {
    return (this.db.prepare('SELECT * FROM incident_timeline WHERE incident_id = ? ORDER BY ts, id').all(id) as Raw[]).map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, actor: r.actor, text: r.text, data: parse(r.data, {}) }));
  }
  addTimeline(id: string, kind: string, actor: string, userId: string | null, text: string, data: Record<string, unknown> = {}): void {
    this.db.prepare('INSERT INTO incident_timeline (id, incident_id, ts, kind, actor, user_id, text, data) VALUES (?,?,?,?,?,?,?,?)').run(newId(), id, this.now(), kind, actor, userId, text, JSON.stringify(data));
  }

  // ---------- acknowledgements ----------
  acks(): AlertAck[] {
    return (this.db.prepare('SELECT * FROM alert_acks ORDER BY ts DESC LIMIT 1000').all() as Raw[]).map((r) => ({ entityId: r.entity_id, since: r.since, actor: r.actor, ts: r.ts, note: r.note }));
  }
  ack(entityId: string, since: string, actor: string, userId: string | null, note: string | null): AlertAck {
    const ts = this.now();
    this.db.prepare('INSERT OR REPLACE INTO alert_acks (entity_id, since, actor, user_id, ts, note) VALUES (?,?,?,?,?,?)').run(entityId, since, actor, userId, ts, note);
    return { entityId, since, actor, ts, note };
  }

  // ---------- maintenance ----------
  private toWindow(r: Raw): MaintenanceWindow {
    return { id: r.id, title: r.title, description: r.description, entityIds: parse(r.entity_ids, []), startsAt: r.starts_at, endsAt: r.ends_at, suppress: !!r.suppress, createdBy: r.created_by, cancelledAt: r.cancelled_at };
  }
  maintenance(includePast = false): MaintenanceWindow[] {
    const sql = includePast ? 'SELECT * FROM maintenance ORDER BY starts_at DESC LIMIT 200' : 'SELECT * FROM maintenance WHERE ends_at > ? AND cancelled_at IS NULL ORDER BY starts_at';
    return ((includePast ? this.db.prepare(sql).all() : this.db.prepare(sql).all(this.now())) as Raw[]).map((r) => this.toWindow(r));
  }
  window(id: string): MaintenanceWindow | undefined {
    const r = this.db.prepare('SELECT * FROM maintenance WHERE id = ?').get(id);
    return r ? this.toWindow(r) : undefined;
  }
  addWindow(w: Omit<MaintenanceWindow, 'id' | 'cancelledAt'>): MaintenanceWindow {
    const id = newId();
    this.db.prepare('INSERT INTO maintenance (id, title, description, entity_ids, starts_at, ends_at, suppress, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, w.title, w.description, JSON.stringify(w.entityIds), w.startsAt, w.endsAt, w.suppress ? 1 : 0, w.createdBy, this.now());
    return this.window(id)!;
  }
  cancelWindow(id: string): boolean {
    return this.db.prepare('UPDATE maintenance SET cancelled_at = ? WHERE id = ? AND cancelled_at IS NULL').run(this.now(), id).changes === 1;
  }

  // ---------- notifications ----------
  notify(userId: string, n: Omit<NotificationView, 'id' | 'ts' | 'readAt'>): NotificationView {
    const id = newId(), ts = this.now();
    this.db.prepare('INSERT INTO notifications (id, user_id, ts, severity, title, text, entity_id, incident_id) VALUES (?,?,?,?,?,?,?,?)').run(id, userId, ts, n.severity, n.title, n.text, n.entityId, n.incidentId);
    return { id, ts, readAt: null, ...n };
  }
  notifications(userId: string, limit = 50): NotificationView[] {
    return (this.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY ts DESC LIMIT ?').all(userId, limit) as Raw[]).map((r) => ({ id: r.id, ts: r.ts, severity: r.severity, title: r.title, text: r.text, entityId: r.entity_id, incidentId: r.incident_id, readAt: r.read_at }));
  }
  markRead(userId: string, ids: string[] | 'all'): void {
    if (ids === 'all') this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(this.now(), userId);
    else for (const id of ids) this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(this.now(), id, userId);
  }
  pruneNotifications(before: string): number {
    return this.db.prepare('DELETE FROM notifications WHERE ts < ?').run(before).changes;
  }
}
