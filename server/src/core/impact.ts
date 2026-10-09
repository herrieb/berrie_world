import type { ConnectionView, ImpactItem, ImpactReport, RouteHop, Verification } from '@berrie/shared';
import type { AppConfig } from '../config.js';
import { ConnectionStore } from '../db/connections.js';
import type { EntityRow, Repo } from '../db/repo.js';
import { CLOUDFLARE_EDGE, gatewayEntityId, gatewayFor, ownFailure } from './topology.js';

/** "A relies on B": if B fails, A may be affected. */
interface Reliance { from: string; to: string; verification: Verification; why: string; connection: ConnectionView | null }

const STRONG: Verification[] = ['verified', 'configured'];
const FRESH_MS = 10 * 60_000;

function relianceGraph(cfg: AppConfig, repo: Repo): { edges: Reliance[]; byId: Map<string, EntityRow> } {
  const all = repo.listEntities().filter((e) => e.lifecycle !== 'removed');
  const byId = new Map(all.map((e) => [e.id, e]));
  const conns = repo.connections.list().filter((c) => c.lifecycle !== 'removed').map(ConnectionStore.view);
  const edges: Reliance[] = [];
  for (const c of conns) {
    if (c.type === 'dependency' || c.type === 'database' || c.type === 'api') {
      edges.push({ from: c.src, to: c.dst, verification: c.verification, why: `${c.type} (${c.verification}: ${c.evidence[0] ?? c.source})`, connection: c });
    }
    if (c.type === 'internet' && c.src === CLOUDFLARE_EDGE) {
      edges.push({ from: c.dst, to: c.src, verification: c.verification, why: 'tunnel reaches the internet through the Cloudflare edge', connection: c });
    }
  }
  for (const e of all) {
    // Containment is a fact: a container runs on its host.
    if (e.hostId && e.hostId !== e.id && byId.has(e.hostId) && e.kind !== 'project') {
      edges.push({ from: e.id, to: e.hostId, verification: 'verified', why: `runs on ${byId.get(e.hostId)!.name}`, connection: null });
    }
    if (e.kind === 'endpoint') {
      const target = e.meta.routesTo as string | null;
      if (target && byId.has(target)) edges.push({ from: e.id, to: target, verification: 'configured', why: `public hostname routes to ${byId.get(target)!.name}`, connection: conns.find((c) => c.type === 'proxy' && c.dst === target) ?? null });
      const g = e.hostnames.map((h) => gatewayFor(cfg, h)).find(Boolean);
      if (g && byId.has(gatewayEntityId(g))) edges.push({ from: e.id, to: gatewayEntityId(g), verification: 'configured', why: `public hostname passes through gateway ${g.name}`, connection: conns.find((c) => c.type === 'proxy' && c.src === gatewayEntityId(g)) ?? null });
    }
  }
  return { edges, byId };
}

/**
 * Who may be affected if `rootId` fails (or is failing). Classes:
 * - confirmed: the dependent's own checks/state show it failing
 * - likely: reached only through verified/configured relationships, own state not confirmed either way
 * - unknown: reached through observed/inferred/unverified relationships
 * - unaffected: its own checks pass and are fresh
 * A cause is never asserted: the summary labels it as a hypothesis.
 */
export function impactOf(cfg: AppConfig, repo: Repo, rootId: string, simulate: boolean): ImpactReport {
  const { edges, byId } = relianceGraph(cfg, repo);
  const root = byId.get(rootId) ?? repo.getEntity(rootId);
  const items = new Map<string, ImpactItem>();
  const queue: { id: string; path: string[]; strong: boolean; why: string }[] = [{ id: rootId, path: [rootId], strong: true, why: '' }];
  const seen = new Set([rootId]);
  while (queue.length) {
    const cur = queue.shift()!;
    for (const r of edges.filter((x) => x.to === cur.id)) {
      if (seen.has(r.from) || seen.size > 2000) continue;
      seen.add(r.from);
      const e = byId.get(r.from);
      if (!e) continue;
      const strong = cur.strong && STRONG.includes(r.verification);
      const path = [...cur.path, r.from];
      let cls: ImpactItem['class'] = strong ? 'likely' : 'unknown';
      let why = `${r.why}${strong ? '' : ' — relationship not verified'}`;
      if (!simulate) {
        const st = repo.getStatus(e.id);
        if (ownFailure(e, repo)) { cls = 'confirmed'; why = `own state: ${st?.health}${st?.reason ? ` (${st.reason})` : ''}`; }
        else if (st?.health === 'healthy' && st.lastSuccessAt && Date.now() - Date.parse(st.lastSuccessAt) < FRESH_MS) { cls = 'unaffected'; why = 'its own checks are passing'; }
      }
      items.set(e.id, { entityId: e.id, class: cls, path, why });
      queue.push({ id: e.id, path, strong, why });
    }
  }
  const list = [...items.values()];
  const n = (c: ImpactItem['class']) => list.filter((i) => i.class === c).length;
  const name = root?.displayName ?? root?.name ?? rootId;
  let summary: string;
  if (simulate) {
    summary = `Simulation (nothing was changed): if ${name} failed, ${n('likely')} dependent(s) would likely be affected and ${n('unknown')} might be (unverified relationships).`;
  } else {
    const failing = root ? ownFailure(root, repo) : false;
    summary = `${name} is ${failing ? 'failing' : 'not confirmed failing'}. Dependents: ${n('confirmed')} confirmed failing, ${n('likely')} likely affected, ${n('unknown')} unknown, ${n('unaffected')} verified fine.`;
    if (failing && n('confirmed')) summary += ` Hypothesis (not verified): ${name} may be the cause of the failures in its confirmed dependents.`;
  }
  return { root: rootId, simulated: simulate, items: list.sort((a, b) => ['confirmed', 'likely', 'unknown', 'unaffected'].indexOf(a.class) - ['confirmed', 'likely', 'unknown', 'unaffected'].indexOf(b.class)), summary };
}

/**
 * Root-cause hypothesis for a set of failing entities: failing nodes whose own dependencies are not failing.
 * Always returned as hypotheses with the reasoning; never as verified causes.
 */
export function causeHypotheses(cfg: AppConfig, repo: Repo, failing: string[]): { entityId: string; explains: string[]; reasoning: string }[] {
  const { edges, byId } = relianceGraph(cfg, repo);
  const set = new Set(failing);
  const out: { entityId: string; explains: string[]; reasoning: string }[] = [];
  for (const id of failing) {
    const upstreamFailing = edges.filter((r) => r.from === id && set.has(r.to));
    if (upstreamFailing.length) continue; // something it relies on is failing too: not a root
    const explains = impactOf(cfg, repo, id, false).items.filter((i) => i.class === 'confirmed' && set.has(i.entityId)).map((i) => i.entityId);
    out.push({ entityId: id, explains, reasoning: `${byId.get(id)?.name ?? id} is failing and none of the things it relies on are${explains.length ? `; ${explains.length} other failing item(s) rely on it` : ''}` });
  }
  return out.sort((a, b) => b.explains.length - a.explains.length);
}

/** Known path(s) from public endpoints to the application, plus upstream/downstream relationships. */
export function routeOf(cfg: AppConfig, repo: Repo, id: string): { routes: RouteHop[][]; upstream: { entityId: string; connection: ConnectionView | null; why: string }[]; downstream: { entityId: string; connection: ConnectionView | null; why: string }[] } {
  const { edges, byId } = relianceGraph(cfg, repo);
  const conns = repo.connections.list().filter((c) => c.lifecycle !== 'removed').map(ConnectionStore.view);
  const e = byId.get(id);
  const chainFor = (ep: EntityRow): RouteHop[] => {
    const hops: RouteHop[] = [{ entityId: ep.id, via: null }];
    const g = ep.hostnames.map((h) => gatewayFor(cfg, h)).find(Boolean);
    const target = ep.meta.routesTo as string | null;
    if (g) {
      const gid = gatewayEntityId(g);
      if (g.kind === 'cloudflare-tunnel' && byId.has(CLOUDFLARE_EDGE)) hops.push({ entityId: CLOUDFLARE_EDGE, via: null });
      hops.push({ entityId: gid, via: conns.find((c) => c.type === 'internet' && c.dst === gid) ?? null });
      if (target) hops.push({ entityId: target, via: conns.find((c) => c.type === 'proxy' && c.src === gid && c.dst === target) ?? null });
    } else if (target) hops.push({ entityId: target, via: null });
    return hops;
  };
  const routes: RouteHop[][] = [];
  if (e?.kind === 'endpoint') routes.push(chainFor(e));
  else if (e) for (const ep of [...byId.values()].filter((x) => x.kind === 'endpoint' && x.meta.routesTo === id)) routes.push(chainFor(ep));
  return {
    routes,
    upstream: edges.filter((r) => r.from === id).map((r) => ({ entityId: r.to, connection: r.connection, why: r.why })),
    downstream: edges.filter((r) => r.to === id).map((r) => ({ entityId: r.from, connection: r.connection, why: r.why })),
  };
}
