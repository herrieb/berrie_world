import type { Me, NotificationView, SavedView, ServerMessage, UserPrefs } from '@berrie/shared';
import { useStore } from './store';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

export async function refreshAuth(): Promise<Me | null> {
  try {
    const me = await api<Me>('/api/auth/me');
    useStore.getState().setMe(me);
    if (me.user) void loadPersonal();
    return me;
  } catch { return null; /* server unreachable; ws state shows this */ }
}

/** Personal state lives on the server so it follows the user across devices. */
export async function loadPersonal(): Promise<void> {
  try {
    const [p, f, v, n] = await Promise.all([
      api<{ prefs: UserPrefs }>('/api/account/prefs'),
      api<{ favorites: string[] }>('/api/account/favorites'),
      api<{ views: SavedView[] }>('/api/account/views'),
      api<{ notifications: NotificationView[] }>('/api/notifications'),
    ]);
    useStore.getState().setPersonal({ prefs: p.prefs, favorites: f.favorites, savedViews: v.views });
    useStore.getState().setNotifications(n.notifications);
  } catch { /* keep defaults */ }
}

let prefTimer: number | undefined;
let pendingPrefs: UserPrefs = {};
/** Merge into personal preferences locally now, persist (debounced) to the server. */
export function savePrefs(patch: UserPrefs): void {
  const st = useStore.getState();
  st.setPersonal({ prefs: { ...st.prefs, ...patch } });
  pendingPrefs = { ...pendingPrefs, ...patch };
  window.clearTimeout(prefTimer);
  prefTimer = window.setTimeout(() => {
    const body = pendingPrefs;
    pendingPrefs = {};
    void api('/api/account/prefs', { method: 'PUT', json: body }).catch(() => undefined);
  }, 800);
}

export async function toggleFavorite(id: string): Promise<void> {
  const on = useStore.getState().favorites.includes(id);
  const r = await api<{ favorites: string[] }>(`/api/account/favorites/${encodeURIComponent(id)}`, { method: on ? 'DELETE' : 'PUT' });
  useStore.getState().setPersonal({ favorites: r.favorites });
}

export async function signOut(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  location.hash = '';
  location.reload();
}

type Listener = (m: ServerMessage) => void;
const listeners = new Set<Listener>();
export function onServerMessage(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** WebSocket with exponential-backoff reconnect. Every (re)connect starts with a full snapshot. */
export function connectWs(): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;
  let timer: number | undefined;
  const open = () => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    useStore.getState().setWs('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => { backoff = 1000; useStore.getState().setWs('open'); };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string) as ServerMessage;
        useStore.getState().apply(m);
        if (m.t === 'notification') browserNotify(m.data);
        for (const l of listeners) l(m);
      } catch { /* ignore malformed */ }
    };
    ws.onclose = (ev) => {
      useStore.getState().setWs('closed');
      if (stopped) return;
      // 4401: sign-in required to view. Don't retry; the app reconnects after login.
      if (ev.code === 4401) { void refreshAuth(); return; }
      timer = window.setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
  };
  open();
  return () => { stopped = true; window.clearTimeout(timer); ws?.close(); };
}

/** Browser notification for a new personal notification, if the user enabled it and granted permission. */
function browserNotify(n: NotificationView): void {
  try {
    if (!useStore.getState().prefs.notifications?.browser || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(n.title, { body: n.text ?? undefined, tag: n.incidentId ?? n.id });
  } catch { /* unsupported */ }
}
