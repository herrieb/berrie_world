import { useEffect, useMemo, useState } from 'react';
import type { MetricSeries } from '@berrie/shared';
import { api } from '../state/api';
import { fmtBytes } from './status';

const RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
const LABEL: Record<string, string> = {
  'cpu.pct': 'CPU busy %', 'mem.pct': 'Memory used %', 'mem.used': 'Memory used', 'load1': 'Load (1 min)', 'uptime': 'Uptime (s)',
  'net.rx_bps': 'Network in', 'net.tx_bps': 'Network out', 'latency': 'Response time (ms)', 'tls.days_left': 'TLS certificate days left',
};
const label = (m: string) => LABEL[m] ?? (m.startsWith('disk.pct:') ? `Disk used % (${m.slice(9)})` : m);
const fmt = (m: string, v: number) => (m === 'mem.used' ? fmtBytes(v) : m.startsWith('net.') ? `${fmtBytes(v)}/s` : m.endsWith('pct') || m.startsWith('disk.pct') ? `${Math.round(v * 10) / 10}%` : String(Math.round(v * 100) / 100));

/** History chart for one entity. Shows nothing invented: too few samples → says so instead of drawing. */
export function MetricChart({ entityId }: { entityId: string }) {
  const [names, setNames] = useState<string[] | null>(null);
  const [metric, setMetric] = useState<string>('');
  const [range, setRange] = useState<(typeof RANGES)[number]>('24h');
  const [series, setSeries] = useState<MetricSeries | null>(null);

  useEffect(() => {
    api<{ metrics: string[] }>(`/api/entities/${encodeURIComponent(entityId)}/metrics`).then((r) => {
      const useful = r.metrics.filter((m) => m !== 'uptime');
      setNames(useful);
      setMetric((cur) => (useful.includes(cur) ? cur : useful.find((m) => m === 'cpu.pct') ?? useful[0] ?? ''));
    }).catch(() => setNames([]));
  }, [entityId]);

  useEffect(() => {
    if (!metric) return;
    let alive = true;
    const load = () => api<MetricSeries>(`/api/entities/${encodeURIComponent(entityId)}/metrics?metric=${encodeURIComponent(metric)}&range=${range}`).then((s) => alive && setSeries(s)).catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [entityId, metric, range]);

  const W = 320, H = 110, P = 4;
  const chart = useMemo(() => {
    const pts = series?.points ?? [];
    if (pts.length < 3) return null;
    const t0 = Date.parse(pts[0].ts), t1 = Date.parse(pts[pts.length - 1].ts) || t0 + 1;
    const lo = Math.min(...pts.map((p) => p.min ?? p.value)), hi = Math.max(...pts.map((p) => p.max ?? p.value));
    const pct = metric.endsWith('pct') || metric.startsWith('disk.pct');
    const yMin = pct ? 0 : lo, yMax = pct ? Math.max(100, hi) : hi === lo ? hi + 1 : hi;
    const x = (ts: string) => P + ((Date.parse(ts) - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
    const y = (v: number) => H - P - ((v - yMin) / (yMax - yMin)) * (H - 2 * P);
    // Break the line where samples are missing (more than 3× the median gap): gaps are shown, not interpolated.
    const gaps = pts.slice(1).map((p, i) => Date.parse(p.ts) - Date.parse(pts[i].ts)).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] || 60_000;
    let d = '';
    pts.forEach((p, i) => { const jump = i === 0 || Date.parse(p.ts) - Date.parse(pts[i - 1].ts) > median * 3; d += `${jump ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`; });
    const band = series?.resolution === 'hourly' ? pts.map((p) => `${x(p.ts).toFixed(1)},${y(p.max ?? p.value).toFixed(1)}`).join(' ') + ' ' + [...pts].reverse().map((p) => `${x(p.ts).toFixed(1)},${y(p.min ?? p.value).toFixed(1)}`).join(' ') : null;
    return { d, band, last: pts[pts.length - 1], lo, hi };
  }, [series, metric]);

  if (names === null) return <p className="muted">Loading…</p>;
  if (!names.length) return <p className="muted">No metrics have been collected for this entity. Values appear only once a collector (SSH or agent) has measured them.</p>;
  return (
    <div className="metric-chart">
      <div className="row">
        <select value={metric} onChange={(e) => setMetric(e.target.value)} aria-label="Metric">{names.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
        <div className="seg">{RANGES.map((r) => <button key={r} className={range === r ? 'on' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
      </div>
      {!chart ? <p className="muted small">Not enough samples in this range to draw a history ({series?.points.length ?? 0} so far).</p> : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`${label(metric)} over ${range}`}>
            {chart.band && <polygon points={chart.band} className="band" />}
            <path d={chart.d} className="line" />
          </svg>
          <p className="small muted">now {fmt(metric, chart.last.value)} · range {fmt(metric, chart.lo)}–{fmt(metric, chart.hi)} · {series!.points.length} {series!.resolution === 'hourly' ? 'hourly averages' : 'samples'} · source {series!.source ?? 'unknown'}</p>
        </>
      )}
    </div>
  );
}
