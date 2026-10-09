import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
const app = await buildApp(cfg);

if (cfg.bindHost !== '127.0.0.1' && cfg.bindHost !== 'localhost' && !cfg.adminToken) {
  app.http.log.warn('listening on a non-loopback interface without ADMIN_TOKEN: the world is read-only and admin features are disabled');
}
if (cfg.mode === 'demo') app.http.log.warn('DEMO MODE: showing fixture data from a separate demo database, not real infrastructure');

await app.http.listen({ port: cfg.port, host: cfg.bindHost });

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    app.http.log.info({ sig }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try { await app.close(); } finally { process.exit(0); }
  });
}
