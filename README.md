# Berrie World

An interactive isometric pixel-art village generated from real infrastructure. Every building is a real host, container,
manually configured service, or public endpoint. Health and existence are tracked separately: **a service that goes
down stays in the village; it disappears only after its removal has been positively confirmed.**

```
browser ──HTTP/WS──▶ berrie-world (Fastify + SQLite + scheduler) ──HTTP──▶ docker-socket-proxy (read-only) ──▶ /var/run/docker.sock
                         │                                     └──▶ HTTP/TCP probes, DNS lookups (hints)
                         └── ./data/berrie.sqlite  (entities, layout, events, checks, audit)
```

- `shared/` – domain types shared by server and web (lifecycle, health, events, snapshot).
- `server/` – Node 22 / TypeScript, Fastify, better-sqlite3, WebSocket. Discovery adapters, reconciler, monitor, API.
- `web/` – React + Vite + PixiJS 8. All art is generated procedurally in code; there are no external assets.

## Lifecycle vs. health

| Lifecycle | Meaning |
|---|---|
| `discovered` | First seen (shown with scaffolding) |
| `active` | Seen in at least two inventories |
| `missing` | Absent from a **complete** inventory; awaiting confirmation |
| `removed` | Absent from ≥ `removal.confirmations` complete inventories **and** for ≥ `minMissingSeconds` (shown as ruins) |
| `archived` | `archiveAfterHours` after removal; leaves the map, kept in history |

Health (`healthy`, `degraded`, `unhealthy`, `unreachable`, `starting`, `restarting`, `host_offline`, `unknown`) never
changes lifecycle. Every adapter reports `complete` / `incomplete` / `unavailable`. Only `complete` inventories are evidence
of absence. When Docker is unreachable, services keep their place, are flagged *stale* and turn `unknown` after
`unknownAfterInventoryFailures`, with the last known health preserved. A host outage (host probe failing) shows on every child
as inherited *host offline* without overwriting the child's own state.

Identity is stable across container recreation: `berrie.world.id` label → `docker:<host>:<compose project>/<service>` →
`docker:<host>:name/<container name>`. Container IDs are metadata only; a changed ID emits `deployment.changed`.

## Running locally

```bash
npm install
cp config/berrie.config.example.json config/berrie.config.json   # edit; drop "hosts" to use the local socket
npm run dev:server     # http://127.0.0.1:4780 (API), uses ./data and ./config
npm run dev:web        # http://127.0.0.1:5180 (proxies /api and /ws)
npm test               # lifecycle test suite (vitest)
```

Demo mode runs scripted fixtures against a **separate** database (`berrie-demo.sqlite`); the live database refuses demo
entities and vice versa. Use `DEMO_MODE=1 PORT=4781 DATA_DIR=./data/demo npx tsx server/src/main.ts` and
`API_URL=http://127.0.0.1:4781 npx vite --port 5181` (inside `web/`).

Deep links: `/#/e/<entity id>` selects a building; `/?view=services|events|alerts|settings` opens a view.

## Accounts and permissions

Everyone signs in with a personal account. On first start nobody exists yet: the web UI asks for the bootstrap token
(`ADMIN_TOKEN`) to create the first administrator; after that the token is not a credential anymore.

| Role | Can |
|---|---|
| viewer | see the world, events and history for the servers they have access to |
| operator | viewer + view logs, rename/arrange buildings, run allowlisted container actions (if enabled) |
| admin | everything, including people, invitations, the audit log and (later) Server Harbor; always all servers |

- Per-server access: each non-admin user has access to *all servers* or a selected list. Every REST endpoint and every
  WebSocket message is filtered server-side; hidden entities answer like unknown ones (404).
- Passwords are hashed with scrypt; sessions are random tokens stored only as SHA-256 hashes, with an absolute lifetime
  (`SESSION_DAYS`) and idle timeout (`SESSION_IDLE_HOURS`), revocable per device.
- Optional TOTP two-factor (RFC 6238) with replay protection; seeds are encrypted with `BERRIE_MASTER_KEY`.
- Invitations and password-reset links are one-time, expiring links created by administrators (no email needed).
- Removing a person deletes their personal state (preferences, favorites, saved views, tasks, sessions); events,
  audit entries and other shared history stay intact.
- Personal (per-user, never shared): camera, island arrangement, favorites, saved views, tasks, notification settings.
- Recovery from a shell: `docker exec berrie-world node server/dist/cli.js list-users | reset-password <user> | disable-mfa <user> | cleanup-build-steps`.

## Islands and Server Harbor

Every server is its own persistent island (origins are assigned once on a grid and never move). Servers come from the
config file or are registered at runtime in **Server Harbor** (admins), with one of these discovery methods:

| Method | What it collects | Access needed |
|---|---|---|
| SSH | host facts via one fixed read-only collector; optionally containers through a forwarded Docker socket or a read-only socket proxy on the server | a dedicated user; key restricted in `authorized_keys` |
| Agent | the same collector, pushed every minute by a POSIX shell script (`curl` only) with a per-host token; optionally containers via a local read-only proxy | none inbound |
| Docker API | containers from a read-only docker-socket-proxy URL | network access to the proxy |
| Manual | nothing (optional TCP reachability probe) | none |

- SSH host keys are fetched, shown as a fingerprint and must be confirmed by an admin before the first connection;
  they are pinned and a mismatch refuses the connection. There is no "skip host-key check".
- Harbor can generate a dedicated ed25519 key per server (only the public key is shown) or accept a pasted key or
  password. Credentials are sealed with `BERRIE_MASTER_KEY` (AES-256-GCM), never returned by the API or logged, and
  deleted when a server is archived.
- Every new server is tested first: the preview lists exactly which facts and containers would be imported.
- Suspend stops monitoring (state becomes *unknown*, nothing is removed). Archive (type the id to confirm) is the
  explicit evidence that removes a whole server from the map; its history stays in the archive.
- Config-file servers can get Harbor extras (name, tags, biome, an agent, suspension); their connection stays in the file.

### Host facts and metrics

Each category (hostname, OS, CPU, memory, storage, network, uptime/load, containers) carries a status:
`confirmed`, `stale` (shown with its age), `unavailable` (a collector tried and failed, with the reason),
`unconfigured` (nothing collects it) or `unknown` (no result yet). Values are never shown, charted or used for visuals
unless collected. Docker-only servers know memory *size* but not usage, and say so.

Samples are stored with their source and timestamp (`metrics`, raw for `retention.metricRawDays`, default 7) plus
hourly min/avg/max rollups (`retention.metricHourlyDays`, default 365). Charts appear only with enough samples and show
gaps instead of interpolating. Island visuals: server tower height follows the *confirmed* CPU count (a neutral tower
when unknown); a pressure marker appears for collected memory/disk ≥ 90 %, CPU ≥ 95 % or load ≥ 2× cores.

Agent install (shown in Harbor with the token): an unprivileged `berrie-agent` user, `/usr/local/bin/berrie-agent`,
a 0600 `/etc/berrie-agent.env`, and a systemd timer (hardened unit: `NoNewPrivileges`, `ProtectSystem=strict`).

## Topology: bridges, ferries, gateways

Relationships are stored as first-class connections (own lifecycle, evidence, history) and reconciled like entities:
only complete reports from their source can make one *missing*, and removal needs repeated confirmation.

| Drawn as | Type | Source | Verification |
|---|---|---|---|
| Bridge between islands | `vpn` (also `lan`, `direct`) | `tailscale status` reported by a host's collector (SSH/agent) | verified |
| Ferry on a sea lane | `internet` (Cloudflare edge → tunnel gateway) | `gateways` in config; verified when a collector sees `cloudflared` running | verified / configured |
| Gatehouse building | gateway (`proxy` hops to services) | `gateways[].routes` matched against public endpoints | configured |
| Lines on selection | `dependency` / `database` | Compose `depends_on` | configured |
| Lines on selection | `api` | traffic reported through the ingest API | observed |
| Dashed / translucent | anything not verified | config `connections`, observed traffic | configured / observed |
| Port on the external island | external service | `externals` in config, the Cloudflare edge | — |

Nothing is inferred from reachability: two servers that can talk to each other get no bridge unless a source reports
the relationship. A failing gateway turns its routes red and marks dependent endpoints as *likely affected* — their own
health stays what their own checks say.

The inspector's **Dependencies** tab has a route explorer (public hostname → edge → gateway → application, each hop with
its verification), upstream/downstream lists with evidence, and **impact analysis**: *confirmed* (own checks failing),
*likely* (reached via verified/configured links), *unknown* (via unverified links) and *verified fine*. **Simulate
failure** runs the same analysis as a pure calculation and never touches infrastructure. Suspected causes are always
labelled as hypotheses. Click a bridge or ferry to inspect it (evidence, configured vs. observed, measured values only).

```json
"gateways": [{ "id": "cloudflared", "name": "Cloudflare Tunnel", "host": "srv01", "kind": "cloudflare-tunnel", "routes": ["*.example.com"] }],
"externals": [{ "id": "openai", "name": "OpenAI API", "hostnames": ["api.openai.com"] }],
"connections": [{ "from": "srv01", "to": "nas", "type": "lan", "description": "same switch" }]
```

## Operations: incidents, maintenance, notifications

- **Incidents** open automatically from real failures (service unhealthy/unreachable, host offline). Failures on the same
  host, or connected through known dependencies, are grouped into one incident (one notification per person). A
  suggested cause is computed from the dependency graph and always labelled **hypothesis — not verified** until an
  operator confirms or rejects it. When everything recovers the incident moves to *recovered — awaiting confirmation*;
  a person confirms recovery to resolve it; a regression reopens it. Notes, acknowledgements, assignment and status
  changes form an audited timeline that survives user removal.
- **Replay** shows the recorded states of an incident's entities on the map with a time scrubber (no interpolation).
- **Alerts** can be acknowledged per state change (a new failure alerts again).
- **Maintenance windows** (hosts cover everything on them) suppress incidents and notifications during planned work —
  raw health stays visible and maintenance is marked on the map and in alerts.
- **Notifications** are personal (Account → Notifications): in-app, optional browser notifications, minimum severity,
  favorites only; only for servers the person may see.
- **Failure simulation** (Dependencies tab) never executes anything on real infrastructure.

Extra metrics (`metrics` in the config file): endpoint response time from the regular checks, TLS certificate expiry of
public hostnames (`tlsIntervalHours`, default 12 — alerts below 14 days), container CPU/memory from Docker stats
(`containerIntervalSeconds`, default 300, 0 disables). A failed sample is absent, never stored as zero.

## Configuration

Environment (see `.env.example`): `ADMIN_TOKEN` (bootstrap), `BERRIE_MASTER_KEY`, `SESSION_DAYS`, `SESSION_IDLE_HOURS`,
`INGEST_TOKEN`, `ENABLE_ACTIONS`, `SECURE_COOKIES`, `TRUST_PROXY`, `PORT`, `BIND_HOST`, `DATA_DIR`, `CONFIG_PATH`,
`DOCKER_PROXY_URL` / `DOCKER_SOCKET`, `HOST_ID`, `HOST_NAME`, `DISCOVERY_INTERVAL`, `DEMO_MODE`.

`config/berrie.config.json` (see the example) holds hosts, host reachability probes, manual services with HTTP/TCP checks,
endpoints (hostname → `compose:<project>/<service>` | `container:<name>` | entity id), optional cloudflared
`tunnelConfigPaths` (ingress rules are read, never modified), hostname `hints`, `protected` services, a network `canary`,
removal timings and retention.

Hostname hints are **not** buildings. A hint becomes an endpoint only when matched through config, the
`berrie.world.hostnames` container label, or tunnel ingress. DNS resolution is shown only as a hint.

Container labels: `berrie.world.id`, `berrie.world.name`, `berrie.world.type` (`house|lab|workshop|silo|tower|depot|clocktower|cache|post|shop`),
`berrie.world.hostnames` (comma-separated), `berrie.world.hide=true`, `berrie.world.oneshot=true` (exit 0 is healthy),
`berrie.world.protect=true` (never controllable).

### Real activity (optional)

Couriers and vehicles are only drawn for stored events. Docker start/stop/redeploy events come from the Docker event stream.
Other systems can report events with the ingest token. For example, an n8n workflow can do this:

```bash
curl -X POST https://<world>/api/ingest/events -H "Authorization: Bearer $INGEST_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"automation.executed","entity":"n8n.berrie.uk","related":"docker:srv01:filesharez/app","details":{"workflow":"Daily report"}}'
```

Allowed types: `http.request`, `automation.executed`, `ai.request_started`, `ai.request_completed`, `task.executed`,
`alert`. Unknown entities are rejected, never created.

## Deployment (Docker Compose)

```bash
cp .env.example .env            # set ADMIN_TOKEN (long random), keep ENABLE_ACTIONS=false at first
cp config/berrie.config.example.json config/berrie.config.json
DOCKER_BUILDKIT=1 docker compose up -d --build   # BuildKit: no temporary build-step containers
curl -s http://127.0.0.1:4780/api/health
```

- The app binds to `127.0.0.1:${BERRIE_PORT:-4780}` only. The Docker socket is reached through `tecnativa/docker-socket-proxy`
  on an `internal` network with GET-only access to containers, events, info, ping and version. Exec, images, volumes,
  networks, secrets, build and auth stay denied.
- Operations: set `ENABLE_ACTIONS=true` **and** `PROXY_ALLOW_POST=1`. Actions are limited to start/stop/restart of
  Docker services, require an operator or admin with access to that server, a confirmation that echoes the entity id,
  a per-user rate limit and a 30 s timeout, and are audited. Containers marked protected (including Berrie World and its proxy) are never controllable.
- Limits: app `mem_limit 256m`, `cpus 0.5`, read-only root filesystem; proxy `64m`. Measured locally: ~34 MiB / ~1.4% CPU idle.
- Public access: every page requires sign-in. Behind a tunnel/proxy set `SECURE_COOKIES=true` and `TRUST_PROXY=true`;
  Cloudflare Access in front adds a second layer. No DNS/tunnel changes are made by this project.

### Backup and restore

The database is `./data/berrie.sqlite` (WAL mode). Online backup (safe while running):

```bash
docker exec berrie-world node -e "require('better-sqlite3')('/data/berrie.sqlite',{readonly:true}).backup('/data/backup-'+new Date().toISOString().slice(0,10)+'.sqlite').then(()=>console.log('ok'))"
```

Restore: `docker compose stop berrie-world`, replace `data/berrie.sqlite` with the backup and remove any
`berrie.sqlite-wal`/`-shm` files, then run `docker compose start berrie-world`. Layout, history and archive come back intact.
Encrypted values (TOTP seeds, stored credentials) need the same master key: back up `BERRIE_MASTER_KEY` (or
`data/master.key`) separately and securely — without it those values cannot be decrypted.

### Retention

Hourly pruning: check results and observations `retention.checkResultDays` (7), events `eventDays` (90), audit `auditDays` (365),
archived entities `archivedEntityDays` (null = keep forever).

## Database

`server/src/db/migrations.ts` holds explicit, ordered migrations with `down` scripts, tracked in `schema_migrations`.
Once a version is deployed, migrations are **append-only**: never edit an applied migration; add a new one. Tables:
`entities`, `entity_status`, `layout`, `districts` (persisted origins), `blocks`, `adapter_state`, `observations`,
`check_results`, `events`, `audit_log`, `settings`. Timestamps are ISO-8601 UTC.

## Layout

Each host gets a district whose origin is persisted. Compose projects claim 7×7 city blocks (roads on the block edges) in
a deterministic spiral around the host's server building. Services fill 2×2 lots in their project's blocks. Placement
never moves existing buildings, never overlaps (including across districts), and survives restarts. Admins can drag
buildings in the layout editor; moved buildings are pinned.
