import type { BuildingType } from '@berrie/shared';

const RULES: [RegExp, BuildingType][] = [
  [/ollama|open-?webui|llama|vllm|comfy|whisper|litellm|localai|text-generation|stable-diffusion|openlamma|\bai\b|ai[_-]chat|gpt/i, 'lab'],
  [/n8n|node-?red|huginn|activepieces|windmill|automat/i, 'workshop'],
  [/postgres|mysql|mariadb|mongo|clickhouse|influx|timescale|couch|cockroach|sqlite|\bdb\b|database/i, 'silo'],
  [/redis|memcache|valkey|keydb|dragonfly/i, 'cache'],
  [/cloudflared|traefik|caddy|haproxy|nginx-proxy-manager|\btunnel\b|envoy/i, 'gateway'],
  [/nginx-proxy|proxy|tailscale|wireguard|pihole|adguard|\bdns\b|nginx/i, 'tower'],
  [/minio|nextcloud|seafile|syncthing|filebrowser|samba|share|files?|storage|backup|restic/i, 'depot'],
  [/worker|scheduler|cron|celery|queue|sidekiq|ofelia|beat|jobs?\b/i, 'clocktower'],
  [/mail|smtp|postfix|dovecot/i, 'post'],
];

const VALID = new Set<BuildingType>(['server', 'townhall', 'house', 'lab', 'workshop', 'silo', 'tower', 'depot', 'clocktower', 'cache', 'post', 'gateway', 'port', 'shop']);

export function isBuildingType(v: unknown): v is BuildingType {
  return typeof v === 'string' && VALID.has(v as BuildingType);
}

/** Pick a building type from labels, image and names. An explicit `berrie.world.type` label wins. */
export function classify(opts: { label?: string; image?: string; names: string[]; hasHttp?: boolean }): BuildingType {
  if (isBuildingType(opts.label)) return opts.label;
  const image = (opts.image ?? '').replace(/^.*\//, '');
  // Service/container name is the strongest hint (e.g. filesharez_worker), then the image.
  for (const subject of [...opts.names, image]) {
    for (const [re, t] of RULES) if (re.test(subject)) return t;
  }
  return opts.hasHttp ? 'house' : 'shop';
}
