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

## Configuration

Environment (see `.env.example`): `ADMIN_TOKEN`, `INGEST_TOKEN`, `ENABLE_ACTIONS`, `REQUIRE_AUTH_FOR_VIEW`,
`SECURE_COOKIES`, `TRUST_PROXY`, `PORT`, `BIND_HOST`, `DATA_DIR`, `CONFIG_PATH`, `DOCKER_PROXY_URL` / `DOCKER_SOCKET`,
`HOST_ID`, `HOST_NAME`, `DISCOVERY_INTERVAL`, `DEMO_MODE`.

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
docker compose up -d --build
curl -s http://127.0.0.1:4780/api/health
```

- The app binds to `127.0.0.1:${BERRIE_PORT:-4780}` only. The Docker socket is reached through `tecnativa/docker-socket-proxy`
  on an `internal` network with GET-only access to containers, events, info, ping and version. Exec, images, volumes,
  networks, secrets, build and auth stay denied.
- Operations: set `ENABLE_ACTIONS=true` **and** `PROXY_ALLOW_POST=1`. Actions are limited to start/stop/restart of
  Docker services, require an admin session, a confirmation that echoes the entity id, a rate limit, and are
  audited. Containers marked protected (including Berrie World and its proxy) are never controllable.
- Limits: app `mem_limit 256m`, `cpus 0.5`, read-only root filesystem; proxy `64m`. Measured locally: ~34 MiB / ~1.4% CPU idle.
- Public access: do **not** expose without authentication. Recommended: a Cloudflare Tunnel public hostname protected by
  Cloudflare Access, plus `REQUIRE_AUTH_FOR_VIEW=true`, `SECURE_COOKIES=true`, `TRUST_PROXY=true`. No DNS/tunnel changes
  are made by this project.

### Backup and restore

The database is `./data/berrie.sqlite` (WAL mode). Online backup (safe while running):

```bash
docker exec berrie-world node -e "require('better-sqlite3')('/data/berrie.sqlite',{readonly:true}).backup('/data/backup-'+new Date().toISOString().slice(0,10)+'.sqlite').then(()=>console.log('ok'))"
```

Restore: `docker compose stop berrie-world`, replace `data/berrie.sqlite` with the backup and remove any
`berrie.sqlite-wal`/`-shm` files, then run `docker compose start berrie-world`. Layout, history and archive come back intact.

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
