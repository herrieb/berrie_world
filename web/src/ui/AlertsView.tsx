import type { Alert } from '@berrie/shared';
import { HEALTH_LABEL } from '@berrie/shared';
import { alertExtras, useRole, useStore } from '../state/store';
import { api } from '../state/api';
import { Icon } from './Icon';
import { HEALTH_COLOR, timeAgo } from './status';

export function AlertsView({ alerts }: { alerts: Alert[] }) {
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const entities = useStore((s) => s.entities);
  const adapters = useStore((s) => s.adapters);
  const acks = useStore((s) => s.acks);
  const windows = useStore((s) => s.maintenance);
  const incidents = useStore((s) => s.incidents);
  const selectIncident = useStore((s) => s.selectIncident);
  const offset = useStore((s) => s.serverOffsetMs);
  const canOperate = useRole('operator');
  const uncertain = adapters.filter((a) => a.completeness !== 'complete');
  const go = (id: string) => { select(id, true); setView('world'); };
  const ack = (a: Alert) => void api(`/api/alerts/${encodeURIComponent(a.entityId)}/ack`, { method: 'POST', json: { since: a.since ?? new Date().toISOString() } });

  return (
    <div className="page">
      <div className="page-head"><h1>Alerts</h1><span className="muted">{alerts.length} active · grouped into {Object.values(incidents).filter((i) => i.status !== 'resolved').length} open incident(s)</span></div>
      {uncertain.length > 0 && (
        <div className="card callout amber">
          <b>Discovery is uncertain</b>
          {uncertain.map((a) => <p key={a.adapter + a.scope}>{a.adapter}:{a.scope} is {a.completeness}{a.error ? ` — ${a.error}` : ''}. Services it reports are kept, and none will be removed until a complete inventory succeeds.</p>)}
        </div>
      )}
      <div className="card">
        {!alerts.length ? <p className="muted">No active alerts. Everything that is known is healthy.</p> : (
          <table className="table">
            <thead><tr><th>Severity</th><th>Service</th><th>State</th><th>Reason</th><th>Since</th><th /></tr></thead>
            <tbody>
              {alerts.map((a) => {
                const affected = entities[a.entityId]?.kind === 'host' ? Object.values(entities).filter((e) => e.hostId === a.entityId && e.id !== a.entityId && e.kind === 'service').length : 0;
                const x = alertExtras(a, acks, windows, entities);
                const inc = Object.values(incidents).find((i) => i.status !== 'resolved' && i.entities.some((e) => e.entityId === a.entityId));
                return (
                  <tr key={`${a.entityId}|${a.reason}`} onClick={() => go(a.entityId)} className={x.acked ? 'dim' : ''}>
                    <td><span className={`sev ${a.severity}`}>{a.severity}</span></td>
                    <td><b>{a.displayName}</b>{affected ? <small>{affected} services potentially affected</small> : null}{x.maintenance && <small className="maint"><Icon name="wrench" size={11} /> in maintenance “{x.maintenance.title}”{x.maintenance.suppress ? ' — notifications suppressed' : ''}</small>}</td>
                    <td><span className="dot" style={{ background: a.lifecycle === 'missing' ? '#c9b37a' : HEALTH_COLOR[a.health] }} /> {a.lifecycle === 'missing' ? 'Missing (unconfirmed)' : HEALTH_LABEL[a.health]}</td>
                    <td>{a.reason ?? '—'}{inc && <small><a onClick={(ev) => { ev.stopPropagation(); selectIncident(inc.id); setView('incidents'); }}>incident: {inc.title}</a></small>}</td>
                    <td>{timeAgo(a.since, offset)}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      {x.acked ? <span className="small muted" title={x.acked.note ?? ''}>acknowledged by {x.acked.actor}</span>
                        : canOperate ? <button onClick={() => ack(a)}><Icon name="check" /> Acknowledge</button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="small muted">Acknowledging records who is on it; the alert stays until the state really changes. A new failure alerts again.</p>
      </div>
    </div>
  );
}
