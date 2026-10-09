import { create } from 'zustand';
import type {
  AdapterStatus, Alert, BlockView, BuildingType, EntityView, Health, HostnameHint, Origin, ServerMessage, Severity, WorldEvent,
} from '@berrie/shared';
import { effectiveHealth } from '@berrie/shared';

export type View = 'world' | 'services' | 'events' | 'alerts' | 'settings';
export type Daylight = 'auto' | 'day' | 'night';

export interface Filters {
  text: string;
  health: Health | 'all' | 'problems';
  type: BuildingType | 'all';
  host: string | 'all';
}

interface State {
  ws: 'connecting' | 'open' | 'closed';
  loaded: boolean;
  mode: Origin;
  connected: boolean;
  actionsEnabled: boolean;
  entities: Record<string, EntityView>;
  blocks: BlockView[];
  adapters: AdapterStatus[];
  hints: HostnameHint[];
  events: WorldEvent[];
  serverOffsetMs: number;
  selectedId: string | null;
  view: View;
  filters: Filters;
  daylight: Daylight;
  editLayout: boolean;
  admin: boolean;
  adminConfigured: boolean;
  /** Server requires admin sign-in to view the world (REQUIRE_AUTH_FOR_VIEW). */
  viewRequiresAuth: boolean;
  /** True once /api/auth/me has answered. */
  authKnown: boolean;
  /** Increment to ask the renderer to fly to the selected building. */
  focusTick: number;
  apply: (m: ServerMessage) => void;
  select: (id: string | null, focus?: boolean) => void;
  setView: (v: View) => void;
  setFilters: (f: Partial<Filters>) => void;
  setDaylight: (d: Daylight) => void;
  setEditLayout: (b: boolean) => void;
  setAuth: (a: { admin: boolean; adminConfigured: boolean; actionsEnabled?: boolean; viewRequiresAuth?: boolean }) => void;
  setWs: (s: State['ws']) => void;
}

const loadPref = <T,>(k: string, d: T): T => {
  try { const v = localStorage.getItem(`bw:${k}`); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
};
const savePref = (k: string, v: unknown) => { try { localStorage.setItem(`bw:${k}`, JSON.stringify(v)); } catch { /* ignore */ } };

export const useStore = create<State>((set) => ({
  ws: 'connecting',
  loaded: false,
  mode: 'live',
  connected: false,
  actionsEnabled: false,
  entities: {},
  blocks: [],
  adapters: [],
  hints: [],
  events: [],
  serverOffsetMs: 0,
  selectedId: null,
  view: ((): View => { try { const v = new URLSearchParams(location.search).get('view'); return (['world', 'services', 'events', 'alerts', 'settings'] as View[]).includes(v as View) ? (v as View) : 'world'; } catch { return 'world'; } })(),
  filters: { text: '', health: 'all', type: 'all', host: 'all' },
  daylight: loadPref<Daylight>('daylight', 'auto'),
  editLayout: false,
  admin: false,
  adminConfigured: false,
  viewRequiresAuth: false,
  authKnown: false,
  focusTick: 0,
  apply: (m) => set((s) => {
    switch (m.t) {
      case 'snapshot':
        return {
          loaded: true, mode: m.data.mode, connected: m.data.connected, actionsEnabled: m.data.actionsEnabled,
          entities: Object.fromEntries(m.data.entities.map((e) => [e.id, e])), blocks: m.data.blocks,
          adapters: m.data.adapters, hints: m.data.hints, events: m.data.recentEvents,
          serverOffsetMs: Date.parse(m.data.serverTime) - Date.now(),
        };
      case 'entity': {
        const entities = { ...s.entities };
        if (m.data.lifecycle === 'archived') delete entities[m.data.id];
        else entities[m.data.id] = m.data;
        return { entities, connected: true };
      }
      case 'removed': {
        const entities = { ...s.entities };
        delete entities[m.data.id];
        return { entities };
      }
      case 'event':
        return { events: [m.data, ...s.events].slice(0, 300) };
      case 'blocks':
        return { blocks: m.data };
      case 'adapters':
        return { adapters: m.data, connected: s.connected || m.data.some((a) => a.lastCompleteAt && a.adapter !== 'config') };
      case 'hints':
        return { hints: m.data };
      default:
        return {};
    }
  }),
  select: (id, focus = false) => set((s) => ({ selectedId: id, focusTick: focus ? s.focusTick + 1 : s.focusTick })),
  setView: (view) => set({ view }),
  setFilters: (f) => set((s) => ({ filters: { ...s.filters, ...f } })),
  setDaylight: (daylight) => { savePref('daylight', daylight); set({ daylight }); },
  setEditLayout: (editLayout) => set({ editLayout }),
  setAuth: (a) => set((s) => ({
    admin: a.admin, adminConfigured: a.adminConfigured, actionsEnabled: a.actionsEnabled ?? s.actionsEnabled,
    viewRequiresAuth: a.viewRequiresAuth ?? s.viewRequiresAuth, authKnown: true,
  })),
  setWs: (ws) => set({ ws }),
}));

// ---------- derived helpers ----------

export const BAD: Health[] = ['degraded', 'unhealthy', 'unreachable', 'restarting', 'host_offline'];

export function hasBuilding(e: EntityView): boolean {
  return !!e.layout && e.lifecycle !== 'archived';
}

export function deriveAlerts(entities: EntityView[]): Alert[] {
  const out: Alert[] = [];
  for (const e of entities) {
    if (e.kind === 'project' || e.lifecycle === 'archived' || e.lifecycle === 'removed') continue;
    const h = effectiveHealth(e);
    let severity: Severity | null = null;
    if (e.kind === 'host' && h === 'host_offline') severity = 'critical';
    else if (e.inheritedHostOffline) continue; // represented by the host alert
    else if (h === 'unhealthy' || h === 'unreachable') severity = 'warning';
    else if (h === 'degraded' || h === 'restarting') severity = 'notice';
    else if (e.lifecycle === 'missing') severity = 'notice';
    if (!severity) continue;
    out.push({
      entityId: e.id, displayName: e.displayName, health: h, lifecycle: e.lifecycle,
      reason: e.lifecycle === 'missing' ? 'not found in the latest complete inventory — awaiting confirmation' : e.healthReason,
      since: e.lifecycle === 'missing' ? e.missingSince : e.lastChangeAt, severity,
    });
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, notice: 2, info: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.displayName.localeCompare(b.displayName));
}

export function matchesFilters(e: EntityView, f: Filters): boolean {
  if (f.text) {
    const q = f.text.toLowerCase();
    const hay = [e.displayName, e.name, e.id, ...e.hostnames, String(e.meta.image ?? ''), String(e.meta.composeProject ?? '')].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  const h = effectiveHealth(e);
  if (f.health === 'problems' && !(BAD.includes(h) || e.lifecycle === 'missing')) return false;
  if (f.health !== 'all' && f.health !== 'problems' && h !== f.health) return false;
  if (f.type !== 'all' && e.buildingType !== f.type) return false;
  if (f.host !== 'all' && e.hostId !== f.host) return false;
  return true;
}

export function filtersActive(f: Filters): boolean {
  return !!f.text || f.health !== 'all' || f.type !== 'all' || f.host !== 'all';
}
