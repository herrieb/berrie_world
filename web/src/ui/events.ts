import type { EntityView, WorldEvent } from '@berrie/shared';

const SEV_COLOR = { info: '#5b8def', notice: '#3fd17a', warning: '#f2b33d', critical: '#ef4b4b' } as const;

export function eventColor(ev: WorldEvent): string {
  if (ev.type === 'service.unhealthy' || ev.type === 'service.unreachable' || ev.type === 'host.offline') return '#ef4b4b';
  if (ev.type === 'connection.degraded' || ev.type === 'incident.opened') return '#ef4b4b';
  if (ev.type === 'incident.resolved') return '#3fd17a';
  if (ev.type === 'maintenance.started' || ev.type === 'maintenance.ended') return '#4aa8ff';
  if (ev.type === 'connection.recovered') return '#3fd17a';
  if (ev.type === 'service.recovered' || ev.type === 'service.healthy' || ev.type === 'host.online' || ev.type === 'container.started') return '#3fd17a';
  if (ev.type === 'service.removal_confirmed' || ev.type === 'service.archived') return '#8a94a6';
  return SEV_COLOR[ev.severity];
}

export function describeEvent(ev: WorldEvent, entities: Record<string, EntityView>): string {
  const n = (id: string | null) => (id ? entities[id]?.displayName ?? (String(ev.details.name ?? '') || id.split(/[/:]/).pop()) : 'unknown');
  const name = n(ev.entityId);
  const rel = n(ev.relatedEntityId);
  const d = ev.details;
  switch (ev.type) {
    case 'service.discovered': return `New ${d.kind === 'host' ? 'host' : d.kind === 'project' ? 'project' : 'service'} discovered: ${name}`;
    case 'service.rediscovered': return `${name} is back (was ${d.previously})`;
    case 'service.healthy': return `${name} is healthy`;
    case 'service.degraded': return `${name} is degraded${d.reason ? ` — ${d.reason}` : ''}`;
    case 'service.unhealthy': return `${name} became unhealthy${d.reason ? ` — ${d.reason}` : ''}`;
    case 'service.unreachable': return `${name} became unreachable${d.reason ? ` — ${d.reason}` : ''}`;
    case 'service.recovered': return `${name} recovered`;
    case 'service.health_unknown': return `${name}: health unknown${d.reason ? ` — ${d.reason}` : ''}`;
    case 'service.missing': return `${name} not found in inventory — awaiting confirmation`;
    case 'service.removal_confirmed': return `${name} removal confirmed`;
    case 'service.archived': return `${name} archived`;
    case 'service.renamed': return `Renamed ${d.from} → ${d.to}`;
    case 'container.started': return `Container ${d.container ?? name} started`;
    case 'container.stopped': return `Container ${d.container ?? name} stopped${d.exitCode != null ? ` (exit ${d.exitCode})` : ''}`;
    case 'container.restarted': return `Container ${d.container ?? name} restarted`;
    case 'deployment.changed': return `${name} redeployed (${d.from} → ${d.to})`;
    case 'host.offline': return `Host ${name} is offline`;
    case 'host.online': return `Host ${name} is back online`;
    case 'inventory.uncertain': return `Inventory ${d.scope} ${d.completeness}${d.error ? ` — ${d.error}` : ''}; nothing will be removed`;
    case 'inventory.restored': return `Inventory ${d.scope} complete again`;
    case 'http.request': return `Request ${name} → ${rel}`;
    case 'automation.executed': return `${name} ran a workflow${ev.relatedEntityId ? ` → ${rel}` : ''}`;
    case 'ai.request_started': return `AI request ${name} → ${rel}`;
    case 'ai.request_completed': return `AI request completed by ${rel || name}`;
    case 'task.executed': return `${name} executed a task`;
    case 'alert': return `Alert on ${name}${d.message ? `: ${d.message}` : ''}`;
    case 'action.performed': return `${d.by ?? 'An operator'} ran ${d.action} on ${name}`;
    case 'incident.opened': return `Incident opened: ${d.title ?? name}`;
    case 'incident.recovered': return `Incident recovered (awaiting confirmation): ${d.title ?? name}`;
    case 'incident.resolved': return `Incident resolved${d.by ? ` by ${d.by}` : ''}: ${d.title ?? name}`;
    case 'maintenance.started': return `Maintenance started: ${d.title}`;
    case 'maintenance.ended': return `Maintenance ended: ${d.title}`;
    case 'connection.discovered': return `New ${d.verification} ${String(d.type)} link: ${name} → ${rel}`;
    case 'connection.missing': return `${String(d.type)} link ${name} → ${rel} not reported — awaiting confirmation`;
    case 'connection.removed': return `${String(d.type)} link ${name} → ${rel} removal confirmed`;
    case 'connection.degraded': return `${String(d.type)} link ${name} → ${rel} is ${d.to}${d.reason ? ` — ${d.reason}` : ''}`;
    case 'connection.recovered': return `${String(d.type)} link ${name} → ${rel} recovered`;
    case 'layout.moved': return `${name} moved`;
    default: return `${ev.type} ${name}`;
  }
}
