import { useMemo, useState } from 'react';
import type { EntityView } from '@berrie/shared';
import { HEALTH_LABEL, LIFECYCLE_LABEL, effectiveHealth } from '@berrie/shared';
import { useStore, matchesFilters } from '../state/store';
import { HEALTH_COLOR, TYPE_LABEL, iconSvg, timeAgo } from './status';
import { Icon } from './Icon';

type SortKey = 'name' | 'health' | 'type' | 'host' | 'lastChange';
const HRANK: Record<string, number> = { host_offline: 0, unhealthy: 1, unreachable: 2, restarting: 3, degraded: 4, starting: 5, unknown: 6, healthy: 7 };

export function ServicesView() {
  const entities = useStore((s) => s.entities);
  const filters = useStore((s) => s.filters);
  const setFilters = useStore((s) => s.setFilters);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const offset = useStore((s) => s.serverOffsetMs);
  const [sort, setSort] = useState<SortKey>('health');
  const [showEndpoints, setShowEndpoints] = useState(false);

  const rows = useMemo(() => {
    const all = Object.values(entities).filter((e) => e.kind !== 'project' && (showEndpoints || e.kind !== 'endpoint' || e.layout) && matchesFilters(e, filters));
    const host = (e: EntityView) => (e.hostId ? entities[e.hostId]?.displayName ?? '' : '');
    const cmp: Record<SortKey, (a: EntityView, b: EntityView) => number> = {
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      health: (a, b) => (a.lifecycle === 'missing' ? -1 : 0) - (b.lifecycle === 'missing' ? -1 : 0) || HRANK[effectiveHealth(a)] - HRANK[effectiveHealth(b)] || a.displayName.localeCompare(b.displayName),
      type: (a, b) => a.buildingType.localeCompare(b.buildingType) || a.displayName.localeCompare(b.displayName),
      host: (a, b) => host(a).localeCompare(host(b)) || a.displayName.localeCompare(b.displayName),
      lastChange: (a, b) => (b.lastChangeAt ?? '').localeCompare(a.lastChangeAt ?? ''),
    };
    return all.sort(cmp[sort]);
  }, [entities, filters, sort, showEndpoints]);

  const go = (id: string) => { select(id, true); setView('world'); };
  const H = ({ k, children }: { k: SortKey; children: React.ReactNode }) => <th><button className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{children}</button></th>;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Services</h1>
        <label className="search"><Icon name="search" /><input placeholder="Search name, hostname, image…" value={filters.text} onChange={(e) => setFilters({ text: e.target.value })} /></label>
        <select value={filters.health} onChange={(e) => setFilters({ health: e.target.value as never })} aria-label="Status filter">
          <option value="all">All states</option><option value="problems">Problems only</option>
          {Object.entries(HEALTH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={showEndpoints} onChange={(e) => setShowEndpoints(e.target.checked)} /> include endpoints</label>
      </div>
      <div className="table-wrap card">
        <table className="table">
          <thead><tr><H k="name">Name</H><H k="health">Health</H><th>Lifecycle</th><H k="type">Type</H><H k="host">Host</H><th>Hostnames</th><H k="lastChange">Changed</H></tr></thead>
          <tbody>
            {rows.map((e) => {
              const h = effectiveHealth(e);
              return (
                <tr key={e.id} onClick={() => go(e.id)} className={e.lifecycle === 'removed' ? 'removed' : ''}>
                  <td><span className="cell-name"><span className="ic" dangerouslySetInnerHTML={{ __html: iconSvg(e.buildingType, 14) }} />{e.displayName}</span><small className="mono">{e.id}</small></td>
                  <td><span className="dot" style={{ background: HEALTH_COLOR[h] }} /> {HEALTH_LABEL[h]}{e.inventoryUncertain ? <small> · stale</small> : null}<small>{e.healthReason}</small></td>
                  <td>{LIFECYCLE_LABEL[e.lifecycle]}</td>
                  <td>{TYPE_LABEL[e.buildingType]}</td>
                  <td>{e.hostId ? entities[e.hostId]?.displayName : '—'}</td>
                  <td>{e.hostnames.join(', ') || '—'}</td>
                  <td>{timeAgo(e.lastChangeAt, offset)}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={7} className="muted">No services match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
