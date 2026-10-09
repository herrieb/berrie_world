import type { FastifyInstance, FastifyRequest } from 'fastify';
import ssh2 from 'ssh2';
import type { Biome, DiscoveryMethod, HostRegistration } from '@berrie/shared';
import { BIOMES } from '@berrie/shared';
import type { Repo } from '../db/repo.js';
import type { HostRow } from '../db/hosts.js';
import type { Scheduler } from '../core/scheduler.js';
import type { World } from '../core/world.js';
import { COLLECTOR_SH, parseCollector } from '../core/collector.js';
import { DockerClient } from '../adapters/dockerClient.js';
import { DockerAdapter, hostEntityId } from '../adapters/docker.js';
import { SshTransport, describeSshError, fingerprintOf, probeHostKey, type SshSecret, type Transport } from '../adapters/ssh.js';
import { randomToken, safeEqual, sha256, type SecretBox } from '../core/secrets.js';
import { redactError } from '../core/redact.js';
import { RateLimiter, type Auth, type Principal } from './auth.js';
import type { TransportFactory } from '../core/hosts.js';
import { AGENT_SH, AGENT_UNITS } from '../core/agentScript.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$|^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-fA-F:]+$/;
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/i;
const NAME = /^[\p{L}\p{N} ._'()&+-]{1,60}$/u;
const TAG = /^[a-z0-9][a-z0-9:_.-]{0,30}$/i;
const METHODS: DiscoveryMethod[] = ['ssh', 'agent', 'docker', 'manual'];
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 } } } as const;

interface Ctx { repo: Repo; world: World; scheduler: Scheduler; auth: Auth; box: SecretBox; transportFactory?: TransportFactory }

interface SettingsIn {
  address?: string; port?: number; username?: string; authMethod?: 'key' | 'password';
  docker?: 'none' | 'socket' | 'tcp'; dockerSocket?: string; dockerTcpPort?: number; dockerUrl?: string;
  intervalSeconds?: number; probe?: boolean; description?: string;
}
interface CredentialIn { kind: 'key' | 'password' | 'generated'; privateKey?: string; passphrase?: string; password?: string; keyId?: string }

const SETTINGS_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    address: { type: 'string', maxLength: 253 }, port: { type: 'integer', minimum: 1, maximum: 65535 }, username: { type: 'string', maxLength: 32 },
    authMethod: { type: 'string', enum: ['key', 'password'] }, docker: { type: 'string', enum: ['none', 'socket', 'tcp'] },
    dockerSocket: { type: 'string', maxLength: 200 }, dockerTcpPort: { type: 'integer', minimum: 1, maximum: 65535 }, dockerUrl: { type: 'string', maxLength: 300 },
    intervalSeconds: { type: 'integer', minimum: 30, maximum: 3600 }, probe: { type: 'boolean' }, description: { type: 'string', maxLength: 300 },
  },
} as const;
const CREDENTIAL_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { type: 'string', enum: ['key', 'password', 'generated'] }, privateKey: { type: 'string', maxLength: 20000 }, passphrase: { type: 'string', maxLength: 500 }, password: { type: 'string', maxLength: 500 }, keyId: { type: 'string', maxLength: 64 },
  },
} as const;

/** Validate connection settings for a method. Returns an error message or null. */
function settingsProblem(method: DiscoveryMethod, s: SettingsIn): string | null {
  if (s.address !== undefined && !HOSTNAME.test(s.address)) return 'invalid address (hostname or IP)';
  if (method === 'ssh') {
    if (!s.address) return 'address is required for SSH';
    if (!s.username || !USER.test(s.username)) return 'a valid SSH username is required';
    if (s.docker === 'tcp' && !s.dockerTcpPort) return 'dockerTcpPort is required when Docker is reached over TCP';
    if (s.dockerSocket && !/^\/[\w./-]+$/.test(s.dockerSocket)) return 'invalid Docker socket path';
  }
  if (method === 'docker') {
    if (!s.dockerUrl) return 'dockerUrl is required (a read-only docker-socket-proxy URL)';
    try { const u = new URL(s.dockerUrl); if (!['http:', 'https:'].includes(u.protocol)) return 'dockerUrl must be http(s)'; } catch { return 'invalid dockerUrl'; }
  }
  if (s.probe && !s.address) return 'a reachability probe needs an address';
  return null;
}

function credentialProblem(c: CredentialIn | undefined): string | null {
  if (!c) return null;
  if (c.kind === 'generated') return 'generated key has expired — generate a new one';
  if (c.kind === 'password') return c.password ? null : 'password is empty';
  if (!c.privateKey) return 'private key is empty';
  const parsed = ssh2.utils.parseKey(c.privateKey, c.passphrase || undefined);
  if (parsed instanceof Error) return `private key could not be read: ${parsed.message}`;
  const k = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!k || !k.isPrivateKey()) return 'that is a public key — paste the private key (it is encrypted at rest and never shown again)';
  return null;
}

const cleanTags = (tags: unknown): string[] | null => (Array.isArray(tags) && tags.length <= 20 && tags.every((t) => typeof t === 'string' && TAG.test(t)) ? [...new Set(tags as string[])] : null);
const cleanAppearance = (a: unknown): { biome?: Biome } => (a && typeof a === 'object' && BIOMES.includes((a as { biome?: Biome }).biome!) ? { biome: (a as { biome: Biome }).biome } : {});

export async function registerHarborRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { repo, world, scheduler, auth, box } = ctx;
  // Key pairs generated for a server that is still being set up. Private halves never leave the server;
  // they live only in memory (1 h) until the server is registered, then sealed with the master key.
  const pendingKeys = new Map<string, { privateKey: string; createdAt: number; by: string }>();
  /** Swap a reference to a generated key for the real credential (server-side only). */
  const resolveCredential = (c: CredentialIn | undefined, userId: string): CredentialIn | undefined => {
    if (c?.kind !== 'generated') return c;
    const k = c.keyId ? pendingKeys.get(c.keyId) : undefined;
    if (!k || k.by !== userId || Date.now() - k.createdAt > 3600_000) return c;
    return { kind: 'key', privateKey: k.privateKey };
  };
  const hm = scheduler.hosts;
  const admin = auth.require('admin');
  const testLimiter = new RateLimiter(20, 60_000);
  const agentLimiter = new RateLimiter(30, 60_000);
  const me = (req: FastifyRequest): Principal => auth.principal(req)!;
  const audit = (req: FastifyRequest, action: string, entityId: string | null, result: string, params?: Record<string, unknown>) =>
    repo.audit({ ...auth.actor(auth.principal(req)), ip: req.ip, action, entityId, params, result });
  const makeTransport = (t: { address: string; port: number; username: string }, secret: SshSecret, hostKey: string): Transport =>
    ctx.transportFactory ? ctx.transportFactory(t, secret, hostKey) : new SshTransport(t, secret, hostKey);

  const listing = (): (HostRegistration & { health: string | null; healthReason: string | null; lifecycle: string | null; services: number })[] =>
    hm.resolve(true).map((h) => {
      const e = repo.getEntity(h.entityId);
      const v = e ? repo.toView(e) : null;
      return {
        ...hm.registration(h), health: v?.health ?? null, healthReason: v?.healthReason ?? null, lifecycle: v?.lifecycle ?? null,
        services: repo.listEntities(true).filter((x) => x.hostId === h.entityId && x.kind === 'service' && x.lifecycle !== 'archived').length,
      };
    });

  app.get('/api/harbor/hosts', { preHandler: admin }, async () => ({ hosts: listing(), collector: COLLECTOR_SH }));

  /** Generate a dedicated ed25519 key for one server; only the public key is returned. */
  app.post('/api/harbor/keypair', { preHandler: admin }, async (req) => {
    for (const [id, k] of pendingKeys) if (Date.now() - k.createdAt > 3600_000) pendingKeys.delete(id);
    const pair = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'berrie-world' });
    const keyId = randomToken(12);
    pendingKeys.set(keyId, { privateKey: pair.private, createdAt: Date.now(), by: me(req).user.id });
    audit(req, 'harbor.keypair', null, 'ok');
    return { keyId, publicKey: pair.public.trim() };
  });

  // Step 1 of adding an SSH server: fetch the host key so an admin can verify its fingerprint out of band.
  app.post('/api/harbor/probe-key', {
    preHandler: admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['address'], properties: { address: { type: 'string', maxLength: 253 }, port: { type: 'integer', minimum: 1, maximum: 65535 } } } },
  }, async (req, reply) => {
    const b = req.body as { address: string; port?: number };
    if (!testLimiter.allow(`probe:${me(req).user.id}`)) return reply.code(429).send({ error: 'too many attempts, wait a minute' });
    if (!HOSTNAME.test(b.address)) return reply.code(400).send({ error: 'invalid address' });
    try {
      const k = await probeHostKey({ address: b.address, port: b.port ?? 22 });
      audit(req, 'harbor.probe_key', null, 'ok', { address: b.address, fingerprint: k.fingerprint });
      return k;
    } catch (err) {
      return reply.code(502).send({ error: describeSshError(err) });
    }
  });

  /** Connect with the given settings and preview what would be imported. Nothing is stored. */
  app.post('/api/harbor/test', {
    preHandler: admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['method', 'settings'], properties: {
      method: { type: 'string', enum: METHODS }, settings: SETTINGS_SCHEMA, credential: CREDENTIAL_SCHEMA, hostKey: { type: 'string', maxLength: 4000 }, existingId: { type: 'string', maxLength: 64 },
    } } },
  }, async (req, reply) => {
    const b = req.body as { method: DiscoveryMethod; settings: SettingsIn; credential?: CredentialIn; hostKey?: string; existingId?: string };
    b.credential = resolveCredential(b.credential, me(req).user.id);
    if (!testLimiter.allow(`test:${me(req).user.id}`)) return reply.code(429).send({ error: 'too many attempts, wait a minute' });
    const problem = settingsProblem(b.method, b.settings) ?? credentialProblem(b.credential);
    if (problem) return reply.code(400).send({ error: problem });
    const existing = b.existingId ? repo.hosts.get(b.existingId) : undefined;
    const preview: { ok: boolean; steps: { step: string; ok: boolean; detail: string }[]; facts?: unknown; containers?: { id: string; name: string; project: string | null; state: string; health: string }[] } = { ok: false, steps: [] };
    let transport: Transport | null = null;
    try {
      if (b.method === 'ssh') {
        const hostKey = b.hostKey ?? existing?.hostKey;
        if (!hostKey) return reply.code(400).send({ error: 'verify and confirm the host key first' });
        let secret: SshSecret | null = (b.credential as SshSecret | undefined) ?? null;
        if (!secret && existing?.credential) secret = JSON.parse(box.open(existing.credential, `host:${existing.id}`)) as SshSecret;
        if (!secret) return reply.code(400).send({ error: 'a credential is required' });
        transport = makeTransport({ address: b.settings.address!, port: b.settings.port ?? 22, username: b.settings.username! }, secret, hostKey);
        const r = await transport.exec(COLLECTOR_SH, { timeoutMs: 25_000 });
        preview.steps.push({ step: 'SSH connection (pinned host key)', ok: true, detail: `connected as ${b.settings.username}` });
        const parsed = parseCollector(r.stdout, 'preview', new Date().toISOString());
        preview.facts = parsed.facts;
        const unavailable = Object.entries(parsed.facts).filter(([, f]) => f?.status === 'unavailable').map(([k, f]) => `${k}: ${f?.error}`);
        preview.steps.push({ step: 'Read-only collector', ok: unavailable.length < 4, detail: unavailable.length ? `unavailable — ${unavailable.join('; ')}` : 'all categories collected' });
        if (b.settings.docker && b.settings.docker !== 'none') {
          const t = transport;
          const client = new DockerClient({ connect: () => (b.settings.docker === 'tcp' ? t.forwardTcp('127.0.0.1', b.settings.dockerTcpPort!) : t.forwardSocket(b.settings.dockerSocket || '/var/run/docker.sock')) });
          await previewDocker(client, b.existingId ?? 'preview', preview);
        }
      } else if (b.method === 'docker') {
        await previewDocker(new DockerClient({ url: b.settings.dockerUrl! }), b.existingId ?? 'preview', preview);
      } else {
        preview.steps.push({ step: b.method === 'agent' ? 'Agent' : 'Manual', ok: true, detail: b.method === 'agent' ? 'nothing to test yet — the agent will push its first report after installation' : 'no automatic discovery; the island shows only what you register' });
      }
      preview.ok = preview.steps.every((s) => s.ok);
      audit(req, 'harbor.test', b.existingId ? hostEntityId(b.existingId) : null, preview.ok ? 'ok' : 'partial', { method: b.method, address: b.settings.address ?? b.settings.dockerUrl ?? null });
      return preview;
    } catch (err) {
      preview.steps.push({ step: b.method === 'ssh' ? 'SSH connection (pinned host key)' : 'Connection', ok: false, detail: describeSshError(err) });
      audit(req, 'harbor.test', null, `failed: ${describeSshError(err)}`, { method: b.method });
      return preview;
    } finally {
      transport?.close();
    }
  });

  async function previewDocker(client: DockerClient, hostId: string, preview: { steps: { step: string; ok: boolean; detail: string }[]; containers?: { id: string; name: string; project: string | null; state: string; health: string }[] }) {
    const inv = await new DockerAdapter({ id: hostId, name: hostId }, client).inventory();
    if (inv.completeness === 'unavailable') { preview.steps.push({ step: 'Docker API (read-only)', ok: false, detail: inv.error ?? 'unavailable' }); return; }
    const svcs = inv.entities.filter((e) => e.kind === 'service');
    preview.containers = svcs.map((e) => ({ id: e.id, name: e.name, project: (e.meta?.composeProject as string) ?? null, state: String(e.meta?.state ?? ''), health: e.health?.health ?? 'unknown' }));
    preview.steps.push({ step: 'Docker API (read-only)', ok: true, detail: `${svcs.length} containers in ${new Set(svcs.map((e) => e.meta?.composeProject).filter(Boolean)).size} compose projects` });
  }

  app.post('/api/harbor/hosts', {
    preHandler: admin,
    schema: { body: { type: 'object', additionalProperties: false, required: ['id', 'name', 'method', 'settings'], properties: {
      id: { type: 'string', maxLength: 32 }, name: { type: 'string', maxLength: 60 }, method: { type: 'string', enum: METHODS }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 32 } },
      settings: SETTINGS_SCHEMA, credential: CREDENTIAL_SCHEMA, hostKey: { type: 'string', maxLength: 4000 }, hostKeyConfirmed: { type: 'boolean' }, appearance: { type: 'object' },
    } } },
  }, async (req, reply) => {
    const b = req.body as { id: string; name: string; method: DiscoveryMethod; tags?: string[]; settings: SettingsIn; credential?: CredentialIn; hostKey?: string; hostKeyConfirmed?: boolean; appearance?: unknown };
    const generated = b.credential?.kind === 'generated' ? b.credential.keyId : undefined;
    b.credential = resolveCredential(b.credential, me(req).user.id);
    if (!SLUG.test(b.id)) return reply.code(400).send({ error: 'id: 2–32 lowercase letters, digits and dashes' });
    if (hm.get(b.id)) return reply.code(409).send({ error: 'a server with this id already exists (archived servers keep their id)' });
    if (!NAME.test(b.name.trim())) return reply.code(400).send({ error: 'invalid name' });
    const tags = cleanTags(b.tags ?? []);
    if (!tags) return reply.code(400).send({ error: 'invalid tags' });
    const problem = settingsProblem(b.method, b.settings) ?? credentialProblem(b.credential);
    if (problem) return reply.code(400).send({ error: problem });
    if (b.method === 'ssh') {
      if (!b.credential) return reply.code(400).send({ error: 'an SSH credential is required' });
      // Host-key checking is never optional: an admin must have explicitly confirmed this exact key.
      if (!b.hostKey || !b.hostKeyConfirmed) return reply.code(400).send({ error: 'the SSH host key must be verified and confirmed' });
      if (!/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|rsa-sha2-(256|512)) [A-Za-z0-9+/=]+$/.test(b.hostKey)) return reply.code(400).send({ error: 'invalid host key format' });
    }
    let agentToken: string | null = null;
    if (b.method === 'agent') agentToken = randomToken(32);
    const row = repo.hosts.create({
      id: b.id, name: b.name.trim(), tags, method: b.method, settings: { ...b.settings, authMethod: b.credential?.kind === 'password' ? 'password' : b.credential ? 'key' : undefined },
      credential: b.credential ? box.seal(JSON.stringify(b.credential), `host:${b.id}`) : null,
      hostKey: b.method === 'ssh' ? b.hostKey! : null, agentTokenHash: agentToken ? sha256(agentToken) : null,
      appearance: cleanAppearance(b.appearance), status: 'active', createdBy: me(req).user.id,
    });
    if (generated) pendingKeys.delete(generated);
    audit(req, 'harbor.host.create', hostEntityId(row.id), 'ok', { method: row.method, address: row.settings.address ?? row.settings.dockerUrl ?? null, hostKey: row.hostKey ? fingerprintOf(row.hostKey) : null });
    scheduler.hostsChanged();
    return { host: listing().find((h) => h.id === row.id), agentToken };
  });

  app.patch('/api/harbor/hosts/:id', {
    preHandler: admin,
    schema: { params: ID, body: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 60 }, tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 32 } }, appearance: { type: 'object' },
      settings: SETTINGS_SCHEMA, credential: CREDENTIAL_SCHEMA, hostKey: { type: 'string', maxLength: 4000 }, hostKeyConfirmed: { type: 'boolean' },
    } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const h = hm.get(id);
    if (!h || h.status === 'archived') return reply.code(404).send({ error: 'unknown server' });
    const b = req.body as { name?: string; tags?: string[]; appearance?: unknown; settings?: SettingsIn; credential?: CredentialIn; hostKey?: string; hostKeyConfirmed?: boolean };
    b.credential = resolveCredential(b.credential, me(req).user.id);
    if (b.name !== undefined && !NAME.test(b.name.trim())) return reply.code(400).send({ error: 'invalid name' });
    const tags = b.tags !== undefined ? cleanTags(b.tags) : undefined;
    if (tags === null) return reply.code(400).send({ error: 'invalid tags' });
    if (h.source === 'config' && (b.settings || b.credential || b.hostKey)) return reply.code(400).send({ error: 'connection settings of this server are defined in the config file' });
    const row = h.row ?? ensureOverlay(h.id, h.name);
    const settings = b.settings ? { ...row.settings, ...b.settings } : undefined;
    if (settings) { const p = settingsProblem(row.method, settings); if (p) return reply.code(400).send({ error: p }); }
    const cp = credentialProblem(b.credential);
    if (cp) return reply.code(400).send({ error: cp });
    if (b.hostKey && !b.hostKeyConfirmed) return reply.code(400).send({ error: 'confirm the new host key' });
    repo.hosts.update(id, {
      name: b.name?.trim(), tags: tags ?? undefined, appearance: b.appearance !== undefined ? cleanAppearance(b.appearance) : undefined, settings,
      credential: b.credential ? box.seal(JSON.stringify(b.credential), `host:${id}`) : undefined, hostKey: b.hostKey,
    });
    audit(req, 'harbor.host.update', h.entityId, 'ok', { fields: Object.keys(b), hostKey: b.hostKey ? fingerprintOf(b.hostKey) : undefined });
    scheduler.hostsChanged();
    return { host: listing().find((x) => x.id === id) };
  });

  /** Config-file hosts get an overlay row for Harbor-managed extras (name, tags, appearance, agent, suspension). */
  function ensureOverlay(id: string, name: string): HostRow {
    return repo.hosts.get(id) ?? repo.hosts.create({ id, name, tags: [], method: 'manual', settings: {}, credential: null, hostKey: null, agentTokenHash: null, appearance: {}, status: 'active', createdBy: null });
  }

  app.post('/api/harbor/hosts/:id/agent-token', { preHandler: admin, schema: { params: ID } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const h = hm.get(id);
    if (!h || h.status === 'archived') return reply.code(404).send({ error: 'unknown server' });
    ensureOverlay(id, h.name);
    const token = randomToken(32);
    repo.hosts.update(id, { agentTokenHash: sha256(token) });
    audit(req, 'harbor.agent_token', h.entityId, 'ok');
    scheduler.hostsChanged();
    return { token };
  });

  app.post('/api/harbor/hosts/:id/discover', { preHandler: auth.require('operator'), schema: { params: ID } }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const h = hm.get(id);
    const p = me(req);
    if (!h || h.status !== 'active' || !auth.canHost(p, h.entityId)) return reply.code(404).send({ error: 'unknown or inactive server' });
    scheduler.hostsChanged();
    const r = h.method === 'ssh' ? await hm.collect(hm.get(id)!) : { ok: true };
    audit(req, 'harbor.discover', h.entityId, r.ok ? 'ok' : `failed: ${(r as { error?: string }).error}`);
    return r;
  });

  app.post('/api/harbor/hosts/:id/suspend', {
    preHandler: admin, schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['suspend'], properties: { suspend: { type: 'boolean' } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const h = hm.get(id);
    if (!h || h.status === 'archived') return reply.code(404).send({ error: 'unknown server' });
    const suspend = (req.body as { suspend: boolean }).suspend;
    ensureOverlay(id, h.name);
    repo.hosts.update(id, { status: suspend ? 'suspended' : 'active' });
    if (suspend) world.suspendHost(h.entityId, me(req).user.username);
    audit(req, suspend ? 'harbor.suspend' : 'harbor.resume', h.entityId, 'ok');
    scheduler.hostsChanged();
    return { host: listing().find((x) => x.id === id) };
  });

  app.post('/api/harbor/hosts/:id/archive', {
    preHandler: admin, schema: { params: ID, body: { type: 'object', additionalProperties: false, required: ['confirm'], properties: { confirm: { type: 'string', maxLength: 64 } } } },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const h = hm.get(id);
    if (!h || h.status === 'archived') return reply.code(404).send({ error: 'unknown server' });
    if (h.source === 'config') return reply.code(400).send({ error: 'this server is defined in the config file; remove it there (suspending is possible here)' });
    if ((req.body as { confirm: string }).confirm !== id) return reply.code(400).send({ error: 'type the server id to confirm' });
    repo.hosts.update(id, { status: 'archived', archivedAt: repo.now(), credential: null, agentTokenHash: null });
    scheduler.hostsChanged();
    const n = world.archiveHost(h.entityId, me(req).user.username);
    audit(req, 'harbor.archive', h.entityId, 'ok', { entities: n, credentialDeleted: true });
    return { ok: true, archivedEntities: n };
  });

  app.get('/api/harbor/agent-script', { preHandler: admin }, async () => ({ script: AGENT_SH, units: AGENT_UNITS }));

  // ---------------------------------------------------------------- agent push (per-host token, no session)

  const agentRow = (req: FastifyRequest): HostRow | null => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ') || h.length > 200) return null;
    const hash = sha256(h.slice(7));
    const row = repo.hosts.byAgentToken(hash);
    return row?.agentTokenHash && safeEqual(row.agentTokenHash, hash) ? row : null;
  };

  // Raw collector output as text/plain (the agent never builds JSON in shell).
  app.post('/api/agent/report', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    if (!agentLimiter.allow(`agent:${req.ip}`)) return reply.code(429).send({ error: 'rate limited' });
    const row = agentRow(req);
    if (!row) return reply.code(401).send({ error: 'unknown agent token' });
    const body = req.body as unknown;
    const output = typeof body === 'string' ? body : typeof (body as { output?: unknown })?.output === 'string' ? (body as { output: string }).output : null;
    if (output === null) return reply.code(400).send({ error: 'expected collector output as text/plain' });
    try { return await hm.agentReport(row, { output }); } catch (err) { return reply.code(500).send({ error: redactError(err, 160) }); }
  });

  // Docker's /containers/json array, forwarded verbatim; X-Docker-Error when the agent could not reach Docker.
  app.post('/api/agent/containers', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    if (!agentLimiter.allow(`agent:${req.ip}`)) return reply.code(429).send({ error: 'rate limited' });
    const row = agentRow(req);
    if (!row) return reply.code(401).send({ error: 'unknown agent token' });
    const err = req.headers['x-docker-error'];
    if (!Array.isArray(req.body)) return reply.code(400).send({ error: 'expected a JSON array' });
    try { return await hm.agentReport(row, { containers: err ? undefined : (req.body as unknown[]), dockerError: err ? String(err).slice(0, 200) : null }); } catch (e) { return reply.code(500).send({ error: redactError(e, 160) }); }
  });

  // ---------------------------------------------------------------- metrics (any signed-in user with access)

  app.get('/api/entities/:id/metrics', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', maxLength: 300 } } }, querystring: { type: 'object', properties: { metric: { type: 'string', maxLength: 120 }, range: { type: 'string', enum: ['1h', '6h', '24h', '7d', '30d', '90d'] } } } },
  }, async (req, reply) => {
    const e = repo.getEntity((req.params as { id: string }).id);
    if (!e || !auth.canSee(auth.principal(req), e)) return reply.code(404).send({ error: 'unknown entity' });
    const q = req.query as { metric?: string; range?: string };
    const names = repo.hosts.metricNames(e.id);
    if (!q.metric) return { metrics: names };
    if (!names.includes(q.metric)) return { metric: q.metric, resolution: 'raw', source: null, points: [] };
    const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }[q.range ?? '24h'] ?? 24;
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    return repo.hosts.series(e.id, q.metric, since, hours <= 24 ? 'raw' : 'hourly');
  });
}
