import { useEffect, useState } from 'react';
import type { ConnectionView, WorldEvent } from '@berrie/shared';
import { CONNECTION_LABEL, HEALTH_LABEL, LIFECYCLE_LABEL } from '@berrie/shared';
import { useStore } from '../state/store';
import { api } from '../state/api';
import { Icon } from './Icon';
import { HEALTH_COLOR, fmtTime, timeAgo } from './status';
import { describeEvent, eventColor } from './events';
import { VERIFICATION_TEXT } from './topologyText';

/** A relationship: what supports it, configured vs observed, and its measured values (if any). */
export function ConnectionInspector({ c, onClose }: { c: ConnectionView; onClose: () => void }) {
  const entities = useStore((s) => s.entities);
  const select = useStore((s) => s.select);
  const offset = useStore((s) => s.serverOffsetMs);
  const [history, setHistory] = useState<WorldEvent[]>([]);
  useEffect(() => {
    api<{ events: WorldEvent[] }>(`/api/events?entity=${encodeURIComponent(c.src)}&limit=200`)
      .then((r) => setHistory(r.events.filter((e) => e.details.connection === c.id))).catch(() => setHistory([]));
  }, [c.id, c.health, c.lifecycle]);
  const a = entities[c.src], b = entities[c.dst];
  const v = VERIFICATION_TEXT[c.verification];
  const kind = c.type === 'internet' ? 'Ferry — public internet route' : ['lan', 'vpn', 'direct'].includes(c.type) ? 'Bridge — private network link' : c.type === 'proxy' ? 'Gateway route' : 'Dependency';
  return (
    <div className="inspector card">
      <div className="insp-head">
        <div className="insp-icon"><Icon name={c.type === 'internet' ? 'anchor' : 'route'} size={24} /></div>
        <div className="grow">
          <h2>{c.meta.label ?? CONNECTION_LABEL[c.type]}</h2>
          <div className="sub">{kind}</div>
        </div>
        <span className="pill" style={{ '--c': HEALTH_COLOR[c.health] } as React.CSSProperties}><span className="dot" />{HEALTH_LABEL[c.health]}</span>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)"><Icon name="x" /></button>
      </div>
      <div className="insp-body">
        <div className="link-ends">
          <button onClick={() => a && select(a.id, true)}>{a?.displayName ?? c.src}</button>
          <span>{['lan', 'vpn', 'direct'].includes(c.type) ? '⟷' : '→'}</span>
          <button onClick={() => b && select(b.id, true)}>{b?.displayName ?? c.dst}</button>
        </div>
        <div className={`callout ${c.verification === 'verified' ? 'gray' : 'amber'}`}>
          <b>{v.label[0].toUpperCase() + v.label.slice(1)}</b>
          <p>{v.help}</p>
        </div>
        <dl className="facts">
          <dt>Type</dt><dd>{CONNECTION_LABEL[c.type]}</dd>
          <dt>Reported by</dt><dd>{c.source}</dd>
          <dt>State</dt><dd>{HEALTH_LABEL[c.health]}{c.reason ? ` — ${c.reason}` : ''}</dd>
          <dt>Lifecycle</dt><dd>{LIFECYCLE_LABEL[c.lifecycle]}</dd>
          <dt>Latency</dt><dd>{c.meta.latencyMs != null ? `${c.meta.latencyMs} ms (measured ${timeAgo(c.meta.measuredAt ?? null, offset)})` : <span className="muted">not measured</span>}</dd>
          <dt>Packet loss</dt><dd>{c.meta.lossPct != null ? `${c.meta.lossPct}%` : <span className="muted">not measured</span>}</dd>
          {c.meta.direct !== undefined && <><dt>Path</dt><dd>{c.meta.direct ? 'direct' : c.meta.relay ? `relayed (${c.meta.relay})` : 'not direct'}</dd></>}
          <dt>Traffic</dt><dd>{c.lastActivityAt ? `last observed ${timeAgo(c.lastActivityAt, offset)}` : <span className="muted">no traffic reported (configured connectivity only)</span>}</dd>
          <dt>First seen</dt><dd>{new Date(c.firstSeenAt).toLocaleString()}</dd>
          <dt>Last confirmed</dt><dd>{timeAgo(c.lastSeenAt, offset)}</dd>
        </dl>
        {!!c.meta.hostnames?.length && <section><h4>Public hostnames on this route</h4><p className="small">{c.meta.hostnames.join(', ')}</p></section>}
        <section><h4>What supports this relationship</h4><ul className="evidence">{c.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></section>
        <section>
          <h4>History</h4>
          {!history.length ? <p className="muted">No state changes recorded.</p> : (
            <ol className="timeline compact">{history.slice(0, 15).map((ev) => <li key={ev.id}><span className="t">{fmtTime(ev.ts)}</span><span className="dot" style={{ background: eventColor(ev) }} /><span className="d">{describeEvent(ev, entities)}</span></li>)}</ol>
          )}
        </section>
      </div>
    </div>
  );
}
