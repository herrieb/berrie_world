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

export type EntityKind = 'host' | 'project' | 'service' | 'endpoint' | 'gateway' | 'external';

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
  | 'gateway' // reverse proxy / tunnel / gateway
  | 'port' // external third-party service (on the external island)
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
  | 'layout.moved'
  | 'connection.discovered'
  | 'connection.missing'
  | 'connection.removed'
  | 'connection.degraded'
  | 'connection.recovered';

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
  connections: ConnectionView[];
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
  | { t: 'hints'; data: HostnameHint[] }
  | { t: 'connection'; data: ConnectionView };

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

// ---------------------------------------------------------------- accounts

export type Role = 'admin' | 'operator' | 'viewer';
export const ROLES: Role[] = ['admin', 'operator', 'viewer'];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const ROLE_LABEL: Record<Role, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };

/** Procedurally generated pixel avatar; no uploads. */
export interface Avatar { seed: number; color: string; style: number }

export interface UserView {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  /** 'all' = every server; 'list' = only `hosts`. Admins always see everything. */
  hostScope: 'all' | 'list';
  hosts: string[];
  status: 'active' | 'disabled' | 'deleted';
  totpEnabled: boolean;
  avatar: Avatar | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Me {
  user: UserView | null;
  /** No users exist yet: the first administrator must be created with the bootstrap token. */
  setupRequired: boolean;
  /** Password accepted, waiting for the TOTP code. */
  mfaPending: boolean;
  actionsEnabled: boolean;
}

export interface NotificationPrefs {
  inApp: boolean;
  browser: boolean;
  minSeverity: Severity;
  /** Only notify about servers the user has marked as favorite. */
  favoritesOnly: boolean;
}

/** Personal, per-user state. Never affects what other users see. */
export interface UserPrefs {
  daylight?: 'auto' | 'day' | 'night';
  camera?: { x: number; y: number; zoom: number };
  /** Personal island arrangement: offset in tiles per island (host entity id). */
  islandOffsets?: Record<string, { dx: number; dy: number }>;
  labelDensity?: 'less' | 'auto' | 'more';
  notifications?: NotificationPrefs;
}

export interface SavedViewFilters { text: string; health: string; type: string; host: string }
export interface SavedView {
  id: string;
  name: string;
  view: { filters: SavedViewFilters; camera?: { x: number; y: number; zoom: number } };
  createdAt: string;
}

export interface UserTask {
  id: string;
  title: string;
  notes: string | null;
  entityId: string | null;
  dueAt: string | null;
  doneAt: string | null;
  createdAt: string;
}

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = { inApp: true, browser: false, minSeverity: 'warning', favoritesOnly: false };

// ---------------------------------------------------------------- servers, facts and metrics

/**
 * Collection status of a piece of information. Never shown as a value when not 'confirmed'/'stale':
 * - confirmed: measured within the expected interval
 * - stale: measured, but longer ago than expected (shown with its age)
 * - unavailable: a collector tried and failed (permission, command missing, connection error)
 * - unconfigured: no adapter for this host collects it
 * - unknown: should be collected but no result yet
 */
export type FactStatus = 'confirmed' | 'stale' | 'unavailable' | 'unconfigured' | 'unknown';

export interface Fact<T> { status: FactStatus; value: T | null; ts: string | null; source: string | null; error?: string | null }

export interface HostFacts {
  identity: Fact<{ hostname: string }>;
  os: Fact<{ name: string; version: string | null; kernel: string | null; arch: string | null }>;
  cpu: Fact<{ cores: number; model: string | null; usagePct: number | null }>;
  memory: Fact<{ totalBytes: number; usedBytes: number | null; usedPct: number | null; swapTotalBytes: number | null; swapUsedBytes: number | null }>;
  storage: Fact<{ filesystems: { mount: string; fstype: string; sizeBytes: number; usedBytes: number; usedPct: number }[] }>;
  network: Fact<{ interfaces: { name: string; rxBps: number | null; txBps: number | null }[] }>;
  uptime: Fact<{ seconds: number; load1: number; load5: number; load15: number }>;
  containers: Fact<{ running: number; stopped: number; total: number }>;
}
export type FactCategory = keyof HostFacts;
export const FACT_CATEGORIES: FactCategory[] = ['identity', 'os', 'cpu', 'memory', 'storage', 'network', 'uptime', 'containers'];
export const FACT_LABEL: Record<FactCategory, string> = {
  identity: 'Hostname', os: 'Operating system', cpu: 'CPU', memory: 'Memory', storage: 'Storage', network: 'Network', uptime: 'Uptime & load', containers: 'Containers',
};

export type DiscoveryMethod = 'ssh' | 'agent' | 'docker' | 'manual';
export type Biome = 'meadow' | 'autumn' | 'snow' | 'desert' | 'tropical';
export const BIOMES: Biome[] = ['meadow', 'autumn', 'snow', 'desert', 'tropical'];

/** A server as shown in Server Harbor. Secrets are never included. */
export interface HostRegistration {
  id: string;
  entityId: string;
  name: string;
  tags: string[];
  method: DiscoveryMethod;
  /** 'config' = defined in the config file (read-only in Harbor). */
  source: 'harbor' | 'config';
  settings: {
    address?: string; port?: number; username?: string; authMethod?: 'key' | 'password';
    docker?: 'none' | 'socket' | 'tcp'; dockerSocket?: string; dockerTcpPort?: number; dockerUrl?: string;
    intervalSeconds?: number; probe?: boolean; description?: string;
  };
  status: 'active' | 'suspended' | 'archived';
  hostKeyFingerprint: string | null;
  hasCredential: boolean;
  agentConfigured: boolean;
  appearance: { biome?: Biome };
  createdAt: string | null;
  archivedAt: string | null;
  lastContactAt: string | null;
  lastError: string | null;
}

export interface MetricSeries { metric: string; source: string | null; resolution: 'raw' | 'hourly'; points: { ts: string; value: number; min?: number; max?: number }[] }

// ---------------------------------------------------------------- topology

/**
 * - lan/vpn/direct: verified private network relationships between hosts → bridges
 * - internet: known public-internet paths → ferries
 * - tunnel/proxy: hops through gateways (reverse proxies, tunnels)
 * - dependency/database/api: configured or observed application dependencies
 */
export type ConnectionType = 'lan' | 'vpn' | 'direct' | 'internet' | 'tunnel' | 'proxy' | 'dependency' | 'database' | 'api';

/**
 * - verified: confirmed by a source that observes the actual network state (e.g. `tailscale status` on the host)
 * - configured: declared in configuration (compose depends_on, gateway routes, config file)
 * - observed: real traffic was reported between the two
 * - inferred / unverified: plausible but not confirmed — always drawn dashed and labelled
 */
export type Verification = 'verified' | 'configured' | 'observed' | 'inferred' | 'unverified';

export interface ConnectionView {
  id: string;
  src: string;
  dst: string;
  type: ConnectionType;
  source: string;
  verification: Verification;
  lifecycle: Lifecycle;
  health: Health;
  reason: string | null;
  /** Human-readable facts supporting the relationship. */
  evidence: string[];
  /** Measured values only (never estimated). */
  meta: { latencyMs?: number; lossPct?: number; measuredAt?: string; direct?: boolean; relay?: string | null; bytes?: number; label?: string; hostnames?: string[] };
  firstSeenAt: string;
  lastSeenAt: string | null;
  lastActivityAt: string | null;
}

export const CONNECTION_LABEL: Record<ConnectionType, string> = {
  lan: 'LAN', vpn: 'VPN', direct: 'Direct link', internet: 'Internet', tunnel: 'Tunnel', proxy: 'Reverse proxy', dependency: 'Depends on', database: 'Database', api: 'API call',
};
export const BRIDGE_TYPES: ConnectionType[] = ['lan', 'vpn', 'direct'];

export interface RouteHop { entityId: string; via: ConnectionView | null }

export type ImpactClass = 'confirmed' | 'likely' | 'unknown' | 'unaffected';
export interface ImpactItem { entityId: string; class: ImpactClass; path: string[]; why: string }
export interface ImpactReport {
  root: string;
  simulated: boolean;
  items: ImpactItem[];
  /** Plain-language summary; a cause is always labelled as a hypothesis unless verified. */
  summary: string;
}
