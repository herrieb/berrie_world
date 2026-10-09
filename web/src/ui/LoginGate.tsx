import { useState } from 'react';
import { api, refreshAuth } from '../state/api';

/** Full-screen sign-in shown when the server requires admin sign-in to view the world. */
export function LoginGate() {
  const [token, setToken] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api('/api/auth/login', { method: 'POST', json: { token } });
      setToken('');
      await refreshAuth();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={(e) => void submit(e)}>
        <svg width="40" height="40" viewBox="0 0 16 16" aria-hidden><path d="M8 1 15 5v6l-7 4-7-4V5z" fill="#2c8f4a" /><path d="M8 1 15 5 8 9 1 5z" fill="#5fd27a" /><path d="M8 9v6l7-4V5z" fill="#1f6a37" /></svg>
        <h1>Berrie World</h1>
        <p className="muted">Sign in with the admin token to view the village.</p>
        <input type="password" placeholder="Admin token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password" autoFocus />
        <button className="primary" type="submit" disabled={busy || !token}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {err && <p className="msg">{err}</p>}
      </form>
    </div>
  );
}
