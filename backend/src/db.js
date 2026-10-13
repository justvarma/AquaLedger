// Off-chain database (KT section 9). Uses Node's built-in SQLite (Node 22.13+), so no native build step.
//
// residents        resident ID, wallet, unit number, contact info
// meter_readings   module, resident, timestamp, reading value (raw data never goes on-chain)
// usage_batches    groups of readings pushed on-chain together, with the hash anchored on-chain
// bills            module, resident, month, amount, status - mirrored from CommunityEscrow events
// payments         resident, escrow tx hash, amount, date - mirrored from escrow events
// module_config    module name, rate, tier/slab rules - mirrored from the module contracts
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS residents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet        TEXT NOT NULL UNIQUE,          -- lowercase 0x address
  unit_number   TEXT,
  name          TEXT,
  phone         TEXT,
  email         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  on_chain      INTEGER NOT NULL DEFAULT 0,    -- 1 once seen in ResidentRegistry
  parking_slot  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  module        TEXT NOT NULL,
  resident_id   INTEGER NOT NULL REFERENCES residents(id),
  month         INTEGER NOT NULL,
  delta         INTEGER NOT NULL,              -- on-chain units (value * scale, rounded)
  batch_hash    TEXT NOT NULL,                 -- keccak256 of the canonical readings JSON
  tx_hash       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meter_readings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  module        TEXT NOT NULL,
  resident_id   INTEGER NOT NULL REFERENCES residents(id),
  ts            INTEGER NOT NULL,              -- unix ms
  value         REAL NOT NULL,                 -- human units (L, kWh, m3, hours, count)
  source        TEXT NOT NULL DEFAULT 'simulator',
  month         INTEGER NOT NULL,
  batch_id      INTEGER REFERENCES usage_batches(id)  -- NULL = not yet pushed on-chain
);
CREATE INDEX IF NOT EXISTS idx_readings_lookup ON meter_readings(resident_id, module, month);
CREATE INDEX IF NOT EXISTS idx_readings_pending ON meter_readings(batch_id) WHERE batch_id IS NULL;

CREATE TABLE IF NOT EXISTS bills (
  id            INTEGER PRIMARY KEY,           -- = billId in CommunityEscrow
  module        TEXT NOT NULL,
  resident_id   INTEGER NOT NULL REFERENCES residents(id),
  month         INTEGER NOT NULL,
  usage         INTEGER,                       -- on-chain units
  amount_paise  INTEGER NOT NULL,
  paid_paise    INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | partial | paid
  tx_hash       TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resident_id   INTEGER NOT NULL REFERENCES residents(id),
  kind          TEXT NOT NULL,                 -- deposit | settlement | withdrawal
  amount_wei    TEXT NOT NULL,
  amount_paise  INTEGER,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  block_number  INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  UNIQUE(tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS module_config (
  module        TEXT PRIMARY KEY,
  address       TEXT NOT NULL,
  unit          TEXT NOT NULL,
  scale         INTEGER NOT NULL,
  rules_json    TEXT NOT NULL,                 -- rates / tiers / slabs read from the contract
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
`);

export function getState(key, fallback = null) {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setState(key, value) {
  db.prepare("INSERT INTO sync_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    String(value)
  );
}

export function residentByWallet(wallet) {
  return db.prepare("SELECT * FROM residents WHERE wallet = ?").get(String(wallet).toLowerCase());
}

export function upsertResident({ wallet, unit_number, name, phone, email, on_chain, active }) {
  const w = String(wallet).toLowerCase();
  const existing = residentByWallet(w);
  if (existing) {
    db.prepare(
      `UPDATE residents SET
         unit_number = COALESCE(?, unit_number), name = COALESCE(?, name), phone = COALESCE(?, phone),
         email = COALESCE(?, email), on_chain = COALESCE(?, on_chain), active = COALESCE(?, active)
       WHERE wallet = ?`
    ).run(unit_number ?? null, name ?? null, phone ?? null, email ?? null, on_chain ?? null, active ?? null, w);
  } else {
    db.prepare(
      `INSERT INTO residents(wallet, unit_number, name, phone, email, on_chain, active, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(w, unit_number ?? null, name ?? null, phone ?? null, email ?? null, on_chain ?? 0, active ?? 1, Date.now());
  }
  return residentByWallet(w);
}

/** Wraps fn in a transaction. */
export function tx(fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
