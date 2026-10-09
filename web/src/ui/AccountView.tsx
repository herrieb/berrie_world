import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Avatar as AvatarSpec, NotificationPrefs, Severity } from '@berrie/shared';
import { DEFAULT_NOTIFICATIONS, ROLE_LABEL } from '@berrie/shared';
import { useStore } from '../state/store';
import { api, refreshAuth, savePrefs, signOut } from '../state/api';
import { Avatar, AVATAR_COLORS, AVATAR_STYLES } from './Avatar';
import { Icon } from './Icon';
import { timeAgo } from './status';

interface SessionInfo { id: string; current: boolean; createdAt: string; lastSeenAt: string; ip: string | null; userAgent: string | null }

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }, [text]);
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function AccountView() {
  const me = useStore((s) => s.me);
  const prefs = useStore((s) => s.prefs);
  const user = me?.user;
  const [profile, setProfile] = useState({ displayName: user?.displayName ?? '', email: user?.email ?? '' });
  const [avatar, setAvatar] = useState<AvatarSpec>(user?.avatar ?? { seed: 1, color: AVATAR_COLORS[0], style: 0 });
  const [pw, setPw] = useState({ current: '', next: '', next2: '' });
  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpPw, setTotpPw] = useState('');
  const [code, setCode] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const notif: NotificationPrefs = { ...DEFAULT_NOTIFICATIONS, ...(prefs.notifications ?? {}) };

  const loadSessions = () => api<{ sessions: SessionInfo[] }>('/api/account/sessions').then((r) => setSessions(r.sessions)).catch(() => undefined);
  useEffect(() => { void loadSessions(); }, []);
  if (!user) return null;

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); await refreshAuth(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };

  const setNotif = (p: Partial<NotificationPrefs>) => {
    const next = { ...notif, ...p };
    if (p.browser && 'Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    savePrefs({ notifications: next });
  };

  return (
    <div className="page account">
      <div className="page-head">
        <h1><Avatar avatar={user.avatar} size={32} /> {user.displayName}</h1>
        <span className="muted">{user.username} · {ROLE_LABEL[user.role]} · {user.hostScope === 'all' || user.role === 'admin' ? 'all servers' : `${user.hosts.length} server(s)`}</span>
        <button className="ghost-btn right" onClick={() => void signOut()}><Icon name="logout" /> Sign out</button>
      </div>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      <div className="grid2">
        <section className="card">
          <h3>Profile</h3>
          <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => api('/api/account', { method: 'PATCH', json: { displayName: profile.displayName, email: profile.email || null, avatar } }), 'Profile saved.'); }}>
            <label>Display name<input value={profile.displayName} maxLength={60} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} /></label>
            <label>Email (optional)<input type="email" value={profile.email} maxLength={200} onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label>
            <div className="avatar-picker">
              <Avatar avatar={avatar} size={64} />
              <div>
                <div className="swatches">{AVATAR_COLORS.map((c) => <button type="button" key={c} className={avatar.color === c ? 'on' : ''} style={{ background: c }} onClick={() => setAvatar({ ...avatar, color: c })} aria-label={`colour ${c}`} />)}</div>
                <div className="row">
                  <select value={avatar.style} onChange={(e) => setAvatar({ ...avatar, style: Number(e.target.value) })} aria-label="Avatar style">
                    {AVATAR_STYLES.map((s, i) => <option key={s} value={i}>{s}</option>)}
                  </select>
                  <button type="button" onClick={() => setAvatar({ ...avatar, seed: Math.floor(Math.random() * 1e6) })}>Shuffle</button>
                </div>
              </div>
            </div>
            <button className="primary" type="submit">Save profile</button>
          </form>
        </section>

        <section className="card">
          <h3><Icon name="lock" /> Password</h3>
          <form className="form" onSubmit={(e) => { e.preventDefault(); if (pw.next !== pw.next2) { setMsg({ ok: false, text: 'New passwords do not match.' }); return; } void act(() => api('/api/account/password', { method: 'POST', json: { current: pw.current, next: pw.next } }).then(() => setPw({ current: '', next: '', next2: '' })), 'Password changed. Your other sessions were signed out.'); }}>
            <label>Current password<input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required /></label>
            <label>New password<input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required minLength={10} /></label>
            <label>Repeat new password<input type="password" autoComplete="new-password" value={pw.next2} onChange={(e) => setPw({ ...pw, next2: e.target.value })} required /></label>
            <button type="submit">Change password</button>
          </form>
        </section>

        <section className="card">
          <h3><Icon name="shield" /> Two-factor authentication</h3>
          {user.totpEnabled ? (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => api('/api/account/totp/disable', { method: 'POST', json: { password: totpPw, code } }).then(() => { setTotpPw(''); setCode(''); }), 'Two-factor authentication disabled.'); }}>
              <p><span className="inv complete">enabled</span> A code from your authenticator app is required at every sign-in.</p>
              <label>Password<input type="password" value={totpPw} onChange={(e) => setTotpPw(e.target.value)} required /></label>
              <label>Current code<input inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
              <button type="submit">Disable two-factor</button>
            </form>
          ) : totp ? (
            <form className="form" onSubmit={(e) => { e.preventDefault(); void act(() => api('/api/account/totp/enable', { method: 'POST', json: { code } }).then(() => { setTotp(null); setCode(''); }), 'Two-factor authentication enabled.'); }}>
              <p>Scan this with an authenticator app (Aegis, 1Password, Google Authenticator…), then enter the code it shows.</p>
              <Qr text={totp.otpauthUrl} />
              <p className="small muted">Or enter the key manually: <code className="mono">{totp.secret.replace(/(.{4})/g, '$1 ').trim()}</code></p>
              <label>Code<input inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={(e) => setCode(e.target.value)} autoFocus required /></label>
              <button className="primary" type="submit">Enable</button>
            </form>
          ) : (
            <form className="form" onSubmit={(e) => { e.preventDefault(); setMsg(null); api<{ secret: string; otpauthUrl: string }>('/api/account/totp/setup', { method: 'POST', json: { password: totpPw } }).then((r) => { setTotp(r); setTotpPw(''); }).catch((x) => setMsg({ ok: false, text: (x as Error).message })); }}>
              <p className="muted">Off. Strongly recommended for administrators and operators.</p>
              <label>Confirm your password to start<input type="password" value={totpPw} onChange={(e) => setTotpPw(e.target.value)} required /></label>
              <button type="submit">Set up two-factor</button>
            </form>
          )}
        </section>

        <section className="card">
          <h3><Icon name="bell" /> Notifications</h3>
          <div className="form">
            <label className="check"><input type="checkbox" checked={notif.inApp} onChange={(e) => setNotif({ inApp: e.target.checked })} /> Show in-app notifications</label>
            <label className="check"><input type="checkbox" checked={notif.browser} onChange={(e) => setNotif({ browser: e.target.checked })} /> Browser notifications while Berrie World is open</label>
            <label className="check"><input type="checkbox" checked={notif.favoritesOnly} onChange={(e) => setNotif({ favoritesOnly: e.target.checked })} /> Only for my favorite services and islands</label>
            <label>Minimum severity
              <select value={notif.minSeverity} onChange={(e) => setNotif({ minSeverity: e.target.value as Severity })}>
                <option value="critical">Critical only</option><option value="warning">Warning and above</option><option value="notice">Notice and above</option><option value="info">Everything</option>
              </select>
            </label>
            <label>Map labels
              <select value={prefs.labelDensity ?? 'auto'} onChange={(e) => savePrefs({ labelDensity: e.target.value as 'auto' })}>
                <option value="less">Fewer labels</option><option value="auto">Automatic</option><option value="more">More labels</option>
              </select>
            </label>
          </div>
          <p className="small muted">Personal: these settings only affect you. Raw health data is never hidden.</p>
        </section>

        <section className="card wide">
          <h3>Active sessions</h3>
          <table className="table compact">
            <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last active</th><th /></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{(s.userAgent ?? 'unknown').replace(/\(.*?\)/g, '').slice(0, 60)}{s.current && <small>this device</small>}</td>
                  <td className="mono">{s.ip ?? '—'}</td><td>{timeAgo(s.createdAt)}</td><td>{timeAgo(s.lastSeenAt)}</td>
                  <td>{!s.current && <button onClick={() => void api(`/api/account/sessions/${s.id}`, { method: 'DELETE' }).then(loadSessions)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
