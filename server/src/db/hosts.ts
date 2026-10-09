import type Database from 'better-sqlite3';
import type { Biome, DiscoveryMethod, HostFacts, HostRegistration, MetricSeries } from '@berrie/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

export interface HostRow {
  id: string;
  name: string;
  tags: string[];
  method: DiscoveryMethod;
  settings: HostRegistration['settings'];
  /** Sealed credential JSON (see SecretBox). Never leaves the server. */
  credential: string | null;
  /** Pinned SSH host key, "<type> <base64>". */
  hostKey: string | null;
  agentTokenHash: string | null;
  appearance: { biome?: Biome };
  status: 'active' | 'suspended' | 'archived';
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastContactAt: string | null;
  lastError: string | null;
}

const parse = <T,>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

function toRow(r: Raw): HostRow {
  return {
    id: r.id, name: r.name, tags: parse(r.tags, []), method: r.method, settings: parse(r.settings, {}), credential: r.credential,
    hostKey: r.host_key, agentTokenHash: r.agent_token_hash, appearance: parse(r.appearance, {}), status: r.status, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at, lastContactAt: r.last_contact_at, lastError: r.last_error,
  };
}

/** Servers registered through Server Harbor, their latest facts, and their metrics. */
export class HostRegistry {
  constructor(private readonly db: Database.Database, private readonly now: () => string) {}

  list(includeArchived = false): HostRow[] {
    const sql = includeArchived ? 'SELECT * FROM hosts ORDER BY id' : "SELECT * FROM hosts WHERE status != 'archived' ORDER BY id";
    return (this.db.prepare(sql).all() as Raw[]).map(toRow);
  }
  get(id: string): HostRow | undefined {
    const r = this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
    return r ? toRow(r) : undefined;
  }
  byAgentToken(hash: string): HostRow | undefined {
    const r = this.db.prepare("SELECT * FROM hosts WHERE agent_token_hash = ? AND status != 'archived'").get(hash);
    return r ? toRow(r) : undefined;
  }
  create(h: Omit<HostRow, 'createdAt' | 'updatedAt' | 'archivedAt' | 'lastContactAt' | 'lastError'>): HostRow {
    const now = this.now();
    this.db.prepare(`INSERT INTO hosts (id, name, tags, method, settings, credential, host_key, agent_token_hash, appearance, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(h.id, h.name, JSON.stringify(h.tags), h.method, JSON.stringify(h.settings), h.credential, h.hostKey,
      h.agentTokenHash, JSON.stringify(h.appearance), h.status, h.createdBy, now, now);
    return this.get(h.id)!;
  }
  update(id: string, patch: Partial<Omit<HostRow, 'id' | 'createdAt'>>): void {
    const map: Record<string, string> = {
      name: 'name', tags: 'tags', method: 'method', settings: 'settings', credential: 'credential', hostKey: 'host_key', agentTokenHash: 'agent_token_hash',
      appearance: 'appearance', status: 'status', archivedAt: 'archived_at', lastContactAt: 'last_contact_at', lastError: 'last_error',
    };
    const json = new Set(['tags', 'settings', 'appearance']);
    const keys = Object.keys(patch).filter((k) => k in map && (patch as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return;
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return json.has(k) ? JSON.stringify(v) : v; });
    this.db.prepare(`UPDATE hosts SET ${keys.map((k) => `${map[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
  }

  // ---------- facts ----------
  getFacts(hostId: string): HostFacts | null {
    const r = this.db.prepare('SELECT facts FROM host_facts WHERE host_id = ?').get(hostId) as Raw;
    return r ? parse<HostFacts | null>(r.facts, null) : null;
  }
  setFacts(hostId: string, facts: HostFacts): void {
    this.db.prepare('INSERT INTO host_facts (host_id, facts, updated_at) VALUES (?,?,?) ON CONFLICT(host_id) DO UPDATE SET facts = excluded.facts, updated_at = excluded.updated_at')
      .run(hostId, JSON.stringify(facts), this.now());
  }

  // ---------- metrics ----------
  /** Store real samples. Each sample carries its source; an hourly rollup is maintained alongside. */
  insertMetrics(entityId: string, source: string, ts: string, samples: { metric: string; value: number }[]): void {
    const ins = this.db.prepare('INSERT OR REPLACE INTO metrics (entity_id, metric, ts, value, source) VALUES (?,?,?,?,?)');
    const roll = this.db.prepare(`INSERT INTO metrics_hourly (entity_id, metric, hour, n, sum, min, max) VALUES (?,?,?,1,?,?,?)
      ON CONFLICT(entity_id, metric, hour) DO UPDATE SET n = n + 1, sum = sum + excluded.sum, min = MIN(min, excluded.min), max = MAX(max, excluded.max)`);
    const hour = `${ts.slice(0, 13)}:00:00.000Z`;
    this.db.transaction(() => {
      for (const s of samples) {
        if (!Number.isFinite(s.value)) continue; // never store NaN/Infinity as a measurement
        ins.run(entityId, s.metric, ts, s.value, source);
        roll.run(entityId, s.metric, hour, s.value, s.value, s.value);
      }
    })();
  }

  metricNames(entityId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT metric FROM metrics_hourly WHERE entity_id = ? ORDER BY metric').all(entityId) as Raw[]).map((r) => r.metric);
  }

  series(entityId: string, metric: string, sinceIso: string, resolution: 'raw' | 'hourly'): MetricSeries {
    if (resolution === 'raw') {
      const rows = this.db.prepare('SELECT ts, value, source FROM metrics WHERE entity_id = ? AND metric = ? AND ts >= ? ORDER BY ts').all(entityId, metric, sinceIso) as Raw[];
      return { metric, resolution, source: rows.at(-1)?.source ?? null, points: rows.map((r) => ({ ts: r.ts, value: r.value })) };
    }
    const rows = this.db.prepare('SELECT hour, n, sum, min, max FROM metrics_hourly WHERE entity_id = ? AND metric = ? AND hour >= ? ORDER BY hour').all(entityId, metric, sinceIso) as Raw[];
    const src = this.db.prepare('SELECT source FROM metrics WHERE entity_id = ? AND metric = ? ORDER BY ts DESC LIMIT 1').get(entityId, metric) as Raw;
    return { metric, resolution, source: src?.source ?? null, points: rows.map((r) => ({ ts: r.hour, value: Math.round((r.sum / r.n) * 100) / 100, min: r.min, max: r.max })) };
  }

  pruneMetrics(rawBefore: string, hourlyBefore: string): { raw: number; hourly: number } {
    return {
      raw: this.db.prepare('DELETE FROM metrics WHERE ts < ?').run(rawBefore).changes,
      hourly: this.db.prepare('DELETE FROM metrics_hourly WHERE hour < ?').run(hourlyBefore).changes,
    };
  }
}
