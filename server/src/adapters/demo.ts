import type { BuildingType, EventType, Health } from '@berrie/shared';
import type { InventoryResult, ObservedEntity, World } from '../core/world.js';

/**
 * DEMO MODE ONLY. Scripted fixture infrastructure used to preview the village without real data.
 * Runs exclusively against the separate demo database (Repo refuses demo entities in the live DB).
 */
interface Fixture { id: string; name: string; type: BuildingType; project: string; host: string; hostnames?: string[]; deps?: string[] }

const F: Fixture[] = [
  { id: 'ollama', name: 'ollama', type: 'lab', project: 'ai', host: 'srv', hostnames: ['openlamma.example'] },
  { id: 'webui', name: 'open-webui', type: 'lab', project: 'ai', host: 'srv', hostnames: ['ai.example'], deps: ['ollama'] },
  { id: 'n8n', name: 'n8n', type: 'workshop', project: 'automation', host: 'srv', hostnames: ['n8n.example'], deps: ['n8n-db'] },
  { id: 'n8n-db', name: 'postgres', type: 'silo', project: 'automation', host: 'srv' },
  { id: 'dash', name: 'dashboard', type: 'house', project: 'web', host: 'srv', hostnames: ['dashboard.example'] },
  { id: 'stats', name: 'stats', type: 'house', project: 'web', host: 'srv', hostnames: ['stats.example'] },
  { id: 'c64', name: 'c64', type: 'house', project: 'games', host: 'srv', hostnames: ['c64.example'] },
  { id: 'pesten', name: 'pesten', type: 'house', project: 'games', host: 'srv' },
  { id: 'ra2', name: 'red-alert2', type: 'house', project: 'games', host: 'srv' },
  { id: 'old', name: 'old-game', type: 'shop', project: 'games', host: 'srv' },
  { id: 'files', name: 'filesharez', type: 'depot', project: 'files', host: 'srv', hostnames: ['files.example'], deps: ['files-db', 'files-redis'] },
  { id: 'files-db', name: 'postgres', type: 'silo', project: 'files', host: 'srv' },
  { id: 'files-redis', name: 'redis', type: 'cache', project: 'files', host: 'srv' },
  { id: 'files-worker', name: 'worker', type: 'clocktower', project: 'files', host: 'srv' },
  { id: 'tunnel', name: 'cloudflared', type: 'tower', project: 'net', host: 'srv' },
  { id: 'proxy', name: 'proxy', type: 'tower', project: 'net', host: 'srv' },
  { id: 'lights', name: 'lights', type: 'house', project: 'home', host: 'pi', hostnames: ['lights.example'] },
  { id: 'weather', name: 'roadweather', type: 'house', project: 'home', host: 'pi' },
];

export class DemoAdapter {
  private cycleNo = 0;

  inventory(): InventoryResult[] {
    // The scenario loops every 30 cycles so every lifecycle state keeps recurring.
    const c = (this.cycleNo++ % 30) + 1;
    const out: InventoryResult[] = [];
    for (const host of ['srv', 'pi']) {
      const hostId = `demo:host/${host}`;
      const piOffline = host === 'pi' && c >= 14 && c < 20;
      if (piOffline) {
        out.push({ adapter: 'demo', scope: host, completeness: 'unavailable', entities: [], error: 'demo: host unreachable' });
        continue;
      }
      const entities: ObservedEntity[] = [];
      const projects = new Set<string>();
      for (const f of F.filter((f) => f.host === host)) {
        if (f.id === 'old' && c >= 8) continue; // removed in the scenario
        if (f.id === 'webui' && c < 5) continue; // appears later (construction)
        projects.add(f.project);
        entities.push({
          id: `demo:${f.id}`, kind: 'service', name: f.name, buildingType: f.type,
          parentId: `demo:project/${f.project}`, hostId, hostnames: f.hostnames ?? [],
          dependsOn: (f.deps ?? []).map((d) => `demo:${d}`),
          meta: { demo: true, image: `demo/${f.name}:latest`, composeProject: f.project, containerId: `demo${f.id}${c >= 10 && f.id === 'stats' ? '-v2' : ''}` },
          health: this.health(f.id, c),
        });
      }
      out.push({
        adapter: 'demo', scope: host, completeness: 'complete',
        entities: [
          { id: hostId, kind: 'host', name: `demo-${host}`, buildingType: 'server', parentId: null, hostId, meta: { demo: true } },
          ...[...projects].map((p) => ({ id: `demo:project/${p}`, kind: 'project' as const, name: p, buildingType: 'townhall' as const, parentId: hostId, hostId, meta: { demo: true } })),
          ...entities,
        ],
      });
    }
    return out;
  }

  private health(id: string, c: number): { health: Health; reason: string } {
    if (id === 'ollama' && c >= 4 && c < 12) return { health: 'unhealthy', reason: 'demo: container exited (137)' };
    if (id === 'files-worker' && c % 9 === 3) return { health: 'restarting', reason: 'demo: restarting' };
    if (id === 'stats' && c === 10) return { health: 'starting', reason: 'demo: redeploying' };
    if (id === 'ra2' && c >= 6) return { health: 'degraded', reason: 'demo: paused' };
    return { health: 'healthy', reason: 'demo: running' };
  }

  applyHealth(world: World): void {
    const c = ((this.cycleNo - 1) % 30) + 1;
    world.setHostSignal('demo:host/srv', { docker: 'ok' });
    world.setHostSignal('demo:host/pi', c >= 14 && c < 20 ? { probe: 'host_offline' } : { probe: 'healthy', docker: 'ok' });
  }

  /** Demo traffic so couriers can be previewed. Only ever emitted in demo mode. */
  tickActivity(world: World): void {
    const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    const flows: [EventType, string, string][] = [
      ['http.request', 'demo:proxy', pick(['demo:dash', 'demo:stats', 'demo:c64', 'demo:files'])],
      ['ai.request_started', 'demo:webui', 'demo:ollama'],
      ['automation.executed', 'demo:n8n', pick(['demo:n8n-db', 'demo:files', 'demo:dash'])],
      ['task.executed', 'demo:files-worker', 'demo:files-db'],
    ];
    const [type, from, to] = pick(flows);
    if (!world.repo.getEntity(from) || !world.repo.getEntity(to)) return;
    world.emit({ type, entityId: from, relatedEntityId: to, source: 'demo', details: { demo: true } });
  }
}
