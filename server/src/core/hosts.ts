import type { Biome, DiscoveryMethod, FactCategory, HostFacts, HostRegistration } from '@berrie/shared';
import type { AppConfig, CheckConfig, HostConfig } from '../config.js';
import type { HostRow } from '../db/hosts.js';
import type { Repo } from '../db/repo.js';
import { DockerAdapter, hostEntityId } from '../adapters/docker.js';
import { DockerClient, type DockerTarget } from '../adapters/dockerClient.js';
import { SshTransport, describeSshError, fingerprintOf, isNetworkError, type SshSecret, type Transport } from '../adapters/ssh.js';
import { COLLECTOR_SH, mergeFacts, parseCollector, unconfiguredFacts } from './collector.js';
import { redactError } from './redact.js';
import type { SecretBox } from './secrets.js';
import type { InventoryResult, World } from './world.js';

export interface ResolvedHost {
  id: string;
  entityId: string;
  name: string;
  source: 'config' | 'harbor';
  method: DiscoveryMethod;
  status: HostRow['status'];
  tags: string[];
  appearance: { biome?: Biome };
  row: HostRow | null;
  config: HostConfig | null;
  intervalSeconds: number;
}

export type DockerEventHandler = (hostId: string, ev: { action: string; entityId: string | null; name: string; attrs: Record<string, string> }) => void;

/** Builds SSH transports; tests replace it with a fake. */
export type TransportFactory = (target: { address: string; port: number; username: string }, secret: SshSecret, hostKey: string) => Transport;

const COLLECTOR_CATEGORIES: FactCategory[] = ['identity', 'os', 'cpu', 'memory', 'storage', 'network', 'uptime', 'containers'];
const DOCKER_CATEGORIES: FactCategory[] = ['identity', 'os', 'cpu', 'memory', 'containers'];

/** Read-only "client" over the last container list an agent pushed. */
class StaticDockerClient extends DockerClient {
  constructor(private readonly list: unknown[], private readonly info: Record<string, unknown>) { super({ socketPath: '/nonexistent' }); }
  override async get<T>(path: string): Promise<T> {
    if (path.startsWith('/containers/json')) return this.list as T;
    if (path.startsWith('/info')) return this.info as T;
    throw new Error('not available for agent-reported hosts');
  }
  override async post(): Promise<number> { throw new Error('container actions are not available for agent-reported hosts'); }
  override async raw(): Promise<Buffer> { throw new Error('logs are not available for agent-reported hosts'); }
}

/**
 * Owns every server's discovery adapters: config-file hosts, hosts registered in Server Harbor (SSH, Docker API,
 * agent, manual), their collected facts and metrics. A failure to reach a host is reported as a signal, never as
 * evidence that the host or its services are gone.
 */
export class HostManager {
  readonly docker = new Map<string, DockerAdapter>();
  private transports = new Map<string, Transport>();
  private signatures = new Map<string, string>();
  private rt = new Map<string, { nextAt: number; running: boolean; netFailures: number; agentOverdueReported: boolean }>();
  private stopped = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly repo: Repo,
    private readonly world: World,
    private readonly box: SecretBox,
    private readonly hooks: { onDockerEvent?: DockerEventHandler; log?: (msg: string, extra?: Record<string, unknown>) => void; canary?: () => Promise<boolean> } = {},
    private readonly transportFactory: TransportFactory = (target, secret, hostKey) => new SshTransport(target, secret, hostKey),
    private readonly startEvents = true,
  ) {}

  private log(msg: string, extra?: Record<string, unknown>) { this.hooks.log?.(msg, extra); }

  // ---------------------------------------------------------------- registry

  resolve(includeArchived = false): ResolvedHost[] {
    const rows = new Map(this.repo.hosts.list(true).map((r) => [r.id, r]));
    const out: ResolvedHost[] = [];
    for (const c of this.cfg.hosts) {
      const overlay = rows.get(c.id) ?? null;
      rows.delete(c.id);
      out.push({
        id: c.id, entityId: hostEntityId(c.id), name: overlay?.name ?? c.name, source: 'config', method: c.docker ? 'docker' : 'manual',
        status: overlay?.status === 'suspended' ? 'suspended' : 'active', tags: overlay?.tags ?? [], appearance: overlay?.appearance ?? {},
        row: overlay, config: c, intervalSeconds: overlay?.settings.intervalSeconds ?? 60,
      });
    }
    for (const r of rows.values()) {
      if (r.status === 'archived' && !includeArchived) continue;
      out.push({
        id: r.id, entityId: hostEntityId(r.id), name: r.name, source: 'harbor', method: r.method, status: r.status, tags: r.tags,
        appearance: r.appearance, row: r, config: null, intervalSeconds: Math.max(30, r.settings.intervalSeconds ?? 60),
      });
    }
    return out;
  }

  get(id: string): ResolvedHost | undefined {
    return this.resolve(true).find((h) => h.id === id);
  }

  registration(h: ResolvedHost): HostRegistration {
    const r = h.row;
    const settings = { ...(r?.settings ?? {}) };
    if (h.config?.docker?.url) settings.dockerUrl = h.config.docker.url;
    return {
      id: h.id, entityId: h.entityId, name: h.name, tags: h.tags, method: h.method, source: h.source, settings, status: h.status,
      hostKeyFingerprint: r?.hostKey ? fingerprintOf(r.hostKey) : null, hasCredential: !!r?.credential, agentConfigured: !!r?.agentTokenHash,
      appearance: h.appearance, createdAt: r?.createdAt ?? null, archivedAt: r?.archivedAt ?? null, lastContactAt: r?.lastContactAt ?? null, lastError: r?.lastError ?? null,
    };
  }

  private secretFor(r: HostRow): SshSecret | null {
    if (!r.credential) return null;
    try { return JSON.parse(this.box.open(r.credential, `host:${r.id}`)) as SshSecret; } catch { return null; }
  }

  private dockerTargetFor(h: ResolvedHost): DockerTarget | null {
    if (h.config?.docker) return h.config.docker;
    const s = h.row?.settings;
    if (!s) return null;
    if (h.method === 'docker' && s.dockerUrl) return { url: s.dockerUrl };
    if (h.method === 'ssh' && s.docker && s.docker !== 'none') {
      const t = this.transports.get(h.id);
      if (!t) return null;
      if (s.docker === 'socket') return { connect: () => t.forwardSocket(s.dockerSocket || '/var/run/docker.sock') };
      if (s.docker === 'tcp' && s.dockerTcpPort) return { connect: () => t.forwardTcp('127.0.0.1', s.dockerTcpPort!) };
    }
    return null;
  }

  /** (Re)build adapters for hosts whose settings changed; stop those that were suspended, archived or removed. */
  sync(): void {
    if (this.stopped) return;
    const hosts = this.resolve();
    const active = new Set<string>();
    for (const h of hosts) {
      const sig = JSON.stringify([h.status, h.method, h.row?.settings, h.row?.credential, h.row?.hostKey, h.config?.docker]);
      if (h.status !== 'active') { this.teardown(h.id); this.signatures.set(h.id, sig); continue; }
      active.add(h.id);
      if (this.signatures.get(h.id) === sig && (this.docker.has(h.id) || !this.dockerTargetNeeded(h))) continue;
      this.teardown(h.id);
      this.signatures.set(h.id, sig);
      if (h.method === 'ssh' && h.row) {
        const secret = this.secretFor(h.row);
        if (!secret || !h.row.hostKey) { this.repo.hosts.update(h.id, { lastError: !secret ? 'no usable credential stored' : 'no pinned host key' }); continue; }
        try { this.transports.set(h.id, this.transportFactory({ address: h.row.settings.address!, port: h.row.settings.port ?? 22, username: h.row.settings.username! }, secret, h.row.hostKey)); } catch (err) { this.repo.hosts.update(h.id, { lastError: describeSshError(err) }); continue; }
      }
      const target = this.dockerTargetFor(h);
      if (target) {
        const d = new DockerAdapter({ id: h.id, name: h.name }, new DockerClient(target));
        this.docker.set(h.id, d);
        if (this.startEvents && this.hooks.onDockerEvent) d.startEvents((ev) => this.hooks.onDockerEvent!(h.id, ev));
      }
      if (!this.rt.has(h.id)) this.rt.set(h.id, { nextAt: Date.now() + Math.random() * 5000, running: false, netFailures: 0, agentOverdueReported: false });
    }
    for (const id of [...this.docker.keys(), ...this.transports.keys()]) if (!active.has(id)) this.teardown(id);
  }

  private dockerTargetNeeded(h: ResolvedHost): boolean {
    return !!h.config?.docker || (h.method === 'docker' && !!h.row?.settings.dockerUrl) || (h.method === 'ssh' && !!h.row?.settings.docker && h.row.settings.docker !== 'none');
  }

  private teardown(id: string): void {
    this.docker.get(id)?.stop();
    this.docker.delete(id);
    this.transports.get(id)?.close();
    this.transports.delete(id);
  }

  stop(): void {
    this.stopped = true;
    for (const id of [...this.docker.keys(), ...this.transports.keys()]) this.teardown(id);
  }

  // ---------------------------------------------------------------- inventories

  /** Hosts registered in Harbor, as a complete inventory of the registry itself. Config hosts come from configInventory. */
  hostInventory(): InventoryResult {
    return {
      adapter: 'harbor', scope: 'harbor', completeness: 'complete',
      entities: this.resolve().filter((h) => h.source === 'harbor').map((h) => ({
        id: h.entityId, kind: 'host' as const, name: h.name, buildingType: 'server' as const, parentId: null, hostId: h.entityId,
        meta: this.hostMeta(h),
      })),
    };
  }

  /** Metadata attached to a host entity: registration info plus collected facts (with their status). */
  hostMeta(h: ResolvedHost): Record<string, unknown> {
    const d = this.docker.get(h.id);
    return {
      source: h.source, method: h.method, tags: h.tags, appearance: h.appearance, monitoring: h.status,
      ...(d ? d.hostInfo : {}), facts: this.facts(h.id),
    };
  }

  /** Current facts with age applied. Hosts without any collector report everything as 'unconfigured'. */
  facts(hostId: string): HostFacts {
    const h = this.resolve().find((x) => x.id === hostId);
    const stored = this.repo.hosts.getFacts(hostId);
    if (!h) return stored ?? unconfiguredFacts();
    return mergeFacts(stored, {}, this.providedCategories(h), Date.now(), h.intervalSeconds * 3000);
  }

  private providedCategories(h: ResolvedHost): FactCategory[] {
    const c = new Set<FactCategory>();
    if (h.method === 'ssh' || h.row?.agentTokenHash) for (const x of COLLECTOR_CATEGORIES) c.add(x);
    if (this.dockerTargetNeeded(h)) for (const x of DOCKER_CATEGORIES) c.add(x);
    return [...c];
  }

  /** Facts derived from Docker's /info. Only fills categories a richer collector has not confirmed recently. */
  applyDockerInfo(hostId: string): void {
    const h = this.resolve().find((x) => x.id === hostId);
    const d = this.docker.get(hostId);
    if (!h || !d?.hostInfo.infoAt) return;
    const i = d.hostInfo as Record<string, unknown>;
    const ts = String(i.infoAt);
    const src = `docker:${hostId}`;
    const stored = this.repo.hosts.getFacts(hostId) ?? unconfiguredFacts();
    const fresh: Partial<HostFacts> = {};
    const richer = (c: FactCategory) => { const f = stored[c]; return f.status === 'confirmed' && f.source !== src; };
    if (!richer('identity') && i.hostname) fresh.identity = { status: 'confirmed', value: { hostname: String(i.hostname) }, ts, source: src };
    if (!richer('os') && i.os) fresh.os = { status: 'confirmed', value: { name: String(i.os), version: null, kernel: (i.kernel as string) ?? null, arch: (i.arch as string) ?? null }, ts, source: src };
    if (!richer('cpu') && Number(i.cpus) > 0) fresh.cpu = { status: 'confirmed', value: { cores: Number(i.cpus), model: null, usagePct: null }, ts, source: src };
    if (!richer('memory') && Number(i.memTotal) > 0) fresh.memory = { status: 'confirmed', value: { totalBytes: Number(i.memTotal), usedBytes: null, usedPct: null, swapTotalBytes: null, swapUsedBytes: null }, ts, source: src };
    if (Number.isFinite(Number(i.containers))) fresh.containers = { status: 'confirmed', value: { running: Number(i.containersRunning), stopped: Number(i.containersStopped), total: Number(i.containers) }, ts, source: src };
    this.repo.hosts.setFacts(hostId, mergeFacts(stored, fresh, this.providedCategories(h), Date.now(), h.intervalSeconds * 3000));
    this.world.patchMeta(h.entityId, { facts: this.facts(hostId) });
  }

  // ---------------------------------------------------------------- collection (SSH collector, agent staleness)

  async collectTick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const h of this.resolve()) {
      if (h.status !== 'active') continue;
      const rt = this.rt.get(h.id) ?? { nextAt: 0, running: false, netFailures: 0, agentOverdueReported: false };
      this.rt.set(h.id, rt);
      if (h.row?.agentTokenHash) this.checkAgentOverdue(h, rt);
      if (h.method !== 'ssh' || rt.running || rt.nextAt > now) continue;
      rt.running = true;
      void this.collect(h).finally(() => { rt.running = false; rt.nextAt = Date.now() + h.intervalSeconds * 1000 * (0.9 + Math.random() * 0.2); });
    }
  }

  /** Run the collector over SSH once. Returns the parse result (also used by "re-run discovery"). */
  async collect(h: ResolvedHost): Promise<{ ok: boolean; error?: string }> {
    const t = this.transports.get(h.id);
    if (!t) return { ok: false, error: h.row?.lastError ?? 'not connected' };
    const rt = this.rt.get(h.id)!;
    const ts = new Date().toISOString();
    try {
      const r = await t.exec(COLLECTOR_SH, { timeoutMs: 25_000 });
      const parsed = parseCollector(r.stdout, `ssh:${h.id}`, ts);
      this.storeCollected(h, parsed, ts, `ssh:${h.id}`);
      rt.netFailures = 0;
      this.repo.hosts.update(h.id, { lastContactAt: ts, lastError: null });
      this.world.setHostSignal(h.entityId, { probe: 'healthy', collector: 'ok', collectorError: null });
      return { ok: true };
    } catch (err) {
      const msg = describeSshError(err);
      this.repo.hosts.update(h.id, { lastError: msg });
      if (isNetworkError(err)) {
        // Only a reachable monitor network makes repeated connection failures meaningful.
        const ours = this.hooks.canary ? await this.hooks.canary() : true;
        if (ours) rt.netFailures++;
        if (rt.netFailures >= 3) this.world.setHostSignal(h.entityId, { probe: 'host_offline' });
      } else {
        // Host answered but refused us (auth, host key, permissions): reachable, collection failing.
        this.world.setHostSignal(h.entityId, { probe: 'healthy', collector: 'fail', collectorError: msg });
      }
      // Keep last values visible but mark the categories as failing now.
      const stored = this.repo.hosts.getFacts(h.id);
      const failed: Partial<HostFacts> = {};
      for (const c of COLLECTOR_CATEGORIES) (failed as Record<string, unknown>)[c] = { status: 'unavailable', value: null, ts, source: `ssh:${h.id}`, error: msg };
      this.repo.hosts.setFacts(h.id, mergeFacts(stored, failed, this.providedCategories(h), Date.now(), h.intervalSeconds * 3000));
      this.world.patchMeta(h.entityId, { facts: this.facts(h.id) });
      return { ok: false, error: msg };
    }
  }

  private storeCollected(h: ResolvedHost, parsed: ReturnType<typeof parseCollector>, ts: string, source: string): void {
    const stored = this.repo.hosts.getFacts(h.id);
    this.repo.hosts.setFacts(h.id, mergeFacts(stored, parsed.facts, this.providedCategories(h), Date.now(), h.intervalSeconds * 3000));
    this.repo.hosts.insertMetrics(h.entityId, source, ts, parsed.metrics);
    this.extras.set(h.id, { ...parsed.extras, ts });
    this.world.patchMeta(h.entityId, { facts: this.facts(h.id), signals: { cloudflared: parsed.extras.cloudflared, signalsAt: ts } });
  }

  /** Raw topology signals from the last collection (cloudflared, tailscale), keyed by host id. */
  readonly extras = new Map<string, { cloudflared: string; tailscale: unknown; ts: string }>();

  private checkAgentOverdue(h: ResolvedHost, rt: { agentOverdueReported: boolean }): void {
    const last = h.row?.lastContactAt ? Date.parse(h.row.lastContactAt) : null;
    const overdue = last === null || Date.now() - last > h.intervalSeconds * 3000;
    if (!overdue) { rt.agentOverdueReported = false; return; }
    if (rt.agentOverdueReported) return;
    rt.agentOverdueReported = true;
    // Silence is not proof of an outage (the agent may have stopped): health becomes unknown, nothing is removed.
    if (!this.docker.has(h.id) && last !== null) {
      this.world.reconcile({ adapter: 'docker', scope: h.id, completeness: 'unavailable', entities: [], error: `no agent report since ${new Date(last).toISOString()}` });
    }
    if (h.method === 'agent') this.world.setHostSignal(h.entityId, { probe: null, collector: 'fail', collectorError: last ? `no agent report since ${new Date(last).toISOString()}` : 'agent has not reported yet' });
  }

  /** Push from the lightweight agent: raw collector output and, optionally, Docker's container list. */
  async agentReport(row: HostRow, body: { output?: string; containers?: unknown; dockerError?: string | null }): Promise<{ ok: true; containers: number | null }> {
    const h = this.resolve().find((x) => x.id === row.id);
    if (!h || h.status !== 'active') return { ok: true, containers: null };
    const ts = new Date().toISOString();
    if (typeof body.output === 'string') {
      const parsed = parseCollector(body.output.slice(0, 2_000_000), `agent:${h.id}`, ts);
      this.storeCollected(h, parsed, ts, `agent:${h.id}`);
      this.repo.hosts.update(h.id, { lastContactAt: ts, lastError: null });
      this.world.setHostSignal(h.entityId, { probe: 'healthy', collector: 'ok', collectorError: null });
      const rt = this.rt.get(h.id);
      if (rt) rt.agentOverdueReported = false;
    }
    if (body.dockerError) this.repo.hosts.update(h.id, { lastError: `docker: ${redactError(body.dockerError, 160)}` });
    // Container lists from an agent are used only when Berrie World has no direct Docker connection to this host
    // (two sources for the same containers would fight over lifecycle).
    if (this.docker.has(h.id)) return { ok: true, containers: null };
    if (Array.isArray(body.containers)) {
      const adapter = new DockerAdapter({ id: h.id, name: h.name }, new StaticDockerClient(body.containers.slice(0, 2000), {}));
      const inv = await adapter.inventory();
      this.world.reconcile(inv);
      return { ok: true, containers: inv.entities.filter((e) => e.kind === 'service').length };
    }
    if (body.dockerError) this.world.reconcile({ adapter: 'docker', scope: h.id, completeness: 'unavailable', entities: [], error: redactError(body.dockerError, 160) });
    return { ok: true, containers: null };
  }

  /** Reachability probes for Harbor hosts that asked for one (config hosts define theirs in the config file). */
  probes(): { entityId: string; check: CheckConfig }[] {
    return this.resolve().filter((h) => h.source === 'harbor' && h.status === 'active' && h.row?.settings.probe && h.row.settings.address)
      .map((h) => ({ entityId: h.entityId, check: { type: 'tcp', host: h.row!.settings.address!, port: h.row!.settings.port ?? 22, intervalSeconds: 60, failureThreshold: 3 } }));
  }

  dockerFor(entityId: string): { adapter: DockerAdapter; containerId: string } | null {
    for (const d of this.docker.values()) {
      const cid = d.containerFor(entityId);
      if (cid) return { adapter: d, containerId: cid };
    }
    return null;
  }

  /** Transport for a one-off operation (re-run discovery preview). */
  transport(id: string): Transport | undefined {
    return this.transports.get(id);
  }
}
