import type { Alert } from '@berrie/shared';
import { HEALTH_LABEL } from '@berrie/shared';
import { useStore } from '../state/store';
import { HEALTH_COLOR, timeAgo } from './status';

export function AlertsView({ alerts }: { alerts: Alert[] }) {
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const entities = useStore((s) => s.entities);
  const adapters = useStore((s) => s.adapters);
  const offset = useStore((s) => s.serverOffsetMs);
  const uncertain = adapters.filter((a) => a.completeness !== 'complete');
  const go = (id: string) => { select(id, true); setView('world'); };

  return (
    <div className="page">
      <div className="page-head"><h1>Alerts</h1></div>
      {uncertain.length > 0 && (
        <div className="card callout amber">
          <b>Discovery is uncertain</b>
          {uncertain.map((a) => <p key={a.adapter + a.scope}>{a.adapter}:{a.scope} is {a.completeness}{a.error ? ` — ${a.error}` : ''}. Services it reports are kept, and none will be removed until a complete inventory succeeds.</p>)}
        </div>
      )}
      <div className="card">
        {!alerts.length ? <p className="muted">No active alerts. Everything that is known is healthy.</p> : (
          <table className="table">
            <thead><tr><th>Severity</th><th>Service</th><th>State</th><th>Reason</th><th>Since</th></tr></thead>
            <tbody>
              {alerts.map((a) => {
                const affected = entities[a.entityId]?.kind === 'host' ? Object.values(entities).filter((e) => e.hostId === a.entityId && e.id !== a.entityId && e.kind === 'service').length : 0;
                return (
                  <tr key={a.entityId} onClick={() => go(a.entityId)}>
                    <td><span className={`sev ${a.severity}`}>{a.severity}</span></td>
                    <td><b>{a.displayName}</b>{affected ? <small>{affected} services potentially affected</small> : null}</td>
                    <td><span className="dot" style={{ background: a.lifecycle === 'missing' ? '#c9b37a' : HEALTH_COLOR[a.health] }} /> {a.lifecycle === 'missing' ? 'Missing (unconfirmed)' : HEALTH_LABEL[a.health]}</td>
                    <td>{a.reason ?? '—'}</td>
                    <td>{timeAgo(a.since, offset)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
