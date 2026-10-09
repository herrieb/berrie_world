import { useEffect, useMemo, useRef, useState } from 'react';
import type { Alert, BuildingType, Summary } from '@berrie/shared';
import { useStore, matchesFilters, filtersActive, useRole } from '../state/store';
import { onServerMessage, api, savePrefs } from '../state/api';
import { WorldRenderer } from '../world/WorldRenderer';
import { Inspector } from './Inspector';
import { ActivityPanel } from './ActivityPanel';
import { Minimap } from './Minimap';
import { Icon } from './Icon';
import { HEALTH_COLOR, TYPE_LABEL, timeAgo } from './status';

export function WorldView({ alerts, summary, hidden }: { alerts: Alert[]; summary: Summary; hidden: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<WorldRenderer | null>(null);
  const [ready, setReady] = useState(false);
  const [camTick, setCamTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const s = useStore();
  const canOperate = useRole('operator');
  const [saving, setSaving] = useState<string | null>(null);
  const list = useMemo(() => Object.values(s.entities), [s.entities]);

  useEffect(() => {
    const r = new WorldRenderer(hostRef.current!, labelRef.current!, {
      onSelect: (id) => useStore.getState().select(id),
      onMove: async (id, x, y) => {
        try { await api(`/api/entities/${encodeURIComponent(id)}/layout`, { method: 'PUT', json: { x, y } }); }
        catch (e) { setToast(`Move rejected: ${(e as Error).message}`); }
      },
      onCamera: () => setCamTick((t) => t + 1),
      // Camera position is personal; persisted (debounced) so it follows the user across devices.
      onCameraSettled: (camera) => savePrefs({ camera }),
    });
    rendererRef.current = r;
    let cancelled = false;
    void r.init().then(() => { if (!cancelled) setReady(true); });
    const off = onServerMessage((m) => { if (m.t === 'event') r.onEvent(m.data); });
    return () => { cancelled = true; off(); r.destroy(); rendererRef.current = null; };
  }, []);

  const matching = useMemo(() => (filtersActive(s.filters) ? new Set(list.filter((e) => matchesFilters(e, s.filters)).map((e) => e.id)) : null), [list, s.filters]);

  useEffect(() => {
    if (!ready) return;
    rendererRef.current?.update({ entities: list, blocks: s.blocks, selectedId: s.selectedId, matching, daylight: s.daylight, editLayout: s.editLayout, labelDensity: s.prefs.labelDensity ?? 'auto', initialCamera: s.prefs.camera ?? null });
  }, [ready, list, s.blocks, s.selectedId, matching, s.daylight, s.editLayout, s.prefs.labelDensity, s.prefs.camera]);

  useEffect(() => { if (ready && s.selectedId && s.focusTick) rendererRef.current?.focus(s.selectedId); }, [s.focusTick, ready]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

  const hosts = list.filter((e) => e.kind === 'host');
  const types = [...new Set(list.filter((e) => e.layout).map((e) => e.buildingType))].sort() as BuildingType[];
  const selected = s.selectedId ? s.entities[s.selectedId] : null;
  const noBuilding = list.filter((e) => e.kind === 'service' && !e.layout && e.lifecycle !== 'removed');
  const counts: [string, number, string, string][] = [
    ['Healthy', summary.healthy, HEALTH_COLOR.healthy, 'healthy'],
    ['Degraded / down', summary.degradedOrUnhealthy, HEALTH_COLOR.unhealthy, 'problems'],
    ['Unreachable', summary.unreachable, HEALTH_COLOR.unreachable, 'unreachable'],
    ['Unknown', summary.unknown, HEALTH_COLOR.unknown, 'unknown'],
  ];

  return (
    <div className={`world${hidden ? ' behind' : ''}`}>
      <div className="canvas-host" ref={hostRef} />
      <div className="label-layer" ref={labelRef} />

      {s.mode === 'demo' && <div className="demo-banner">DEMO MODE — scripted fixture data, not your infrastructure</div>}
      {s.ws === 'closed' && s.loaded && <div className="stale-banner">Lost connection to the Berrie World server. Reconnecting… values shown are the last known state.</div>}

      <aside className="overview card">
        <h3>Overview</h3>
        <ul className="counts">
          {counts.map(([label, n, color, f]) => (
            <li key={label}>
              <button className={s.filters.health === f ? 'on' : ''} onClick={() => s.setFilters({ health: s.filters.health === f ? 'all' : (f as never) })}>
                <span className="dot" style={{ background: color }} /><b>{n}</b><span>{label}</span>
              </button>
            </li>
          ))}
          {summary.missing > 0 && <li><button onClick={() => s.setView('alerts')}><span className="dot ring" /><b>{summary.missing}</b><span>Missing (unconfirmed)</span></button></li>}
          {summary.hostsOffline > 0 && <li><button onClick={() => s.setView('alerts')}><span className="dot" style={{ background: HEALTH_COLOR.host_offline }} /><b>{summary.hostsOffline}</b><span>Hosts offline</span></button></li>}
        </ul>
        <div className="filters">
          <label className="search"><Icon name="search" /><input placeholder="Search services…" value={s.filters.text} onChange={(e) => s.setFilters({ text: e.target.value })} /></label>
          <div className="row">
            <select value={s.filters.type} onChange={(e) => s.setFilters({ type: e.target.value as never })} aria-label="Type filter">
              <option value="all">All types</option>
              {types.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
            </select>
            <select value={s.filters.host} onChange={(e) => s.setFilters({ host: e.target.value })} aria-label="Host filter">
              <option value="all">All hosts</option>
              {hosts.map((h) => <option key={h.id} value={h.id}>{h.displayName}</option>)}
            </select>
          </div>
          {filtersActive(s.filters) && (
            <div className="row">
              <button className="link-btn" onClick={() => s.setFilters({ text: '', health: 'all', type: 'all', host: 'all' })}>Clear filters</button>
              {saving === null
                ? <button className="link-btn" onClick={() => setSaving('')}><Icon name="bookmark" size={12} /> Save view</button>
                : (
                  <form className="save-view" onSubmit={(ev) => { ev.preventDefault(); if (!saving.trim()) return; void api<{ view: import('@berrie/shared').SavedView }>('/api/account/views', { method: 'POST', json: { name: saving.trim(), view: { filters: s.filters, camera: rendererRef.current?.camera() } } }).then((r) => { s.setPersonal({ savedViews: [...s.savedViews, r.view] }); setSaving(null); setToast('View saved to your home page.'); }).catch((e) => setToast((e as Error).message)); }}>
                    <input autoFocus placeholder="View name" maxLength={60} value={saving} onChange={(ev) => setSaving(ev.target.value)} />
                    <button type="submit">Save</button>
                  </form>
                )}
            </div>
          )}
          {s.savedViews.length > 0 && (
            <select value="" onChange={(ev) => { const v = s.savedViews.find((x) => x.id === ev.target.value); if (v) { s.setFilters(v.view.filters as never); if (v.view.camera) rendererRef.current?.setCamera(v.view.camera); } }} aria-label="My saved views">
              <option value="">My saved views…</option>
              {s.savedViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
        </div>
        {noBuilding.length > 0 && <p className="hint-small">{noBuilding.length} service(s) without a plot (district full).</p>}
      </aside>

      <div className="controls">
        <button onClick={() => rendererRef.current?.zoomBy(1.25)} title="Zoom in (+)"><Icon name="plus" /></button>
        <button onClick={() => rendererRef.current?.zoomBy(0.8)} title="Zoom out (−)"><Icon name="minus" /></button>
        <button onClick={() => rendererRef.current?.fit()} title="Fit village"><Icon name="target" /></button>
        {canOperate && <button className={s.editLayout ? 'on' : ''} onClick={() => s.setEditLayout(!s.editLayout)} title="Edit layout: drag buildings to move them"><Icon name="move" /></button>}
      </div>
      {ready && <Minimap renderer={rendererRef.current!} tick={camTick} entitiesKey={list.length + s.blocks.length} />}
      {s.editLayout && <div className="edit-banner">Layout editor: drag a building to a free spot. Positions are saved and pinned.<button onClick={() => s.setEditLayout(false)}>Done</button></div>}
      {toast && <div className="toast">{toast}</div>}

      <aside className="sidepanel">
        {selected ? <Inspector entity={selected} onClose={() => s.select(null)} /> : <ActivityPanel alerts={alerts} />}
      </aside>

      {s.loaded && !s.connected && s.mode === 'live' && (
        <div className="setup card">
          <h2>Not connected to your infrastructure yet</h2>
          <p>Berrie World has not completed a single discovery inventory, so there is nothing real to show. No demo data is mixed in.</p>
          <ul>
            {s.adapters.filter((a) => a.adapter !== 'config').map((a) => <li key={a.adapter + a.scope}><b>{a.adapter}:{a.scope}</b> — {a.completeness}{a.error ? `: ${a.error}` : ''}</li>)}
            {!s.adapters.some((a) => a.adapter !== 'config') && <li>No discovery adapter has reported yet.</li>}
          </ul>
          <p className="hint-small">Check that the Docker socket (or socket proxy) is reachable by the server, then wait for the next discovery cycle.</p>
        </div>
      )}

      <footer className="footer">
        <span>{summary.total} services</span>·<span>{hosts.length} host{hosts.length === 1 ? '' : 's'}</span>·
        <span>{s.hints.filter((h) => h.status === 'matched').length}/{s.hints.length} known hostnames verified</span>·
        <span title={summary.lastDiscoveryAt ?? ''}>discovery {timeAgo(summary.lastDiscoveryAt, s.serverOffsetMs)}</span>
      </footer>
    </div>
  );
}
