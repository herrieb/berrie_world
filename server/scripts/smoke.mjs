// Start the built server (dist/main.js) with a throwaway data dir and wait until it listens.
// Catches problems unit tests cannot see, e.g. ESM/CJS interop of dependencies under plain Node.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'berrie-smoke-'));
const child = spawn(process.execPath, ['dist/main.js'], {
  env: { ...process.env, DATA_DIR: dir, CONFIG_PATH: join(dir, 'none.json'), PORT: '0', DOCKER_SOCKET: join(dir, 'no.sock'), LOG_LEVEL: 'info' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
const done = (code, msg) => { clearTimeout(timer); child.kill(); rmSync(dir, { recursive: true, force: true }); console.log(msg); process.exit(code); };
const timer = setTimeout(() => done(1, `smoke: server did not start within 15 s\n${out.slice(-2000)}`), 15_000);
for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { out += d; if (/Server listening/.test(out)) done(0, 'smoke: built server starts and listens'); });
child.on('exit', (code) => done(1, `smoke: server exited early (${code})\n${out.slice(-2000)}`));
