import { useEffect, useState } from 'react';
import type { ConnectionView, EntityView, ImpactReport, WorldEvent } from '@berrie/shared';
import { CONNECTION_LABEL, HEALTH_LABEL, LIFECYCLE_LABEL, effectiveHealth } from '@berrie/shared';
import { useStore, useRole } from '../state/store';
import { api, ApiError, toggleFavorite } from '../state/api';
import { Icon } from './Icon';
import { HEALTH_COLOR, TYPE_LABEL, fmtBytes, fmtTime, iconSvg, statusText, timeAgo } from './status';
import { describeEvent, eventColor } from './events';
import { HostFactsPanel } from './HostFactsPanel';
import { MetricChart } from './MetricChart';
import { IMPACT_TEXT, VERIFICATION_TEXT } from './topologyText';
import { fmtDuration, hostFacts, known } from './facts';

interface Detail {
  entity: EntityView;
  children: EntityView[];
  events: WorldEvent[];
  checks: { check_name: string; ts: string; outcome: 'ok' | 'fail' | 'unknown'; latency_ms: number | null; status_code: number | null; error: string | null }[];
  actions: { enabled: boolean; reason: string | null; allowed: { action: 'start' | 'stop' | 'restart'; impact: string }[] };
}
interface Runtime {
  available: boolean;
  reason?: string;
  measuredAt?: string;
  details?: { startedAt: string | null; finishedAt: string | null; exitCode: number | null; restartCount: number; hasHealthcheck: boolean; healthLog: { ts: string; exitCode: number; output: string }[] };
  metrics?: { cpuPercent: number | null; memBytes: number | null; memLimit: number | null } | null;
}

type Tab = 'overview' | 'metrics' | 'logs' | 'deps';

export function Inspector({ entity: e, onClose }: { entity: EntityView; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [confirm, setConfirm] = useState<{ action: 'start' | 'stop' | 'restart'; impact: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(e.displayName);
  const entities = useStore((s) => s.entities);
  const admin = useRole('operator');
  const isFavorite = useStore((s) => s.favorites.includes(e.id));
  const offset = useStore((s) => s.serverOffsetMs);
  const select = useStore((s) => s.select);

  useEffect(() => { setTab('overview'); setRuntime(null); setDetail(null); setMsg(null); setRenaming(false); setName(e.displayName); }, [e.id]);

  // Refresh details when the entity changes state; never poll faster than necessary.
  useEffect(() => {
    let alive = true;
    api<Detail>(`/api/entities/${encodeURIComponent(e.id)}`).then((d) => alive && setDetail(d)).catch(() => undefined);
    return () => { alive = false; };
  }, [e.id, e.health, e.lifecycle, e.lastCheckAt, admin]);

  useEffect(() => {
    if (e.kind !== 'service' || e.lifecycle === 'removed') return;
    let alive = true;
    const load = () => api<Runtime>(`/api/entities/${encodeURIComponent(e.id)}/runtime`).then((r) => alive && setRuntime(r)).catch(() => alive && setRuntime({ available: false, reason: 'request failed' }));
    void load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [e.id, e.kind, e.lifecycle]);

  const h = effectiveHealth(e);
  const st = statusText(e);
  const bad = ['unhealthy', 'unreachable', 'degraded', 'restarting', 'host_offline'].includes(h) || e.lifecycle === 'missing';
  const host = e.hostId ? entities[e.hostId] : undefined;
  const parent = e.parentId ? entities[e.parentId] : undefined;
  const endpoints = (detail?.children ?? []).filter((c) => c.kind === 'endpoint');
  const hostnames = [...new Set([...e.hostnames, ...endpoints.flatMap((c) => c.hostnames)])];
  const meta = e.meta as Record<string, unknown>;
  const lastFail = detail?.checks.find((c) => c.outcome === 'fail');
  const consecutive = detail ? detail.checks.findIndex((c) => c.outcome !== 'fail') : 0;

  const doAction = async () => {
    if (!confirm) return;
    try {
      await api(`/api/entities/${encodeURIComponent(e.id)}/actions`, { method: 'POST', json: { action: confirm.action, confirm: e.id } });
      setMsg(`${confirm.action} requested. The building will update when Docker reports the new state.`);
    } catch (err) { setMsg(`Action failed: ${(err as Error).message}`); }
    setConfirm(null);
  };

  const rename = async () => {
    try {
      await api(`/api/entities/${encodeURIComponent(e.id)}`, { method: 'PATCH', json: { displayName: name.trim() || null } });
      setRenaming(false);
    } catch (err) { setMsg((err as ApiError).message); }
  };

  return (
    <div className="inspector card">
      <div className="insp-head">
        <div className="insp-icon" style={{ color: st.color }} dangerouslySetInnerHTML={{ __html: iconSvg(e.buildingType, 26) }} />
        <div className="grow">
          {renaming ? (
            <form className="rename" onSubmit={(ev) => { ev.preventDefault(); void rename(); }}>
              <input value={name} maxLength={60} autoFocus onChange={(ev) => setName(ev.target.value)} />
              <button type="submit">Save</button><button type="button" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          ) : (
            <h2>{e.displayName}{admin && <button className="icon-btn" title="Rename" onClick={() => setRenaming(true)}><Icon name="edit" size={14} /></button>}</h2>
          )}
          <div className="sub">{TYPE_LABEL[e.buildingType]} · {e.kind}{host && host.id !== e.id ? ` · ${host.displayName}` : ''}</div>
        </div>
        <span className="pill" style={{ '--c': st.color } as React.CSSProperties}><span className="dot" />{st.text}</span>
        <button className={`icon-btn fav${isFavorite ? ' on' : ''}`} onClick={() => void toggleFavorite(e.id)} title={isFavorite ? 'Remove from my favorites' : 'Add to my favorites (personal)'}><Icon name="star" /></button>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)"><Icon name="x" /></button>
      </div>

      <div className="insp-tabs">
        {(['overview', 'metrics', 'logs', 'deps'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{{ overview: 'Overview', metrics: 'Metrics', logs: 'Logs', deps: 'Dependencies' }[t]}</button>
        ))}
      </div>

      <div className="insp-body">
        {tab === 'overview' && (
          <>
            {e.lifecycle === 'removed' && (
              <div className="callout gray"><b>Removal confirmed</b><p>Absent from {String(detail?.events.find((x) => x.type === 'service.removal_confirmed')?.details.absentInventories ?? 'several')} consecutive complete inventories. It will be archived; history is kept.</p></div>
            )}
            {e.lifecycle === 'missing' && (
              <div className="callout amber"><b>Missing — awaiting confirmation</b><p>Not seen in the latest complete inventory since {timeAgo(e.missingSince, offset)}. It is <i>not</i> removed until absence is confirmed repeatedly.</p></div>
            )}
            {e.inheritedHostOffline && (
              <div className="callout violet"><b>Host {host?.displayName} is offline</b><p>This service may be affected. Its own last known state was <b>{e.lastKnownHealth ? HEALTH_LABEL[e.lastKnownHealth] : 'unknown'}</b>; it is not individually confirmed down.</p></div>
            )}
            {bad && !e.inheritedHostOffline && e.lifecycle !== 'missing' && e.lifecycle !== 'removed' && (
              <div className="callout red">
                <b>{h === 'unreachable' ? 'Service is not responding' : h === 'degraded' ? 'Service is degraded' : h === 'restarting' ? 'Service is restarting' : 'Service is unhealthy'}</b>
                <p>{e.healthReason ?? 'No reason reported.'}</p>
                <p className="muted">{lastFail && consecutive > 0 ? `${consecutive} consecutive failed checks · ` : ''}Last healthy: {timeAgo(e.lastSuccessAt, offset)}</p>
              </div>
            )}
            {h === 'unknown' && e.lifecycle !== 'removed' && (
              <div className="callout gray"><b>Health unknown</b><p>{e.healthReason ?? 'No check has produced a result yet.'}{e.lastKnownHealth ? ` Last known: ${HEALTH_LABEL[e.lastKnownHealth]}.` : ''}</p></div>
            )}

            {e.kind === 'host' ? <HostTiles e={e} offset={offset} /> : <div className="tiles">
              <div className="tile"><span>Uptime</span><b>{runtime?.details?.startedAt && meta.state === 'running' ? since(runtime.details.startedAt) : meta.state && meta.state !== 'running' ? String(meta.state) : '—'}</b><small>{runtime?.available ? 'live' : meta.containerId == null ? 'not a container' : runtime?.reason ? 'unavailable' : e.lifecycle !== 'removed' ? 'loading…' : 'n/a'}</small></div>
              <div className="tile"><span>CPU / Memory</span><b>{runtime?.metrics ? `${runtime.metrics.cpuPercent ?? '—'}%` : '—'}</b><small>{runtime?.metrics ? `${fmtBytes(runtime.metrics.memBytes)} · live` : 'no live metrics'}</small></div>
              <div className="tile"><span>Last check</span><b>{timeAgo(e.lastCheckAt, offset)}</b><small>{e.inventoryUncertain ? 'inventory uncertain' : 'state change ' + timeAgo(e.lastChangeAt, offset)}</small></div>
            </div>}

            <dl className="facts">
              <dt>Lifecycle</dt><dd>{LIFECYCLE_LABEL[e.lifecycle]}</dd>
              <dt>Health</dt><dd>{e.lifecycle === 'removed'
                ? <span className="muted">n/a — last known before removal: {HEALTH_LABEL[e.lastKnownHealth ?? e.health]}</span>
                : <><span className="dot" style={{ background: HEALTH_COLOR[e.health] }} /> {HEALTH_LABEL[e.health]}{e.healthReason ? ` — ${e.healthReason}` : ''}</>}</dd>
              {host && host.id !== e.id && <><dt>Host</dt><dd><a onClick={() => select(host.id, true)}>{host.displayName}</a> <span className="muted">({HEALTH_LABEL[effectiveHealth(host)]})</span></dd></>}
              {parent && parent.id !== host?.id && <><dt>Project</dt><dd>{parent.displayName}</dd></>}
              {meta.containerName != null && <><dt>Container</dt><dd><code>{String(meta.containerName)}</code></dd></>}
              {meta.containerId != null && <><dt>Container ID</dt><dd><code>{String(meta.containerId).slice(0, 12)}</code><CopyBtn text={String(meta.containerId)} /></dd></>}
              {meta.image != null && <><dt>Image</dt><dd><code>{String(meta.image)}</code></dd></>}
              {Array.isArray(meta.ports) && meta.ports.length > 0 && <><dt>Ports</dt><dd>{(meta.ports as string[]).join(', ')}</dd></>}
              {Array.isArray(meta.networks) && meta.networks.length > 0 && <><dt>Networks</dt><dd>{(meta.networks as string[]).join(', ')}</dd></>}
              {e.kind === 'host' && meta.method != null && <><dt>Discovery</dt><dd>{String(meta.method)}{meta.source === 'config' ? ' (config file)' : ' (Server Harbor)'}{meta.monitoring === 'suspended' ? ' · monitoring suspended' : ''}</dd></>}
              {e.kind === 'host' && Array.isArray(meta.tags) && (meta.tags as string[]).length > 0 && <><dt>Tags</dt><dd>{(meta.tags as string[]).join(', ')}</dd></>}
              {e.kind === 'host' && meta.dockerVersion != null && <><dt>Docker</dt><dd>{String(meta.dockerVersion)} · {String(meta.containersRunning)} running / {String(meta.containersStopped)} stopped</dd></>}
              <dt>First seen</dt><dd>{new Date(e.firstSeenAt).toLocaleString()}</dd>
              <dt>Last seen</dt><dd>{timeAgo(e.lastSeenAt, offset)}</dd>
              {meta.via != null && <><dt>Source</dt><dd>{String(meta.via)}</dd></>}
            </dl>

            {e.kind === 'host' && <HostFactsPanel e={e} offset={offset} />}

            {hostnames.length > 0 && (
              <section>
                <h4>Public endpoints</h4>
                <ul className="endpoints">
                  {hostnames.map((hn) => {
                    const ep = endpoints.find((c) => c.hostnames.includes(hn)) ?? (e.kind === 'endpoint' ? e : undefined);
                    const eh = ep ? effectiveHealth(ep) : 'unknown';
                    return (
                      <li key={hn}>
                        <span className="dot" style={{ background: HEALTH_COLOR[eh] }} />
                        <span className="grow">{hn}<small>{ep ? `${HEALTH_LABEL[eh]}${ep.healthReason ? ` — ${ep.healthReason}` : ''}` : 'no check'}</small></span>
                        <a className="icon-btn" href={`https://${hn}/`} target="_blank" rel="noreferrer noopener" title="Open"><Icon name="external" size={14} /></a>
                        <CopyBtn text={`https://${hn}/`} />
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="actions">
              {(detail?.actions.allowed ?? []).map((a) => (
                <button key={a.action} className={a.action === 'restart' ? 'primary' : a.action === 'stop' ? 'danger' : 'primary'} onClick={() => setConfirm(a)}>
                  <Icon name={a.action === 'restart' ? 'restart' : a.action === 'stop' ? 'stop' : 'play'} />{a.action[0].toUpperCase() + a.action.slice(1)}
                </button>
              ))}
              {e.kind === 'service' && meta.containerId != null && e.lifecycle !== 'removed' && <button onClick={() => setTab('logs')}><Icon name="logs" />View logs</button>}
              {detail && !detail.actions.enabled && e.kind === 'service' && e.lifecycle !== 'removed' && <p className="muted small">{detail.actions.reason}</p>}
            </section>
            {msg && <p className="msg">{msg}</p>}

            <section>
              <h4>Recent events</h4>
              {!detail?.events.length ? <p className="muted">No events.</p> : (
                <ol className="timeline compact">
                  {detail.events.slice(0, 10).map((ev) => (
                    <li key={ev.id}><span className="t">{fmtTime(ev.ts)}</span><span className="dot" style={{ background: eventColor(ev) }} /><span className="d">{describeEvent(ev, entities)}</span></li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}

        {tab === 'metrics' && <MetricsTab e={e} runtime={runtime} detail={detail} />}
        {tab === 'logs' && <LogsTab e={e} />}
        {tab === 'deps' && <DepsTab e={e} detail={detail} />}
      </div>

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal card" onClick={(ev) => ev.stopPropagation()} role="dialog" aria-modal="true">
            <h3>{confirm.action[0].toUpperCase() + confirm.action.slice(1)} {e.displayName}?</h3>
            <p>{confirm.impact}</p>
            <dl className="facts"><dt>Container</dt><dd><code>{String(meta.containerName)}</code></dd><dt>Host</dt><dd>{host?.displayName}</dd></dl>
            {(detail?.children.length ?? 0) > 0 && <p className="muted">Endpoints served by this container will be affected: {hostnames.join(', ')}</p>}
            <p className="muted small">This action is recorded in the audit log.</p>
            <div className="row-end">
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button className={confirm.action === 'stop' ? 'danger' : 'primary'} onClick={() => void doAction()}>Confirm {confirm.action}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Host tiles: only collected values; otherwise the collection status is shown instead of a number. */
function HostTiles({ e, offset }: { e: EntityView; offset: number }) {
  const f = hostFacts(e);
  const up = known(f?.uptime), cpu = known(f?.cpu), mem = known(f?.memory);
  const status = (x: { status: string } | undefined) => (x ? (x.status === 'unconfigured' ? 'not collected' : x.status) : 'not collected');
  return (
    <div className="tiles">
      <div className="tile"><span>Uptime</span><b>{up ? fmtDuration(up.seconds) : '—'}</b><small>{up ? `load ${up.load1}` : status(f?.uptime)}</small></div>
      <div className="tile"><span>CPU / Memory</span><b>{cpu?.usagePct != null ? `${Math.round(cpu.usagePct)}%` : '—'}{mem?.usedPct != null ? ` · ${Math.round(mem.usedPct)}%` : ''}</b><small>{cpu ? `${cpu.cores} cores` : status(f?.cpu)}{mem ? ` · ${fmtBytes(mem.totalBytes)}` : ''}</small></div>
      <div className="tile"><span>Last contact</span><b>{timeAgo(f?.os.ts ?? e.lastCheckAt, offset)}</b><small>{e.inventoryUncertain ? 'inventory uncertain' : 'state change ' + timeAgo(e.lastChangeAt, offset)}</small></div>
    </div>
  );
}

function since(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="icon-btn" title="Copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); }}>
      {ok ? '✓' : <Icon name="copy" size={14} />}
    </button>
  );
}

function MetricsTab({ e, runtime, detail }: { e: EntityView; runtime: Runtime | null; detail: Detail | null }) {
  const checks = (detail?.checks ?? []).slice().reverse();
  const maxLat = Math.max(50, ...checks.map((c) => c.latency_ms ?? 0));
  return (
    <>
      {e.kind !== 'service' && (
        <section>
          <h4>History</h4>
          <MetricChart entityId={e.id} />
        </section>
      )}
      <section>
        <h4>Live container metrics</h4>
        {e.kind !== 'service' ? <p className="muted">Not a container.</p> : !runtime ? <p className="muted">Loading…</p> : !runtime.available ? <p className="muted">Unavailable: {runtime.reason}</p> : (
          <dl className="facts">
            <dt>CPU</dt><dd>{runtime.metrics?.cpuPercent != null ? `${runtime.metrics.cpuPercent}%` : '—'}</dd>
            <dt>Memory</dt><dd>{fmtBytes(runtime.metrics?.memBytes)}{runtime.metrics?.memLimit ? ` of ${fmtBytes(runtime.metrics.memLimit)}` : ''}</dd>
            <dt>Started</dt><dd>{runtime.details?.startedAt ? new Date(runtime.details.startedAt).toLocaleString() : '—'}</dd>
            <dt>Restarts</dt><dd>{runtime.details?.restartCount ?? '—'}</dd>
            <dt>Healthcheck</dt><dd>{runtime.details?.hasHealthcheck ? 'configured' : 'none'}</dd>
            <dt>Measured</dt><dd>{runtime.measuredAt ? new Date(runtime.measuredAt).toLocaleTimeString() : '—'} (cached ≤10s)</dd>
          </dl>
        )}
        {!!runtime?.details?.healthLog.length && (
          <><h4>Docker healthcheck log</h4><ul className="mono-list">{runtime.details.healthLog.map((l) => <li key={l.ts}><span className={l.exitCode === 0 ? 'ok' : 'bad'}>{l.exitCode === 0 ? 'pass' : `exit ${l.exitCode}`}</span> {fmtTime(l.ts)} {l.output}</li>)}</ul></>
        )}
      </section>
      <section>
        <h4>Endpoint check history</h4>
        {!checks.length ? <p className="muted">No HTTP/TCP checks recorded for this entity{e.kind === 'service' ? ' (endpoint checks appear under the endpoint itself)' : ''}.</p> : (
          <>
            <div className="spark" role="img" aria-label="Check latency history">
              {checks.map((c, i) => <span key={i} title={`${new Date(c.ts).toLocaleString()} — ${c.outcome}${c.latency_ms != null ? ` ${c.latency_ms} ms` : ''}${c.error ? ` — ${c.error}` : ''}`} className={c.outcome} style={{ height: `${c.outcome === 'ok' ? Math.max(8, ((c.latency_ms ?? 0) / maxLat) * 100) : 100}%` }} />)}
            </div>
            <ul className="mono-list">{(detail?.checks ?? []).slice(0, 12).map((c, i) => <li key={i}><span className={c.outcome === 'ok' ? 'ok' : c.outcome === 'fail' ? 'bad' : ''}>{c.outcome}</span> {fmtTime(c.ts)} {c.check_name} {c.status_code ?? ''} {c.latency_ms != null ? `${c.latency_ms}ms` : ''} {c.error ?? ''}</li>)}</ul>
          </>
        )}
      </section>
    </>
  );
}

function LogsTab({ e }: { e: EntityView }) {
  const admin = useRole('operator');
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    api<{ lines: string[] }>(`/api/entities/${encodeURIComponent(e.id)}/logs?tail=200`).then((r) => setLines(r.lines)).catch((x) => setErr((x as Error).message));
  };
  useEffect(() => { if (admin && e.meta.containerId) load(); }, [e.id, admin]);
  if (!e.meta.containerId) return <p className="muted">No container logs for this entity.</p>;
  if (!admin) return <p className="muted"><Icon name="lock" size={14} /> Logs can contain sensitive data and are available to operators and administrators.</p>;
  return (
    <section>
      <div className="row-between"><h4>Last 200 lines (secrets redacted)</h4><button onClick={load}><Icon name="restart" size={14} />Refresh</button></div>
      {err && <p className="msg">{err}</p>}
      <pre className="logs">{lines?.join('\n') || (lines ? '(no output)' : 'Loading…')}</pre>
    </section>
  );
}

interface RouteInfo {
  routes: { entityId: string; via: ConnectionView | null }[][];
  upstream: { entityId: string; connection: ConnectionView | null; why: string }[];
  downstream: { entityId: string; connection: ConnectionView | null; why: string }[];
}

function DepsTab({ e, detail }: { e: EntityView; detail: Detail | null }) {
  const entities = useStore((s) => s.entities);
  const select = useStore((s) => s.select);
  const impact = useStore((s) => s.impact);
  const setImpact = useStore((s) => s.setImpact);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<RouteInfo>(`/api/entities/${encodeURIComponent(e.id)}/route`).then(setRoute).catch(() => setRoute({ routes: [], upstream: [], downstream: [] }));
  }, [e.id, e.health]);
  const name = (id: string) => entities[id]?.displayName ?? id;
  const Badge = ({ c }: { c: ConnectionView | null }) => (c ? <span className={`vbadge v-${c.verification}`} title={VERIFICATION_TEXT[c.verification].help}>{c.verification}</span> : <span className="vbadge v-configured" title="Structural fact (containment or configured route)">fact</span>);
  const Rel = ({ id, c, why }: { id: string; c: ConnectionView | null; why: string }) => {
    const x = entities[id];
    return (
      <li><button onClick={() => select(id, true)}>
        <span className="dot" style={{ background: x ? HEALTH_COLOR[effectiveHealth(x)] : '#888' }} />
        <span className="grow">{name(id)}<small>{why}</small></span><Badge c={c} />
      </button></li>
    );
  };
  const run = async (simulate: boolean) => {
    setBusy(true);
    try { setImpact(await api<ImpactReport>(`/api/impact/${encodeURIComponent(e.id)}${simulate ? '?simulate=true' : ''}`)); } finally { setBusy(false); }
  };
  const mine = impact?.root === e.id ? impact : null;
  return (
    <>
      {!!route?.routes.length && (
        <section>
          <h4>Route explorer — public path{route.routes.length > 1 ? 's' : ''}</h4>
          {route.routes.map((hops, i) => (
            <ol key={i} className="route">
              {hops.map((h, j) => {
                const x = entities[h.entityId];
                return (
                  <li key={j}>
                    {h.via && <span className="hop">{CONNECTION_LABEL[h.via.type]} <span className={`vbadge v-${h.via.verification}`}>{h.via.verification}</span>{h.via.health !== 'unknown' && <span className="dot" style={{ background: HEALTH_COLOR[h.via.health] }} />}</span>}
                    <button onClick={() => select(h.entityId, true)}><span className="dot" style={{ background: x ? HEALTH_COLOR[effectiveHealth(x)] : '#888' }} />{name(h.entityId)}<small>{x ? TYPE_LABEL[x.buildingType] : ''}</small></button>
                  </li>
                );
              })}
            </ol>
          ))}
          <p className="muted small">Only hops that are configured or verified are shown; nothing is guessed from reachability.</p>
        </section>
      )}
      <section><h4>Relies on (upstream)</h4>{route?.upstream.length ? <ul className="rel-list">{route.upstream.map((u) => <Rel key={u.entityId} id={u.entityId} c={u.connection} why={u.why} />)}</ul> : <p className="muted">No known dependencies.</p>}</section>
      <section><h4>Relied on by (downstream)</h4>{route?.downstream.length ? <ul className="rel-list">{route.downstream.map((d) => <Rel key={d.entityId} id={d.entityId} c={d.connection} why={d.why} />)}</ul> : <p className="muted">Nothing known relies on this.</p>}</section>
      {!!detail?.children.length && <section><h4>Children</h4><ul className="rel-list">{detail.children.map((x) => <Rel key={x.id} id={x.id} c={null} why={TYPE_LABEL[x.buildingType]} />)}</ul></section>}
      <section>
        <h4>Impact analysis</h4>
        <div className="row">
          <button disabled={busy} onClick={() => void run(false)}><Icon name="activity" /> Analyse impact</button>
          <button disabled={busy} onClick={() => void run(true)} title="Pure calculation — no real infrastructure is touched"><Icon name="flame" /> Simulate failure</button>
          {mine && <button className="link-btn" onClick={() => setImpact(null)}>Clear map overlay</button>}
        </div>
        {mine && (
          <div className="impact">
            <p className={mine.simulated ? 'callout gray' : 'callout amber'}>{mine.summary}</p>
            {(['confirmed', 'likely', 'unknown', 'unaffected'] as const).map((cls) => {
              const items = mine.items.filter((i) => i.class === cls);
              if (!items.length) return null;
              return (
                <div key={cls}>
                  <h5 style={{ color: IMPACT_TEXT[cls].color }}>{IMPACT_TEXT[cls].label} ({items.length})</h5>
                  <ul className="rel-list">{items.map((i) => <li key={i.entityId}><button onClick={() => select(i.entityId, true)}><span className="dot" style={{ background: IMPACT_TEXT[cls].color }} /><span className="grow">{name(i.entityId)}<small>{i.why}{i.path.length > 2 ? ` · via ${i.path.slice(1, -1).map(name).join(' → ')}` : ''}</small></span></button></li>)}</ul>
                </div>
              );
            })}
            {!mine.items.length && <p className="muted">Nothing known depends on this.</p>}
          </div>
        )}
      </section>
    </>
  );
}
