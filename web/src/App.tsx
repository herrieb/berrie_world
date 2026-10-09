import { useEffect, useMemo, useState } from 'react';
import { computeSummary } from '@berrie/shared';
import { useStore, deriveAlerts, type View } from './state/store';
import { connectWs, refreshAuth } from './state/api';
import { WorldView } from './ui/WorldView';
import { ServicesView } from './ui/ServicesView';
import { EventsView } from './ui/EventsView';
import { AlertsView } from './ui/AlertsView';
import { SettingsView } from './ui/SettingsView';
import { Icon } from './ui/Icon';
import { LoginGate } from './ui/LoginGate';

const TABS: { id: View; label: string; icon: string }[] = [
  { id: 'world', label: 'World', icon: 'globe' },
  { id: 'services', label: 'Services', icon: 'list' },
  { id: 'events', label: 'Events', icon: 'activity' },
  { id: 'alerts', label: 'Alerts', icon: 'alert' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

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

  const admin = useStore((s) => s.admin);
  const authKnown = useStore((s) => s.authKnown);
  const viewRequiresAuth = useStore((s) => s.viewRequiresAuth);
  const gated = authKnown && viewRequiresAuth && !admin;
  useEffect(() => { void refreshAuth(); }, []);
  // (Re)connect whenever the sign-in state changes, so the world loads right after login.
  useEffect(() => (authKnown && !gated ? connectWs() : undefined), [authKnown, gated, admin]);

  // Deep links: #/e/<entity id> selects and focuses a building.
  const selectedId = useStore((s) => s.selectedId);
  const [linkHandled, setLinkHandled] = useState(false);
  useEffect(() => {
    if (linkHandled || !loaded) return;
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

  if (gated) return <LoginGate />;

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
          {TABS.map((t) => (
            <button key={t.id} className={`tab${view === t.id ? ' active' : ''}`} onClick={() => setView(t.id)}>
              <Icon name={t.icon} />{t.label}
              {t.id === 'alerts' && alerts.length > 0 && <span className={`badge ${alerts.some((a) => a.severity !== 'notice') ? 'bad' : 'warn'}`}>{alerts.length}</span>}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <span className="clock"><Icon name="clock" />{now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</span>
          <button className="ghost-btn" onClick={() => setDaylight(daylight === 'auto' ? 'day' : daylight === 'day' ? 'night' : 'auto')} title="Toggle day/night (auto follows your local time)">
            <Icon name={daylight === 'night' ? 'moon' : 'sun'} />{daylight === 'auto' ? 'Auto' : daylight === 'day' ? 'Day' : 'Night'}
          </button>
        </div>
      </header>
      <main className="main">
        <WorldView alerts={alerts} summary={summary} hidden={view !== 'world'} />
        {view === 'services' && <ServicesView />}
        {view === 'events' && <EventsView />}
        {view === 'alerts' && <AlertsView alerts={alerts} />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
