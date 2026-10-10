import type { Fact, FactCategory, HostFacts } from '@berrie/shared';
import { FACT_CATEGORIES } from '@berrie/shared';

/**
 * Fixed, read-only collector. The same script is used over SSH (as one exec) and by the push agent.
 * It needs no root: it reads /proc, /etc/os-release and `df`, and only *asks* docker/systemctl/tailscale for status.
 * Nothing user-supplied is ever interpolated into it.
 */
export const COLLECTOR_SH = `LC_ALL=C; export LC_ALL
s() { printf '\\n@@%s\\n' "$1"; }
s hostname; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null
s os; cat /etc/os-release 2>/dev/null
s uname; uname -srm 2>/dev/null
s uptime; cat /proc/uptime 2>/dev/null
s loadavg; cat /proc/loadavg 2>/dev/null
s meminfo; cat /proc/meminfo 2>/dev/null
s cpuinfo; nproc 2>/dev/null; grep -m1 'model name' /proc/cpuinfo 2>/dev/null
s stat1; head -1 /proc/stat 2>/dev/null
s net1; cat /proc/net/dev 2>/dev/null
sleep 1
s stat2; head -1 /proc/stat 2>/dev/null
s net2; cat /proc/net/dev 2>/dev/null
s df; df -P -T -B1 -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs -x fuse.snapfuse 2>&1
s docker; if command -v docker >/dev/null 2>&1; then docker info --format '{{.ContainersRunning}} {{.ContainersStopped}} {{.Containers}}' 2>&1 | head -3; else echo "__NA__ docker CLI not installed"; fi
s cloudflared; systemctl is-active cloudflared 2>/dev/null; pgrep -x cloudflared >/dev/null 2>&1 && echo process-running
s listen; if command -v ss >/dev/null 2>&1; then ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null; else echo "__NA__ ss not installed"; fi
s cftunnel; for p in 20241 20242 20243 20244 20245; do r=$( (curl -s -m 2 "http://127.0.0.1:$p/config" || wget -qO- -T 2 "http://127.0.0.1:$p/config") 2>/dev/null ); case "$r" in *ingress*) printf '%s\n' "$r" | head -c 300000; break;; esac; done
s tailscale; if command -v tailscale >/dev/null 2>&1; then tailscale status --json 2>/dev/null | head -c 400000; else echo "__NA__"; fi
s end
`;

export interface CollectResult {
  facts: Partial<HostFacts>;
  metrics: { metric: string; value: number }[];
  /** Raw signals used by the topology layer (gateways, VPN peers). */
  extras: { cloudflared: 'active' | 'inactive' | 'unknown'; tailscale: unknown | null; tunnelIngress: { hostname: string; service: string }[] | null };
}

function sections(out: string): Map<string, string> {
  const m = new Map<string, string>();
  const parts = out.split(/\n@@([a-z0-9]+)\n/);
  for (let i = 1; i < parts.length; i += 2) m.set(parts[i], (parts[i + 1] ?? '').replace(/\n$/, ''));
  return m;
}

const confirmed = <T,>(value: T, ts: string, source: string): Fact<T> => ({ status: 'confirmed', value, ts, source, error: null });
const unavailable = <T,>(ts: string, source: string, error: string): Fact<T> => ({ status: 'unavailable', value: null, ts, source, error });

function cpuTimes(line: string | undefined): { idle: number; total: number } | null {
  const f = line?.trim().split(/\s+/);
  if (!f || f[0] !== 'cpu' || f.length < 5) return null;
  const n = f.slice(1).map(Number);
  if (n.some((x) => !Number.isFinite(x))) return null;
  const idle = n[3] + (n[4] ?? 0);
  return { idle, total: n.reduce((a, b) => a + b, 0) };
}

function netDev(text: string | undefined): Map<string, { rx: number; tx: number }> {
  const m = new Map<string, { rx: number; tx: number }>();
  for (const line of (text ?? '').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) m.set(name.trim(), { rx: f[0], tx: f[8] });
  }
  return m;
}

const VIRTUAL_IF = /^(lo|veth|br-|docker|virbr|cni|flannel|cali|vnet|tun|tap)/;

/** Parse collector output. Each category is either confirmed with real values or marked unavailable with a reason. */
export function parseCollector(out: string, source: string, ts: string): CollectResult {
  const s = sections(out);
  const facts: Partial<HostFacts> = {};
  const metrics: CollectResult['metrics'] = [];
  if (!s.has('end')) {
    // Truncated output: trust nothing partial except what parsed cleanly below.
  }

  const hostname = s.get('hostname')?.trim();
  facts.identity = hostname ? confirmed({ hostname: hostname.split('\n')[0].slice(0, 255) }, ts, source) : unavailable(ts, source, 'hostname not readable');

  const osr = s.get('os') ?? '';
  const kv = new Map(osr.split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] as [string, string]; }).filter(([k]) => k));
  const uname = (s.get('uname') ?? '').trim().split(/\s+/);
  if (kv.get('NAME') || uname[0]) {
    facts.os = confirmed({
      name: kv.get('PRETTY_NAME') ?? kv.get('NAME') ?? uname[0], version: kv.get('VERSION_ID') ?? null,
      kernel: uname[1] ?? null, arch: uname[2] ?? null,
    }, ts, source);
  } else facts.os = unavailable(ts, source, '/etc/os-release not readable');

  const up = (s.get('uptime') ?? '').trim().split(/\s+/).map(Number);
  const la = (s.get('loadavg') ?? '').trim().split(/\s+/).map(Number);
  if (Number.isFinite(up[0]) && la.length >= 3 && la.slice(0, 3).every(Number.isFinite)) {
    facts.uptime = confirmed({ seconds: Math.round(up[0]), load1: la[0], load5: la[1], load15: la[2] }, ts, source);
    metrics.push({ metric: 'load1', value: la[0] }, { metric: 'uptime', value: Math.round(up[0]) });
  } else facts.uptime = unavailable(ts, source, '/proc/uptime or /proc/loadavg not readable');

  const mem = new Map((s.get('meminfo') ?? '').split('\n').map((l) => { const m = /^(\w+):\s+(\d+)\s*kB/.exec(l); return m ? [m[1], Number(m[2]) * 1024] as [string, number] : null; }).filter(Boolean) as [string, number][]);
  const total = mem.get('MemTotal'), avail = mem.get('MemAvailable');
  if (total && avail !== undefined) {
    const used = total - avail;
    const usedPct = Math.round((used / total) * 1000) / 10;
    facts.memory = confirmed({ totalBytes: total, usedBytes: used, usedPct, swapTotalBytes: mem.get('SwapTotal') ?? 0, swapUsedBytes: (mem.get('SwapTotal') ?? 0) - (mem.get('SwapFree') ?? 0) }, ts, source);
    metrics.push({ metric: 'mem.pct', value: usedPct }, { metric: 'mem.used', value: used });
  } else facts.memory = unavailable(ts, source, '/proc/meminfo not readable');

  const cpuLines = (s.get('cpuinfo') ?? '').split('\n');
  const cores = Number(cpuLines[0]);
  const a = cpuTimes(s.get('stat1')), b = cpuTimes(s.get('stat2'));
  const usage = a && b && b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 1000) / 10 : null;
  if (Number.isInteger(cores) && cores > 0) {
    facts.cpu = confirmed({ cores, model: cpuLines.find((l) => l.startsWith('model name'))?.split(':')[1]?.trim() ?? null, usagePct: usage }, ts, source);
    if (usage !== null) metrics.push({ metric: 'cpu.pct', value: usage });
  } else facts.cpu = unavailable(ts, source, 'nproc not available');

  const n1 = netDev(s.get('net1')), n2 = netDev(s.get('net2'));
  if (n2.size) {
    const interfaces = [...n2.entries()].filter(([name]) => !VIRTUAL_IF.test(name)).map(([name, v]) => {
      const p = n1.get(name);
      return { name, rxBps: p ? Math.max(0, v.rx - p.rx) : null, txBps: p ? Math.max(0, v.tx - p.tx) : null };
    });
    facts.network = confirmed({ interfaces }, ts, source);
    const rx = interfaces.reduce((t, i) => t + (i.rxBps ?? 0), 0), tx = interfaces.reduce((t, i) => t + (i.txBps ?? 0), 0);
    if (n1.size) metrics.push({ metric: 'net.rx_bps', value: rx }, { metric: 'net.tx_bps', value: tx });
  } else facts.network = unavailable(ts, source, '/proc/net/dev not readable');

  const dfLines = (s.get('df') ?? '').split('\n');
  const fss = dfLines.slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 7 && /^\d+$/.test(f[2]))
    .map((f) => ({ mount: f.slice(6).join(' '), fstype: f[1], sizeBytes: Number(f[2]), usedBytes: Number(f[3]), usedPct: Number(f[2]) ? Math.round((Number(f[3]) / Number(f[2])) * 1000) / 10 : 0 }))
    .filter((f) => f.sizeBytes > 0 && !f.mount.startsWith('/snap/') && !f.mount.startsWith('/run') && !f.mount.startsWith('/boot/efi'));
  if (fss.length) {
    facts.storage = confirmed({ filesystems: fss.slice(0, 20) }, ts, source);
    for (const f of fss.slice(0, 20)) metrics.push({ metric: `disk.pct:${f.mount}`, value: f.usedPct });
  } else facts.storage = unavailable(ts, source, dfLines[0]?.slice(0, 120) || 'df not available');

  const dk = (s.get('docker') ?? '').trim();
  const dm = /^(\d+) (\d+) (\d+)$/.exec(dk.split('\n')[0] ?? '');
  facts.containers = dm
    ? confirmed({ running: Number(dm[1]), stopped: Number(dm[2]), total: Number(dm[3]) }, ts, source)
    : unavailable(ts, source, dk.startsWith('__NA__') ? 'docker CLI not installed' : /permission denied/i.test(dk) ? 'no permission to query Docker (user not in docker group)' : (dk.split('\n')[0] || 'docker info failed').slice(0, 160));

  // Listening TCP sockets from the server's own socket table (no scanning). Processes are visible only for our own user.
  const ls = (s.get('listen') ?? '').trim();
  if (s.has('listen') && !ls.startsWith('__NA__')) {
    const seen = new Set<string>();
    const listeners = ls.split('\n').map((line) => {
      const f = line.trim().split(/\s+/);
      const local = f.find((x, i) => i >= 2 && /:(\d+)$/.test(x) && !x.endsWith(':*'));
      if (!local) return null;
      const port = Number(/:(\d+)$/.exec(local)![1]);
      const address = local.slice(0, local.lastIndexOf(':')).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
      const scope: 'loopback' | 'tailscale' | 'lan' | 'all' =
        address === '*' || address === '0.0.0.0' || address === '::' ? 'all'
        : /^127\./.test(address) || address === '::1' ? 'loopback'
        : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^fd7a:115c:a1e0:/i.test(address) ? 'tailscale' : 'lan';
      const proc = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? null;
      return { port, address, scope, process: proc };
    }).filter((l): l is NonNullable<typeof l> => !!l && Number.isInteger(l.port) && l.port > 0)
      .filter((l) => { const k = `${l.address}|${l.port}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.port - b.port).slice(0, 300);
    facts.ports = confirmed({ listeners }, ts, source);
  } else facts.ports = unavailable(ts, source, ls.startsWith('__NA__') ? 'ss not installed' : 'socket list not readable');

  // Live route list from cloudflared's local metrics server (/config): works for dashboard-managed tunnels, no root needed.
  let tunnelIngress: { hostname: string; service: string }[] | null = null;
  const tc = (s.get('cftunnel') ?? '').trim();
  if (tc) {
    try {
      const doc = JSON.parse(tc) as { config?: { ingress?: { hostname?: string | null; service?: string }[] } };
      tunnelIngress = (doc.config?.ingress ?? []).filter((r) => r.hostname && r.service && !r.hostname.includes('*'))
        .map((r) => ({ hostname: String(r.hostname).toLowerCase().slice(0, 253), service: String(r.service).slice(0, 300) })).slice(0, 500);
    } catch { tunnelIngress = null; }
  }
  const cf = s.get('cloudflared') ?? '';
  const cloudflared = /^active$/m.test(cf) || /process-running/.test(cf) || tunnelIngress ? 'active' : /inactive|failed|unknown/.test(cf) ? 'inactive' : 'unknown';
  let tailscale: unknown = null;
  const ts2 = (s.get('tailscale') ?? '').trim();
  if (ts2 && !ts2.startsWith('__NA__')) { try { tailscale = JSON.parse(ts2); } catch { tailscale = null; } }

  return { facts, metrics, extras: { cloudflared, tailscale, tunnelIngress } };
}

/** Facts for a host with no collector at all: everything is honestly 'unconfigured'. */
export function unconfiguredFacts(): HostFacts {
  const f = {} as Record<FactCategory, Fact<unknown>>;
  for (const c of FACT_CATEGORIES) f[c] = { status: 'unconfigured', value: null, ts: null, source: null };
  return f as unknown as HostFacts;
}

/**
 * Merge a fresh partial result into stored facts and age everything: values older than `staleAfterMs`
 * become 'stale' (still shown, with their age); categories nobody provides stay 'unconfigured'.
 */
export function mergeFacts(stored: HostFacts | null, fresh: Partial<HostFacts>, provided: FactCategory[], now: number, staleAfterMs: number): HostFacts {
  const out = { ...(stored ?? unconfiguredFacts()) } as Record<FactCategory, Fact<unknown>>;
  for (const c of FACT_CATEGORIES) {
    const f = fresh[c] as Fact<unknown> | undefined;
    if (f) {
      const cur = out[c];
      if (f.status === 'unavailable' && cur?.value != null) {
        // A failed read keeps the last value from the same source visible as stale rather than erasing it;
        // a value from another source (e.g. Docker /info) is unaffected by this collector's failure.
        if (cur.source === f.source) out[c] = { ...cur, status: 'stale', error: f.error };
      } else out[c] = f;
    } else if (!provided.includes(c)) {
      if (out[c]?.status !== 'unconfigured' && out[c]?.value == null) out[c] = { status: 'unconfigured', value: null, ts: null, source: null };
    } else if (out[c]?.status === 'unconfigured') {
      out[c] = { status: 'unknown', value: null, ts: null, source: null };
    }
    const cur = out[c];
    if (cur?.status === 'confirmed' && cur.ts && now - Date.parse(cur.ts) > staleAfterMs) out[c] = { ...cur, status: 'stale' };
  }
  return out as unknown as HostFacts;
}
