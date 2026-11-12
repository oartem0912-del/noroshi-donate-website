import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { now, safeJson } from './util.js';

let db;
const cache = new Map();

const MIGRATIONS = [
  // v1 — основная схема
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE owners (
    email TEXT PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('primary','secondary')),
    added_at INTEGER NOT NULL, verified_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('owner','player')),
    email TEXT, mc_uuid TEXT, mc_name TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_exp ON sessions(expires_at);
  CREATE TABLE login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE confirmations (
    id TEXT PRIMARY KEY, action TEXT NOT NULL, payload TEXT NOT NULL, code_hash TEXT NOT NULL,
    requested_by TEXT NOT NULL, sent_to TEXT NOT NULL, expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );
  CREATE TABLE mc_accounts (uuid TEXT PRIMARY KEY, name TEXT NOT NULL, linked_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE link_requests (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('link','unlink')),
    nickname TEXT, mc_uuid TEXT, code_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_link_code ON link_requests(code_hash, status);
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    name TEXT NOT NULL, short_description TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
    price_kop INTEGER NOT NULL CHECK (price_kop > 0), active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
    delivery TEXT NOT NULL DEFAULT '{"commands":[],"requireOnline":true}',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE orders (
    id TEXT PRIMARY KEY, session_id TEXT, mc_uuid TEXT NOT NULL, mc_name TEXT NOT NULL,
    product_id INTEGER, product_name TEXT NOT NULL, price_kop INTEGER NOT NULL,
    provider TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, rate REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','cancelled','refunded','failed')),
    test INTEGER NOT NULL DEFAULT 0,
    fee_minor INTEGER NOT NULL DEFAULT 0, fee_kop INTEGER NOT NULL DEFAULT 0, net_kop INTEGER NOT NULL DEFAULT 0,
    provider_payment_id TEXT, paytype TEXT,
    delivery_commands TEXT NOT NULL DEFAULT '[]', require_online INTEGER NOT NULL DEFAULT 1,
    delivery_status TEXT NOT NULL DEFAULT 'none' CHECK (delivery_status IN ('none','queued','delivering','delivered','failed')),
    delivery_attempt INTEGER NOT NULL DEFAULT 1, delivery_lease_until INTEGER, delivery_message TEXT, delivered_at INTEGER,
    created_at INTEGER NOT NULL, paid_at INTEGER, refunded_at INTEGER, updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_orders_status ON orders(status, paid_at);
  CREATE INDEX idx_orders_delivery ON orders(delivery_status);
  CREATE TABLE payment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, event_id TEXT NOT NULL, order_id TEXT, kind TEXT NOT NULL,
    payload TEXT, created_at INTEGER NOT NULL, UNIQUE(provider, event_id)
  );
  CREATE TABLE pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]', draft_blocks TEXT, published INTEGER NOT NULL DEFAULT 0,
    show_in_nav INTEGER NOT NULL DEFAULT 0, nav_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  );
  CREATE TABLE servers (name TEXT PRIMARY KEY, version TEXT, online INTEGER, max_players INTEGER, players TEXT, last_seen INTEGER NOT NULL);
  CREATE TABLE rates (currency TEXT PRIMARY KEY, uah_per_unit REAL NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, amount_kop INTEGER NOT NULL, paid_at INTEGER NOT NULL, note TEXT);
  CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, ctx TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX idx_logs_time ON logs(created_at);
  `,
];

export function openDb(file) {
  const dbPath = file || path.join(config.dataDir, 'noroshi.sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  cache.clear();
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

export const raw = () => db;
export function closeDb() { try { db?.close(); } catch { /* уже закрыта */ } db = undefined; cache.clear(); }

function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const norm = (p) => p.map((x) => (x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x));

export const q = {
  get: (sql, ...p) => stmt(sql).get(...norm(p)),
  all: (sql, ...p) => stmt(sql).all(...norm(p)),
  run: (sql, ...p) => stmt(sql).run(...norm(p)),
};

/** Транзакция (синхронная; node:sqlite однопоточный, поэтому BEGIN IMMEDIATE безопасен). */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---- настройки ----
export const getSetting = (key, fallback) => {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? safeJson(row.value, fallback) : fallback;
};
export const setSetting = (key, value) => q.run(
  'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

// ---- журнал ----
export function log(level, source, message, ctx) {
  try { q.run('INSERT INTO logs(level,source,message,ctx,created_at) VALUES(?,?,?,?,?)', level, source, String(message).slice(0, 500), ctx ? JSON.stringify(ctx).slice(0, 2000) : null, now()); } catch { /* журнал не должен ронять запрос */ }
  if (level === 'error') console.error(`[${source}] ${message}`, ctx || '');
}

export const DEFAULT_SETTINGS = {
  siteName: 'Noroshi',
  tagline: 'Ванильный Minecraft-сервер',
  serverAddress: 'play.noroshi.example',
  banner: '',
  logo: '',
  accent: '#14b8a6',
  discord: '',
  footerText: '© Noroshi. Сайт не связан с Mojang и Microsoft.',
  currencies: ['UAH', 'EUR', 'USD'],
  providers: { liqpay: true, test: true },
  manualRates: {},
  nav: [],
};

export function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k, DEFAULT_SETTINGS[k]);
  return out;
}
