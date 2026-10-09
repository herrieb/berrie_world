import { useEffect, useState } from 'react';
import type { EntityView } from '@berrie/shared';
import { useStore } from '../state/store';
import { api, refreshAuth } from '../state/api';
import { fmtBytes, timeAgo } from './status';
import { Icon } from './Icon';

interface SelfHealth {
  mode: string; uptimeSeconds: number; dbBytes: number | null; checks: number; lastMonitoringAt: string | null;
  process: { rssBytes: number; heapUsedBytes: number; cpuUserMs: number; cpuSystemMs: number };
}

export function SettingsView() {
  const s = useStore();
  const [health, setHealth] = useState<SelfHealth | null>(null);
  const [archive, setArchive] = useState<EntityView[]>([]);
  const [audit, setAudit] = useState<{ id: number; ts: string; action: string; entity_id: string | null; result: string; ip: string }[]>([]);
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api<SelfHealth>('/api/health').then(setHealth).catch(() => undefined);
      api<{ entities: EntityView[] }>('/api/archive').then((r) => setArchive(r.entities)).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (s.admin) api<{ entries: typeof audit }>('/api/audit').then((r) => setAudit(r.entries)).catch(() => undefined); }, [s.admin]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try { await api('/api/auth/login', { method: 'POST', json: { token } }); setToken(''); await refreshAuth(); }
    catch (x) { setErr((x as Error).message); }
  };
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); await refreshAuth(); };

  return (
    <div className="page settings">
      <div className="page-head"><h1>Settings & system</h1></div>
      <div className="grid2">
        <section className="card">
          <h3><Icon name="lock" /> Administration</h3>
          {!s.adminConfigured ? <p className="muted">No <code>ADMIN_TOKEN</code> is configured on the server. Berrie World is read-only; renaming, layout editing, logs and container actions are unavailable.</p>
            : s.admin ? (
              <><p>Signed in as admin. Container actions are <b>{s.actionsEnabled ? 'enabled' : 'disabled (ENABLE_ACTIONS=false)'}</b>.</p><button onClick={() => void logout()}>Sign out</button></>
            ) : (
              <form onSubmit={(e) => void login(e)} className="login">
                <input type="password" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" />
                <button className="primary" type="submit">Sign in</button>
                {err && <p className="msg">{err}</p>}
              </form>
            )}
        </section>

        <section className="card">
          <h3>Berrie World itself</h3>
          {health ? (
            <dl className="facts">
              <dt>Mode</dt><dd>{health.mode}</dd>
              <dt>Uptime</dt><dd>{Math.floor(health.uptimeSeconds / 3600)}h {Math.floor((health.uptimeSeconds % 3600) / 60)}m</dd>
              <dt>Memory (RSS)</dt><dd>{fmtBytes(health.process.rssBytes)}</dd>
              <dt>CPU time</dt><dd>{((health.process.cpuUserMs + health.process.cpuSystemMs) / 1000).toFixed(1)} s</dd>
              <dt>Database</dt><dd>{fmtBytes(health.dbBytes)}</dd>
              <dt>Scheduled checks</dt><dd>{health.checks}</dd>
              <dt>Last probe</dt><dd>{timeAgo(health.lastMonitoringAt)}</dd>
            </dl>
          ) : <p className="muted">Server unreachable.</p>}
        </section>

        <section className="card">
          <h3>Discovery adapters</h3>
          <table className="table compact">
            <thead><tr><th>Adapter</th><th>Inventory</th><th>Last run</th><th>Last complete</th></tr></thead>
            <tbody>
              {s.adapters.map((a) => (
                <tr key={a.adapter + a.scope}>
                  <td>{a.adapter}<small>{a.scope}</small></td>
                  <td><span className={`inv ${a.completeness}`}>{a.completeness}</span>{a.error && <small>{a.error}</small>}</td>
                  <td>{timeAgo(a.lastRunAt, s.serverOffsetMs)}</td>
                  <td>{timeAgo(a.lastCompleteAt, s.serverOffsetMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Only a <b>complete</b> inventory counts as evidence that something was removed.</p>
        </section>

        <section className="card">
          <h3>Known hostnames (hints)</h3>
          {!s.hints.length ? <p className="muted">No hostname hints configured.</p> : (
            <table className="table compact">
              <thead><tr><th>Hostname</th><th>Status</th><th>DNS</th></tr></thead>
              <tbody>
                {s.hints.map((h) => (
                  <tr key={h.hostname} onClick={() => { if (h.entityId) { s.select(h.entityId, true); s.setView('world'); } }} className={h.entityId ? 'clickable' : ''}>
                    <td>{h.hostname}</td>
                    <td>{h.status === 'matched' ? <span className="inv complete">matched</span> : <span className="inv incomplete">unverified</span>}{h.via && <small>{h.via}</small>}</td>
                    <td>{h.dns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small">A DNS record is a hint, not proof of a live service. Hostnames become endpoints only when matched via config, container labels or tunnel ingress.</p>
        </section>

        <section className="card">
          <h3><Icon name="archive" /> Archive</h3>
          {!archive.length ? <p className="muted">No archived services.</p> : (
            <table className="table compact">
              <thead><tr><th>Name</th><th>Removed</th><th>Archived</th></tr></thead>
              <tbody>{archive.map((e) => <tr key={e.id}><td>{e.displayName}<small className="mono">{e.id}</small></td><td>{e.removedAt ? new Date(e.removedAt).toLocaleString() : '—'}</td><td>{e.archivedAt ? new Date(e.archivedAt).toLocaleString() : '—'}</td></tr>)}</tbody>
            </table>
          )}
        </section>

        {s.admin && (
          <section className="card">
            <h3>Audit log</h3>
            <table className="table compact">
              <thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Result</th></tr></thead>
              <tbody>{audit.slice(0, 40).map((a) => <tr key={a.id}><td>{new Date(a.ts).toLocaleString()}</td><td>{a.action}</td><td className="mono">{a.entity_id ?? '—'}</td><td>{a.result}</td></tr>)}</tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}
