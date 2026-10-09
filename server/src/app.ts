import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { Repo } from './db/repo.js';
import { World } from './core/world.js';
import { Scheduler } from './core/scheduler.js';
import { DemoAdapter } from './adapters/demo.js';
import { Auth } from './api/auth.js';
import { registerRoutes } from './api/routes.js';
import { registerAccountRoutes } from './api/accountRoutes.js';
import { SecretBox } from './core/secrets.js';

export interface App {
  http: FastifyInstance;
  repo: Repo;
  world: World;
  box: SecretBox;
  scheduler: Scheduler;
  close: () => Promise<void>;
}

/** Container id of this process when running in Docker, so it can refuse to act on itself. */
function selfContainerId(): string | null {
  try {
    if (!existsSync('/.dockerenv')) return null;
    const m = /([0-9a-f]{64})/.exec(readFileSync('/proc/self/mountinfo', 'utf8'));
    return m?.[1] ?? process.env.HOSTNAME ?? null;
  } catch {
    return process.env.HOSTNAME ?? null;
  }
}

export async function buildApp(cfg: AppConfig, opts: { clock?: () => Date; startScheduler?: boolean; logger?: boolean } = {}): Promise<App> {
  const repo = new Repo(cfg.dbPath, cfg.mode, opts.clock);
  const world = new World(repo, { removal: cfg.removal, unknownAfterInventoryFailures: cfg.unknownAfterInventoryFailures });
  const http = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: process.env.TRUST_PROXY === 'true',
    bodyLimit: 64 * 1024,
  });
  const scheduler = new Scheduler(cfg, world, {
    log: (msg, extra) => http.log.warn(extra ?? {}, msg),
  }, cfg.mode === 'demo' ? new DemoAdapter() : null);
  const auth = new Auth(cfg, repo);
  const box = new SecretBox(cfg.masterKey ?? undefined, cfg.dataDir);
  const knownHosts = () => repo.listEntities().filter((e) => e.kind === 'host').map((e) => e.id).sort();

  await http.register(cookie);
  await http.register(websocket, { options: { maxPayload: 4096 } });
  http.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    return payload;
  });
  // CSRF defence in depth (cookies are already SameSite=Strict): state-changing requests from a browser
  // must come from our own origin.
  http.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (agents, ingest, curl) authenticate with bearer tokens
    const host = (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-host']) || req.headers.host;
    try {
      if (new URL(origin).host !== host) return reply.code(403).send({ error: 'cross-origin request refused' });
    } catch {
      return reply.code(403).send({ error: 'cross-origin request refused' });
    }
  });
  await registerAccountRoutes(http, { cfg, repo, auth, box, knownHosts });
  await registerRoutes(http, { cfg, world, scheduler, auth, selfContainerId: selfContainerId() });

  if (cfg.webDist && existsSync(cfg.webDist)) {
    await http.register(fastifyStatic, { root: cfg.webDist, wildcard: false });
    http.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  if (opts.startScheduler !== false) scheduler.start();

  return {
    http, repo, world, scheduler, box,
    close: async () => {
      scheduler.stop();
      await http.close();
      repo.close();
    },
  };
}
