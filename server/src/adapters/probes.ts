import net from 'node:net';
import type { CheckConfig } from '../config.js';
import { redactError } from '../core/redact.js';

export interface ProbeResult {
  outcome: 'ok' | 'fail';
  /** How bad a failure is: no connection at all vs. an error response. */
  severity: 'unreachable' | 'unhealthy' | 'degraded';
  reason: string;
  latencyMs: number;
  statusCode: number | null;
  /** True when the error suggests the monitor itself could not run the check. */
  localError: boolean;
}

const LOCAL_ERRORS = new Set(['EMFILE', 'ENFILE', 'ENOBUFS', 'ENOMEM', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN']);

function statusAccepted(code: number, expect: string[] | undefined): boolean {
  const ranges = expect?.length ? expect : ['200-399', '401', '403'];
  return ranges.some((r) => {
    const [a, b] = r.split('-').map(Number);
    return b === undefined ? code === a : code >= a && code <= b;
  });
}

function errCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.cause?.code ?? e?.code ?? '';
}

export async function httpProbe(c: CheckConfig): Promise<ProbeResult> {
  const started = Date.now();
  const timeout = c.timeoutMs ?? 8000;
  try {
    const res = await fetch(c.url!, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': 'BerrieWorld-Monitor/0.1' },
    });
    await res.body?.cancel().catch(() => undefined);
    const latencyMs = Date.now() - started;
    if (statusAccepted(res.status, c.expectStatus)) return { outcome: 'ok', severity: 'degraded', reason: `HTTP ${res.status} in ${latencyMs} ms`, latencyMs, statusCode: res.status, localError: false };
    // Cloudflare origin errors (502/521/522/523/530) mean the tunnel/origin is unreachable.
    const sev = [502, 504, 521, 522, 523, 530].includes(res.status) ? 'unreachable' : res.status >= 500 ? 'unhealthy' : 'degraded';
    return { outcome: 'fail', severity: sev, reason: `HTTP ${res.status}`, latencyMs, statusCode: res.status, localError: false };
  } catch (err) {
    const code = errCode(err);
    const timedOut = (err as Error)?.name === 'TimeoutError';
    return {
      outcome: 'fail', severity: 'unreachable', reason: timedOut ? `timeout after ${timeout} ms` : redactError((err as { cause?: unknown }).cause ?? err, 160),
      latencyMs: Date.now() - started, statusCode: null, localError: LOCAL_ERRORS.has(code),
    };
  }
}

export function tcpProbe(c: CheckConfig): Promise<ProbeResult> {
  const started = Date.now();
  const timeout = c.timeoutMs ?? 5000;
  return new Promise((resolve) => {
    const sock = net.connect({ host: c.host!, port: c.port! });
    const done = (r: Omit<ProbeResult, 'latencyMs' | 'statusCode'>) => {
      sock.destroy();
      resolve({ ...r, latencyMs: Date.now() - started, statusCode: null });
    };
    sock.setTimeout(timeout, () => done({ outcome: 'fail', severity: 'unreachable', reason: `TCP timeout after ${timeout} ms`, localError: false }));
    sock.once('connect', () => done({ outcome: 'ok', severity: 'degraded', reason: `TCP ${c.host}:${c.port} open`, localError: false }));
    sock.once('error', (err) => done({ outcome: 'fail', severity: 'unreachable', reason: redactError(err, 160), localError: LOCAL_ERRORS.has(errCode(err)) }));
  });
}

export function runProbe(c: CheckConfig): Promise<ProbeResult> {
  return c.type === 'tcp' ? tcpProbe(c) : httpProbe(c);
}
