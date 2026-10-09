import type { ServerMessage } from '@berrie/shared';
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

export async function refreshAuth(): Promise<void> {
  try {
    const me = await api<{ admin: boolean; adminConfigured: boolean; actionsEnabled: boolean; viewRequiresAuth?: boolean }>('/api/auth/me');
    useStore.getState().setAuth(me);
  } catch { /* server unreachable; ws state shows this */ }
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
