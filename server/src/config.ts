import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CheckConfig {
  type: 'http' | 'tcp';
  url?: string; // http
  host?: string; // tcp
  port?: number; // tcp
  /** Accepted HTTP status codes as ranges, e.g. ["200-399", "401"]. */
  expectStatus?: string[];
  intervalSeconds?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  successThreshold?: number;
}

export interface HostConfig {
  id: string;
  name: string;
  /** Docker endpoint: unix socket path or http(s) URL of a read-only socket proxy. */
  docker?: { socketPath?: string; url?: string };
  /** Reachability probe for detecting a host outage (distinct from Docker being down). */
  probe?: CheckConfig;
}

export interface EndpointConfig {
  hostname: string;
  /** Target service: "compose:<project>/<service>", "container:<name>" or an entity id. */
  service?: string;
  host?: string;
  check?: CheckConfig | false;
}

export interface ManualServiceConfig {
  id: string;
  name: string;
  type?: string;
  host?: string;
  hostnames?: string[];
  check?: CheckConfig;
}

export interface AppConfig {
  mode: 'live' | 'demo';
  port: number;
  bindHost: string;
  dataDir: string;
  dbPath: string;
  webDist: string | null;
  adminToken: string | null;
  ingestToken: string | null;
  /** BERRIE_MASTER_KEY: encrypts stored credentials and TOTP seeds. Falls back to a 0600 key file in DATA_DIR. */
  masterKey: string | null;
  session: { maxDays: number; idleHours: number };
  actionsEnabled: boolean;
  secureCookies: boolean;
  discoveryIntervalSeconds: number;
  removal: { confirmations: number; minMissingSeconds: number; archiveAfterHours: number };
  retention: { checkResultDays: number; eventDays: number; auditDays: number; archivedEntityDays: number | null };
  /** Docker inventory failures before own health is reported as unknown. */
  unknownAfterInventoryFailures: number;
  hosts: HostConfig[];
  endpoints: EndpointConfig[];
  services: ManualServiceConfig[];
  hints: string[];
  /** Entity ids or container names that must never be controlled through actions. */
  protected: string[];
  tunnelConfigPaths: string[];
  /** Optional TCP target used to tell "endpoint down" from "monitor has no network". */
  canary: { host: string; port: number } | null;
}

function envBool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envInt(v: string | undefined, d: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = envBool(env.DEMO_MODE, false) ? 'demo' : 'live';
  const dataDir = resolve(env.DATA_DIR ?? './data');
  const configPath = resolve(env.CONFIG_PATH ?? './config/berrie.config.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let file: any = {};
  if (existsSync(configPath)) file = JSON.parse(readFileSync(configPath, 'utf8'));

  const hosts: HostConfig[] = file.hosts ?? [
    { id: env.HOST_ID ?? 'local', name: env.HOST_NAME ?? 'local', docker: env.DOCKER_PROXY_URL ? { url: env.DOCKER_PROXY_URL } : { socketPath: env.DOCKER_SOCKET ?? '/var/run/docker.sock' } },
  ];

  return {
    mode,
    port: envInt(env.PORT, 4780),
    bindHost: env.BIND_HOST ?? '127.0.0.1',
    dataDir,
    dbPath: resolve(dataDir, mode === 'demo' ? 'berrie-demo.sqlite' : 'berrie.sqlite'),
    webDist: env.WEB_DIST ? resolve(env.WEB_DIST) : null,
    adminToken: env.ADMIN_TOKEN || null,
    ingestToken: env.INGEST_TOKEN || null,
    masterKey: env.BERRIE_MASTER_KEY || null,
    session: { maxDays: envInt(env.SESSION_DAYS, 7), idleHours: envInt(env.SESSION_IDLE_HOURS, 24) },
    actionsEnabled: envBool(env.ENABLE_ACTIONS, false),
    secureCookies: envBool(env.SECURE_COOKIES, false),
    discoveryIntervalSeconds: envInt(env.DISCOVERY_INTERVAL, file.discoveryIntervalSeconds ?? 30),
    removal: {
      confirmations: file.removal?.confirmations ?? 3,
      minMissingSeconds: file.removal?.minMissingSeconds ?? 120,
      archiveAfterHours: file.removal?.archiveAfterHours ?? 24,
    },
    retention: {
      checkResultDays: file.retention?.checkResultDays ?? 7,
      eventDays: file.retention?.eventDays ?? 90,
      auditDays: file.retention?.auditDays ?? 365,
      archivedEntityDays: file.retention?.archivedEntityDays ?? null,
    },
    unknownAfterInventoryFailures: file.unknownAfterInventoryFailures ?? 2,
    hosts,
    endpoints: file.endpoints ?? [],
    services: file.services ?? [],
    hints: file.hints ?? [],
    protected: file.protected ?? [],
    tunnelConfigPaths: file.tunnelConfigPaths ?? [],
    canary: file.canary ?? null,
  };
}
