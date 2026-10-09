// Shared domain model for Berrie World. Imported by both server and web.

/** Whether an entity exists. Never derived from health. */
export type Lifecycle = 'discovered' | 'active' | 'missing' | 'removed' | 'archived';

/** How an entity is doing. Never implies existence or removal. */
export type Health =
  | 'healthy'
  | 'degraded'
  | 'unhealthy'
  | 'unreachable'
  | 'starting'
  | 'restarting'
  | 'host_offline'
  | 'unknown';

export type EntityKind = 'host' | 'project' | 'service' | 'endpoint';

export type BuildingType =
  | 'server' // physical/virtual host
  | 'townhall' // compose project marker
  | 'house' // website / web app
  | 'lab' // AI model or AI service
  | 'workshop' // automation (n8n etc.)
  | 'silo' // database
  | 'tower' // network / proxy / tunnel
  | 'depot' // file storage
  | 'clocktower' // scheduled task / background worker
  | 'cache' // redis / memcached
  | 'post' // mail
  | 'shop'; // fallback

export type Origin = 'live' | 'demo';

export interface EntityView {
  id: string;
  kind: EntityKind;
  name: string;
  /** User-chosen name if set, else name. */
  displayName: string;
  buildingType: BuildingType;
  parentId: string | null;
  hostId: string | null;
  origin: Origin;
  lifecycle: Lifecycle;
  /** Own health from the most recent determination. */
  health: Health;
  /** Last health that was actually observed (not 'unknown'), kept during outages. */
  lastKnownHealth: Health | null;
  healthReason: string | null;
  /** Set when the parent host is offline; own health is preserved separately. */
  inheritedHostOffline: boolean;
  /** True if the source that reports this entity is currently uncertain. */
  inventoryUncertain: boolean;
  hostnames: string[];
  dependsOn: string[];
  meta: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string | null;
  missingSince: string | null;
  removedAt: string | null;
  archivedAt: string | null;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastChangeAt: string | null;
  layout: { x: number; y: number; w: number; h: number; pinned: boolean } | null;
}

export type Severity = 'info' | 'notice' | 'warning' | 'critical';

export type EventType =
  | 'service.discovered'
  | 'service.rediscovered'
  | 'service.healthy'
  | 'service.degraded'
  | 'service.unhealthy'
  | 'service.unreachable'
  | 'service.recovered'
  | 'service.health_unknown'
  | 'service.missing'
  | 'service.removal_confirmed'
  | 'service.archived'
  | 'service.renamed'
  | 'container.started'
  | 'container.stopped'
  | 'container.restarted'
  | 'deployment.changed'
  | 'host.offline'
  | 'host.online'
  | 'inventory.uncertain'
  | 'inventory.restored'
  | 'http.request'
  | 'automation.executed'
  | 'ai.request_started'
  | 'ai.request_completed'
  | 'task.executed'
  | 'alert'
  | 'action.performed'
  | 'layout.moved';

export interface WorldEvent {
  id: string;
  ts: string; // ISO-8601 UTC
  type: EventType;
  entityId: string | null;
  relatedEntityId: string | null;
  severity: Severity;
  source: string;
  details: Record<string, unknown>;
}

export type Completeness = 'complete' | 'incomplete' | 'unavailable';

export interface AdapterStatus {
  adapter: string;
  scope: string;
  completeness: Completeness;
  lastRunAt: string | null;
  lastCompleteAt: string | null;
  error: string | null;
}

export interface Alert {
  entityId: string;
  displayName: string;
  health: Health;
  lifecycle: Lifecycle;
  reason: string | null;
  since: string | null;
  severity: Severity;
}

export interface Summary {
  total: number;
  healthy: number;
  degradedOrUnhealthy: number;
  unreachable: number;
  unknown: number;
  hostsOffline: number;
  missing: number;
  lastDiscoveryAt: string | null;
  lastMonitoringAt: string | null;
}

export interface HostnameHint {
  hostname: string;
  status: 'matched' | 'unverified';
  /** Result of a DNS lookup from the monitor; a record is a hint, not proof of a live service. */
  dns: 'resolves' | 'no-record' | 'unknown';
  entityId: string | null;
  via: string | null;
}

/** A city block in tile coordinates; roads run along its edges. */
export interface BlockView {
  x: number;
  y: number;
  size: number;
  group: string;
  district: string;
}

export const BLOCK_PITCH = 7;

export interface WorldSnapshot {
  mode: Origin;
  entities: EntityView[];
  blocks: BlockView[];
  adapters: AdapterStatus[];
  hints: HostnameHint[];
  recentEvents: WorldEvent[];
  connected: boolean; // has at least one successful inventory ever
  actionsEnabled: boolean;
  serverTime: string;
}

export type ServerMessage =
  | { t: 'snapshot'; data: WorldSnapshot }
  | { t: 'entity'; data: EntityView }
  | { t: 'event'; data: WorldEvent }
  | { t: 'adapters'; data: AdapterStatus[] }
  | { t: 'blocks'; data: BlockView[] }
  | { t: 'removed'; data: { id: string } }
  | { t: 'hints'; data: HostnameHint[] };

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
  unreachable: 'Unreachable',
  starting: 'Starting',
  restarting: 'Restarting',
  host_offline: 'Host offline',
  unknown: 'Unknown',
};

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  discovered: 'Discovered',
  active: 'Active',
  missing: 'Missing — awaiting confirmation',
  removed: 'Removal confirmed',
  archived: 'Archived',
};

/** The health shown to users: host outage overrides own state visually, own state is kept. */
export function effectiveHealth(e: Pick<EntityView, 'health' | 'inheritedHostOffline'>): Health {
  return e.inheritedHostOffline ? 'host_offline' : e.health;
}

export function computeSummary(
  entities: EntityView[],
  adapters: AdapterStatus[],
  lastMonitoringAt: string | null,
): Summary {
  const visible = entities.filter((e) => e.lifecycle !== 'archived' && e.lifecycle !== 'removed' && e.kind !== 'project');
  const s: Summary = {
    total: 0, healthy: 0, degradedOrUnhealthy: 0, unreachable: 0, unknown: 0,
    hostsOffline: 0, missing: 0, lastDiscoveryAt: null, lastMonitoringAt,
  };
  for (const e of visible) {
    if (e.kind === 'host') {
      if (e.health === 'host_offline') s.hostsOffline++;
      continue;
    }
    s.total++;
    if (e.lifecycle === 'missing') s.missing++;
    const h = effectiveHealth(e);
    if (h === 'healthy') s.healthy++;
    else if (h === 'degraded' || h === 'unhealthy' || h === 'restarting') s.degradedOrUnhealthy++;
    else if (h === 'unreachable' || h === 'host_offline') s.unreachable++;
    else if (h === 'unknown' || h === 'starting') s.unknown++;
  }
  for (const a of adapters) {
    if (a.lastCompleteAt && (!s.lastDiscoveryAt || a.lastCompleteAt > s.lastDiscoveryAt)) s.lastDiscoveryAt = a.lastCompleteAt;
  }
  return s;
}
