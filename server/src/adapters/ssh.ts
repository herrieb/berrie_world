import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import ssh2, { type ConnectConfig } from 'ssh2';

// ssh2 is CommonJS: take the runtime values from the default export (named ESM imports fail under plain Node).
const { Client } = ssh2;
type Client = InstanceType<typeof ssh2.Client>;
import { redactError } from '../core/redact.js';

export interface SshTarget { address: string; port: number; username: string }
export interface SshSecret { kind: 'key' | 'password'; privateKey?: string; passphrase?: string; password?: string }

/** Anything that can run the collector and open forwarded streams. Real SSH or a test double. */
export interface Transport {
  exec(command: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<{ code: number | null; stdout: string; stderr: string }>;
  forwardTcp(host: string, port: number): Promise<Duplex>;
  forwardSocket(path: string): Promise<Duplex>;
  close(): void;
}

export class HostKeyMismatchError extends Error {}

/** Parse the key type out of an SSH wire-format public key blob. */
function keyType(blob: Buffer): string {
  const len = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  return len > 0 && len < 64 ? blob.subarray(4, 4 + len).toString('ascii') : 'unknown';
}

export function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** "<type> <base64>" as in known_hosts / *.pub files. */
export function formatHostKey(blob: Buffer): string {
  return `${keyType(blob)} ${blob.toString('base64')}`;
}

export function fingerprintOf(hostKey: string): string {
  return fingerprint(Buffer.from(hostKey.split(' ')[1] ?? '', 'base64'));
}

/** Network-level failure (host down / unreachable) vs. a reachable host that refused us. */
export function isNetworkError(err: unknown): boolean {
  const code = (err as { code?: string; level?: string })?.code ?? '';
  const level = (err as { level?: string })?.level ?? '';
  return ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET'].includes(code) || level === 'client-timeout' || /timed out/i.test(String((err as Error)?.message));
}

/**
 * Connect only far enough to learn the server's host key, then abort before authenticating.
 * The admin compares the fingerprint with the server (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`) before pinning it.
 */
export function probeHostKey(t: Pick<SshTarget, 'address' | 'port'>, timeoutMs = 8000): Promise<{ hostKey: string; fingerprint: string; type: string }> {
  return new Promise((resolve, reject) => {
    const c = new Client();
    let got: Buffer | null = null;
    const done = (err?: Error) => {
      c.end();
      if (got) resolve({ hostKey: formatHostKey(got), fingerprint: fingerprint(got), type: keyType(got) });
      else reject(err ?? new Error('server did not present a host key'));
    };
    c.on('error', (e) => done(e));
    c.on('close', () => done());
    c.connect({
      host: t.address, port: t.port, username: 'berrie-world-probe', readyTimeout: timeoutMs,
      // Record the key and refuse: no authentication is attempted.
      hostVerifier: (key: Buffer) => { got = Buffer.from(key); return false; },
      algorithms: { serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256'] },
    } as ConnectConfig);
  });
}

/**
 * One SSH connection with a pinned host key. There is deliberately no way to skip verification:
 * without a pinned key the connection is refused.
 */
export class SshTransport implements Transport {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(private readonly target: SshTarget, private readonly secret: SshSecret, private readonly pinnedKey: string, private readonly timeoutMs = 10_000) {
    if (!pinnedKey) throw new HostKeyMismatchError('no pinned host key');
  }

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    const pinned = Buffer.from(this.pinnedKey.split(' ')[1] ?? '', 'base64');
    this.connecting = new Promise<Client>((resolve, reject) => {
      const c = new Client();
      let mismatch = false;
      c.on('ready', () => { this.client = c; this.connecting = null; resolve(c); });
      c.on('error', (e) => { this.connecting = null; this.client = null; reject(mismatch ? new HostKeyMismatchError(`host key mismatch for ${this.target.address} — refusing to connect`) : e); });
      c.on('close', () => { if (this.client === c) this.client = null; });
      c.connect({
        host: this.target.address, port: this.target.port, username: this.target.username, readyTimeout: this.timeoutMs, keepaliveInterval: 30_000,
        hostVerifier: (key: Buffer) => { const ok = key.length === pinned.length && key.equals(pinned); mismatch = !ok; return ok; },
        ...(this.secret.kind === 'key' ? { privateKey: this.secret.privateKey, passphrase: this.secret.passphrase || undefined } : { password: this.secret.password }),
        tryKeyboard: false,
      } as ConnectConfig);
    });
    return this.connecting;
  }

  async exec(command: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const c = await this.connect();
    const max = opts.maxBytes ?? 2 * 1024 * 1024;
    return new Promise((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) return reject(err);
        let out = '', errOut = '', done = false;
        const timer = setTimeout(() => { if (!done) { done = true; stream.close(); reject(new Error(`command timed out after ${opts.timeoutMs ?? 20_000} ms`)); } }, opts.timeoutMs ?? 20_000);
        stream.on('data', (d: Buffer) => { if (out.length < max) out += d.toString('utf8'); });
        stream.stderr.on('data', (d: Buffer) => { if (errOut.length < 64 * 1024) errOut += d.toString('utf8'); });
        stream.on('close', (code: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: errOut }); });
      });
    });
  }

  async forwardTcp(host: string, port: number): Promise<Duplex> {
    const c = await this.connect();
    return new Promise((resolve, reject) => c.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch))));
  }

  async forwardSocket(path: string): Promise<Duplex> {
    const c = await this.connect();
    return new Promise((resolve, reject) => c.openssh_forwardOutStreamLocal(path, (err, ch) => (err ? reject(err) : resolve(ch))));
  }

  close(): void {
    this.client?.end();
    this.client = null;
  }
}

export function describeSshError(err: unknown): string {
  if (err instanceof HostKeyMismatchError) return err.message;
  const msg = redactError(err, 200);
  if (/All configured authentication methods failed/i.test(msg)) return 'SSH authentication failed (check the user and key/password)';
  return msg;
}
