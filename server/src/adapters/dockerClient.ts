import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

export interface DockerTarget {
  socketPath?: string;
  url?: string;
  /** Custom stream factory, e.g. a socket forwarded over SSH. */
  connect?: () => Promise<Duplex>;
}

/** Minimal Docker Engine API client over a unix socket, a (read-only) socket proxy URL, or a forwarded stream. */
export class DockerClient {
  constructor(private readonly target: DockerTarget, private readonly timeoutMs = 8000) {}

  private opts(path: string, method: string): http.RequestOptions & { protocol?: string } {
    if (this.target.connect) {
      const connect = this.target.connect;
      return {
        path, method,
        createConnection: ((_o: unknown, cb: (err: Error | null, s?: Duplex) => void) => { connect().then((s) => cb(null, s), (e: Error) => cb(e)); return undefined; }) as unknown as http.RequestOptions['createConnection'],
      };
    }
    if (this.target.url) {
      const u = new URL(path, this.target.url);
      return { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search, method };
    }
    return { socketPath: this.target.socketPath ?? '/var/run/docker.sock', path, method };
  }

  private request(path: string, method = 'GET', maxBytes = 8 * 1024 * 1024): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const o = this.opts(path, method);
      const lib = o.protocol === 'https:' ? https : http;
      const req = lib.request({ ...o, headers: { Host: 'docker' }, timeout: this.timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('docker API timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  async get<T>(path: string): Promise<T> {
    const r = await this.request(path);
    if (r.status < 200 || r.status >= 300) throw new Error(`docker API ${path.split('?')[0]} returned ${r.status}`);
    return JSON.parse(r.body.toString('utf8')) as T;
  }

  async post(path: string): Promise<number> {
    const r = await this.request(path, 'POST');
    if (r.status >= 400) throw new Error(`docker API returned ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
    return r.status;
  }

  /** Raw bytes (used for logs). */
  async raw(path: string, maxBytes: number): Promise<Buffer> {
    const r = await this.request(path, 'GET', maxBytes);
    if (r.status >= 400) throw new Error(`docker API returned ${r.status}`);
    return r.body;
  }

  /** Stream newline-delimited JSON (the /events endpoint). Returns a function that stops the stream. */
  stream(path: string, onMessage: (m: unknown) => void, onEnd: (err?: Error) => void): () => void {
    const o = this.opts(path, 'GET');
    const lib = o.protocol === 'https:' ? https : http;
    let buf = '';
    let ended = false;
    const finish = (err?: Error) => { if (!ended) { ended = true; onEnd(err); } };
    const req = lib.request({ ...o, headers: { Host: 'docker' } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) { finish(new Error(`events stream returned ${res.statusCode}`)); res.resume(); return; }
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) try { onMessage(JSON.parse(line)); } catch { /* ignore malformed */ }
        }
        if (buf.length > 1_000_000) buf = '';
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
    });
    req.on('error', (e) => finish(e));
    req.end();
    return () => { ended = true; req.destroy(); };
  }
}

/** Demultiplex Docker's log stream format (8-byte frame headers) when the container has no TTY. */
export function demuxLogs(buf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  const looksFramed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return buf.toString('utf8');
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'));
    i += 8 + len;
  }
  return out.join('');
}
