import { Fragment } from 'react';
import type { EntityView, Fact, FactCategory, FactStatus, Listener } from '@berrie/shared';
import { FACT_CATEGORIES, FACT_LABEL, SENSITIVE_PORTS, WELL_KNOWN_PORTS } from '@berrie/shared';
import { useStore } from '../state/store';
import { fmtBytes, timeAgo } from './status';
import { fmtDuration, hostFacts, pressure } from './facts';

const STATUS_TEXT: Record<FactStatus, string> = {
  confirmed: 'confirmed', stale: 'stale', unavailable: 'unavailable', unconfigured: 'not collected', unknown: 'waiting',
};

function value(c: FactCategory, f: Fact<unknown>): string {
  const v = f.value as Record<string, unknown> | null;
  if (!v) return f.error ?? (f.status === 'unconfigured' ? 'no collector for this server — add an agent or SSH in Server Harbor' : f.status === 'unknown' ? 'no result yet' : '—');
  switch (c) {
    case 'identity': return String(v.hostname);
    case 'os': return [v.name, v.kernel && `kernel ${v.kernel}`, v.arch].filter(Boolean).join(' · ');
    case 'cpu': return `${v.cores} cores${v.model ? ` · ${v.model}` : ''}${v.usagePct != null ? ` · ${v.usagePct}% busy` : ''}`;
    case 'memory': return v.usedPct != null ? `${fmtBytes(v.usedBytes as number)} of ${fmtBytes(v.totalBytes as number)} (${v.usedPct}%)` : `${fmtBytes(v.totalBytes as number)} total · usage not collected`;
    case 'storage': return (v.filesystems as { mount: string; usedPct: number; sizeBytes: number }[]).map((x) => `${x.mount} ${x.usedPct}% of ${fmtBytes(x.sizeBytes)}`).join(' · ');
    case 'network': return (v.interfaces as { name: string; rxBps: number | null; txBps: number | null }[]).map((i) => `${i.name} ↓${i.rxBps != null ? fmtBytes(i.rxBps) + '/s' : '?'} ↑${i.txBps != null ? fmtBytes(i.txBps) + '/s' : '?'}`).join(' · ') || 'no physical interfaces';
    case 'uptime': return `up ${fmtDuration(Number(v.seconds))} · load ${v.load1} / ${v.load5} / ${v.load15}`;
    case 'containers': return `${v.running} running · ${v.stopped} stopped`;
    case 'ports': { const ls = v.listeners as Listener[]; return `${new Set(ls.map((l) => l.port)).size} ports · ${new Set(ls.filter((l) => l.scope === 'all').map((l) => l.port)).size} on all interfaces`; }
    default: return '';
  }
}

/** Every category with its collection status, value (only when collected), source and age. */
export function HostFactsPanel({ e, offset }: { e: EntityView; offset: number }) {
  const facts = hostFacts(e);
  if (!facts) return null;
  const pr = pressure(facts);
  return (
    <section>
      <h4>Server facts</h4>
      {pr.length > 0 && <div className="callout amber"><b>Resource pressure</b><p>{pr.map((p) => p.label).join(' · ')}</p></div>}
      <dl className="facts facts-status">
        {FACT_CATEGORIES.map((c) => {
          const f = facts[c] as Fact<unknown>;
          return (
            <Fragment key={c}>
              <dt>{FACT_LABEL[c]}</dt>
              <dd>
                <span className={`fs fs-${f.status}`}>{STATUS_TEXT[f.status]}</span> <span className={f.value ? '' : 'muted'}>{value(c, f)}</span>
                {f.source && <small>{f.source}{f.ts ? ` · ${timeAgo(f.ts, offset)}` : ''}{f.status === 'stale' && f.error ? ` · last attempt failed: ${f.error}` : ''}</small>}
              </dd>
            </Fragment>
          );
        })}
      </dl>
      <PortsList e={e} />
    </section>
  );
}

const SCOPE_TEXT: Record<Listener['scope'], string> = { all: 'All interfaces', lan: 'Specific address', tailscale: 'Tailscale only', loopback: 'This machine only' };

/** Listening ports grouped by exposure, labelled with the container that publishes them when Docker explains it. */
function PortsList({ e }: { e: EntityView }) {
  const entities = useStore((s) => s.entities);
  const f = hostFacts(e)?.ports;
  if (!f?.value?.listeners.length) return null;
  const containers = Object.values(entities).filter((x) => x.hostId === e.id && x.kind === 'service');
  const owner = (port: number) => containers.find((c) => ((c.meta.ports as string[]) ?? []).some((p) => p.includes(`:${port}->`)));
  const byPort = new Map<string, Listener>();
  for (const l of f.value.listeners) { const k = `${l.scope}|${l.port}`; if (!byPort.has(k)) byPort.set(k, l); }
  const groups = (['all', 'lan', 'tailscale', 'loopback'] as const).map((sc) => [sc, [...byPort.values()].filter((l) => l.scope === sc)] as const).filter(([, ls]) => ls.length);
  const exposed = [...byPort.values()].filter((l) => l.scope === 'all' && SENSITIVE_PORTS.has(l.port));
  return (
    <details className="ports">
      <summary>Listening ports ({new Set(f.value.listeners.map((l) => l.port)).size}) — from the server's own socket list, not a scan</summary>
      {exposed.length > 0 && <div className="callout amber"><b>Worth a look</b><p>{exposed.map((l) => `${WELL_KNOWN_PORTS[l.port] ?? l.port} (${l.port})`).join(', ')} listen on all interfaces. Whether that is reachable from outside depends on your router/firewall — Berrie World does not test it.</p></div>}
      {groups.map(([sc, ls]) => (
        <div key={sc}>
          <h5>{SCOPE_TEXT[sc]}</h5>
          <ul className="port-list">
            {ls.map((l) => { const c = owner(l.port); return (
              <li key={`${sc}${l.port}`} className={sc === 'all' && SENSITIVE_PORTS.has(l.port) ? 'warn' : ''}>
                <b>{l.port}</b><span>{c ? c.displayName : l.process ?? (WELL_KNOWN_PORTS[l.port] ? `probably ${WELL_KNOWN_PORTS[l.port]}` : 'unknown process')}</span><small>{l.address}</small>
              </li>
            ); })}
          </ul>
        </div>
      ))}
      <p className="small muted">Processes owned by other users (e.g. root) cannot be named without root rights; labels marked “probably” come from the port number only.</p>
    </details>
  );
}
