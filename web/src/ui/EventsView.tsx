import { useEffect, useState } from 'react';
import type { WorldEvent } from '@berrie/shared';
import { useStore } from '../state/store';
import { api } from '../state/api';
import { describeEvent, eventColor } from './events';

export function EventsView() {
  const live = useStore((s) => s.events);
  const entities = useStore((s) => s.entities);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const [older, setOlder] = useState<WorldEvent[]>([]);
  const [done, setDone] = useState(false);
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('all');

  useEffect(() => { setOlder([]); setDone(false); }, []);
  const all = [...live, ...older.filter((o) => !live.some((l) => l.id === o.id))];
  const shown = all.filter((e) => (sev === 'all' || e.severity === sev) && (!q || describeEvent(e, entities).toLowerCase().includes(q.toLowerCase()) || e.type.includes(q)));

  const more = async () => {
    const before = all.at(-1)?.ts;
    const r = await api<{ events: WorldEvent[] }>(`/api/events?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    if (r.events.length < 100) setDone(true);
    setOlder((o) => [...o, ...r.events]);
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Event timeline</h1>
        <label className="search"><input placeholder="Filter events…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <select value={sev} onChange={(e) => setSev(e.target.value)} aria-label="Severity"><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option><option value="notice">Notice</option><option value="info">Info</option></select>
      </div>
      <p className="muted small page-note">Every entry is a stored, observed event. Village animations replay these; nothing is generated for decoration.</p>
      <div className="card">
        <ol className="timeline full">
          {shown.map((ev) => (
            <li key={ev.id} className={ev.entityId && entities[ev.entityId] ? 'clickable' : ''} onClick={() => { if (ev.entityId && entities[ev.entityId]) { select(ev.entityId, true); setView('world'); } }}>
              <span className="t">{new Date(ev.ts).toLocaleString()}</span>
              <span className="dot" style={{ background: eventColor(ev) }} />
              <span className="d">{describeEvent(ev, entities)}<small>{ev.type} · {ev.source} · {ev.severity}</small></span>
            </li>
          ))}
          {!shown.length && <li className="muted">No events.</li>}
        </ol>
        {!done && <button className="more" onClick={() => void more()}>Load older events</button>}
      </div>
    </div>
  );
}
