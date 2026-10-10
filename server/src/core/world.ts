import type {
  AlertAck, BlockView, BuildingType, Completeness, ConnectionType, ConnectionView, EntityKind, EntityView, EventType, Health, IncidentView,
  MaintenanceWindow, NotificationView, Severity, Verification, WorldEvent,
} from '@berrie/shared';
import { ConnectionStore } from '../db/connections.js';
import { BLOCK_PITCH } from '@berrie/shared';
import type { EntityRow, Repo } from '../db/repo.js';

/** An entity as reported by a discovery adapter in one inventory run. */
export interface ObservedEntity {
  id: string;
  kind: EntityKind;
  name: string;
  buildingType: BuildingType;
  parentId: string | null;
  hostId: string | null;
  hostnames?: string[];
  dependsOn?: string[];
  meta?: Record<string, unknown>;
  /** Factual state from the source (e.g. Docker container state). Applied without hysteresis. */
  health?: { health: Health; reason: string | null };
}

export interface InventoryResult {
  adapter: string;
  scope: string;
  completeness: Completeness;
  entities: ObservedEntity[];
  error?: string | null;
}

export interface ProbeOutcome {
  checkName: string;
  outcome: 'ok' | 'fail' | 'unknown';
  /** Health to report once the failure threshold is reached. */
  failHealth?: Health;
  reason: string | null;
  latencyMs?: number | null;
  statusCode?: number | null;
  failureThreshold?: number;
  successThreshold?: number;
}

/** A relationship as reported by one topology source in one run. */
export interface ObservedConnection {
  id: string;
  src: string;
  dst: string;
  type: ConnectionType;
  verification: Verification;
  evidence: string[];
  health?: { health: Health; reason: string | null };
  meta?: ConnectionView['meta'];
}

export interface ConnectionInventory {
  source: string;
  scope: string;
  completeness: Completeness;
  connections: ObservedConnection[];
  error?: string | null;
}

/** Stable id; symmetric network links sort their ends so A↔B and B↔A are one record. */
export function connectionId(type: ConnectionType, a: string, b: string): string {
  const sym = type === 'lan' || type === 'vpn' || type === 'direct';
  const [x, y] = sym && b < a ? [b, a] : [a, b];
  return `conn:${type}:${x}>${y}`;
}

export interface WorldOptions {
  removal: { confirmations: number; minMissingSeconds: number; archiveAfterHours: number };
  unknownAfterInventoryFailures: number;
}

export type WorldListener = {
  entity?: (v: EntityView) => void;
  event?: (e: WorldEvent) => void;
  blocks?: (b: BlockView[]) => void;
  connection?: (c: ConnectionView) => void;
  /** Operational records (incidents, acks, maintenance); `userId` set = only for that user (notifications). */
  ops?: (m: OpsMessage) => void;
};

export type OpsMessage =
  | { t: 'incident'; data: IncidentView }
  | { t: 'ack'; data: AlertAck }
  | { t: 'maintenance'; data: MaintenanceWindow }
  | { t: 'notification'; data: NotificationView; userId: string };

const BAD: Health[] = ['degraded', 'unhealthy', 'unreachable', 'restarting', 'host_offline'];
const LOT_OFFSETS: [number, number][] = [[1, 1], [4, 1], [1, 4], [4, 4]];
const SPIRAL_RADIUS = 4;

function spiral(): [number, number][] {
  const cells: [number, number][] = [];
  for (let r = 1; r <= SPIRAL_RADIUS; r++) {
    const ring: [number, number][] = [];
    for (let bx = -r; bx <= r; bx++) for (let by = -r; by <= r; by++) {
      if (Math.max(Math.abs(bx), Math.abs(by)) === r) ring.push([bx, by]);
    }
    // Deterministic order: prefer the "front" of the island (towards the viewer), then by angle.
    ring.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    cells.push(...ring);
  }
  return cells;
}
const SPIRAL = spiral();

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export class World {
  private listeners = new Set<WorldListener>();
  private dirty = new Set<string>();
  private blocksDirty = false;
  private uncertainScopes = new Set<string>();
  /** Per-host signals used to derive host health. */
  private hostSignals = new Map<string, { probe: Health | null; docker: 'ok' | 'fail' | null; dockerError: string | null; collector: 'ok' | 'fail' | null; collectorError: string | null }>();

  constructor(readonly repo: Repo, readonly opts: WorldOptions) {}

  subscribe(l: WorldListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---------------- events ----------------

  emit(e: { type: EventType; entityId?: string | null; relatedEntityId?: string | null; severity?: Severity; source: string; details?: Record<string, unknown> }): WorldEvent {
    const ev = this.repo.insertEvent({
      type: e.type, entityId: e.entityId ?? null, relatedEntityId: e.relatedEntityId ?? null,
      severity: e.severity ?? 'info', source: e.source, details: e.details ?? {},
    });
    for (const l of this.listeners) l.event?.(ev);
    return ev;
  }

  publishOps(m: OpsMessage): void {
    for (const l of this.listeners) l.ops?.(m);
  }

  markDirty(id: string): void {
    this.dirty.add(id);
  }

  /** Push changed entity views to subscribers. Children of changed hosts are included (inherited state). */
  flush(): void {
    if (this.blocksDirty) {
      this.blocksDirty = false;
      const b = this.repo.blockViews();
      for (const l of this.listeners) l.blocks?.(b);
    }
    if (!this.dirty.size) return;
    const ids = new Set(this.dirty);
    this.dirty.clear();
    for (const id of [...ids]) {
      const e = this.repo.getEntity(id);
      if (e?.kind === 'host') for (const c of this.repo.listEntities().filter((c) => c.hostId === id)) ids.add(c.id);
      if (e?.kind === 'endpoint' && e.parentId) ids.add(e.parentId);
    }
    for (const id of ids) {
      const e = this.repo.getEntity(id);
      if (!e) continue;
      const v = this.repo.toView(e);
      for (const l of this.listeners) l.entity?.(v);
    }
  }

  // ---------------- inventory reconciliation ----------------

  reconcile(inv: InventoryResult): { created: number; updated: number; missing: number; removed: number } {
    const stats = { created: 0, updated: 0, missing: 0, removed: 0 };
    // Demo fixtures and live inventories never mix, in either direction.
    if ((inv.adapter === 'demo') !== (this.repo.mode === 'demo')) {
      throw new Error(`refusing ${inv.adapter} inventory in ${this.repo.mode} world`);
    }
    const now = this.repo.now();
    const scopeKey = `${inv.adapter}|${inv.scope}`;
    this.repo.tx(() => {
      this.repo.recordObservation(inv.adapter, inv.scope, inv.completeness, inv.entities.length, inv.error ?? null);
      const seen = new Set<string>();

      for (const o of inv.entities) {
        seen.add(o.id);
        const existing = this.repo.getEntity(o.id);
        if (!existing) {
          this.repo.insertEntity({
            id: o.id, kind: o.kind, name: o.name, displayName: null, buildingType: o.buildingType,
            parentId: o.parentId, hostId: o.hostId, origin: this.repo.mode, source: inv.adapter, scope: inv.scope,
            lifecycle: 'discovered', hostnames: o.hostnames ?? [], dependsOn: o.dependsOn ?? [], meta: o.meta ?? {},
            firstSeenAt: now, lastSeenAt: now, missingSince: null, missingCount: 0, removedAt: null, archivedAt: null, updatedAt: now,
          });
          stats.created++;
          this.emit({ type: 'service.discovered', entityId: o.id, source: inv.adapter, severity: 'notice', details: { name: o.name, kind: o.kind } });
        } else {
          stats.updated++;
          const wasGone = existing.lifecycle === 'removed' || existing.lifecycle === 'archived';
          const lifecycle = existing.lifecycle === 'discovered' || existing.lifecycle === 'missing' || wasGone ? 'active' : existing.lifecycle;
          if (existing.lifecycle === 'missing' || wasGone) {
            this.emit({ type: 'service.rediscovered', entityId: o.id, source: inv.adapter, severity: 'notice', details: { previously: existing.lifecycle } });
          }
          this.detectDeployment(existing, o, inv.adapter);
          this.repo.updateEntity(o.id, {
            kind: o.kind, name: o.name, buildingType: (existing.meta.typeOverride as BuildingType) ?? o.buildingType,
            parentId: o.parentId, hostId: o.hostId, source: inv.adapter, scope: inv.scope, lifecycle,
            hostnames: o.hostnames ?? [], dependsOn: o.dependsOn ?? [],
            meta: { ...(o.meta ?? {}), ...(existing.meta.typeOverride ? { typeOverride: existing.meta.typeOverride } : {}) },
            lastSeenAt: now, missingSince: null, missingCount: 0, removedAt: null, archivedAt: null,
          });
        }
        this.repo.updateStatus(o.id, { inventoryFailures: 0, inventoryUncertain: false });
        if (o.health) this.applyHealth(o.id, o.health.health, o.health.reason, inv.adapter, { factual: true });
        this.dirty.add(o.id);
      }

      const known = this.repo.listBySource(inv.adapter, inv.scope).filter((e) => !seen.has(e.id) && e.lifecycle !== 'removed');
      if (inv.completeness === 'complete') {
        // Only a complete inventory is evidence of absence.
        for (const e of known) {
          const missingSince = e.missingSince ?? now;
          const missingCount = e.missingCount + 1;
          const elapsed = (Date.parse(now) - Date.parse(missingSince)) / 1000;
          if (missingCount >= this.opts.removal.confirmations && elapsed >= this.opts.removal.minMissingSeconds) {
            this.repo.updateEntity(e.id, { lifecycle: 'removed', removedAt: now, missingCount, missingSince });
            this.emit({ type: 'service.removal_confirmed', entityId: e.id, source: inv.adapter, severity: 'notice', details: { name: e.name, absentInventories: missingCount } });
            stats.removed++;
          } else {
            if (e.lifecycle !== 'missing') {
              this.emit({ type: 'service.missing', entityId: e.id, source: inv.adapter, severity: 'warning', details: { name: e.name } });
            }
            this.repo.updateEntity(e.id, { lifecycle: 'missing', missingSince, missingCount });
            stats.missing++;
          }
          this.dirty.add(e.id);
        }
        if (this.uncertainScopes.delete(scopeKey)) {
          this.emit({ type: 'inventory.restored', source: inv.adapter, severity: 'notice', details: { scope: inv.scope } });
        }
      } else {
        // Uncertain inventory: never treat absence as removal. Mark unseen entities uncertain.
        for (const e of known) {
          const st = this.repo.getStatus(e.id)!;
          const failures = st.inventoryFailures + 1;
          this.repo.updateStatus(e.id, { inventoryFailures: failures, inventoryUncertain: true });
          if (failures >= this.opts.unknownAfterInventoryFailures && st.health !== 'unknown' && e.kind !== 'host') {
            this.applyHealth(e.id, 'unknown', `${inv.adapter} inventory ${inv.completeness}${inv.error ? `: ${inv.error}` : ''}`, inv.adapter, { factual: true });
          }
          this.dirty.add(e.id);
        }
        if (!this.uncertainScopes.has(scopeKey)) {
          this.uncertainScopes.add(scopeKey);
          this.emit({ type: 'inventory.uncertain', source: inv.adapter, severity: 'warning', details: { scope: inv.scope, completeness: inv.completeness, error: inv.error ?? null } });
        }
      }
      this.ensureLayout();
    });
    this.flush();
    return stats;
  }

  private detectDeployment(prev: EntityRow, o: ObservedEntity, source: string): void {
    const a = prev.meta, b = o.meta ?? {};
    if (a.containerId && b.containerId && a.containerId !== b.containerId) {
      this.emit({
        type: 'deployment.changed', entityId: prev.id, source, severity: 'info',
        details: { from: String(a.containerId).slice(0, 12), to: String(b.containerId).slice(0, 12), image: b.image ?? null, imageChanged: a.imageId !== b.imageId },
      });
    }
  }

  /** Move removed entities to the archive after the retention delay. */
  archivePass(): number {
    const cutoff = Date.parse(this.repo.now()) - this.opts.removal.archiveAfterHours * 3600_000;
    let n = 0;
    this.repo.tx(() => {
      for (const e of this.repo.listEntities().filter((e) => e.lifecycle === 'removed' && e.removedAt && Date.parse(e.removedAt) <= cutoff)) {
        this.repo.updateEntity(e.id, { lifecycle: 'archived', archivedAt: this.repo.now() });
        this.repo.deleteLayout(e.id);
        this.emit({ type: 'service.archived', entityId: e.id, source: 'world', severity: 'info', details: { name: e.name } });
        this.dirty.add(e.id);
        n++;
      }
    });
    this.flush();
    return n;
  }

  // ---------------- connections ----------------

  private pushConnection(id: string): void {
    const c = this.repo.connections.get(id);
    if (!c) return;
    const v = ConnectionStore.view(c);
    for (const l of this.listeners) l.connection?.(v);
  }

  /**
   * Reconcile one topology source. Same evidence rules as entities: only a complete report can make a relationship
   * missing, and removal needs repeated confirmation. Health changes are events, never removals.
   */
  reconcileConnections(inv: ConnectionInventory): { created: number; missing: number; removed: number } {
    const stats = { created: 0, missing: 0, removed: 0 };
    const now = this.repo.now();
    const changed = new Set<string>();
    this.repo.tx(() => {
      const seen = new Set<string>();
      for (const o of inv.connections) {
        seen.add(o.id);
        const cur = this.repo.connections.get(o.id);
        const health = o.health?.health ?? 'unknown';
        const reason = o.health?.reason ?? null;
        if (!cur) {
          this.repo.connections.insert({ id: o.id, src: o.src, dst: o.dst, type: o.type, source: inv.source, scope: inv.scope, verification: o.verification,
            lifecycle: 'discovered', health, reason, evidence: o.evidence, meta: o.meta ?? {}, lastSeenAt: now });
          stats.created++;
          // Network topology changes are worth an event; individual compose dependencies are not (noise).
          if (o.type !== 'dependency' && o.type !== 'database') {
            this.emit({ type: 'connection.discovered', entityId: o.src, relatedEntityId: o.dst, source: inv.source, details: { connection: o.id, type: o.type, verification: o.verification } });
          }
        } else {
          const wasGone = cur.lifecycle === 'missing' || cur.lifecycle === 'removed' || cur.lifecycle === 'archived';
          if (cur.health !== health) {
            const bad = (h: Health) => h === 'unhealthy' || h === 'unreachable' || h === 'degraded';
            if (bad(health)) this.emit({ type: 'connection.degraded', entityId: o.src, relatedEntityId: o.dst, source: inv.source, severity: 'warning', details: { connection: o.id, type: o.type, from: cur.health, to: health, reason } });
            else if (health === 'healthy' && bad(cur.health)) this.emit({ type: 'connection.recovered', entityId: o.src, relatedEntityId: o.dst, source: inv.source, severity: 'notice', details: { connection: o.id, type: o.type } });
          }
          this.repo.connections.update(o.id, {
            src: o.src, dst: o.dst, type: o.type, source: inv.source, scope: inv.scope, verification: o.verification, health, reason, evidence: o.evidence,
            meta: { ...(o.meta ?? {}) }, lastSeenAt: now, lifecycle: cur.lifecycle === 'discovered' || wasGone ? 'active' : cur.lifecycle,
            missingSince: null, missingCount: 0, removedAt: null, archivedAt: null,
          });
        }
        changed.add(o.id);
      }
      if (inv.completeness !== 'complete') return;
      for (const c of this.repo.connections.bySource(inv.source, inv.scope)) {
        if (seen.has(c.id) || c.lifecycle === 'removed') continue;
        const missingSince = c.missingSince ?? now;
        const missingCount = c.missingCount + 1;
        const elapsed = (Date.parse(now) - Date.parse(missingSince)) / 1000;
        if (missingCount >= this.opts.removal.confirmations && elapsed >= this.opts.removal.minMissingSeconds) {
          this.repo.connections.update(c.id, { lifecycle: 'removed', removedAt: now, missingCount, missingSince });
          this.emit({ type: 'connection.removed', entityId: c.src, relatedEntityId: c.dst, source: inv.source, severity: 'notice', details: { connection: c.id, type: c.type } });
          stats.removed++;
        } else {
          if (c.lifecycle !== 'missing') this.emit({ type: 'connection.missing', entityId: c.src, relatedEntityId: c.dst, source: inv.source, severity: 'notice', details: { connection: c.id, type: c.type } });
          this.repo.connections.update(c.id, { lifecycle: 'missing', missingSince, missingCount });
          stats.missing++;
        }
        changed.add(c.id);
      }
    });
    for (const id of changed) this.pushConnection(id);
    return stats;
  }

  /** Observed traffic between two known entities: record activity on the relationship (creating an 'observed' one if needed). */
  observeTraffic(src: string, dst: string, at: string): void {
    const existing = this.repo.connections.touching(src).find((c) => (c.src === src && c.dst === dst) || (c.src === dst && c.dst === src));
    if (existing) {
      this.repo.connections.update(existing.id, { lastActivityAt: at });
      this.pushConnection(existing.id);
      return;
    }
    const id = connectionId('api', src, dst);
    this.repo.connections.insert({ id, src, dst, type: 'api', source: 'ingest', scope: 'ingest', verification: 'observed', lifecycle: 'active', health: 'unknown',
      reason: 'traffic reported via the ingest API', evidence: ['traffic reported via the ingest API'], meta: {}, lastSeenAt: at, lastActivityAt: at });
    this.emit({ type: 'connection.discovered', entityId: src, relatedEntityId: dst, source: 'ingest', details: { connection: id, type: 'api', verification: 'observed' } });
    this.pushConnection(id);
  }

  /** Removed relationships leave the map after the same retention as entities; archived ones stay in history. */
  archiveConnectionsPass(): void {
    const cutoff = Date.parse(this.repo.now()) - this.opts.removal.archiveAfterHours * 3600_000;
    for (const c of this.repo.connections.list().filter((x) => x.lifecycle === 'removed' && x.removedAt && Date.parse(x.removedAt) <= cutoff)) {
      this.repo.connections.update(c.id, { lifecycle: 'archived', archivedAt: this.repo.now() });
      this.pushConnection(c.id);
    }
  }

  // ---------------- health ----------------

  /** Set an entity's own health. Factual sources (Docker state) apply immediately; probes go through recordProbe. */
  applyHealth(id: string, health: Health, reason: string | null, source: string, opts: { factual?: boolean } = {}): void {
    const e = this.repo.getEntity(id);
    const st = this.repo.getStatus(id);
    if (!e || !st) return;
    const now = this.repo.now();
    const patch: Parameters<Repo['updateStatus']>[1] = { reason, lastCheckAt: now };
    if (health !== 'unknown') patch.lastKnownHealth = health;
    if (health === 'healthy') patch.lastSuccessAt = now;
    const changed = st.health !== health;
    if (changed) {
      patch.health = health;
      patch.lastChangeAt = now;
    }
    // Persist first, then emit: listeners (incidents, impact) must see the new state.
    this.repo.updateStatus(id, patch);
    if (changed) this.emitHealthTransition(e, st.health, st.lastKnownHealth, health, reason, source);
    if (opts.factual) this.repo.updateStatus(id, { consecutiveFailures: 0, consecutiveSuccesses: 0 });
    this.dirty.add(id);
  }

  private emitHealthTransition(e: EntityRow, prev: Health, lastKnown: Health | null, next: Health, reason: string | null, source: string): void {
    const details = { from: prev, to: next, reason };
    if (e.kind === 'host') {
      if (next === 'host_offline') this.emit({ type: 'host.offline', entityId: e.id, source, severity: 'critical', details });
      else if (prev === 'host_offline' && next === 'healthy') this.emit({ type: 'host.online', entityId: e.id, source, severity: 'notice', details });
      return;
    }
    const firstSighting = lastKnown === null;
    switch (next) {
      case 'healthy':
        if (BAD.includes(prev) || (prev === 'unknown' && lastKnown && BAD.includes(lastKnown))) this.emit({ type: 'service.recovered', entityId: e.id, source, severity: 'notice', details });
        else if (!firstSighting) this.emit({ type: 'service.healthy', entityId: e.id, source, details });
        break;
      case 'unhealthy': this.emit({ type: 'service.unhealthy', entityId: e.id, source, severity: 'warning', details }); break;
      case 'unreachable': this.emit({ type: 'service.unreachable', entityId: e.id, source, severity: 'warning', details }); break;
      case 'degraded': this.emit({ type: 'service.degraded', entityId: e.id, source, severity: 'notice', details }); break;
      case 'unknown': if (!firstSighting) this.emit({ type: 'service.health_unknown', entityId: e.id, source, details }); break;
      default: break;
    }
  }

  /** Apply a probe result with consecutive-failure/success hysteresis. */
  recordProbe(entityId: string, p: ProbeOutcome): void {
    const st = this.repo.getStatus(entityId);
    if (!st) return;
    this.repo.insertCheckResult({ entityId, checkName: p.checkName, outcome: p.outcome, latencyMs: p.latencyMs ?? null, statusCode: p.statusCode ?? null, error: p.outcome === 'ok' ? null : p.reason });
    const now = this.repo.now();
    if (p.outcome === 'unknown') {
      // The monitor itself could not run the check; do not fabricate a result.
      this.repo.updateStatus(entityId, { lastCheckAt: now });
      if (st.health !== 'unknown' && st.consecutiveFailures === 0) {
        this.applyHealth(entityId, 'unknown', p.reason ?? 'check could not run', 'monitor');
      }
      this.flush();
      return;
    }
    const failT = p.failureThreshold ?? 3;
    const okT = p.successThreshold ?? 1;
    if (p.outcome === 'ok') {
      const successes = st.consecutiveSuccesses + 1;
      this.repo.updateStatus(entityId, { consecutiveSuccesses: successes, consecutiveFailures: 0, lastCheckAt: now, lastSuccessAt: now });
      if (st.health !== 'healthy' && successes >= okT) this.applyHealth(entityId, 'healthy', p.reason, 'monitor');
      else this.repo.updateStatus(entityId, { reason: st.health === 'healthy' ? p.reason : st.reason });
    } else {
      const failures = st.consecutiveFailures + 1;
      this.repo.updateStatus(entityId, { consecutiveFailures: failures, consecutiveSuccesses: 0, lastCheckAt: now });
      const target = p.failHealth ?? 'unreachable';
      if (failures >= failT) {
        if (st.health !== target) this.applyHealth(entityId, target, `${p.reason} (${failures} consecutive failures)`, 'monitor');
        else this.repo.updateStatus(entityId, { reason: `${p.reason} (${failures} consecutive failures)` });
      }
    }
    this.dirty.add(entityId);
    this.flush();
  }

  // ---------------- host health ----------------

  setHostSignal(hostId: string, signal: { probe?: Health | null; docker?: 'ok' | 'fail'; dockerError?: string | null; collector?: 'ok' | 'fail'; collectorError?: string | null }): void {
    const s = this.hostSignals.get(hostId) ?? { probe: null, docker: null, dockerError: null, collector: null, collectorError: null };
    Object.assign(s, signal);
    this.hostSignals.set(hostId, s);
    if (!this.repo.getEntity(hostId)) return;
    let health: Health;
    let reason: string;
    if (s.probe === 'host_offline') { health = 'host_offline'; reason = 'host unreachable (repeated connection failures)'; }
    else if (s.collector === 'fail') {
      // Reachable but we cannot collect (auth, permissions), or an agent went silent: never "offline" on that basis.
      const reachable = s.probe === 'healthy' || s.docker === 'ok';
      health = reachable ? 'degraded' : 'unknown';
      reason = reachable ? `host reachable, collection failing: ${s.collectorError}` : s.collectorError ?? 'collection failing';
    } else if (s.docker === 'fail') {
      health = s.probe === 'healthy' ? 'degraded' : 'unknown';
      reason = s.probe === 'healthy' ? `host reachable, Docker API unavailable: ${s.dockerError}` : `Docker API unavailable: ${s.dockerError}`;
    } else if (s.docker === 'ok' || s.probe === 'healthy') { health = 'healthy'; reason = s.docker === 'ok' ? 'Docker API reachable' : 'host reachable'; }
    else if (s.collector === 'ok') { health = 'healthy'; reason = 'collector reporting'; }
    else { health = 'unknown'; reason = 'no signal yet'; }
    this.applyHealth(hostId, health, reason, 'host');
    this.flush();
  }

  /** Mark a host's monitoring as suspended: its state becomes unknown (we stopped looking), nothing is removed. */
  suspendHost(hostId: string, by: string): void {
    this.hostSignals.delete(hostId);
    for (const e of this.repo.listEntities().filter((x) => x.hostId === hostId && x.lifecycle !== 'removed')) {
      this.applyHealth(e.id, 'unknown', `monitoring suspended by ${by}`, 'harbor', { factual: true });
    }
    this.flush();
  }

  /** Merge fields into an entity's metadata (e.g. freshly collected facts) and push the change. */
  patchMeta(id: string, patch: Record<string, unknown>): void {
    const e = this.repo.getEntity(id);
    if (!e) return;
    this.repo.updateEntity(id, { meta: { ...e.meta, ...patch } });
    this.dirty.add(id);
    this.flush();
  }

  /**
   * Explicit, confirmed removal of a whole server by an administrator (Server Harbor). This is the positive evidence
   * the lifecycle rules require; history stays in the archive.
   */
  archiveHost(hostId: string, by: string): number {
    const now = this.repo.now();
    let n = 0;
    this.repo.tx(() => {
      for (const e of this.repo.listEntities().filter((x) => x.hostId === hostId || x.id === hostId)) {
        this.repo.updateEntity(e.id, { lifecycle: 'archived', removedAt: e.removedAt ?? now, archivedAt: now });
        this.repo.deleteLayout(e.id);
        this.dirty.add(e.id);
        n++;
      }
      this.repo.releaseEmptyBlocks((district) => district === hostId);
      const archivedIds = new Set(this.repo.listEntities(true).filter((x) => x.hostId === hostId || x.id === hostId).map((x) => x.id));
      for (const c of this.repo.connections.list().filter((x) => archivedIds.has(x.src) || archivedIds.has(x.dst))) {
        this.repo.connections.update(c.id, { lifecycle: 'archived', removedAt: c.removedAt ?? now, archivedAt: now });
      }
      this.blocksDirty = true;
      this.emit({ type: 'service.archived', entityId: hostId, source: by, severity: 'notice', details: { name: hostId, reason: 'server archived in Server Harbor', entities: n, by } });
    });
    this.flush();
    return n;
  }

  // ---------------- layout ----------------

  private needsBuilding(e: EntityRow, byId: Map<string, EntityRow>): boolean {
    if (e.lifecycle === 'archived') return false;
    if (e.kind === 'host' || e.kind === 'service' || e.kind === 'gateway' || e.kind === 'external') return true;
    if (e.kind === 'endpoint') {
      const p = e.parentId ? byId.get(e.parentId) : undefined;
      return !(p && p.kind === 'service' && p.lifecycle !== 'archived');
    }
    return false;
  }

  /** Give every entity that needs a building a persistent position. Never moves existing buildings. */
  /**
   * Explicit "generate a new map" (operator action): forget all positions — island origins, city blocks, building
   * plots and manual pins — and place everything again with islands in random order and buildings in random order.
   * Entities, health and history are untouched; only the shared layout changes.
   */
  regenerateLayout(by: string, rand: () => number = Math.random): { islands: number; buildings: number } {
    const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    let buildings = 0;
    this.repo.tx(() => {
      this.repo.db.prepare('DELETE FROM layout').run();
      this.repo.db.prepare('DELETE FROM blocks').run();
      this.repo.db.prepare('DELETE FROM districts').run();
      const all = this.repo.listEntities().filter((e) => e.lifecycle !== 'archived');
      // Reserve island origins in random order (properly spaced by islandSlot).
      const districts = shuffle([...new Set(all.map((e) => (e.kind === 'host' ? e.id : e.hostId ?? 'external')))]);
      for (const d of districts) this.repo.districtOrigin(d);
      this.ensureLayout(shuffle);
      buildings = this.repo.listLayouts().length;
      this.blocksDirty = true;
      for (const e of all) this.dirty.add(e.id);
      this.emit({ type: 'layout.moved', entityId: null, source: by, severity: 'notice', details: { regenerated: true, islands: districts.length, buildings, by } });
    });
    this.flush();
    return { islands: (this.repo.db.prepare('SELECT COUNT(*) n FROM districts').get() as { n: number }).n, buildings };
  }

  ensureLayout(shuffle?: <T>(a: T[]) => T[]): void {
    const all = this.repo.listEntities(true);
    const byId = new Map(all.map((e) => [e.id, e]));
    const layouts = new Map(this.repo.listLayouts().map((l) => [l.entityId, l]));
    // Hosts first so their blocks are reserved, then by first sighting for determinism (or randomly for a new map).
    const rest = all.filter((e) => e.kind !== 'host').sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
    const order = [...all.filter((e) => e.kind === 'host'), ...(shuffle ? shuffle(rest) : rest)];
    for (const e of order) {
      const need = this.needsBuilding(e, byId);
      const has = layouts.get(e.id);
      if (need && !has) {
        const l = this.place(e, byId, [...layouts.values()]);
        if (l) { layouts.set(e.id, l); this.dirty.add(e.id); }
      } else if (!need && has) {
        this.repo.deleteLayout(e.id);
        layouts.delete(e.id);
        this.dirty.add(e.id);
      }
    }
  }

  private groupKey(e: EntityRow, byId: Map<string, EntityRow>): string {
    const district = e.hostId ?? 'external';
    if (e.kind === 'host') return `host:${e.id}`;
    const p = e.parentId ? byId.get(e.parentId) : undefined;
    if (e.kind === 'service' && p?.kind === 'project') return p.id;
    if (e.kind === 'endpoint') return `web:${district}`;
    if (e.kind === 'gateway') return `gw:${district}`;
    if (e.kind === 'external') return 'ports:external';
    return `misc:${district}`;
  }

  private place(e: EntityRow, byId: Map<string, EntityRow>, layouts: { x: number; y: number; w: number; h: number }[]) {
    const district = e.hostId ?? 'external';
    const origin = this.repo.districtOrigin(district);
    const blocks = this.repo.listBlocksRaw().filter((b) => b.district === district);
    const claimed = new Set(blocks.map((b) => `${b.bx},${b.by}`));
    const group = this.groupKey(e, byId);
    const free = (r: { x: number; y: number; w: number; h: number }) => !layouts.some((l) => overlaps(l, r));

    if (e.kind === 'host') {
      if (!claimed.has('0,0')) { this.repo.claimBlock(district, 0, 0, group); this.blocksDirty = true; }
      const r = { x: origin.x + 2, y: origin.y + 2, w: 3, h: 3 };
      if (free(r)) { const l = { entityId: e.id, ...r, pinned: false }; this.repo.setLayout(l); return l; }
    }

    const spiralIdx = (bx: number, by: number) => SPIRAL.findIndex(([x, y]) => x === bx && y === by);
    const own = blocks.filter((b) => b.groupKey === group).sort((a, b) => spiralIdx(a.bx, a.by) - spiralIdx(b.bx, b.by));
    const tryBlock = (bx: number, by: number) => {
      for (const [ox, oy] of LOT_OFFSETS) {
        const r = { x: origin.x + bx * BLOCK_PITCH + ox, y: origin.y + by * BLOCK_PITCH + oy, w: 2, h: 2 };
        if (free(r)) return r;
      }
      return null;
    };
    for (const b of own) {
      const r = tryBlock(b.bx, b.by);
      if (r) { const l = { entityId: e.id, ...r, pinned: false }; this.repo.setLayout(l); return l; }
    }
    // Claim a new block: adjacent to the district's existing blocks (so roads connect), nearest the group's anchor.
    if (!claimed.has('0,0')) { this.repo.claimBlock(district, 0, 0, `plaza:${district}`); claimed.add('0,0'); }
    const anchor = own[0] ?? { bx: 0, by: 0 };
    const adjacent = (bx: number, by: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => claimed.has(`${bx + dx},${by + dy}`));
    // Absolute tile rects of every claimed block (all districts) so districts never grow into each other.
    const taken = this.repo.blockViews().map((b) => ({ x: b.x, y: b.y, w: b.size, h: b.size }));
    const collides = (bx: number, by: number) => {
      const r = { x: origin.x + bx * BLOCK_PITCH, y: origin.y + by * BLOCK_PITCH, w: BLOCK_PITCH, h: BLOCK_PITCH };
      return taken.some((t) => overlaps(t, r)) || layouts.some((l) => overlaps(l, { ...r, x: r.x + 1, y: r.y + 1, w: r.w - 1, h: r.h - 1 }));
    };
    const candidates = SPIRAL.filter(([bx, by]) => !claimed.has(`${bx},${by}`) && adjacent(bx, by) && !collides(bx, by))
      .map(([bx, by], i) => ({ bx, by, i, d: Math.abs(bx - anchor.bx) + Math.abs(by - anchor.by) }))
      .sort((a, b) => a.d - b.d || a.i - b.i);
    for (const c of candidates) {
      const r = tryBlock(c.bx, c.by);
      if (!r) continue;
      this.repo.claimBlock(district, c.bx, c.by, group);
      this.blocksDirty = true;
      const l = { entityId: e.id, ...r, pinned: false };
      this.repo.setLayout(l);
      return l;
    }
    return null; // district full; entity remains listed without a building
  }

  /** Manual layout editing: move a building to a free position. Returns an error string on rejection. */
  moveBuilding(id: string, x: number, y: number, actor: string): string | null {
    const cur = this.repo.getLayout(id);
    if (!cur) return 'entity has no building';
    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x) > 2000 || Math.abs(y) > 2000) return 'invalid position';
    const r = { x, y, w: cur.w, h: cur.h };
    if (this.repo.listLayouts().some((l) => l.entityId !== id && overlaps(l, r))) return 'position overlaps another building';
    for (const b of this.repo.blockViews()) {
      for (let tx = x; tx < x + cur.w; tx++) for (let ty = y; ty < y + cur.h; ty++) {
        const inside = tx >= b.x && tx <= b.x + b.size && ty >= b.y && ty <= b.y + b.size;
        if (inside && (tx === b.x || ty === b.y || tx === b.x + b.size || ty === b.y + b.size)) return 'position is on a road';
      }
    }
    this.repo.setLayout({ entityId: id, ...r, pinned: true });
    this.emit({ type: 'layout.moved', entityId: id, source: actor, details: { from: { x: cur.x, y: cur.y }, to: { x, y } } });
    this.dirty.add(id);
    this.flush();
    return null;
  }
}
