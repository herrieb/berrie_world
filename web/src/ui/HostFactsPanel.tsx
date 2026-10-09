import { Fragment } from 'react';
import type { EntityView, Fact, FactCategory, FactStatus } from '@berrie/shared';
import { FACT_CATEGORIES, FACT_LABEL } from '@berrie/shared';
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
    </section>
  );
}
