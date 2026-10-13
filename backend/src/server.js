// AquaLedger off-chain API. Plain node:http (no Express) so the only dependency is ethers.
//
//   npm start                      -> API on http://localhost:4000
//   Readings come in from the simulator / dataset importer via POST /api/readings.
//   The dashboard reads history and charts from here, and bills/balances straight from the chain.
import http from "node:http";
import { ethers } from "ethers";
import { config } from "./config.js";
import { db, residentByWallet, upsertResident } from "./db.js";
import { MODULES, MODULE_BY_KEY, normalizeModuleKey, monthOf, currentMonth } from "./modules.js";
import {
  deployment,
  provider,
  registry,
  escrow,
  oracleAddress,
  pushPendingUsage,
  closeMonth,
  settleAll,
  syncEvents,
  syncModuleConfig,
  verifyIntegrity,
} from "./chain.js";

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": config.corsOrigin,
    "access-control-allow-headers": "content-type, x-api-key, x-aqua-address, x-aqua-timestamp, x-aqua-signature",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5_000_000) throw new HttpError(413, "Body too large");
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function parseMonth(v, fallback = currentMonth()) {
  if (v === undefined || v === null || v === "") return fallback;
  const m = Number(v);
  if (!Number.isInteger(m) || m % 100 < 1 || m % 100 > 12 || m < 200001) throw new HttpError(400, `Bad month "${v}", use YYYYMM`);
  return m;
}

function parseWallet(v) {
  if (!v || !ethers.isAddress(v)) throw new HttpError(400, `Bad wallet address "${v}"`);
  return v.toLowerCase();
}

/**
 * Admin check. Two ways in:
 *  - scripts send `x-api-key: <ADMIN_API_KEY>`
 *  - the dashboard signs "AquaLedger admin request <timestamp>" with MetaMask; we check the signer is an
 *    admin in ResidentRegistry, so admin rights live on-chain, not in this server.
 */
async function requireAdmin(req) {
  if (req.headers["x-api-key"] && req.headers["x-api-key"] === config.adminApiKey) return "api-key";
  const address = req.headers["x-aqua-address"];
  const ts = Number(req.headers["x-aqua-timestamp"]);
  const sig = req.headers["x-aqua-signature"];
  if (!address || !ts || !sig) throw new HttpError(401, "Admin authentication required");
  if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) throw new HttpError(401, "Signature expired, sign again");
  let recovered;
  try {
    recovered = ethers.verifyMessage(`AquaLedger admin request ${ts}`, sig);
  } catch {
    throw new HttpError(401, "Bad signature");
  }
  if (recovered.toLowerCase() !== String(address).toLowerCase()) throw new HttpError(401, "Signature does not match address");
  if (!(await registry.isAdmin(recovered))) throw new HttpError(403, "Wallet is not an admin in ResidentRegistry");
  return recovered;
}

async function isAdminRequest(req) {
  try {
    await requireAdmin(req);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- routes

const routes = [];
const route = (method, path, handler) => routes.push({ method, path, handler });

route("GET", "/api/health", async () => {
  const block = await provider.getBlockNumber();
  return { ok: true, chainId: config.chainId, block, oracle: oracleAddress };
});

route("GET", "/api/config", async () => {
  const rows = db.prepare("SELECT * FROM module_config").all();
  const cfg = Object.fromEntries(rows.map((r) => [r.module, JSON.parse(r.rules_json)]));
  return {
    chainId: config.chainId,
    deployment,
    weiPerPaise: (await escrow.weiPerPaise()).toString(),
    modules: MODULES.map((m) => ({ ...m, keyHash: ethers.id(m.key), address: deployment[m.key], rules: cfg[m.key] || null })),
  };
});

// ---- residents
route("GET", "/api/residents", async (req) => {
  const admin = await isAdminRequest(req);
  const rows = db.prepare("SELECT * FROM residents ORDER BY unit_number").all();
  return rows.map((r) =>
    admin
      ? r
      : { id: r.id, wallet: r.wallet, unit_number: r.unit_number, active: r.active, on_chain: r.on_chain, parking_slot: r.parking_slot }
  );
});

/** Save off-chain contact info. On-chain registration itself is done by an admin wallet (dashboard or Remix). */
route("POST", "/api/residents", async (req) => {
  await requireAdmin(req);
  const body = await readJson(req);
  const wallet = parseWallet(body.wallet);
  return upsertResident({ wallet, unit_number: body.unit_number, name: body.name, phone: body.phone, email: body.email });
});

// ---- readings (data feed)
/** Body: { readings: [{ module, wallet, value, ts? , source? }, ...] }  (ts = unix ms, defaults to now) */
route("POST", "/api/readings", async (req) => {
  await requireAdmin(req);
  const body = await readJson(req);
  const list = Array.isArray(body) ? body : body.readings || [body];
  const insert = db.prepare(
    "INSERT INTO meter_readings(module, resident_id, ts, value, source, month) VALUES(?, ?, ?, ?, ?, ?)"
  );
  let accepted = 0;
  const rejected = [];
  db.exec("BEGIN");
  try {
    for (const [i, r] of list.entries()) {
      try {
        const moduleKey = normalizeModuleKey(r.module);
        const wallet = parseWallet(r.wallet);
        const value = Number(r.value);
        if (!Number.isFinite(value) || value < 0) throw new Error("value must be a non-negative number");
        const ts = r.ts ? Number(r.ts) : Date.now();
        const resident = residentByWallet(wallet);
        if (!resident) throw new Error("wallet is not a known resident (register it on-chain, then sync)");
        insert.run(moduleKey, resident.id, ts, value, r.source || "simulator", monthOf(ts));
        accepted++;
      } catch (e) {
        rejected.push({ index: i, error: e.message });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { accepted, rejected };
});

/** Raw readings (for tables) - ?wallet=&module=&month= */
route("GET", "/api/readings", async (_req, q) => {
  const wallet = parseWallet(q.get("wallet"));
  const moduleKey = normalizeModuleKey(q.get("module"));
  const month = parseMonth(q.get("month"));
  const res = residentByWallet(wallet);
  if (!res) return [];
  return db
    .prepare(
      `SELECT r.id, r.ts, r.value, r.source, r.batch_id, b.tx_hash
         FROM meter_readings r LEFT JOIN usage_batches b ON b.id = r.batch_id
        WHERE r.resident_id = ? AND r.module = ? AND r.month = ? ORDER BY r.ts DESC LIMIT 500`
    )
    .all(res.id, moduleKey, month);
});

/** Daily totals for charts - ?wallet=&module=&month= */
route("GET", "/api/usage/daily", async (_req, q) => {
  const wallet = parseWallet(q.get("wallet"));
  const moduleKey = normalizeModuleKey(q.get("module"));
  const month = parseMonth(q.get("month"));
  const res = residentByWallet(wallet);
  if (!res) return { month, days: [], total: 0, pending: 0 };
  const days = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', (ts / 1000) + 19800, 'unixepoch') AS day, SUM(value) AS total, COUNT(*) AS readings
         FROM meter_readings WHERE resident_id = ? AND module = ? AND month = ? GROUP BY day ORDER BY day`
    )
    .all(res.id, moduleKey, month);
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(value),0) AS total, COALESCE(SUM(CASE WHEN batch_id IS NULL THEN value END),0) AS pending,
              COUNT(*) AS readings
         FROM meter_readings WHERE resident_id = ? AND module = ? AND month = ?`
    )
    .get(res.id, moduleKey, month);
  return { month, unit: MODULE_BY_KEY[moduleKey].unit, days, ...agg };
});

/** Month-by-month totals across all modules for one resident (history chart) */
route("GET", "/api/usage/monthly", async (_req, q) => {
  const wallet = parseWallet(q.get("wallet"));
  const res = residentByWallet(wallet);
  if (!res) return [];
  return db
    .prepare(
      `SELECT module, month, SUM(value) AS total, COUNT(*) AS readings
         FROM meter_readings WHERE resident_id = ? GROUP BY module, month ORDER BY month`
    )
    .all(res.id);
});

// ---- bills & payments (mirrored from chain events)
route("GET", "/api/bills", async (_req, q) => {
  const wallet = q.get("wallet");
  const month = q.get("month");
  const where = [];
  const args = [];
  if (wallet) {
    const r = residentByWallet(parseWallet(wallet));
    if (!r) return [];
    where.push("b.resident_id = ?");
    args.push(r.id);
  }
  if (month) {
    where.push("b.month = ?");
    args.push(parseMonth(month));
  }
  return db
    .prepare(
      `SELECT b.*, r.wallet, r.unit_number FROM bills b JOIN residents r ON r.id = b.resident_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY b.month DESC, b.id`
    )
    .all(...args);
});

route("GET", "/api/payments", async (_req, q) => {
  const wallet = q.get("wallet");
  const r = wallet ? residentByWallet(parseWallet(wallet)) : null;
  if (wallet && !r) return [];
  return db
    .prepare(
      `SELECT p.*, res.wallet, res.unit_number FROM payments p JOIN residents res ON res.id = p.resident_id
       ${r ? "WHERE p.resident_id = ?" : ""} ORDER BY p.block_number DESC, p.log_index DESC LIMIT 300`
    )
    .all(...(r ? [r.id] : []));
});

/** Community overview for the admin dashboard */
route("GET", "/api/summary", async (_req, q) => {
  const month = parseMonth(q.get("month"));
  const byModule = db
    .prepare(
      `SELECT module, COUNT(*) AS bills, SUM(amount_paise) AS billed_paise, SUM(paid_paise) AS paid_paise
         FROM bills WHERE month = ? GROUP BY module`
    )
    .all(month);
  const readings = db
    .prepare(
      `SELECT module, COUNT(*) AS readings, SUM(CASE WHEN batch_id IS NULL THEN 1 ELSE 0 END) AS pending
         FROM meter_readings WHERE month = ? GROUP BY module`
    )
    .all(month);
  const residents = db.prepare("SELECT COUNT(*) AS n FROM residents WHERE on_chain = 1 AND active = 1").get().n;
  return { month, residents, byModule, readings };
});

// ---- integrity
route("GET", "/api/verify", async (_req, q) => {
  return verifyIntegrity(parseWallet(q.get("wallet")), normalizeModuleKey(q.get("module")), parseMonth(q.get("month")));
});

// ---- admin actions that send transactions with the oracle wallet
route("POST", "/api/admin/push", async (req) => {
  await requireAdmin(req);
  const body = await readJson(req);
  return { pushed: await pushPendingUsage({ onlyMonth: body.month ? parseMonth(body.month) : null }) };
});

route("POST", "/api/admin/close-month", async (req) => {
  await requireAdmin(req);
  const body = await readJson(req);
  return closeMonth(parseMonth(body.month));
});

route("POST", "/api/admin/settle-all", async (req) => {
  await requireAdmin(req);
  return settleAll();
});

/** Anyone may ask the indexer to catch up right away (idempotent; used by the dashboard after a tx). */
route("POST", "/api/sync", async () => syncEvents());

route("POST", "/api/admin/sync", async (req) => {
  await requireAdmin(req);
  await syncModuleConfig();
  return syncEvents();
});

// ------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  const r = routes.find((x) => x.method === req.method && x.path === url.pathname);
  if (!r) return send(res, 404, { error: `No route ${req.method} ${url.pathname}` });
  try {
    send(res, 200, await r.handler(req, url.searchParams));
  } catch (e) {
    const status = e.status || 500;
    const msg = e.shortMessage || e.reason || e.message || String(e);
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e);
    send(res, status, { error: msg });
  }
});

async function start() {
  console.log(`AquaLedger backend - chain ${config.chainId} via ${config.rpcUrl}`);
  console.log(`Oracle wallet: ${oracleAddress || "(none - read-only mode)"}`);
  if (oracleAddress && !(await registry.isAdmin(oracleAddress))) {
    console.warn(`WARNING: oracle ${oracleAddress} is not an admin in ResidentRegistry - pushes will revert.`);
    console.warn(`         Call registry.setAdmin(${oracleAddress}, true) from the owner wallet.`);
  }
  await syncModuleConfig();
  await syncEvents();
  setInterval(() => syncEvents().catch((e) => console.error("sync failed:", e.shortMessage || e.message)), config.syncIntervalMs);
  server.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`));
}

start().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
