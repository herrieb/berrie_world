import { useEffect, useMemo, useState } from 'react';
import type { Alert, EntityView, SavedView, UserTask } from '@berrie/shared';
import { ROLE_LABEL, effectiveHealth } from '@berrie/shared';
import { useStore } from '../state/store';
import { api, toggleFavorite } from '../state/api';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { HEALTH_COLOR, iconSvg, statusText, timeAgo } from './status';
import { describeEvent, eventColor } from './events';

function EntityRowLink({ e }: { e: EntityView }) {
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const st = statusText(e);
  return (
    <button className="entity-row" onClick={() => { setView('world'); select(e.id, true); }}>
      <span className="ic" style={{ color: st.color }} dangerouslySetInnerHTML={{ __html: iconSvg(e.buildingType, 16) }} />
      <span className="grow">{e.displayName}<small>{e.kind === 'host' ? 'island' : e.hostId?.replace(/^host:/, '') ?? 'external'}</small></span>
      <span className="pill" style={{ '--c': st.color } as React.CSSProperties}><span className="dot" />{st.text}</span>
    </button>
  );
}

function Tasks() {
  const entities = useStore((s) => s.entities);
  const [tasks, setTasks] = useState<UserTask[]>([]);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [entityId, setEntityId] = useState('');
  const load = () => api<{ tasks: UserTask[] }>('/api/account/tasks').then((r) => setTasks(r.tasks)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const now = new Date().toISOString();
  const options = Object.values(entities).filter((e) => e.kind === 'host' || e.kind === 'service').sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <>
      <form className="task-add" onSubmit={(e) => { e.preventDefault(); if (!title.trim()) return; void api('/api/account/tasks', { method: 'POST', json: { title, dueAt: due ? new Date(due).toISOString() : null, entityId: entityId || null } }).then(() => { setTitle(''); setDue(''); setEntityId(''); return load(); }); }}>
        <input placeholder="Add a task or maintenance reminder…" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)} aria-label="Related service"><option value="">No service</option>{options.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}</select>
        <button type="submit"><Icon name="plus" /></button>
      </form>
      {!tasks.length && <p className="muted small">Nothing planned. Tasks are private to you.</p>}
      <ul className="tasks">
        {tasks.map((t) => (
          <li key={t.id} className={t.doneAt ? 'done' : t.dueAt && t.dueAt < now ? 'overdue' : ''}>
            <label><input type="checkbox" checked={!!t.doneAt} onChange={(e) => void api(`/api/account/tasks/${t.id}`, { method: 'PATCH', json: { done: e.target.checked } }).then(load)} /> {t.title}</label>
            <small>{t.dueAt ? `due ${new Date(t.dueAt).toLocaleDateString()}` : ''}{t.entityId ? ` · ${entities[t.entityId]?.displayName ?? 'removed service'}` : ''}</small>
            <button className="icon-btn" title="Delete" onClick={() => void api(`/api/account/tasks/${t.id}`, { method: 'DELETE' }).then(load)}><Icon name="trash" size={13} /></button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function HomeView({ alerts }: { alerts: Alert[] }) {
  const s = useStore();
  const user = s.me?.user;
  const fav = useMemo(() => s.favorites.map((id) => s.entities[id]).filter(Boolean) as EntityView[], [s.favorites, s.entities]);
  const favIslands = fav.filter((e) => e.kind === 'host');
  const favServices = fav.filter((e) => e.kind !== 'host');
  const hosts = Object.values(s.entities).filter((e) => e.kind === 'host');
  const hour = new Date().getHours();
  const greet = hour < 6 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  if (!user) return null;

  const applyView = (v: SavedView) => {
    s.setFilters(v.view.filters as never);
    s.setView('world');
  };

  return (
    <div className="page home">
      <div className="home-hero card">
        <Avatar avatar={user.avatar} size={56} />
        <div className="grow">
          <h1>{greet}, {user.displayName}</h1>
          <p className="muted">{ROLE_LABEL[user.role]} · {user.role === 'admin' || user.hostScope === 'all' ? `all ${hosts.length} island(s)` : `${hosts.length} island(s) shared with you`}</p>
        </div>
        <div className="hero-stats">
          <div><b style={{ color: alerts.some((a) => a.severity !== 'notice') ? HEALTH_COLOR.unhealthy : HEALTH_COLOR.healthy }}>{alerts.length}</b><span>open alerts</span></div>
          <div><b>{Object.values(s.entities).filter((e) => e.kind === 'service' && effectiveHealth(e) === 'healthy').length}</b><span>healthy services</span></div>
        </div>
        <button className="primary" onClick={() => s.setView('world')}><Icon name="globe" /> Open the world</button>
      </div>

      <div className="grid3">
        <section className="card">
          <h3><Icon name="alert" /> Current alerts</h3>
          {!alerts.length ? <p className="muted">All quiet on your islands.</p> : (
            <div className="list">{alerts.slice(0, 8).map((a) => s.entities[a.entityId] && <EntityRowLink key={a.entityId} e={s.entities[a.entityId]} />)}</div>
          )}
          {alerts.length > 8 && <button className="link-btn" onClick={() => s.setView('alerts')}>All {alerts.length} alerts</button>}
        </section>

        <section className="card">
          <h3><Icon name="flame" /> Unresolved incidents</h3>
          {(() => {
            const open = Object.values(s.incidents).filter((i) => i.status !== 'resolved').sort((a, b) => (b.assignee?.id === user.id ? 1 : 0) - (a.assignee?.id === user.id ? 1 : 0));
            if (!open.length) return <p className="muted small">No open incidents.</p>;
            return (
              <div className="list">
                {open.slice(0, 6).map((i) => (
                  <button key={i.id} className="entity-row" onClick={() => { s.selectIncident(i.id); s.setView('incidents'); }}>
                    <span className={`sev ${i.severity}`}>{i.severity}</span>
                    <span className="grow">{i.title}<small>{i.status === 'monitoring' ? 'recovered — needs confirmation' : 'open'}{i.assignee ? ` · ${i.assignee.id === user.id ? 'assigned to you' : i.assignee.name}` : ' · unassigned'}</small></span>
                  </button>
                ))}
              </div>
            );
          })()}
          {s.maintenance.some((w) => Date.parse(w.startsAt) <= Date.now()) && <p className="small muted"><Icon name="wrench" size={11} /> {s.maintenance.filter((w) => Date.parse(w.startsAt) <= Date.now()).length} maintenance window(s) active</p>}
        </section>

        <section className="card">
          <h3><Icon name="star" /> Favorite islands</h3>
          {!favIslands.length ? <p className="muted small">Star an island in the world to pin it here.</p> : <div className="list">{favIslands.map((e) => <EntityRowLink key={e.id} e={e} />)}</div>}
          <div className="quick-add">
            {hosts.filter((h) => !s.favorites.includes(h.id)).slice(0, 6).map((h) => <button key={h.id} className="chip" onClick={() => void toggleFavorite(h.id)}><Icon name="plus" size={12} /> {h.displayName}</button>)}
          </div>
        </section>

        <section className="card">
          <h3><Icon name="star" /> Favorite services</h3>
          {!favServices.length ? <p className="muted small">Open a building and press ☆ to add it here.</p> : <div className="list">{favServices.map((e) => <EntityRowLink key={e.id} e={e} />)}</div>}
        </section>

        <section className="card span2">
          <h3><Icon name="check" /> My tasks & maintenance reminders</h3>
          <Tasks />
        </section>

        <section className="card">
          <h3><Icon name="bookmark" /> Saved map views</h3>
          {!s.savedViews.length ? <p className="muted small">Set filters on the world map and save them as a view.</p> : (
            <ul className="views">
              {s.savedViews.map((v) => (
                <li key={v.id}>
                  <button className="link-btn" onClick={() => applyView(v)}>{v.name}</button>
                  <small>{[v.view.filters.text && `"${v.view.filters.text}"`, v.view.filters.health !== 'all' && v.view.filters.health, v.view.filters.type !== 'all' && v.view.filters.type, v.view.filters.host !== 'all' && v.view.filters.host.replace(/^host:/, '')].filter(Boolean).join(' · ') || 'everything'}</small>
                  <button className="icon-btn" title="Delete view" onClick={() => void api(`/api/account/views/${v.id}`, { method: 'DELETE' }).then(() => s.setPersonal({ savedViews: s.savedViews.filter((x) => x.id !== v.id) }))}><Icon name="trash" size={13} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card span2">
          <h3><Icon name="activity" /> Recent activity</h3>
          <ul className="feed">
            {s.events.slice(0, 12).map((ev) => (
              <li key={ev.id}>
                <span className="dot" style={{ background: eventColor(ev) }} />
                <span className="grow">{describeEvent(ev, s.entities)}</span>
                <small>{timeAgo(ev.ts, s.serverOffsetMs)}</small>
              </li>
            ))}
            {!s.events.length && <li className="muted">No events yet.</li>}
          </ul>
        </section>

        <section className="card">
          <h3><Icon name="shield" /> Account & security</h3>
          <dl className="facts">
            <dt>Two-factor</dt><dd>{user.totpEnabled ? <span className="inv complete">on</span> : <span className="inv incomplete">off</span>}</dd>
            <dt>Notifications</dt><dd>{s.prefs.notifications?.inApp === false ? 'off' : `in-app, ${s.prefs.notifications?.minSeverity ?? 'warning'}+`}</dd>
            <dt>Last sign-in</dt><dd>{timeAgo(user.lastLoginAt)}</dd>
          </dl>
          <button onClick={() => s.setView('account')}>Account settings</button>
        </section>
      </div>
    </div>
  );
}
