import type { EntityView, Fact, HostFacts } from '@berrie/shared';

export const hostFacts = (e: EntityView | undefined): HostFacts | null => (e?.meta.facts as HostFacts | undefined) ?? null;

/** Values may be shown only when actually collected (confirmed, or stale with its age). */
export const known = <T,>(f: Fact<T> | undefined): T | null => (f && (f.status === 'confirmed' || f.status === 'stale') ? f.value : null);

/** Visual capacity tier from the *confirmed* CPU count; null when capacity was never collected. */
export function capacityTier(f: HostFacts | null): number | null {
  const cpu = known(f?.cpu);
  if (!cpu?.cores) return null;
  return cpu.cores <= 4 ? 1 : cpu.cores <= 16 ? 2 : 3;
}

/** Resource pressure from collected values only. Thresholds are deliberately conservative. */
export function pressure(f: HostFacts | null): { kind: 'memory' | 'disk' | 'cpu' | 'load'; label: string; pct?: number }[] {
  if (!f) return [];
  const out: { kind: 'memory' | 'disk' | 'cpu' | 'load'; label: string; pct?: number }[] = [];
  const mem = known(f.memory);
  if (mem?.usedPct != null && mem.usedPct >= 90) out.push({ kind: 'memory', label: `memory ${Math.round(mem.usedPct)}%`, pct: mem.usedPct });
  for (const fs of known(f.storage)?.filesystems ?? []) if (fs.usedPct >= 90) out.push({ kind: 'disk', label: `disk ${fs.mount} ${Math.round(fs.usedPct)}%`, pct: fs.usedPct });
  const cpu = known(f.cpu);
  if (cpu?.usagePct != null && cpu.usagePct >= 95) out.push({ kind: 'cpu', label: `CPU ${Math.round(cpu.usagePct)}%`, pct: cpu.usagePct });
  const up = known(f.uptime);
  if (up && cpu?.cores && up.load1 / cpu.cores >= 2) out.push({ kind: 'load', label: `load ${up.load1.toFixed(1)} on ${cpu.cores} cores` });
  return out;
}

export function fmtDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
