import type { BuildingType, EntityView, Health } from '@berrie/shared';
import { HEALTH_LABEL, effectiveHealth } from '@berrie/shared';

export const HEALTH_COLOR: Record<Health, string> = {
  healthy: '#3fd17a',
  degraded: '#f2b33d',
  unhealthy: '#ef4b4b',
  unreachable: '#f0603c',
  starting: '#4aa8ff',
  restarting: '#4aa8ff',
  host_offline: '#a58bff',
  unknown: '#8a94a6',
};

export const hexNum = (c: string) => Number.parseInt(c.slice(1), 16);

export const TYPE_LABEL: Record<BuildingType, string> = {
  server: 'Server', townhall: 'Project', house: 'Website / app', lab: 'AI service', workshop: 'Automation',
  silo: 'Database', tower: 'Network / proxy', depot: 'File storage', clocktower: 'Worker / scheduler',
  cache: 'Cache', post: 'Mail', shop: 'Service',
};

/** Tiny inline SVG glyphs per building type (24x24 viewBox, currentColor). */
export const TYPE_ICON: Record<BuildingType, string> = {
  server: '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><circle cx="8" cy="6.5" r="1" fill="currentColor"/><circle cx="8" cy="17.5" r="1" fill="currentColor"/>',
  townhall: '<path d="M3 10 12 4l9 6"/><path d="M5 10v9h14v-9"/><path d="M10 19v-5h4v5"/>',
  house: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><rect x="10" y="14" width="4" height="6"/>',
  lab: '<path d="M9 3h6"/><path d="M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3"/><path d="M7.5 15h9"/>',
  workshop: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  silo: '<ellipse cx="12" cy="5" rx="7" ry="2.5"/><path d="M5 5v14c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5"/><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  tower: '<path d="M12 9 7 21M12 9l5 12M9 16h6"/><circle cx="12" cy="7" r="2"/><path d="M7.8 3.8a6 6 0 0 0 0 6.4M16.2 3.8a6 6 0 0 1 0 6.4"/>',
  depot: '<path d="M3 8 12 3l9 5v12H3z"/><path d="M7 20v-7h10v7M7 16h10"/>',
  clocktower: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  cache: '<path d="M13 2 5 13h6l-1 9 8-11h-6z"/>',
  post: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  shop: '<path d="M4 9h16l-1-5H5z"/><path d="M5 9v11h14V9"/><path d="M10 20v-6h4v6"/>',
};

export function iconSvg(t: BuildingType, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICON[t] ?? TYPE_ICON.shop}</svg>`;
}

/** Short status line for labels; lifecycle wins over health when the entity's existence is in question. */
export function statusText(e: EntityView): { text: string; color: string; kind: 'health' | 'lifecycle' } {
  if (e.lifecycle === 'removed') return { text: 'Removed', color: '#6b7385', kind: 'lifecycle' };
  if (e.lifecycle === 'missing') return { text: 'Missing?', color: '#c9b37a', kind: 'lifecycle' };
  if (e.lifecycle === 'discovered') {
    const h = effectiveHealth(e);
    return { text: `New · ${HEALTH_LABEL[h]}`, color: HEALTH_COLOR[h], kind: 'health' };
  }
  const h = effectiveHealth(e);
  return { text: h === 'healthy' ? 'Online' : HEALTH_LABEL[h], color: HEALTH_COLOR[h], kind: 'health' };
}

export function timeAgo(iso: string | null, offsetMs = 0): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() + offsetMs - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
