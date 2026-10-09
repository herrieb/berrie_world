import type { AdapterStatus, HostnameHint } from '@berrie/shared';
import type { AppConfig, CheckConfig } from '../config.js';
import { hostEntityId } from '../adapters/docker.js';
import { configInventory, describeCheck, endpointInventory, hintStatus } from '../adapters/config.js';
import { runProbe, tcpProbe } from '../adapters/probes.js';
import type { DemoAdapter } from '../adapters/demo.js';
import { redactError } from './redact.js';
import type { World } from './world.js';
import { HostManager, type TransportFactory } from './hosts.js';
import type { SecretBox } from './secrets.js';

interface ScheduledCheck {
  entityId: string;
  name: string;
  check: CheckConfig;
  nextAt: number;
  running: boolean;
}

export interface SchedulerHooks {
  adapters?: (a: AdapterStatus[]) => void;
  hints?: (h: HostnameHint[]) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

const MAX_CONCURRENT_CHECKS = 4;

export class Scheduler {
  readonly hosts: HostManager;
  private checks = new Map<string, ScheduledCheck>();
  private timers: NodeJS.Timeout[] = [];
  private cycleRunning = false;
  private cyclePending = false;
  private debounce: NodeJS.Timeout | null = null;
  private hostProbe = new Map<string, { fails: number; oks: number }>();
  private stopped = false;
  lastMonitoringAt: string | null = null;
  hints: HostnameHint[] = [];

  constructor(
    private readonly cfg: AppConfig,
    private readonly world: World,
    private readonly hooks: SchedulerHooks = {},
    private readonly demo: DemoAdapter | null = null,
    opts: { box: SecretBox; transportFactory?: TransportFactory; startEvents?: boolean },
  ) {
    this.hosts = new HostManager(cfg, world.repo, world, opts.box, {
      onDockerEvent: (hostId, ev) => this.onDockerEvent(hostId, ev),
      log: (m, e) => this.log(m, e),
      canary: async () => !cfg.canary || (await tcpProbe({ type: 'tcp', host: cfg.canary.host, port: cfg.canary.port, timeoutMs: 3000 })).outcome === 'ok',
    }, opts.transportFactory, opts.startEvents ?? true);
  }

  get docker() {
    return this.hosts.docker;
  }

  /** Apply Server Harbor changes now (new/edited/suspended/archived hosts) and run discovery. */
  hostsChanged(): void {
    if (this.demo) return;
    this.hosts.sync();
    void this.cycle();
  }

  private log(msg: string, extra?: Record<string, unknown>) {
    this.hooks.log?.(msg, extra);
  }

  start(): void {
    if (!this.demo) this.hosts.sync();
    void this.cycle();
    this.timers.push(setInterval(() => void this.cycle(), this.cfg.discoveryIntervalSeconds * 1000));
    this.timers.push(setInterval(() => void this.monitorTick(), 5000));
    this.timers.push(setInterval(() => this.retention(), 3600_000));
    if (!this.demo) this.timers.push(setInterval(() => void this.hosts.collectTick(), 5000));
    if (this.demo) this.timers.push(setInterval(() => this.demo!.tickActivity(this.world), 2500));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.debounce) clearTimeout(this.debounce);
    this.hosts.stop();
  }

  private running: Promise<void> | null = null;

  /** One discovery cycle. Concurrent calls share the running cycle and schedule one more afterwards. */
  cycle(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.cyclePending = true; return this.running; }
    this.running = this.runCycle().finally(() => {
      this.running = null;
      if (this.cyclePending) { this.cyclePending = false; void this.cycle(); }
    });
    return this.running;
  }

  /** Each adapter is isolated: one failing never stops the others. */
  private async runCycle(): Promise<void> {
    this.cycleRunning = true;
    try {
      if (this.demo) {
        for (const inv of this.demo.inventory()) this.world.reconcile(inv);
        this.demo.applyHealth(this.world);
      } else {
        const describe = () => new Map(this.hosts.resolve().filter((h) => h.source === 'config').map((h) => [h.id, { name: h.name, meta: this.hosts.hostMeta(h) }]));
        this.safe('config', () => this.world.reconcile(configInventory(this.cfg, describe())));
        this.safe('harbor', () => this.world.reconcile(this.hosts.hostInventory()));
        await Promise.all([...this.docker].map(async ([hostId, d]) => {
          try {
            const inv = await d.inventory();
            // The host may have been suspended, archived or reconfigured while this inventory was in flight:
            // a stale result must never touch its entities (it could even resurrect archived ones).
            if (this.docker.get(hostId) !== d) return;
            this.world.reconcile(inv);
            this.world.setHostSignal(hostEntityId(hostId), { docker: inv.completeness === 'unavailable' ? 'fail' : 'ok', dockerError: inv.error ?? null });
            if (inv.completeness !== 'unavailable') this.hosts.applyDockerInfo(hostId);
          } catch (err) {
            this.log('docker adapter failed', { hostId, error: redactError(err) });
          }
        }));
        // Re-run host inventories so metadata from Docker /info and collectors is attached.
        this.safe('config', () => this.world.reconcile(configInventory(this.cfg, describe())));
        this.safe('harbor', () => this.world.reconcile(this.hosts.hostInventory()));
        try {
          const plan = await endpointInventory(this.cfg, this.world.repo);
          this.world.reconcile(plan.inventory);
          this.syncChecks(plan.checks);
        } catch (err) {
          this.log('endpoint adapter failed', { error: redactError(err) });
        }
        try {
          this.hints = await hintStatus(this.cfg, this.world.repo);
          this.hooks.hints?.(this.hints);
        } catch (err) {
          this.log('hint resolution failed', { error: redactError(err) });
        }
      }
      this.world.archivePass();
      this.hooks.adapters?.(this.world.repo.listAdapterStates());
    } catch (err) {
      this.log('discovery cycle failed', { error: redactError(err) });
    } finally {
      this.cycleRunning = false;
    }
  }

  private safe(name: string, fn: () => void) {
    try { fn(); } catch (err) { this.log(`${name} adapter failed`, { error: redactError(err) }); }
  }

  onDockerEvent(hostId: string, ev: { action: string; entityId: string | null; name: string; attrs: Record<string, string> }): void {
    const action = ev.action.split(':')[0];
    const known = ev.entityId ? this.world.repo.getEntity(ev.entityId) : undefined;
    const source = `docker:${hostId}`;
    if (known) {
      if (action === 'start') this.world.emit({ type: 'container.started', entityId: known.id, relatedEntityId: hostEntityId(hostId), source, details: { container: ev.name } });
      else if (action === 'die') this.world.emit({ type: 'container.stopped', entityId: known.id, relatedEntityId: hostEntityId(hostId), source, severity: ev.attrs.exitCode === '0' ? 'info' : 'warning', details: { container: ev.name, exitCode: ev.attrs.exitCode ?? null } });
      else if (action === 'restart') this.world.emit({ type: 'container.restarted', entityId: known.id, relatedEntityId: hostEntityId(hostId), source, details: { container: ev.name } });
    }
    if (['start', 'die', 'stop', 'restart', 'create', 'destroy', 'rename', 'health_status', 'pause', 'unpause'].includes(action)) {
      // Events are triggers only; the inventory is the source of truth.
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.cycle(), 1500);
    }
  }

  // ---------------- monitoring ----------------

  private syncChecks(endpointChecks: { entityId: string; check: CheckConfig }[]): void {
    const wanted = new Map<string, { entityId: string; check: CheckConfig }>();
    for (const c of endpointChecks) wanted.set(`${c.entityId}|${describeCheck(c.check)}`, c);
    for (const s of this.cfg.services) if (s.check) wanted.set(`manual:${s.id}|${describeCheck(s.check)}`, { entityId: `manual:${s.id}`, check: s.check });
    for (const h of this.cfg.hosts) if (h.probe) wanted.set(`${hostEntityId(h.id)}|${describeCheck(h.probe)}`, { entityId: hostEntityId(h.id), check: h.probe });
    for (const p of this.hosts.probes()) wanted.set(`${p.entityId}|${describeCheck(p.check)}`, p);
    for (const k of this.checks.keys()) if (!wanted.has(k)) this.checks.delete(k);
    for (const [k, c] of wanted) {
      const existing = this.checks.get(k);
      if (existing) existing.check = c.check;
      else this.checks.set(k, { entityId: c.entityId, name: describeCheck(c.check), check: c.check, running: false, nextAt: Date.now() + Math.random() * 10_000 });
    }
  }

  private async monitorTick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    const due = [...this.checks.values()].filter((c) => !c.running && c.nextAt <= now);
    if (!due.length) return;
    let canaryOk = true;
    if (this.cfg.canary) canaryOk = (await tcpProbe({ type: 'tcp', host: this.cfg.canary.host, port: this.cfg.canary.port, timeoutMs: 3000 })).outcome === 'ok';
    const running = [...this.checks.values()].filter((c) => c.running).length;
    for (const c of due.slice(0, Math.max(0, MAX_CONCURRENT_CHECKS - running))) {
      c.running = true;
      void this.runCheck(c, canaryOk).finally(() => {
        c.running = false;
        c.nextAt = Date.now() + (c.check.intervalSeconds ?? 60) * 1000 * (0.9 + Math.random() * 0.2);
      });
    }
  }

  private async runCheck(c: ScheduledCheck, canaryOk: boolean): Promise<void> {
    const entity = this.world.repo.getEntity(c.entityId);
    if (!entity || entity.lifecycle === 'removed' || entity.lifecycle === 'archived') return;
    const r = await runProbe(c.check);
    this.lastMonitoringAt = new Date().toISOString();
    if (entity.kind === 'host') {
      const st = this.hostProbe.get(entity.id) ?? { fails: 0, oks: 0 };
      if (r.outcome === 'ok') { st.oks++; st.fails = 0; } else { st.fails++; st.oks = 0; }
      this.hostProbe.set(entity.id, st);
      this.world.repo.insertCheckResult({ entityId: entity.id, checkName: c.name, outcome: r.outcome === 'ok' ? 'ok' : canaryOk ? 'fail' : 'unknown', latencyMs: r.latencyMs, statusCode: null, error: r.outcome === 'ok' ? null : r.reason });
      if (!canaryOk || r.localError) return; // our own network is down: no conclusion about the host
      if (st.fails >= (c.check.failureThreshold ?? 3)) this.world.setHostSignal(entity.id, { probe: 'host_offline' });
      else if (st.oks >= (c.check.successThreshold ?? 1)) this.world.setHostSignal(entity.id, { probe: 'healthy' });
      return;
    }
    const unknown = r.outcome === 'fail' && (!canaryOk || r.localError);
    this.world.recordProbe(c.entityId, {
      checkName: c.name, outcome: unknown ? 'unknown' : r.outcome, failHealth: r.severity,
      reason: unknown ? `monitor could not run check (${r.reason})` : r.reason,
      latencyMs: r.latencyMs, statusCode: r.statusCode,
      failureThreshold: c.check.failureThreshold, successThreshold: c.check.successThreshold,
    });
  }

  checkList(): { entityId: string; name: string; intervalSeconds: number; nextAt: string }[] {
    return [...this.checks.values()].map((c) => ({ entityId: c.entityId, name: c.name, intervalSeconds: c.check.intervalSeconds ?? 60, nextAt: new Date(c.nextAt).toISOString() }));
  }

  private retention(): void {
    try {
      const n = this.world.repo.prune(this.cfg.retention);
      const day = 86400_000;
      const m = this.world.repo.hosts.pruneMetrics(new Date(Date.now() - this.cfg.retention.metricRawDays * day).toISOString(), new Date(Date.now() - this.cfg.retention.metricHourlyDays * day).toISOString());
      this.log('retention prune', { ...n, metricsRaw: m.raw, metricsHourly: m.hourly });
    } catch (err) {
      this.log('retention failed', { error: redactError(err) });
    }
  }

  dockerFor(entityId: string) {
    return this.hosts.dockerFor(entityId);
  }
}
