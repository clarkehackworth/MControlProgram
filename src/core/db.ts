import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type Row = Record<string, any>;

let db: Database.Database | undefined;
const defer: (() => void)[] = [];

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(path.join(config.dataDir, 'mcontrolprogram.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  for (const f of defer) f();
  return db;
}

function migrate(db: Database.Database) {
  // ponytail: additive column migrations; ALTER fails harmlessly when the column exists
  const addCol = (sql: string) => { try { db.exec(sql); } catch { /* exists */ } };
  defer.push(() => addCol("ALTER TABLE plugin_instances ADD COLUMN approval TEXT NOT NULL DEFAULT '{\"mode\":\"none\"}'"));
  // approvals asked by plugins (feature-level asks), not just the core tool gate
  for (const c of ["plugin_id TEXT NOT NULL DEFAULT ''", "feature TEXT NOT NULL DEFAULT 'tool'", "summary TEXT NOT NULL DEFAULT ''", "reason TEXT NOT NULL DEFAULT ''", 'subject TEXT'])
    defer.push(() => addCol(`ALTER TABLE approvals ADD COLUMN ${c}`));
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      host TEXT NOT NULL DEFAULT '127.0.0.1', port INTEGER NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      auth_mode TEXT NOT NULL DEFAULT 'bearer',       -- none | bearer | oauth | both
      log_level TEXT NOT NULL DEFAULT 'tools',        -- off | connections | tools | full
      public_url TEXT,                                -- OAuth issuer base (defaults to http://host:port)
      instructions TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS plugin_instances (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      plugin_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS plugin_config (
      plugin_id TEXT PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}', updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bearer_tokens (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')), last_used_at TEXT, expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      client_secret TEXT, info TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY, client_id TEXT NOT NULL, server_id TEXT NOT NULL,
      code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '',
      resource TEXT, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, -- access | refresh
      client_id TEXT NOT NULL, server_id TEXT NOT NULL, scopes TEXT NOT NULL DEFAULT '',
      resource TEXT, expires_at INTEGER, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL, instance_id TEXT NOT NULL, instance_name TEXT NOT NULL, tool TEXT NOT NULL,
      principal TEXT NOT NULL, session_id TEXT, args TEXT NOT NULL, key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 1, decided_by TEXT,
      created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS approvals_key ON approvals(key, status);
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      level TEXT NOT NULL, category TEXT NOT NULL, server_id TEXT, plugin_instance_id TEXT,
      session_id TEXT, message TEXT NOT NULL, data TEXT
    );
    CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
    CREATE INDEX IF NOT EXISTS logs_server ON logs(server_id, ts);
  `);
}

export const setting = {
  get(key: string): string | undefined {
    return (getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined)?.value;
  },
  set(key: string, value: string) {
    getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  },
};
