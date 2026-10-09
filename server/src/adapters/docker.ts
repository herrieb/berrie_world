import type { Health } from '@berrie/shared';
import type { HostConfig } from '../config.js';
import type { InventoryResult, ObservedEntity } from '../core/world.js';
import { redact, redactError } from '../core/redact.js';
import { classify } from './classify.js';
import { DockerClient, demuxLogs } from './dockerClient.js';

interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  ImageID: string;
  Created: number;
  State: string;
  Status: string;
  Labels: Record<string, string> | null;
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[];
  NetworkSettings?: { Networks?: Record<string, unknown> };
  Health?: { Status?: string };
}

const L = {
  project: 'com.docker.compose.project',
  service: 'com.docker.compose.service',
  number: 'com.docker.compose.container-number',
  oneoff: 'com.docker.compose.oneoff',
  dependsOn: 'com.docker.compose.depends_on',
  workingDir: 'com.docker.compose.project.working_dir',
  id: 'berrie.world.id',
  name: 'berrie.world.name',
  type: 'berrie.world.type',
  hostnames: 'berrie.world.hostnames',
  hide: 'berrie.world.hide',
  oneshot: 'berrie.world.oneshot',
  protect: 'berrie.world.protect',
};

const SAFE_ID = /[^a-zA-Z0-9_.:/#-]/g;

export const hostEntityId = (hostId: string) => `host:${hostId}`;
export const projectEntityId = (hostId: string, project: string) => `docker:${hostId}:project/${project}`.replace(SAFE_ID, '_');

/** Stable logical identity: explicit label > compose project/service > container name. Never the container ID. */
export function containerIdentity(hostId: string, labels: Record<string, string>, name: string): string | null {
  if (labels[L.oneoff] === 'True') return null; // `docker compose run` one-off containers are not services
  if (labels[L.id]) return `svc:${labels[L.id]}`.replace(SAFE_ID, '_');
  const project = labels[L.project];
  const service = labels[L.service];
  if (project && service) {
    const n = Number(labels[L.number] ?? '1');
    return `docker:${hostId}:${project}/${service}${n > 1 ? `#${n}` : ''}`.replace(SAFE_ID, '_');
  }
  return `docker:${hostId}:name/${name}`.replace(SAFE_ID, '_');
}

export function containerHealth(c: Pick<ContainerSummary, 'State' | 'Status' | 'Health'>, oneshot: boolean): { health: Health; reason: string } {
  const status = c.Status ?? '';
  const hc = c.Health?.Status ?? /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1];
  switch (c.State) {
    case 'running':
      if (hc === 'unhealthy') return { health: 'unhealthy', reason: 'running, Docker healthcheck failing' };
      if (hc === 'starting' || hc === 'health: starting') return { health: 'starting', reason: 'running, healthcheck starting' };
      if (hc === 'healthy') return { health: 'healthy', reason: 'running, healthcheck passing' };
      return { health: 'healthy', reason: 'running (no Docker healthcheck)' };
    case 'restarting': return { health: 'restarting', reason: status || 'restarting' };
    case 'paused': return { health: 'degraded', reason: 'paused' };
    case 'created': return { health: 'unknown', reason: 'created, never started' };
    case 'removing': return { health: 'unknown', reason: 'being removed' };
    case 'exited': {
      const code = Number(/Exited \((\d+)\)/.exec(status)?.[1] ?? NaN);
      if (oneshot && code === 0) return { health: 'healthy', reason: 'one-shot task completed' };
      return { health: 'unhealthy', reason: `stopped — ${status || 'exited'}` };
    }
    case 'dead': return { health: 'unhealthy', reason: 'dead' };
    default: return { health: 'unknown', reason: `state ${c.State}` };
  }
}

export class DockerAdapter {
  readonly name = 'docker';
  readonly client: DockerClient;
  private stopEvents: (() => void) | null = null;
  /** containerId -> entityId, refreshed every inventory; used for actions, logs and metrics. */
  readonly containers = new Map<string, { entityId: string; name: string; protected: boolean }>();
  hostInfo: Record<string, unknown> = {};

  constructor(readonly host: Pick<HostConfig, 'id' | 'name' | 'docker'>, client?: DockerClient) {
    this.client = client ?? new DockerClient(host.docker ?? {});
  }

  get scope(): string {
    return this.host.id;
  }

  async inventory(): Promise<InventoryResult> {
    const hostId = hostEntityId(this.host.id);
    let list: ContainerSummary[];
    try {
      list = await this.client.get<ContainerSummary[]>('/containers/json?all=1');
      if (!Array.isArray(list)) throw new Error('unexpected container list response');
    } catch (err) {
      return { adapter: this.name, scope: this.scope, completeness: 'unavailable', entities: [], error: redactError(err) };
    }
    try {
      const info = await this.client.get<Record<string, unknown>>('/info');
      this.hostInfo = {
        hostname: info.Name, os: info.OperatingSystem, kernel: info.KernelVersion, arch: info.Architecture, cpus: info.NCPU,
        memTotal: info.MemTotal, dockerVersion: info.ServerVersion, containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped, containers: info.Containers, infoAt: new Date().toISOString(),
      };
    } catch { /* host info is optional */ }

    const entities: ObservedEntity[] = [];
    const projects = new Map<string, ObservedEntity>();
    let skippedBad = 0;
    this.containers.clear();
    for (const c of list) {
      try {
        const labels = c.Labels ?? {};
        const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
        const id = containerIdentity(this.host.id, labels, name);
        if (!id || labels[L.hide] === 'true') continue;
        const project = labels[L.project];
        const service = labels[L.service];
        let parentId = hostId;
        if (project) {
          parentId = projectEntityId(this.host.id, project);
          if (!projects.has(parentId)) {
            projects.set(parentId, {
              id: parentId, kind: 'project', name: project, buildingType: 'townhall', parentId: hostId, hostId,
              meta: { composeProject: project, workingDir: labels[L.workingDir] ?? null },
            });
          }
        }
        const deps = (labels[L.dependsOn] ?? '').split(',').map((d) => d.split(':')[0]).filter(Boolean)
          .map((svc) => `docker:${this.host.id}:${project}/${svc}`.replace(SAFE_ID, '_'));
        const ports = (c.Ports ?? []).map((p) => (p.PublicPort ? `${p.IP ?? ''}:${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`));
        const hasHttp = (c.Ports ?? []).some((p) => [80, 443, 3000, 5000, 8000, 8080, 8443].includes(p.PrivatePort));
        const isProtected = labels[L.protect] === 'true';
        this.containers.set(c.Id, { entityId: id, name, protected: isProtected });
        entities.push({
          id, kind: 'service', name: labels[L.name] ?? (service && project ? `${service}` : name),
          buildingType: classify({ label: labels[L.type], image: c.Image, names: [service ?? '', name], hasHttp }),
          parentId, hostId, hostnames: (labels[L.hostnames] ?? '').split(',').map((h) => h.trim()).filter(Boolean),
          dependsOn: project ? deps : [],
          meta: {
            containerId: c.Id, containerName: name, image: c.Image, imageId: c.ImageID, composeProject: project ?? null,
            composeService: service ?? null, state: c.State, status: c.Status, createdAt: new Date(c.Created * 1000).toISOString(),
            ports: [...new Set(ports)], networks: Object.keys(c.NetworkSettings?.Networks ?? {}), protected: isProtected,
          },
          health: containerHealth(c, labels[L.oneshot] === 'true'),
        });
      } catch {
        skippedBad++;
      }
    }
    return {
      adapter: this.name, scope: this.scope,
      // If any container could not be interpreted, absence of it is not proof of removal.
      completeness: skippedBad ? 'incomplete' : 'complete',
      entities: [...projects.values(), ...entities],
      error: skippedBad ? `${skippedBad} containers could not be parsed` : null,
    };
  }

  /** Subscribe to Docker container events; reconnects with backoff. */
  startEvents(onEvent: (e: { action: string; entityId: string | null; name: string; attrs: Record<string, string> }) => void): void {
    let backoff = 2000;
    const connect = () => {
      const filters = encodeURIComponent(JSON.stringify({ type: ['container'] }));
      this.stopEvents = this.client.stream(`/events?filters=${filters}`, (m) => {
        backoff = 2000;
        const msg = m as { Action?: string; Actor?: { Attributes?: Record<string, string> } };
        const attrs = msg.Actor?.Attributes ?? {};
        const name = attrs.name ?? '';
        onEvent({ action: msg.Action ?? '', entityId: containerIdentity(this.host.id, attrs, name), name, attrs });
      }, () => {
        if (!this.stopEvents) return;
        setTimeout(() => { if (this.stopEvents) connect(); }, backoff).unref();
        backoff = Math.min(backoff * 2, 60_000);
      });
    };
    connect();
  }

  stop(): void {
    const s = this.stopEvents;
    this.stopEvents = null;
    s?.();
  }

  containerFor(entityId: string): string | null {
    for (const [cid, v] of this.containers) if (v.entityId === entityId) return cid;
    return null;
  }

  async details(containerId: string): Promise<Record<string, unknown>> {
    const i = await this.client.get<{
      State: { StartedAt?: string; FinishedAt?: string; ExitCode?: number; Health?: { Status: string; FailingStreak: number; Log?: { Start: string; ExitCode: number; Output: string }[] } };
      RestartCount: number; Config?: { Healthcheck?: { Test?: string[] } };
    }>(`/containers/${containerId}/json`);
    return {
      startedAt: i.State.StartedAt ?? null, finishedAt: i.State.FinishedAt ?? null, exitCode: i.State.ExitCode ?? null,
      restartCount: i.RestartCount, hasHealthcheck: !!i.Config?.Healthcheck?.Test?.length,
      healthLog: (i.State.Health?.Log ?? []).slice(-5).map((l) => ({ ts: l.Start, exitCode: l.ExitCode, output: redact(l.Output ?? '').slice(0, 300) })),
    };
  }

  async metrics(containerId: string): Promise<{ cpuPercent: number | null; memBytes: number | null; memLimit: number | null }> {
    const s = await this.client.get<{
      cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number; online_cpus?: number };
      precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
      memory_stats: { usage?: number; limit?: number; stats?: { inactive_file?: number } };
    }>(`/containers/${containerId}/stats?stream=false`);
    const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage ?? 0);
    const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
    const cpuPercent = sysDelta > 0 && s.precpu_stats.system_cpu_usage ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus ?? 1) * 100 : null;
    const mem = s.memory_stats.usage != null ? s.memory_stats.usage - (s.memory_stats.stats?.inactive_file ?? 0) : null;
    return { cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10, memBytes: mem, memLimit: s.memory_stats.limit ?? null };
  }

  async logs(containerId: string, tail: number): Promise<string[]> {
    const buf = await this.client.raw(`/containers/${containerId}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`, 2 * 1024 * 1024);
    return demuxLogs(buf).split('\n').filter(Boolean).slice(-tail).map((l) => redact(l).slice(0, 2000));
  }

  async action(containerId: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
    await this.client.post(`/containers/${containerId}/${action}${action === 'start' ? '' : '?t=15'}`);
  }
}
