import { COLLECTOR_SH } from './collector.js';

/**
 * The push agent: a POSIX shell script with no dependencies beyond curl. It runs the same read-only collector as the
 * SSH adapter and posts the raw output (text/plain) plus, optionally, Docker's own JSON container list — so no JSON
 * is ever assembled in shell. Configuration lives in a root-owned 0600 env file.
 */
export const AGENT_SH = `#!/bin/sh
# Berrie World agent — pushes read-only host facts to Berrie World.
# Config: /etc/berrie-agent.env (chmod 600) with
#   BERRIE_URL=https://your-berrie-world
#   BERRIE_TOKEN=<agent token from Server Harbor>
#   BERRIE_DOCKER=0            # 1 = also report containers
#   BERRIE_DOCKER_URL=         # optional read-only docker-socket-proxy, e.g. http://127.0.0.1:2375 (else the unix socket)
set -u
. "\${BERRIE_ENV:-/etc/berrie-agent.env}"
collect() {
${COLLECTOR_SH}
}
post() { curl -fsS -m 20 -X POST -H "Authorization: Bearer $BERRIE_TOKEN" "$@"; }
collect 2>/dev/null | post -H 'Content-Type: text/plain' --data-binary @- "$BERRIE_URL/api/agent/report" >/dev/null || exit 1
if [ "\${BERRIE_DOCKER:-0}" = 1 ]; then
  if [ -n "\${BERRIE_DOCKER_URL:-}" ]; then J=$(curl -fsS -m 10 "$BERRIE_DOCKER_URL/containers/json?all=1" 2>/dev/null)
  else J=$(curl -fsS -m 10 --unix-socket /var/run/docker.sock "http://docker/containers/json?all=1" 2>/dev/null); fi
  if [ -n "\${J:-}" ]; then printf '%s' "$J" | post -H 'Content-Type: application/json' --data-binary @- "$BERRIE_URL/api/agent/containers" >/dev/null
  else post -H 'Content-Type: application/json' -H 'X-Docker-Error: docker API not reachable from the agent' --data-binary '[]' "$BERRIE_URL/api/agent/containers" >/dev/null; fi
fi
`;

export const AGENT_UNITS = `# /etc/systemd/system/berrie-agent.service
[Unit]
Description=Berrie World agent (one report)
After=network-online.target

[Service]
Type=oneshot
User=berrie-agent
ExecStart=/usr/local/bin/berrie-agent
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

# /etc/systemd/system/berrie-agent.timer
[Unit]
Description=Run the Berrie World agent every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
RandomizedDelaySec=5s

[Install]
WantedBy=timers.target
`;
