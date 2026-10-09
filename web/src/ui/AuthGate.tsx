import { useEffect, useState } from 'react';
import type { Me } from '@berrie/shared';
import { ROLE_LABEL } from '@berrie/shared';
import { api, refreshAuth } from '../state/api';

type Mode = 'login' | 'mfa' | 'setup' | 'invite' | 'reset';

const Logo = () => (
  <svg width="40" height="40" viewBox="0 0 16 16" aria-hidden><path d="M8 1 15 5v6l-7 4-7-4V5z" fill="#2c8f4a" /><path d="M8 1 15 5 8 9 1 5z" fill="#5fd27a" /><path d="M8 9v6l7-4V5z" fill="#1f6a37" /></svg>
);

/** Every way into Berrie World: first-run setup, sign-in (+TOTP), invitation acceptance, password reset. */
export function AuthGate({ me, token }: { me: Me | null; token: { kind: 'invite' | 'reset'; value: string } | null }) {
  const initial: Mode = token?.kind ?? (me?.setupRequired ? 'setup' : me?.mfaPending ? 'mfa' : 'login');
  const [mode, setMode] = useState<Mode>(initial);
  const [f, setF] = useState({ username: '', password: '', password2: '', displayName: '', code: '', bootstrapToken: '' });
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ role: keyof typeof ROLE_LABEL; hostScope: string; hosts: string[]; expiresAt: string } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  useEffect(() => { setMode(initial); }, [initial]);
  useEffect(() => {
    if (token?.kind !== 'invite') return;
    api<NonNullable<typeof invite>>(`/api/invitations/${encodeURIComponent(token.value)}`).then(setInvite).catch((e) => setErr((e as Error).message));
  }, [token?.kind, token?.value]);

  const run = async (fn: () => Promise<void>) => {
    setErr(null); setBusy(true);
    try { await fn(); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const done = async () => { if (token) history.replaceState(null, '', location.pathname); await refreshAuth(); };
  const mismatch = (mode === 'setup' || mode === 'invite' || mode === 'reset') && f.password2 !== '' && f.password !== f.password2;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    void run(async () => {
      if (mode === 'login') {
        const r = await api<{ mfaRequired: boolean }>('/api/auth/login', { method: 'POST', json: { username: f.username, password: f.password } });
        if (r.mfaRequired) { setMode('mfa'); setF({ ...f, password: '' }); return; }
        await done();
      } else if (mode === 'mfa') {
        await api('/api/auth/mfa', { method: 'POST', json: { code: f.code } });
        await done();
      } else if (mode === 'setup') {
        await api('/api/auth/setup', { method: 'POST', json: { bootstrapToken: f.bootstrapToken, username: f.username, displayName: f.displayName || f.username, password: f.password } });
        await done();
      } else if (mode === 'invite') {
        await api(`/api/invitations/${encodeURIComponent(token!.value)}/accept`, { method: 'POST', json: { username: f.username, displayName: f.displayName || f.username, password: f.password } });
        await done();
      } else if (mode === 'reset') {
        await api('/api/auth/reset', { method: 'POST', json: { token: token!.value, password: f.password } });
        history.replaceState(null, '', location.pathname);
        setInfo('Password changed. Sign in with your new password.');
        setMode('login');
      }
    });
  };

  const title = { login: 'Sign in', mfa: 'Two-factor code', setup: 'Create the first administrator', invite: 'Join Berrie World', reset: 'Choose a new password' }[mode];
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Logo />
        <h1>Berrie World</h1>
        <p className="muted">{title}</p>
        {info && <p className="ok-msg">{info}</p>}
        {mode === 'setup' && <p className="small muted">Nobody has an account yet. Enter the bootstrap token (<code>ADMIN_TOKEN</code> in the server's <code>.env</code>) to create the first administrator. After that the token is no longer used for sign-in.</p>}
        {mode === 'invite' && invite && <p className="small muted">You were invited as <b>{ROLE_LABEL[invite.role]}</b>{invite.hostScope === 'list' ? ` for ${invite.hosts.map((h) => h.replace(/^host:/, '')).join(', ') || 'no servers yet'}` : ' for all servers'}.</p>}
        {mode === 'setup' && <input type="password" placeholder="Bootstrap token" value={f.bootstrapToken} onChange={set('bootstrapToken')} autoComplete="off" required />}
        {(mode === 'login' || mode === 'setup' || mode === 'invite') && <input placeholder="Username" value={f.username} onChange={set('username')} autoComplete="username" autoFocus required maxLength={32} />}
        {(mode === 'setup' || mode === 'invite') && <input placeholder="Display name (optional)" value={f.displayName} onChange={set('displayName')} maxLength={60} />}
        {mode !== 'mfa' && <input type="password" placeholder={mode === 'login' ? 'Password' : 'New password (min. 10 characters)'} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />}
        {(mode === 'setup' || mode === 'invite' || mode === 'reset') && <input type="password" placeholder="Repeat password" value={f.password2} onChange={set('password2')} autoComplete="new-password" required />}
        {mode === 'mfa' && <input inputMode="numeric" pattern="[0-9]{6}" placeholder="6-digit code from your authenticator" value={f.code} onChange={set('code')} autoComplete="one-time-code" autoFocus required />}
        {mismatch && <p className="msg">Passwords do not match.</p>}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'mfa' ? 'Verify' : mode === 'reset' ? 'Change password' : 'Create account'}</button>
        {err && <p className="msg">{err}</p>}
        {mode === 'login' && <p className="small muted">Forgot your password? Ask an administrator for a reset link.</p>}
        {mode === 'mfa' && <button type="button" className="link-btn" onClick={() => void api('/api/auth/logout', { method: 'POST' }).then(() => setMode('login'))}>Use a different account</button>}
      </form>
    </div>
  );
}
