import type Database from 'better-sqlite3';

/** Explicit, ordered migrations. Each has a reversible `down` where practical. */
export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: `
      CREATE TABLE entities (
        id              TEXT PRIMARY KEY,           -- stable logical identity, survives container recreation
        kind            TEXT NOT NULL CHECK (kind IN ('host','project','service','endpoint')),
        name            TEXT NOT NULL,
        display_name    TEXT,                       -- user override
        building_type   TEXT NOT NULL,
        parent_id       TEXT,
        host_id         TEXT,
        origin          TEXT NOT NULL CHECK (origin IN ('live','demo')),
        source          TEXT NOT NULL,              -- adapter that owns this entity's lifecycle
        scope           TEXT NOT NULL,              -- adapter scope (e.g. docker host id)
        lifecycle       TEXT NOT NULL CHECK (lifecycle IN ('discovered','active','missing','removed','archived')),
        hostnames       TEXT NOT NULL DEFAULT '[]',
        depends_on      TEXT NOT NULL DEFAULT '[]',
        meta            TEXT NOT NULL DEFAULT '{}',
        first_seen_at   TEXT NOT NULL,
        last_seen_at    TEXT,
        missing_since   TEXT,
        missing_count   INTEGER NOT NULL DEFAULT 0,
        removed_at      TEXT,
        archived_at     TEXT,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX idx_entities_source ON entities(source, scope, lifecycle);
      CREATE INDEX idx_entities_parent ON entities(parent_id);

      CREATE TABLE entity_status (
        entity_id              TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        health                 TEXT NOT NULL DEFAULT 'unknown',
        last_known_health      TEXT,
        reason                 TEXT,
        last_check_at          TEXT,
        last_success_at        TEXT,
        last_change_at         TEXT,
        consecutive_failures   INTEGER NOT NULL DEFAULT 0,
        consecutive_successes  INTEGER NOT NULL DEFAULT 0,
        inventory_failures     INTEGER NOT NULL DEFAULT 0,
        inventory_uncertain    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE layout (
        entity_id   TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
        x           INTEGER NOT NULL,
        y           INTEGER NOT NULL,
        w           INTEGER NOT NULL,
        h           INTEGER NOT NULL,
        pinned      INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE districts (key TEXT PRIMARY KEY, idx INTEGER NOT NULL UNIQUE, ox INTEGER NOT NULL, oy INTEGER NOT NULL); -- origin persisted so layout never shifts
      CREATE TABLE blocks (
        district   TEXT NOT NULL,
        bx         INTEGER NOT NULL,
        by         INTEGER NOT NULL,
        group_key  TEXT NOT NULL,
        PRIMARY KEY (district, bx, by)
      );

      CREATE TABLE adapter_state (
        adapter           TEXT NOT NULL,
        scope             TEXT NOT NULL,
        completeness      TEXT NOT NULL,
        last_run_at       TEXT,
        last_complete_at  TEXT,
        error             TEXT,
        PRIMARY KEY (adapter, scope)
      );

      CREATE TABLE observations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        adapter       TEXT NOT NULL,
        scope         TEXT NOT NULL,
        completeness  TEXT NOT NULL,
        ts            TEXT NOT NULL,
        entity_count  INTEGER NOT NULL,
        error         TEXT
      );
      CREATE INDEX idx_observations_ts ON observations(ts);

      CREATE TABLE check_results (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_id   TEXT NOT NULL,
        check_name  TEXT NOT NULL,
        ts          TEXT NOT NULL,
        outcome     TEXT NOT NULL CHECK (outcome IN ('ok','fail','unknown')),
        latency_ms  INTEGER,
        status_code INTEGER,
        error       TEXT
      );
      CREATE INDEX idx_checks_entity ON check_results(entity_id, ts);
      CREATE INDEX idx_checks_ts ON check_results(ts);

      CREATE TABLE events (
        id                 TEXT PRIMARY KEY,
        ts                 TEXT NOT NULL,
        type               TEXT NOT NULL,
        entity_id          TEXT,
        related_entity_id  TEXT,
        severity           TEXT NOT NULL,
        source             TEXT NOT NULL,
        details            TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_ts ON events(ts);
      CREATE INDEX idx_events_entity ON events(entity_id, ts);

      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        actor      TEXT NOT NULL,
        ip         TEXT,
        action     TEXT NOT NULL,
        entity_id  TEXT,
        params     TEXT NOT NULL DEFAULT '{}',
        result     TEXT NOT NULL
      );
      CREATE INDEX idx_audit_ts ON audit_log(ts);

      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
    down: `
      DROP TABLE settings; DROP TABLE audit_log; DROP TABLE events; DROP TABLE check_results;
      DROP TABLE observations; DROP TABLE adapter_state; DROP TABLE blocks; DROP TABLE districts;
      DROP TABLE layout; DROP TABLE entity_status; DROP TABLE entities;
    `,
  },
];

export function migrate(db: Database.Database, target = MIGRATIONS.at(-1)!.version): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const current = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  if (target > current) {
    for (const m of MIGRATIONS.filter((m) => m.version > current && m.version <= target)) {
      db.transaction(() => {
        db.exec(m.up);
        db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.version, m.name, new Date().toISOString());
      })();
    }
  } else if (target < current) {
    for (const m of [...MIGRATIONS].reverse().filter((m) => m.version <= current && m.version > target)) {
      db.transaction(() => {
        db.exec(m.down);
        db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(m.version);
      })();
    }
  }
}
