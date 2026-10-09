import type Database from 'better-sqlite3';

/** Explicit, ordered migrations. Each has a reversible `down` where practical. */
export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
  /** Table rebuilds must run with foreign keys disabled (SQLite ignores the pragma inside a transaction). */
  foreignKeysOff?: boolean;
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
  {
    version: 2,
    name: 'users, sessions and personal state',
    up: `
      CREATE TABLE users (
        id                   TEXT PRIMARY KEY,
        username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name         TEXT NOT NULL,
        email                TEXT,
        password_hash        TEXT,                    -- scrypt; NULL once deleted
        role                 TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
        host_scope           TEXT NOT NULL DEFAULT 'all' CHECK (host_scope IN ('all','list')),
        totp_secret          TEXT,                    -- encrypted with the master key
        totp_enabled         INTEGER NOT NULL DEFAULT 0,
        totp_last_step       INTEGER,                 -- replay protection
        avatar               TEXT,                    -- JSON {seed,color,style}; generated pixel art, no uploads
        status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deleted')),
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        last_login_at        TEXT,
        password_changed_at  TEXT
      );
      CREATE TABLE user_hosts (
        user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        host_id  TEXT NOT NULL,                       -- host entity id, e.g. host:srv01
        PRIMARY KEY (user_id, host_id)
      );
      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,               -- sha256 of the cookie token; the token itself is never stored
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    TEXT NOT NULL,
        expires_at    TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        ip            TEXT,
        user_agent    TEXT,
        mfa_pending   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);
      CREATE TABLE invitations (
        id          TEXT PRIMARY KEY,
        token_hash  TEXT NOT NULL UNIQUE,
        role        TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
        host_scope  TEXT NOT NULL DEFAULT 'all',
        hosts       TEXT NOT NULL DEFAULT '[]',
        email       TEXT,
        note        TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT,
        used_by     TEXT,
        revoked_at  TEXT
      );
      CREATE TABLE password_resets (
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT
      );
      -- Personal state. Deleted with the user; shared infrastructure history never references these.
      CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, prefs TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE favorites (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entity_id   TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, entity_id)
      );
      CREATE TABLE saved_views (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        view        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE user_tasks (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        notes       TEXT,
        entity_id   TEXT,
        due_at      TEXT,
        done_at     TEXT,
        created_at  TEXT NOT NULL
      );
      ALTER TABLE audit_log ADD COLUMN user_id TEXT;
    `,
    down: `
      ALTER TABLE audit_log DROP COLUMN user_id;
      DROP TABLE user_tasks; DROP TABLE saved_views; DROP TABLE favorites; DROP TABLE user_prefs;
      DROP TABLE password_resets; DROP TABLE invitations; DROP TABLE sessions; DROP TABLE user_hosts; DROP TABLE users;
    `,
  },
  {
    version: 3,
    name: 'server harbor, host facts and metrics',
    up: `
      -- Servers registered through Server Harbor (servers from the config file are not stored here).
      CREATE TABLE hosts (
        id                 TEXT PRIMARY KEY,          -- slug; the host entity is host:<id>
        name               TEXT NOT NULL,
        tags               TEXT NOT NULL DEFAULT '[]',
        method             TEXT NOT NULL CHECK (method IN ('ssh','agent','docker','manual')),
        settings           TEXT NOT NULL DEFAULT '{}', -- non-secret connection settings
        credential         TEXT,                       -- sealed with the master key; never returned by the API
        host_key           TEXT,                       -- pinned SSH host key ("<type> <base64>"), confirmed by an admin
        agent_token_hash   TEXT,
        appearance         TEXT NOT NULL DEFAULT '{}',
        status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
        created_by         TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        archived_at        TEXT,
        last_contact_at    TEXT,
        last_error         TEXT
      );
      -- Latest collected facts per host, per category, with status/source/timestamp.
      CREATE TABLE host_facts (host_id TEXT PRIMARY KEY, facts TEXT NOT NULL, updated_at TEXT NOT NULL);
      -- Raw samples (short retention) and hourly rollups (long retention). Every sample has a source.
      CREATE TABLE metrics (
        entity_id  TEXT NOT NULL,
        metric     TEXT NOT NULL,
        ts         TEXT NOT NULL,
        value      REAL NOT NULL,
        source     TEXT NOT NULL,
        PRIMARY KEY (entity_id, metric, ts)
      ) WITHOUT ROWID;
      CREATE INDEX idx_metrics_ts ON metrics(ts);
      CREATE TABLE metrics_hourly (
        entity_id  TEXT NOT NULL,
        metric     TEXT NOT NULL,
        hour       TEXT NOT NULL,
        n          INTEGER NOT NULL,
        sum        REAL NOT NULL,
        min        REAL NOT NULL,
        max        REAL NOT NULL,
        PRIMARY KEY (entity_id, metric, hour)
      ) WITHOUT ROWID;
    `,
    down: `
      DROP TABLE metrics_hourly; DROP TABLE metrics; DROP TABLE host_facts; DROP TABLE hosts;
    `,
  },
  {
    version: 4,
    name: 'topology: gateways, external services and connections',
    foreignKeysOff: true,
    up: `
      -- Rebuild entities to allow the new kinds (SQLite cannot alter a CHECK constraint in place).
      CREATE TABLE entities_v4 (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('host','project','service','endpoint','gateway','external')),
        name TEXT NOT NULL, display_name TEXT, building_type TEXT NOT NULL, parent_id TEXT, host_id TEXT,
        origin TEXT NOT NULL CHECK (origin IN ('live','demo')), source TEXT NOT NULL, scope TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('discovered','active','missing','removed','archived')),
        hostnames TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT NOT NULL, last_seen_at TEXT, missing_since TEXT, missing_count INTEGER NOT NULL DEFAULT 0,
        removed_at TEXT, archived_at TEXT, updated_at TEXT NOT NULL
      );
      INSERT INTO entities_v4 SELECT id, kind, name, display_name, building_type, parent_id, host_id, origin, source, scope, lifecycle,
        hostnames, depends_on, meta, first_seen_at, last_seen_at, missing_since, missing_count, removed_at, archived_at, updated_at FROM entities;
      DROP TABLE entities;
      ALTER TABLE entities_v4 RENAME TO entities;
      CREATE INDEX idx_entities_source ON entities(source, scope, lifecycle);
      CREATE INDEX idx_entities_parent ON entities(parent_id);

      -- Relationships as first-class, persistent records with their own lifecycle and evidence.
      CREATE TABLE connections (
        id                TEXT PRIMARY KEY,           -- stable: conn:<type>:<a>><b>
        src               TEXT NOT NULL,
        dst               TEXT NOT NULL,
        type              TEXT NOT NULL,              -- lan|vpn|direct|internet|tunnel|proxy|dependency|database|api
        source            TEXT NOT NULL,              -- what reported it: compose, tailscale, gateway, config, ingest
        scope             TEXT NOT NULL,
        verification      TEXT NOT NULL CHECK (verification IN ('verified','configured','observed','inferred','unverified')),
        lifecycle         TEXT NOT NULL CHECK (lifecycle IN ('discovered','active','missing','removed','archived')),
        health            TEXT NOT NULL DEFAULT 'unknown',
        reason            TEXT,
        evidence          TEXT NOT NULL DEFAULT '[]',
        meta              TEXT NOT NULL DEFAULT '{}', -- measured only: latencyMs, lossPct, measuredAt, direct, relay, bytes
        first_seen_at     TEXT NOT NULL,
        last_seen_at      TEXT,
        last_activity_at  TEXT,
        missing_since     TEXT,
        missing_count     INTEGER NOT NULL DEFAULT 0,
        removed_at        TEXT,
        archived_at       TEXT,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX idx_connections_src ON connections(src);
      CREATE INDEX idx_connections_dst ON connections(dst);
      CREATE INDEX idx_connections_source ON connections(source, scope, lifecycle);
    `,
    down: `
      DROP TABLE connections;
      DELETE FROM entities WHERE kind IN ('gateway','external');
    `,
  },
  {
    version: 5,
    name: 'incidents, acknowledgements, maintenance and notifications',
    up: `
      CREATE TABLE incidents (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('open','monitoring','resolved')),
        severity             TEXT NOT NULL,
        root_entity_id       TEXT,                 -- where it started (not a verified cause)
        hypothesis           TEXT,                 -- suggested cause, always labelled a hypothesis unless verified
        hypothesis_entity_id TEXT,
        hypothesis_verified  INTEGER NOT NULL DEFAULT 0,
        assignee             TEXT,                 -- user id
        created_by           TEXT NOT NULL,        -- 'system' or a user id
        opened_at            TEXT NOT NULL,
        recovered_at         TEXT,
        resolved_at          TEXT,
        resolved_by          TEXT,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX idx_incidents_status ON incidents(status, opened_at);
      CREATE TABLE incident_entities (
        incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        entity_id    TEXT NOT NULL,
        role         TEXT NOT NULL CHECK (role IN ('affected','suspected','impact')),
        added_at     TEXT NOT NULL,
        PRIMARY KEY (incident_id, entity_id)
      );
      CREATE INDEX idx_incident_entities_entity ON incident_entities(entity_id);
      CREATE TABLE incident_timeline (
        id           TEXT PRIMARY KEY,
        incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        ts           TEXT NOT NULL,
        kind         TEXT NOT NULL,
        actor        TEXT NOT NULL,                -- 'system' or a username (kept even if the user is removed)
        user_id      TEXT,
        text         TEXT NOT NULL,
        data         TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_incident_timeline ON incident_timeline(incident_id, ts);
      -- Acknowledging an alert applies to one specific state change (entity + since), so a new failure alerts again.
      CREATE TABLE alert_acks (
        entity_id  TEXT NOT NULL,
        since      TEXT NOT NULL,
        actor      TEXT NOT NULL,
        user_id    TEXT,
        ts         TEXT NOT NULL,
        note       TEXT,
        PRIMARY KEY (entity_id, since)
      );
      CREATE TABLE maintenance (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL,
        description   TEXT,
        entity_ids    TEXT NOT NULL,               -- JSON; a host id covers everything on that host
        starts_at     TEXT NOT NULL,
        ends_at       TEXT NOT NULL,
        suppress      INTEGER NOT NULL DEFAULT 1,  -- suppress incidents/notifications; raw health is never hidden
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        cancelled_at  TEXT
      );
      CREATE TABLE notifications (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ts           TEXT NOT NULL,
        severity     TEXT NOT NULL,
        title        TEXT NOT NULL,
        text         TEXT,
        entity_id    TEXT,
        incident_id  TEXT,
        read_at      TEXT
      );
      CREATE INDEX idx_notifications_user ON notifications(user_id, ts);
    `,
    down: `
      DROP TABLE notifications; DROP TABLE maintenance; DROP TABLE alert_acks;
      DROP TABLE incident_timeline; DROP TABLE incident_entities; DROP TABLE incidents;
    `,
  },
];

export function migrate(db: Database.Database, target = MIGRATIONS.at(-1)!.version): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const current = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  if (target > current) {
    for (const m of MIGRATIONS.filter((m) => m.version > current && m.version <= target)) {
      if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(m.up);
          if (m.foreignKeysOff) {
            const broken = db.prepare('PRAGMA foreign_key_check').all();
            if (broken.length) throw new Error(`migration ${m.version} left ${broken.length} broken foreign keys`);
          }
          db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.version, m.name, new Date().toISOString());
        })();
      } finally {
        if (m.foreignKeysOff) db.pragma('foreign_keys = ON');
      }
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
