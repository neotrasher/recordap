import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    -- The reminder rule (master record)
    CREATE TABLE IF NOT EXISTS reminders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_slack_id  TEXT NOT NULL,
      title             TEXT NOT NULL,
      description       TEXT,
      channel_id        TEXT NOT NULL,
      assignees         TEXT NOT NULL DEFAULT '[]',
      groups            TEXT NOT NULL DEFAULT '[]',
      rotation_mode     TEXT NOT NULL DEFAULT 'all',
      rotation_index    INTEGER NOT NULL DEFAULT 0,

      timezone          TEXT NOT NULL,
      hour              INTEGER NOT NULL,
      minute            INTEGER NOT NULL,
      recurrence        TEXT NOT NULL DEFAULT 'none',
      recurrence_data   TEXT,
      ends_mode         TEXT NOT NULL DEFAULT 'never',
      ends_data         TEXT,

      reminder_type     TEXT NOT NULL DEFAULT 'task',
      reping_every      TEXT NOT NULL DEFAULT '30m',
      max_pings         TEXT NOT NULL DEFAULT '5',

      notify_channel    INTEGER NOT NULL DEFAULT 1,
      notify_dm         INTEGER NOT NULL DEFAULT 1,
      notify_only_turn  INTEGER NOT NULL DEFAULT 0,

      allow_done        INTEGER NOT NULL DEFAULT 1,
      allow_snooze      INTEGER NOT NULL DEFAULT 1,
      allow_reassign    INTEGER NOT NULL DEFAULT 1,
      snooze_presets    TEXT NOT NULL DEFAULT '["15m","1h","tomorrow_9"]',

      status            TEXT NOT NULL DEFAULT 'active',
      next_fire_at      TEXT,
      fires_count       INTEGER NOT NULL DEFAULT 0,

      escalate_to       TEXT,   -- slack user id a quien avisar si el fire expira sin Done

      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rem_next ON reminders(next_fire_at)
      WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_rem_creator ON reminders(creator_slack_id, status);
    CREATE INDEX IF NOT EXISTS idx_rem_channel ON reminders(channel_id, status);

    -- Each concrete fire instance
    CREATE TABLE IF NOT EXISTS reminder_fires (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id       INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      scheduled_for     TEXT NOT NULL,
      fired_at          TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      done_by_slack_id  TEXT,
      done_at           TEXT,
      ping_count        INTEGER NOT NULL DEFAULT 1,
      next_reping_at    TEXT,
      channel_id        TEXT,
      channel_ts        TEXT,
      assigned_to_slack_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fires_reping
      ON reminder_fires(next_reping_at) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS idx_fires_reminder
      ON reminder_fires(reminder_id, fired_at);

    -- DM copies per person (each has its own ack state)
    CREATE TABLE IF NOT EXISTS reminder_dms (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      fire_id         INTEGER NOT NULL REFERENCES reminder_fires(id) ON DELETE CASCADE,
      slack_user_id   TEXT NOT NULL,
      dm_channel      TEXT NOT NULL,
      dm_ts           TEXT NOT NULL,
      acked_at        TEXT,
      ack_action      TEXT,
      UNIQUE(fire_id, slack_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dms_user ON reminder_dms(slack_user_id, acked_at);

    -- Audit log of state changes (useful for "Editado/Pausado por @x")
    CREATE TABLE IF NOT EXISTS reminder_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id   INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      actor_slack_id TEXT NOT NULL,
      action        TEXT NOT NULL,  -- 'created' | 'edited' | 'paused' | 'resumed' | 'cancelled' | 'reassigned' | 'fired' | 'done' | 'snoozed' | 'expired'
      detail        TEXT,           -- JSON with action-specific payload
      ts            TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_reminder ON reminder_events(reminder_id, ts);
  `);

  // ── Migraciones incrementales para DBs que ya existían ────────────────────
  // CREATE TABLE IF NOT EXISTS no agrega columnas nuevas a una tabla existente.
  // addColumnIfMissing es idempotente: solo aplica el ALTER si la columna falta.
  addColumnIfMissing('reminders', 'escalate_to', 'TEXT');
}

/**
 * Agrega una columna a una tabla si todavía no existe. Seguro de correr en
 * cada arranque (no falla si la columna ya está).
 */
function addColumnIfMissing(table: string, column: string, typeDecl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeDecl}`);
    console.log(`[migrate] added column ${table}.${column}`);
  }
}

if (require.main === module) {
  migrate();
  console.log(`migrated → ${config.dbPath}`);
}
