import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { parse as parseYaml } from 'yaml';
import type { HostnameHint } from '@berrie/shared';
import type { AppConfig, CheckConfig } from '../config.js';
import type { EntityRow, Repo } from '../db/repo.js';
import type { InventoryResult, ObservedEntity } from '../core/world.js';
import { redactError } from '../core/redact.js';
import { classify, isBuildingType } from './classify.js';
import { hostEntityId } from './docker.js';

/** Hosts and manually configured services. The config file is always a complete inventory of itself. */
export function configInventory(cfg: AppConfig, hosts: Map<string, { name: string; meta: Record<string, unknown> }> = new Map()): InventoryResult {
  const entities: ObservedEntity[] = [];
  for (const h of cfg.hosts) {
    const d = hosts.get(h.id);
    entities.push({
      id: hostEntityId(h.id), kind: 'host', name: d?.name ?? h.name, buildingType: 'server', parentId: null, hostId: hostEntityId(h.id),
      meta: { configuredId: h.id, docker: h.docker?.url ? 'proxy' : h.docker?.socketPath ? 'socket' : 'none', ...(d?.meta ?? {}) },
    });
  }
  for (const s of cfg.services) {
    const hostId = s.host ? hostEntityId(s.host) : null;
    entities.push({
      id: `manual:${s.id}`, kind: 'service', name: s.name,
      buildingType: isBuildingType(s.type) ? s.type : classify({ names: [s.id, s.name], hasHttp: s.check?.type === 'http' }),
      parentId: hostId, hostId, hostnames: s.hostnames ?? [],
      meta: { manual: true, check: s.check ? describeCheck(s.check) : null },
    });
  }
  return { adapter: 'config', scope: 'config', completeness: 'complete', entities };
}

export function describeCheck(c: CheckConfig): string {
  return c.type === 'tcp' ? `tcp://${c.host}:${c.port}` : c.url ?? '';
}

interface IngressRule { hostname: string; service: string }

async function readTunnelIngress(paths: string[]): Promise<{ rules: IngressRule[]; errors: string[] }> {
  const rules: IngressRule[] = [];
  const errors: string[] = [];
  for (const p of paths) {
    try {
      const doc = parseYaml(await readFile(p, 'utf8')) as { ingress?: { hostname?: string; service?: string }[] };
      for (const r of doc?.ingress ?? []) if (r.hostname && r.service) rules.push({ hostname: r.hostname.toLowerCase(), service: r.service });
    } catch (err) {
      errors.push(`${p}: ${redactError(err, 120)}`);
    }
  }
  return { rules, errors };
}

/** Resolve an ingress service URL (http://container:port or http://localhost:port) to a known service entity. */
function matchIngress(service: string, services: EntityRow[]): EntityRow | undefined {
  let u: URL;
  try { u = new URL(service); } catch { return undefined; }
  const host = u.hostname;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (host === 'localhost' || host === '127.0.0.1' || host === 'host.docker.internal') {
    return services.find((s) => ((s.meta.ports as string[]) ?? []).some((p) => p.includes(`:${port}->`)));
  }
  return services.find((s) => s.meta.containerName === host || s.meta.composeService === host);
}

function resolveServiceRef(ref: string, services: EntityRow[]): EntityRow | undefined {
  if (ref.startsWith('compose:')) {
    const [project, svc] = ref.slice(8).split('/');
    return services.find((s) => s.meta.composeProject === project && s.meta.composeService === svc);
  }
  if (ref.startsWith('container:')) return services.find((s) => s.meta.containerName === ref.slice(10));
  return services.find((s) => s.id === ref);
}

export interface EndpointPlan {
  inventory: InventoryResult;
  checks: { entityId: string; check: CheckConfig }[];
}

/**
 * Endpoints (public hostnames) from config, container labels and cloudflared ingress files.
 * Each endpoint becomes a child of the service it routes to, or a standalone building if none is known.
 */
export async function endpointInventory(cfg: AppConfig, repo: Repo): Promise<EndpointPlan> {
  const services = repo.listEntities().filter((e) => e.kind === 'service' && e.lifecycle !== 'removed');
  const found = new Map<string, { hostname: string; target?: EntityRow; via: string; check?: CheckConfig | false; host?: string }>();

  const { rules, errors } = await readTunnelIngress(cfg.tunnelConfigPaths);
  for (const r of rules) {
    if (r.hostname.includes('*')) continue;
    found.set(r.hostname, { hostname: r.hostname, target: matchIngress(r.service, services), via: 'tunnel ingress' });
  }
  for (const s of services) {
    for (const h of s.hostnames) found.set(h.toLowerCase(), { hostname: h.toLowerCase(), target: s, via: s.meta.manual ? 'config service' : 'container label' });
  }
  for (const ep of cfg.endpoints) {
    const hn = ep.hostname.toLowerCase();
    const prev = found.get(hn);
    found.set(hn, {
      hostname: hn, via: 'config endpoint', check: ep.check, host: ep.host,
      target: (ep.service ? resolveServiceRef(ep.service, services) : undefined) ?? prev?.target,
    });
  }

  const entities: ObservedEntity[] = [];
  const checks: EndpointPlan['checks'] = [];
  for (const f of found.values()) {
    const id = `endpoint:${f.hostname}`;
    const hostId = f.target?.hostId ?? (f.host ? hostEntityId(f.host) : null);
    entities.push({
      id, kind: 'endpoint', name: f.hostname, buildingType: classify({ names: [f.hostname.split('.')[0]], hasHttp: true }),
      parentId: f.target?.id ?? hostId, hostId, hostnames: [f.hostname],
      meta: { via: f.via, routesTo: f.target?.id ?? null, url: `https://${f.hostname}/` },
    });
    if (f.check !== false) {
      checks.push({ entityId: id, check: f.check || { type: 'http', url: `https://${f.hostname}/`, intervalSeconds: 180, timeoutMs: 10000, failureThreshold: 3 } });
    }
  }
  return {
    // A tunnel file that could not be read makes this inventory incomplete: its endpoints must not be removed.
    inventory: { adapter: 'endpoints', scope: 'endpoints', completeness: errors.length ? 'incomplete' : 'complete', entities, error: errors.join('; ') || null },
    checks,
  };
}

const dnsCache = new Map<string, { at: number; dns: HostnameHint['dns'] }>();

export async function hintStatus(cfg: AppConfig, repo: Repo): Promise<HostnameHint[]> {
  const all = repo.listEntities();
  const resolveDns = async (hostname: string): Promise<HostnameHint['dns']> => {
    const cached = dnsCache.get(hostname);
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.dns;
    let dns: HostnameHint['dns'] = 'unknown';
    try { await lookup(hostname); dns = 'resolves'; } catch (err) { dns = (err as { code?: string }).code === 'ENOTFOUND' ? 'no-record' : 'unknown'; }
    dnsCache.set(hostname, { at: Date.now(), dns });
    return dns;
  };
  return Promise.all(cfg.hints.map(async (raw) => {
    const hostname = raw.toLowerCase();
    const ep = all.find((e) => e.kind === 'endpoint' && e.hostnames.includes(hostname));
    const parent = ep?.parentId ? all.find((p) => p.id === ep.parentId) : undefined;
    return {
      hostname, status: ep ? 'matched' as const : 'unverified' as const, dns: await resolveDns(hostname),
      entityId: ep ? (parent?.kind === 'service' ? parent.id : ep.id) : null, via: ep ? String(ep.meta.via) : null,
    };
  }));
}
