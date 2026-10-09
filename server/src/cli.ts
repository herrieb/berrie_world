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
    default:
      fail('commands: list-users | reset-password <username> | disable-mfa <username>');
  }
} finally {
  repo.close();
}
