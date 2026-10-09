import { useState } from 'react';
import { useStore } from '../state/store';
import { api } from '../state/api';
import { Icon } from './Icon';
import { timeAgo } from './status';

/** Personal notifications (per your own preferences in Account). */
export function NotificationBell() {
  const notifications = useStore((s) => s.notifications);
  const setNotifications = useStore((s) => s.setNotifications);
  const selectIncident = useStore((s) => s.selectIncident);
  const setView = useStore((s) => s.setView);
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.readAt).length;
  const markAll = () => { void api('/api/notifications/read', { method: 'POST', json: { ids: 'all' } }); setNotifications(notifications.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() }))); };
  return (
    <div className="bell">
      <button className="ghost-btn" onClick={() => setOpen(!open)} title="Notifications" aria-label={`Notifications (${unread} unread)`}>
        <Icon name="bell" />{unread > 0 && <span className="badge bad">{unread}</span>}
      </button>
      {open && (
        <div className="bell-menu card">
          <div className="row"><b>Notifications</b>{unread > 0 && <button className="link-btn" onClick={markAll}>Mark all read</button>}</div>
          {!notifications.length && <p className="muted small">Nothing yet. Configure what you receive under Account → Notifications.</p>}
          <ul>
            {notifications.slice(0, 20).map((n) => (
              <li key={n.id} className={n.readAt ? 'read' : ''}>
                <button onClick={() => { if (n.incidentId) { selectIncident(n.incidentId); setView('incidents'); } setOpen(false); void api('/api/notifications/read', { method: 'POST', json: { ids: [n.id] } }); setNotifications(notifications.map((x) => (x.id === n.id ? { ...x, readAt: x.readAt ?? new Date().toISOString() } : x))); }}>
                  <span className={`sev ${n.severity}`}>{n.severity}</span>
                  <span className="grow">{n.title}<small>{n.text ? `${n.text} · ` : ''}{timeAgo(n.ts)}</small></span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
