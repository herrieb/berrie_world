import { useEffect, useMemo, useState } from 'react';
import { computeSummary } from '@berrie/shared';
import { useStore, deriveAlerts, hasRole, type View } from './state/store';
import { connectWs, refreshAuth, savePrefs } from './state/api';
import { WorldView } from './ui/WorldView';
import { ServicesView } from './ui/ServicesView';
import { EventsView } from './ui/EventsView';
import { AlertsView } from './ui/AlertsView';
import { SettingsView } from './ui/SettingsView';
import { Icon } from './ui/Icon';
import { AuthGate } from './ui/AuthGate';
import { HomeView } from './ui/HomeView';
import { AccountView } from './ui/AccountView';
import { PeopleView } from './ui/PeopleView';
import { HarborView } from './ui/HarborView';
import { Avatar } from './ui/Avatar';

const TABS: { id: View; label: string; icon: string; admin?: boolean }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'world', label: 'World', icon: 'globe' },
  { id: 'services', label: 'Services', icon: 'list' },
  { id: 'events', label: 'Events', icon: 'activity' },
  { id: 'alerts', label: 'Alerts', icon: 'alert' },
  { id: 'harbor', label: 'Harbor', icon: 'anchor', admin: true },
  { id: 'people', label: 'People', icon: 'users', admin: true },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

/** One-time links: #/invite/<token> and #/reset/<token>. */
function linkToken(): { kind: 'invite' | 'reset'; value: string } | null {
  const m = /^#\/(invite|reset)\/([A-Za-z0-9_-]{10,100})$/.exec(location.hash);
  return m ? { kind: m[1] as 'invite' | 'reset', value: m[2] } : null;
}

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const entities = useStore((s) => s.entities);
  const adapters = useStore((s) => s.adapters);
  const ws = useStore((s) => s.ws);
  const loaded = useStore((s) => s.loaded);
  const mode = useStore((s) => s.mode);
  const connected = useStore((s) => s.connected);
  const daylight = useStore((s) => s.daylight);
  const setDaylight = useStore((s) => s.setDaylight);

  const me = useStore((s) => s.me);
  const [token] = useState(linkToken);
  const userId = me?.user?.id ?? null;
  const gated = !me || !me.user || (!!token && !me.user);
  useEffect(() => { void refreshAuth(); }, []);
  // Connect only once signed in; reconnect if the account changes.
  useEffect(() => (userId ? connectWs() : undefined), [userId]);

  // Deep links: #/e/<entity id> selects and focuses a building.
  const selectedId = useStore((s) => s.selectedId);
  const [linkHandled, setLinkHandled] = useState(false);
  useEffect(() => {
    if (linkHandled || !loaded || token) return;
    setLinkHandled(true);
    const m = /^#\/e\/(.+)$/.exec(location.hash);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (useStore.getState().entities[id]) setTimeout(() => useStore.getState().select(id, true), 300);
    }
  }, [loaded, linkHandled]);
  useEffect(() => {
    if (!linkHandled) return;
    const h = selectedId ? `#/e/${encodeURIComponent(selectedId)}` : '';
    if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
  }, [selectedId, linkHandled]);

  const list = useMemo(() => Object.values(entities), [entities]);
  const alerts = useMemo(() => deriveAlerts(list), [list]);
  const summary = useMemo(() => computeSummary(list, adapters, null), [list, adapters]);

  let status: { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' };
  if (ws !== 'open' && loaded) status = { text: 'Server connection lost — showing last known state', tone: 'muted' };
  else if (!loaded) status = { text: 'Connecting…', tone: 'muted' };
  else if (!connected) status = { text: 'Not connected to infrastructure', tone: 'muted' };
  else if (alerts.some((a) => a.severity === 'critical')) status = { text: `${alerts.filter((a) => a.severity === 'critical').length} host(s) offline`, tone: 'bad' };
  else if (alerts.some((a) => a.severity === 'warning')) status = { text: `${alerts.filter((a) => a.severity === 'warning').length} service(s) down`, tone: 'bad' };
  else if (alerts.length) status = { text: `${alerts.length} item(s) need attention`, tone: 'warn' };
  else if (summary.unknown) status = { text: `All known services OK · ${summary.unknown} unknown`, tone: 'ok' };
  else status = { text: 'Everything looks good', tone: 'ok' };

  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(t); }, []);

  if (!me) return <div className="gate"><p className="muted">Connecting…</p></div>;
  if (gated) return <AuthGate me={me} token={token} />;
  const user = me.user!;
  const isAdmin = hasRole(me, 'admin');
  const cycleDaylight = () => {
    const next = daylight === 'auto' ? 'day' : daylight === 'day' ? 'night' : 'auto';
    setDaylight(next);
    savePrefs({ daylight: next });
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="26" height="26" viewBox="0 0 16 16" aria-hidden><path d="M8 1 15 5v6l-7 4-7-4V5z" fill="#2c8f4a" /><path d="M8 1 15 5 8 9 1 5z" fill="#5fd27a" /><path d="M8 9v6l7-4V5z" fill="#1f6a37" /></svg>
          <span>Berrie World</span>
          {mode === 'demo' && <span className="demo-pill" title="Fixture data from a separate demo database — not your infrastructure">DEMO</span>}
        </div>
        <div className={`status-line ${status.tone}`}><span className="dot" />{status.text}</div>
        <nav className="tabs" aria-label="Views">
          {TABS.filter((t) => !t.admin || isAdmin).map((t) => (
            <button key={t.id} className={`tab${view === t.id ? ' active' : ''}`} onClick={() => setView(t.id)}>
              <Icon name={t.icon} />{t.label}
              {t.id === 'alerts' && alerts.length > 0 && <span className={`badge ${alerts.some((a) => a.severity !== 'notice') ? 'bad' : 'warn'}`}>{alerts.length}</span>}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <span className="clock"><Icon name="clock" />{now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
          <button className="ghost-btn" onClick={cycleDaylight} title="Toggle day/night (auto follows your local time)">
            <Icon name={daylight === 'night' ? 'moon' : 'sun'} />{daylight === 'auto' ? 'Auto' : daylight === 'day' ? 'Day' : 'Night'}
          </button>
          <button className={`user-btn${view === 'account' ? ' active' : ''}`} onClick={() => setView('account')} title={`${user.displayName} — account & security`}>
            <Avatar avatar={user.avatar} size={24} /><span className="uname">{user.displayName}</span>
          </button>
        </div>
      </header>
      <main className="main">
        <WorldView alerts={alerts} summary={summary} hidden={view !== 'world'} />
        {view === 'services' && <ServicesView />}
        {view === 'events' && <EventsView />}
        {view === 'alerts' && <AlertsView alerts={alerts} />}
        {view === 'settings' && <SettingsView />}
        {view === 'home' && <HomeView alerts={alerts} />}
        {view === 'account' && <AccountView />}
        {view === 'people' && isAdmin && <PeopleView />}
        {view === 'harbor' && isAdmin && <HarborView />}
      </main>
    </div>
  );
}
