// Recovery commands for administrators with shell access to the server (e.g. `docker exec berrie-world node server/dist/cli.js ...`).
// Prints one-time links; never prints stored secrets.
import { loadConfig } from './config.js';
import { Repo } from './db/repo.js';
import { randomToken, sha256 } from './core/secrets.js';

const [cmd, username] = process.argv.slice(2);
const cfg = loadConfig();
const repo = new Repo(cfg.dbPath, cfg.mode);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

try {
  switch (cmd) {
    case 'list-users':
      for (const u of repo.users.list()) console.log(`${u.username}\t${u.role}\t${u.status}\tmfa=${u.totpEnabled ? 'on' : 'off'}\thosts=${u.hostScope === 'all' ? 'all' : u.hosts.join(',')}`);
      break;
    case 'reset-password': {
      const u = username ? repo.users.byUsername(username) : undefined;
      if (!u) fail('usage: cli.js reset-password <username>');
      const token = randomToken(24);
      repo.users.createReset(sha256(token), u.id, 'cli', new Date(Date.now() + 3600_000).toISOString());
      repo.audit({ actor: 'cli', ip: null, action: 'password.reset_link', entityId: null, params: { target: u.username }, result: 'ok' });
      console.log(`One-time reset link (valid 1 hour): <your Berrie World URL>/#/reset/${token}`);
      break;
    }
    case 'disable-mfa': {
      const u = username ? repo.users.byUsername(username) : undefined;
      if (!u) fail('usage: cli.js disable-mfa <username>');
      repo.users.update(u.id, { totpEnabled: false, totpSecret: null, totpLastStep: null });
      repo.users.deleteSessionsFor(u.id);
      repo.audit({ actor: 'cli', ip: null, action: 'mfa.reset', entityId: null, params: { target: u.username }, result: 'ok' });
      console.log(`Two-factor authentication disabled for ${u.username}; their sessions were ended.`);
      break;
    }
    case 'cleanup-build-steps': {
      // Entities recorded from temporary image-build containers (before they were ignored) and their incidents.
      const isStep = (meta: Record<string, unknown>) => /^sha256:[0-9a-f]{12,}$/.test(String(meta.image ?? '')) && !meta.composeProject;
      const steps = repo.listEntities(true).filter((e) => e.kind === 'service' && e.source === 'docker' && isStep(e.meta));
      const ids = new Set(steps.map((e) => e.id));
      const now = repo.now();
      let closed = 0;
      repo.tx(() => {
        for (const i of repo.ops.incidents({ status: ['open', 'monitoring'] })) {
          const ents = repo.ops.incidentEntities(i.id);
          if (!ents.length || !ents.every((x) => ids.has(x.entityId))) continue;
          repo.ops.updateIncident(i.id, { status: 'resolved', resolvedAt: now, resolvedBy: 'cli' });
          repo.ops.addTimeline(i.id, 'resolved', 'cli', null, 'Closed: this was a temporary container of a Docker image build, not a service');
          closed++;
        }
        for (const e of steps) {
          if (e.lifecycle !== 'archived') repo.updateEntity(e.id, { lifecycle: 'archived', removedAt: e.removedAt ?? now, archivedAt: now });
          repo.deleteLayout(e.id);
        }
      });
      repo.audit({ actor: 'cli', ip: null, action: 'cleanup.build_steps', entityId: null, params: { entities: steps.length, incidents: closed }, result: 'ok' });
      console.log(`Archived ${steps.length} build-step entr${steps.length === 1 ? 'y' : 'ies'} and resolved ${closed} incident(s).`);
      break;
    }
    default:
      fail('commands: list-users | reset-password <username> | disable-mfa <username> | cleanup-build-steps');
  }
} finally {
  repo.close();
}
