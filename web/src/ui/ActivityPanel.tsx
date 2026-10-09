import type { Alert } from '@berrie/shared';
import { HEALTH_LABEL } from '@berrie/shared';
import { useStore } from '../state/store';
import { describeEvent, eventColor } from './events';
import { HEALTH_COLOR, fmtTime, timeAgo } from './status';

/** Quiet activity is shown as quiet: only stored events appear here. */
const NOISY = new Set(['http.request', 'ai.request_started', 'task.executed', 'layout.moved']);

export function ActivityPanel({ alerts }: { alerts: Alert[] }) {
  const events = useStore((s) => s.events);
  const entities = useStore((s) => s.entities);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const offset = useStore((s) => s.serverOffsetMs);
  const shown = events.filter((e) => !NOISY.has(e.type)).slice(0, 14);

  return (
    <div className="panel-stack">
      <section className="card">
        <div className="card-head"><h3>Active alerts</h3>{alerts.length > 0 && <button className="link-btn" onClick={() => setView('alerts')}>View all →</button>}</div>
        {alerts.length === 0 ? <p className="muted">No active alerts.</p> : (
          <ul className="alert-list">
            {alerts.slice(0, 6).map((a) => (
              <li key={a.entityId}>
                <button onClick={() => select(a.entityId, true)}>
                  <span className="dot" style={{ background: a.lifecycle === 'missing' ? '#c9b37a' : HEALTH_COLOR[a.health] }} />
                  <span className="grow"><b>{a.displayName}</b><small>{a.lifecycle === 'missing' ? 'Missing — awaiting confirmation' : HEALTH_LABEL[a.health]}{a.since ? ` · ${timeAgo(a.since, offset)}` : ''}</small></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card grow-card">
        <div className="card-head"><h3>Recent activity</h3><button className="link-btn" onClick={() => setView('events')}>View all →</button></div>
        {shown.length === 0 ? <p className="muted">Quiet. No events recorded yet.</p> : (
          <ol className="timeline">
            {shown.map((ev) => (
              <li key={ev.id} onClick={() => ev.entityId && entities[ev.entityId] && select(ev.entityId, true)} className={ev.entityId && entities[ev.entityId] ? 'clickable' : ''}>
                <span className="t">{fmtTime(ev.ts)}</span>
                <span className="dot" style={{ background: eventColor(ev) }} />
                <span className="d">{describeEvent(ev, entities)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
