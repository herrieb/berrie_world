import type { ConnectionType, Health, HostFacts, Verification } from '@berrie/shared';
import type { AppConfig, CheckConfig, GatewayConfig } from '../config.js';
import type { EntityRow, Repo } from '../db/repo.js';
import { hostEntityId } from '../adapters/docker.js';
import type { HostManager } from './hosts.js';
import { connectionId, type ConnectionInventory, type InventoryResult, type ObservedConnection, type ObservedEntity } from './world.js';

export const gatewayEntityId = (g: GatewayConfig) => g.entity ?? `gateway:${g.host}:${g.id}`;
export const externalEntityId = (id: string) => `external:${id}`;
export const CLOUDFLARE_EDGE = 'external:cloudflare-edge';

/** Hostname glob ("*.example.com") → test. */
export function globMatch(glob: string, hostname: string): boolean {
  const re = new RegExp(`^${glob.toLowerCase().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^.]+')}$`);
  return re.test(hostname.toLowerCase());
}

/** The gateway a public hostname passes through, if any configured route matches it. */
export function gatewayFor(cfg: AppConfig, hostname: string): GatewayConfig | undefined {
  return cfg.gateways.find((g) => (g.routes ?? []).some((r) => globMatch(r, hostname)));
}

const SIGNAL_FRESH_MS = 5 * 60_000;

/** Gateway health from a real signal only: a configured check (scheduled separately) or a collector's report. */
function gatewaySignal(g: GatewayConfig, hm: HostManager): { health: Health; reason: string } | null {
  if (g.kind !== 'cloudflare-tunnel') return null;
  const x = hm.extras.get(g.host);
  if (!x || Date.now() - Date.parse(x.ts) > SIGNAL_FRESH_MS) return null;
  if (x.cloudflared === 'active') return { health: 'healthy', reason: `cloudflared active (collector on ${g.host})` };
  if (x.cloudflared === 'inactive') return { health: 'unhealthy', reason: `cloudflared not running (collector on ${g.host})` };
  return null;
}

export interface TopologyPlan {
  entities: InventoryResult;
  connections: ConnectionInventory[];
  checks: { entityId: string; check: CheckConfig }[];
}

/**
 * Build the topology from real sources only. Nothing is inferred from mere reachability:
 * - compose depends_on → configured dependency/database links
 * - configured gateways + endpoint routes → tunnel/proxy hops (verified when a collector sees the tunnel running)
 * - `tailscale status` reported by a host's collector → verified VPN links between registered hosts
 * - the config file → configured links and external services
 */
export function buildTopology(cfg: AppConfig, repo: Repo, hm: HostManager): TopologyPlan {
  const all = repo.listEntities();
  const byId = new Map(all.map((e) => [e.id, e]));
  const entities: ObservedEntity[] = [];
  const checks: TopologyPlan['checks'] = [];

  // ---- gateways and external services (entities) ----
  const needEdge = cfg.gateways.some((g) => g.kind === 'cloudflare-tunnel');
  if (needEdge) {
    entities.push({ id: CLOUDFLARE_EDGE, kind: 'external', name: 'Cloudflare edge', buildingType: 'port', parentId: null, hostId: null, meta: { provider: 'cloudflare', description: 'Public internet entry point for tunnelled hostnames' } });
  }
  for (const x of cfg.externals) {
    entities.push({ id: externalEntityId(x.id), kind: 'external', name: x.name, buildingType: 'port', parentId: null, hostId: null, hostnames: x.hostnames ?? [], meta: { configured: true } });
    if (x.check) checks.push({ entityId: externalEntityId(x.id), check: x.check });
  }
  for (const g of cfg.gateways) {
    if (g.entity) continue; // the gateway is an existing container entity
    const hostId = hostEntityId(g.host);
    const sig = gatewaySignal(g, hm);
    entities.push({
      id: gatewayEntityId(g), kind: 'gateway', name: g.name, buildingType: 'gateway', parentId: hostId, hostId,
      meta: { gatewayKind: g.kind, routes: g.routes ?? [], configured: true },
      ...(sig && !g.check ? { health: sig } : {}),
    });
    if (g.check) checks.push({ entityId: gatewayEntityId(g), check: g.check });
  }

  const inventories: ConnectionInventory[] = [];
  const conn = (type: ConnectionType, src: string, dst: string, verification: Verification, evidence: string[], extra: Partial<ObservedConnection> = {}): ObservedConnection =>
    ({ id: connectionId(type, src, dst), src, dst, type, verification, evidence, ...extra });
  const health = (id: string): Health | null => { const st = repo.getStatus(id); return st ? st.health : null; };

  // ---- compose dependencies ----
  const deps: ObservedConnection[] = [];
  for (const e of all) {
    if (e.kind !== 'service' || e.lifecycle === 'removed') continue;
    for (const d of e.dependsOn) {
      const target = byId.get(d);
      if (!target) continue;
      const type: ConnectionType = target.buildingType === 'silo' || target.buildingType === 'cache' ? 'database' : 'dependency';
      deps.push(conn(type, e.id, d, 'configured', [`docker compose: ${e.name} depends_on ${target.name}${e.meta.composeProject ? ` (project ${e.meta.composeProject})` : ''}`],
        { health: { health: 'unknown', reason: 'link not measured' } }));
    }
  }
  inventories.push({ source: 'compose', scope: 'all', completeness: 'complete', connections: deps });

  // ---- gateway routes: internet → edge → gateway → service ----
  const routes: ObservedConnection[] = [];
  for (const g of cfg.gateways) {
    const gid = gatewayEntityId(g);
    if (!byId.has(gid) && !entities.some((x) => x.id === gid)) continue;
    const sig = gatewaySignal(g, hm);
    const gHealth = health(gid) ?? sig?.health ?? 'unknown';
    const endpoints = all.filter((e) => e.kind === 'endpoint' && e.lifecycle !== 'removed' && e.hostnames.some((h) => (g.routes ?? []).some((r) => globMatch(r, h))));
    if (g.kind === 'cloudflare-tunnel') {
      routes.push(conn('internet', CLOUDFLARE_EDGE, gid, sig?.health === 'healthy' ? 'verified' : 'configured',
        [`gateway ${g.name} is a Cloudflare Tunnel (config)`, ...(sig ? [sig.reason] : ['tunnel state not reported by a collector'])],
        { health: { health: gHealth === 'healthy' ? 'healthy' : gHealth === 'unhealthy' || gHealth === 'unreachable' ? 'unreachable' : 'unknown', reason: sig?.reason ?? 'tunnel state not measured' },
          meta: { hostnames: endpoints.flatMap((e) => e.hostnames).slice(0, 50), label: 'Cloudflare Tunnel' } }));
    }
    // Group public hostnames by the service they route to.
    const byTarget = new Map<string, string[]>();
    for (const ep of endpoints) {
      const target = ep.meta.routesTo as string | null;
      if (!target || !byId.has(target)) continue;
      byTarget.set(target, [...(byTarget.get(target) ?? []), ...ep.hostnames]);
    }
    for (const [target, hostnames] of byTarget) {
      const t = health(target);
      const hop: Health = gHealth === 'unhealthy' || gHealth === 'unreachable' ? 'unreachable' : t === 'unhealthy' || t === 'unreachable' ? 'unhealthy' : gHealth === 'healthy' && t === 'healthy' ? 'healthy' : 'unknown';
      routes.push(conn('proxy', gid, target, 'configured', hostnames.map((h) => `route ${h} → ${byId.get(target)!.name} (${String(all.find((e) => e.hostnames.includes(h))?.meta.via ?? 'config')})`),
        { health: { health: hop, reason: hop === 'unreachable' ? `gateway ${g.name} is down` : hop === 'unhealthy' ? 'target service is failing' : hop === 'healthy' ? 'gateway and target healthy' : 'not fully known' }, meta: { hostnames } }));
    }
  }
  inventories.push({ source: 'gateway', scope: 'all', completeness: 'complete', connections: routes });

  // ---- tailscale (per reporting host) ----
  const hosts = hm.resolve().filter((h) => h.status === 'active');
  const keyToHost = new Map<string, string>();
  for (const h of hosts) {
    const facts = repo.getEntity(h.entityId)?.meta.facts as HostFacts | undefined;
    for (const k of [h.id, h.name, facts?.identity.value?.hostname, h.row?.settings.address].filter(Boolean) as string[]) keyToHost.set(k.toLowerCase(), h.entityId);
  }
  for (const h of hosts) {
    const x = hm.extras.get(h.id);
    if (!x?.tailscale || Date.now() - Date.parse(x.ts) > SIGNAL_FRESH_MS) continue; // no fresh report → no inventory → nothing goes missing
    const ts = x.tailscale as { Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; Online?: boolean; CurAddr?: string; Relay?: string }> };
    const links: ObservedConnection[] = [];
    for (const p of Object.values(ts.Peer ?? {})) {
      const keys = [p.HostName, p.DNSName?.split('.')[0], ...(p.TailscaleIPs ?? [])].filter(Boolean).map((k) => k!.toLowerCase());
      const other = keys.map((k) => keyToHost.get(k)).find(Boolean);
      if (!other || other === h.entityId) continue;
      const direct = !!p.CurAddr;
      links.push(conn('vpn', h.entityId, other, 'verified', [`tailscale status on ${h.name}: peer ${p.HostName ?? p.DNSName} ${p.Online ? 'online' : 'offline'}${direct ? ', direct connection' : p.Relay ? `, relayed via DERP ${p.Relay}` : ''}`],
        { health: { health: p.Online ? 'healthy' : 'unreachable', reason: p.Online ? 'peer online in tailscale' : 'peer offline in tailscale' }, meta: { direct, relay: p.Relay ?? null, label: 'Tailscale' } }));
    }
    inventories.push({ source: 'tailscale', scope: h.id, completeness: 'complete', connections: links });
  }

  // ---- configured links ----
  const declared: ObservedConnection[] = [];
  const ref = (r: string) => (byId.has(r) ? r : byId.has(hostEntityId(r)) ? hostEntityId(r) : byId.has(externalEntityId(r)) || cfg.externals.some((x) => x.id === r) ? externalEntityId(r) : null);
  for (const c of cfg.connections) {
    const a = ref(c.from), b = ref(c.to);
    if (!a || !b) continue;
    declared.push(conn(c.type, a, b, 'configured', [`declared in the config file${c.description ? `: ${c.description}` : ''}`], { health: { health: 'unknown', reason: 'link not measured' }, meta: { label: c.description } }));
  }
  inventories.push({ source: 'config', scope: 'config', completeness: 'complete', connections: declared });

  return { entities: { adapter: 'topology', scope: 'topology', completeness: 'complete', entities }, connections: inventories, checks };
}

/** Is `e` currently known to be failing by its own checks or state? */
export function ownFailure(e: EntityRow, repo: Repo): boolean {
  const st = repo.getStatus(e.id);
  if (!st) return false;
  if (st.health === 'unhealthy' || st.health === 'unreachable' || st.health === 'host_offline') return true;
  const host = e.hostId && e.hostId !== e.id ? repo.getStatus(e.hostId) : undefined;
  return host?.health === 'host_offline';
}
