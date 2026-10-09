import { useEffect, useState } from 'react';
import type { Role, UserView } from '@berrie/shared';
import { ROLES, ROLE_LABEL } from '@berrie/shared';
import { useStore } from '../state/store';
import { api } from '../state/api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { timeAgo } from './status';

interface Invitation { id: string; role: Role; hostScope: 'all' | 'list'; hosts: string[]; email: string | null; note: string | null; createdBy: string; createdAt: string; expiresAt: string; usedAt: string | null; usedBy: string | null; revokedAt: string | null }
interface AuditRow { id: number; ts: string; actor: string; action: string; entity_id: string | null; result: string; ip: string | null; params: string }

const ROLE_HELP: Record<Role, string> = {
  viewer: 'Sees the world for the servers they have access to.',
  operator: 'Viewer + acknowledge alerts, manage incidents and maintenance, view logs, rename/arrange buildings and run allowlisted container actions.',
  admin: 'Everything, including Server Harbor, people and the audit log. Always has access to all servers.',
};

function HostPicker({ scope, hosts, known, onChange, disabled }: { scope: 'all' | 'list'; hosts: string[]; known: string[]; onChange: (scope: 'all' | 'list', hosts: string[]) => void; disabled?: boolean }) {
  const entities = useStore((s) => s.entities);
  return (
    <div className="host-picker">
      <select value={scope} disabled={disabled} onChange={(e) => onChange(e.target.value as 'all' | 'list', hosts)}>
        <option value="all">All servers</option><option value="list">Selected servers</option>
      </select>
      {scope === 'list' && !disabled && (
        <div className="chips">
          {known.map((h) => (
            <label key={h} className={`chip${hosts.includes(h) ? ' on' : ''}`}>
              <input type="checkbox" checked={hosts.includes(h)} onChange={(e) => onChange('list', e.target.checked ? [...hosts, h] : hosts.filter((x) => x !== h))} />
              {entities[h]?.displayName ?? h.replace(/^host:/, '')}
            </label>
          ))}
          {!known.length && <span className="muted small">No servers registered yet.</span>}
        </div>
      )}
    </div>
  );
}

export function PeopleView() {
  const me = useStore((s) => s.me);
  const [users, setUsers] = useState<UserView[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [link, setLink] = useState<{ label: string; url: string } | null>(null);
  const [inv, setInv] = useState<{ role: Role; hostScope: 'all' | 'list'; hosts: string[]; email: string; note: string; days: number }>({ role: 'viewer', hostScope: 'all', hosts: [], email: '', note: '', days: 7 });

  const load = () => {
    api<{ users: UserView[]; knownHosts: string[] }>('/api/users').then((r) => { setUsers(r.users); setKnown(r.knownHosts); }).catch(() => undefined);
    api<{ invitations: Invitation[] }>('/api/invitations').then((r) => setInvites(r.invitations)).catch(() => undefined);
    api<{ entries: AuditRow[] }>('/api/audit').then((r) => setAudit(r.entries)).catch(() => undefined);
  };
  useEffect(load, []);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const patch = (u: UserView, body: Record<string, unknown>) => run(() => api(`/api/users/${u.id}`, { method: 'PATCH', json: body }), `Updated ${u.username}. Their sessions were refreshed.`);
  const base = `${location.origin}${location.pathname}`;

  return (
    <div className="page people">
      <div className="page-head"><h1><Icon name="users" /> People</h1><span className="muted">{users.length} account(s)</span></div>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      {link && (
        <div className="banner link-banner">
          <b>{link.label}</b> — shown once, share it privately:
          <code className="mono">{link.url}</code>
          <button onClick={() => void navigator.clipboard?.writeText(link.url)}><Icon name="copy" /> Copy</button>
          <button className="icon-btn" onClick={() => setLink(null)}><Icon name="x" /></button>
        </div>
      )}

      <section className="card">
        <h3>Accounts</h3>
        <table className="table">
          <thead><tr><th>Person</th><th>Role</th><th>Server access</th><th>2FA</th><th>Last sign-in</th><th /></tr></thead>
          <tbody>
            {users.map((u) => {
              const self = u.id === me?.user?.id;
              return (
                <tr key={u.id} className={u.status === 'disabled' ? 'dim' : ''}>
                  <td><span className="person"><Avatar avatar={u.avatar} size={24} /><span>{u.displayName}<small>{u.username}{self ? ' (you)' : ''}{u.status === 'disabled' ? ' · disabled' : ''}</small></span></span></td>
                  <td>
                    <select value={u.role} disabled={self} onChange={(e) => void patch(u, { role: e.target.value })} title={ROLE_HELP[u.role]}>
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                  </td>
                  <td><HostPicker scope={u.role === 'admin' ? 'all' : u.hostScope} hosts={u.hosts} known={known} disabled={u.role === 'admin'} onChange={(scope, hosts) => void patch(u, { hostScope: scope, hosts })} /></td>
                  <td>{u.totpEnabled ? <span className="inv complete">on</span> : <span className="inv unavailable">off</span>}</td>
                  <td>{timeAgo(u.lastLoginAt)}</td>
                  <td><div className="actions">
                    {!self && <button onClick={() => void run(async () => { const r = await api<{ token: string }>(`/api/users/${u.id}/reset`, { method: 'POST' }); setLink({ label: `Password reset link for ${u.username} (valid 24 h)`, url: `${base}#/reset/${r.token}` }); }, 'Reset link created.')}>Reset link</button>}
                    {!self && u.totpEnabled && <button onClick={() => { if (confirm(`Turn off two-factor for ${u.username}? They can sign in with just a password until they set it up again.`)) void run(() => api(`/api/users/${u.id}/mfa-reset`, { method: 'POST' }), '2FA reset.'); }}>Reset 2FA</button>}
                    {!self && <button onClick={() => void patch(u, { status: u.status === 'disabled' ? 'active' : 'disabled' })}>{u.status === 'disabled' ? 'Enable' : 'Disable'}</button>}
                    {!self && <button className="danger" onClick={() => { if (confirm(`Remove ${u.username}? Their personal data (favorites, tasks, views) is deleted. Infrastructure history and the audit log are kept.`)) void run(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), `${u.username} removed.`); }}><Icon name="trash" /></button>}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="grid2">
        <section className="card">
          <h3>Invite someone</h3>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void run(async () => {
            const r = await api<{ token: string }>('/api/invitations', { method: 'POST', json: { role: inv.role, hostScope: inv.hostScope, hosts: inv.hosts, email: inv.email || null, note: inv.note || null, days: inv.days } });
            setLink({ label: `Invitation (${ROLE_LABEL[inv.role]}, valid ${inv.days} days)`, url: `${base}#/invite/${r.token}` });
          }, 'Invitation created.'); }}>
            <label>Role
              <select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value as Role })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
            </label>
            <p className="small muted">{ROLE_HELP[inv.role]}</p>
            {inv.role !== 'admin' && <label>Server access<HostPicker scope={inv.hostScope} hosts={inv.hosts} known={known} onChange={(hostScope, hosts) => setInv({ ...inv, hostScope, hosts })} /></label>}
            <label>Email (optional, for your reference)<input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></label>
            <label>Note (optional)<input value={inv.note} maxLength={200} onChange={(e) => setInv({ ...inv, note: e.target.value })} /></label>
            <label>Valid for (days)<input type="number" min={1} max={30} value={inv.days} onChange={(e) => setInv({ ...inv, days: Number(e.target.value) })} /></label>
            <button className="primary" type="submit">Create invitation link</button>
          </form>
        </section>

        <section className="card">
          <h3>Invitations</h3>
          {!invites.length ? <p className="muted">None yet.</p> : (
            <table className="table compact">
              <thead><tr><th>Role</th><th>For</th><th>Status</th><th /></tr></thead>
              <tbody>
                {invites.map((i) => {
                  const status = i.usedAt ? `used by ${i.usedBy ?? '?'}` : i.revokedAt ? 'revoked' : i.expiresAt < new Date().toISOString() ? 'expired' : `open until ${new Date(i.expiresAt).toLocaleDateString()}`;
                  return (
                    <tr key={i.id}>
                      <td>{ROLE_LABEL[i.role]}<small>{i.hostScope === 'all' ? 'all servers' : i.hosts.map((h) => h.replace(/^host:/, '')).join(', ')}</small></td>
                      <td>{i.email ?? i.note ?? '—'}<small>by {i.createdBy}</small></td>
                      <td>{status}</td>
                      <td>{!i.usedAt && !i.revokedAt && <button onClick={() => void run(() => api(`/api/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation revoked.')}>Revoke</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="card">
        <h3><Icon name="history" /> Audit log</h3>
        <table className="table compact">
          <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Target</th><th>Result</th><th>IP</th></tr></thead>
          <tbody>{audit.slice(0, 100).map((a) => <tr key={a.id}><td>{new Date(a.ts).toLocaleString()}</td><td>{a.actor}</td><td>{a.action}</td><td className="mono">{a.entity_id ?? (() => { try { return (JSON.parse(a.params) as { target?: string }).target ?? '—'; } catch { return '—'; } })()}</td><td>{a.result}</td><td className="mono">{a.ip ?? '—'}</td></tr>)}</tbody>
        </table>
      </section>
    </div>
  );
}
