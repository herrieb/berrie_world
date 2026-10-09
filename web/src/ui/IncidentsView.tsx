import { useEffect, useMemo, useState } from 'react';
import type { IncidentView, MaintenanceWindow, Severity, TimelineEntry } from '@berrie/shared';
import { useRole, useStore, type Replay } from '../state/store';
import { api } from '../state/api';
import { Icon } from './Icon';
import { HEALTH_COLOR, timeAgo } from './status';
import { effectiveHealth } from '@berrie/shared';

const SEV_ORDER: Severity[] = ['critical', 'warning', 'notice', 'info'];
const STATUS_TEXT = { open: 'Open', monitoring: 'Recovered — awaiting confirmation', resolved: 'Resolved' } as const;

function toLocalInput(d: Date) { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }

function Maintenance() {
  const entities = useStore((s) => s.entities);
  const windows = useStore((s) => s.maintenance);
  const canOperate = useRole('operator');
  const [all, setAll] = useState<MaintenanceWindow[]>([]);
  const [f, setF] = useState({ title: '', entityIds: [] as string[], start: toLocalInput(new Date()), end: toLocalInput(new Date(Date.now() + 2 * 3600_000)), suppress: true, description: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api<{ windows: MaintenanceWindow[] }>('/api/maintenance').then((r) => setAll(r.windows)).catch(() => undefined);
  useEffect(() => { void load(); }, [windows]);
  const targets = Object.values(entities).filter((e) => e.kind === 'host' || e.kind === 'service' || e.kind === 'gateway').sort((a, b) => (a.kind === 'host' ? 0 : 1) - (b.kind === 'host' ? 0 : 1) || a.displayName.localeCompare(b.displayName));
  const now = Date.now();
  return (
    <section className="card">
      <h3><Icon name="wrench" /> Maintenance windows</h3>
      <ul className="maint-list">
        {all.filter((w) => !w.cancelledAt && Date.parse(w.endsAt) > now - 7 * 86400_000).map((w) => {
          const active = Date.parse(w.startsAt) <= now && now < Date.parse(w.endsAt);
          const past = Date.parse(w.endsAt) <= now;
          return (
            <li key={w.id} className={active ? 'active' : past ? 'past' : ''}>
              <b>{w.title}</b> <span className="small muted">{new Date(w.startsAt).toLocaleString()} → {new Date(w.endsAt).toLocaleString()} · {active ? 'active now' : past ? 'ended' : 'scheduled'}{w.suppress ? ' · suppresses incidents' : ''} · by {w.createdBy}</span>
              <small>{w.entityIds.map((id) => entities[id]?.displayName ?? id).join(', ')}</small>
              {canOperate && !past && <button className="link-btn" onClick={() => void api(`/api/maintenance/${w.id}`, { method: 'DELETE' }).then(load)}>Cancel</button>}
            </li>
          );
        })}
        {!all.length && <li className="muted">No maintenance planned.</li>}
      </ul>
      {canOperate && (
        <form className="form maint-form" onSubmit={(e) => { e.preventDefault(); setMsg(null); void api('/api/maintenance', { method: 'POST', json: { title: f.title, description: f.description || undefined, entityIds: f.entityIds, startsAt: new Date(f.start).toISOString(), endsAt: new Date(f.end).toISOString(), suppress: f.suppress } }).then(() => { setF({ ...f, title: '', entityIds: [], description: '' }); void load(); }).catch((x) => setMsg((x as Error).message)); }}>
          <h4>Plan maintenance</h4>
          <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={120} placeholder="Kernel update on srv01" /></label>
          <label>Covers (a server covers everything on it)
            <select multiple size={6} value={f.entityIds} onChange={(e) => setF({ ...f, entityIds: [...e.target.selectedOptions].map((o) => o.value) })}>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.kind === 'host' ? `▣ ${t.displayName} (whole server)` : `   ${t.displayName}`}</option>)}
            </select>
          </label>
          <div className="row3"><label>Starts<input type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></label><label>Ends<input type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></label></div>
          <label className="check"><input type="checkbox" checked={f.suppress} onChange={(e) => setF({ ...f, suppress: e.target.checked })} /> Suppress incidents and notifications (health is still shown as measured)</label>
          <button className="primary" type="submit" disabled={!f.entityIds.length}>Schedule</button>
          {msg && <p className="msg">{msg}</p>}
        </form>
      )}
    </section>
  );
}

function Detail({ inc }: { inc: IncidentView }) {
  const entities = useStore((s) => s.entities);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const setReplay = useStore((s) => s.setReplay);
  const me = useStore((s) => s.me);
  const offset = useStore((s) => s.serverOffsetMs);
  const canOperate = useRole('operator');
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [note, setNote] = useState('');
  const [assignees, setAssignees] = useState<{ id: string; name: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api<{ timeline: TimelineEntry[] }>(`/api/incidents/${inc.id}`).then((r) => setTimeline(r.timeline)).catch(() => undefined); }, [inc]);
  useEffect(() => { if (canOperate) api<{ users: { id: string; name: string }[] }>('/api/assignees').then((r) => setAssignees(r.users)).catch(() => undefined); }, [canOperate]);
  const act = (path: string, body: object = {}) => { setErr(null); return api<{ timeline: TimelineEntry[] }>(`/api/incidents/${inc.id}/${path}`, { method: 'POST', json: body }).then((r) => setTimeline(r.timeline)).catch((e) => setErr((e as Error).message)); };
  const name = (id: string | null) => (id ? entities[id]?.displayName ?? id : '—');
  const replay = async () => {
    const r = await api<Omit<Replay, 'incidentId' | 't'>>(`/api/incidents/${inc.id}/replay`);
    setReplay({ ...r, incidentId: inc.id, t: Date.parse(r.from) });
    setView('world');
  };
  return (
    <div className="card incident-detail">
      <div className="inc-head">
        <span className={`sev ${inc.severity}`}>{inc.severity}</span>
        <h2>{inc.title}</h2>
        <span className={`inc-status ${inc.status}`}>{STATUS_TEXT[inc.status]}</span>
      </div>
      <p className="small muted">Opened {new Date(inc.openedAt).toLocaleString()} ({timeAgo(inc.openedAt, offset)}){inc.createdBy !== 'system' ? ' manually' : ''}{inc.recoveredAt ? ` · recovered ${timeAgo(inc.recoveredAt, offset)}` : ''}{inc.resolvedAt ? ` · resolved by ${inc.resolvedBy} ${timeAgo(inc.resolvedAt, offset)}` : ''}</p>
      {err && <p className="msg">{err}</p>}

      {inc.hypothesis && (
        <div className={`callout ${inc.hypothesisVerified ? 'gray' : 'violet'}`}>
          <b>{inc.hypothesisVerified ? 'Cause (confirmed by a person)' : 'Hypothesis — not verified'}</b>
          <p>{inc.hypothesis}</p>
          <div className="row">
            {inc.hypothesisEntityId && <button onClick={() => { select(inc.hypothesisEntityId, true); setView('world'); }}>Investigate {name(inc.hypothesisEntityId)}</button>}
            {canOperate && !inc.hypothesisVerified && inc.status !== 'resolved' && <><button onClick={() => void act('hypothesis', { verdict: 'confirm' })}>Confirm cause</button><button onClick={() => void act('hypothesis', { verdict: 'reject' })}>Reject</button></>}
          </div>
        </div>
      )}

      <h4>Affected</h4>
      <ul className="rel-list">
        {inc.entities.map((x) => {
          const e = entities[x.entityId];
          return (
            <li key={x.entityId}><button onClick={() => { select(x.entityId, true); setView('world'); }}>
              <span className="dot" style={{ background: e ? HEALTH_COLOR[effectiveHealth(e)] : '#888' }} />
              <span className="grow">{name(x.entityId)}<small>{x.role === 'suspected' ? 'suspected cause (hypothesis)' : x.role} · added {timeAgo(x.addedAt, offset)}{e ? ` · now ${effectiveHealth(e).replace('_', ' ')}` : ' · no longer on the map'}</small></span>
            </button></li>
          );
        })}
      </ul>

      <div className="row inc-actions">
        <button onClick={() => void replay()}><Icon name="history" /> Replay on map</button>
        {canOperate && inc.status !== 'resolved' && (
          <>
            <button onClick={() => void act('ack')}><Icon name="check" /> Acknowledge</button>
            <select value={inc.assignee?.id ?? ''} onChange={(e) => void act('assign', { userId: e.target.value || null })} aria-label="Assignee">
              <option value="">Unassigned</option>
              {assignees.map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === me?.user?.id ? ' (me)' : ''}</option>)}
            </select>
            <button className={inc.status === 'monitoring' ? 'primary' : ''} onClick={() => { if (inc.status === 'monitoring' || confirm('Some affected items are still failing. Resolve anyway?')) void act('resolve', {}); }}>
              <Icon name="check" /> {inc.status === 'monitoring' ? 'Confirm recovery' : 'Resolve'}
            </button>
          </>
        )}
        {inc.assignee && <span className="small muted">assigned to {inc.assignee.name}</span>}
      </div>

      <h4>Timeline</h4>
      <ol className="timeline">
        {timeline.map((t) => (
          <li key={t.id} className={`tl-${t.kind}`}><span className="t">{new Date(t.ts).toLocaleString([], { hourCycle: 'h23' })}</span><span className="d"><b>{t.actor}</b> {t.text}</span></li>
        ))}
      </ol>
      {canOperate && inc.status !== 'resolved' && (
        <form className="note-form" onSubmit={(e) => { e.preventDefault(); if (note.trim()) void act('notes', { text: note }).then(() => setNote('')); }}>
          <textarea rows={2} value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} placeholder="Add a note to the timeline…" />
          <button type="submit">Add note</button>
        </form>
      )}
    </div>
  );
}

export function IncidentsView() {
  const incidents = useStore((s) => s.incidents);
  const selected = useStore((s) => s.selectedIncident);
  const selectIncident = useStore((s) => s.selectIncident);
  const me = useStore((s) => s.me);
  const [tab, setTab] = useState<'active' | 'resolved'>('active');
  const [history, setHistory] = useState<IncidentView[]>([]);
  useEffect(() => { if (tab === 'resolved') api<{ incidents: IncidentView[] }>('/api/incidents?status=resolved').then((r) => setHistory(r.incidents)).catch(() => undefined); }, [tab]);
  const list = useMemo(() => {
    const src = tab === 'active' ? Object.values(incidents).filter((i) => i.status !== 'resolved') : history;
    return src.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || b.openedAt.localeCompare(a.openedAt));
  }, [incidents, history, tab]);
  const current = (selected && (incidents[selected] ?? history.find((h) => h.id === selected))) || list[0] || null;
  return (
    <div className="page incidents">
      <div className="page-head">
        <h1><Icon name="flame" /> Incidents</h1>
        <div className="seg"><button className={tab === 'active' ? 'on' : ''} onClick={() => setTab('active')}>Active</button><button className={tab === 'resolved' ? 'on' : ''} onClick={() => setTab('resolved')}>History</button></div>
      </div>
      <div className="inc-layout">
        <div className="card inc-list">
          {!list.length && <p className="muted">{tab === 'active' ? 'No open incidents.' : 'No resolved incidents yet.'}</p>}
          {list.map((i) => (
            <button key={i.id} className={`inc-row${current?.id === i.id ? ' on' : ''}`} onClick={() => selectIncident(i.id)}>
              <span className={`sev ${i.severity}`}>{i.severity}</span>
              <span className="grow">{i.title}<small>{STATUS_TEXT[i.status]} · {i.entities.length} item(s) · {timeAgo(i.openedAt)}{i.assignee ? ` · ${i.assignee.id === me?.user?.id ? 'assigned to you' : i.assignee.name}` : ''}</small></span>
            </button>
          ))}
        </div>
        <div>{current ? <Detail inc={current} /> : <div className="card"><p className="muted">Incidents are opened automatically from real failures, grouped by host and known dependencies.</p></div>}</div>
      </div>
      <Maintenance />
    </div>
  );
}
