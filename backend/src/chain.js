// Everything that talks to the blockchain: pushing usage, closing a month, indexing events, integrity checks.
import { ethers } from "ethers";
import { config, loadDeployment, loadAbi } from "./config.js";
import { db, tx, getState, setState, residentByWallet, upsertResident } from "./db.js";
import { MODULES, MODULE_BY_KEY } from "./modules.js";

export const deployment = loadDeployment();
export const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
provider.pollingInterval = config.chainId === 31337 ? 500 : 4000;

let signer = null;
if (config.oraclePrivateKey) {
  signer = new ethers.NonceManager(new ethers.Wallet(config.oraclePrivateKey, provider));
}
export const oracleAddress = config.oraclePrivateKey ? new ethers.Wallet(config.oraclePrivateKey).address : null;

const runner = signer || provider;
export const registry = new ethers.Contract(deployment.ResidentRegistry, loadAbi("ResidentRegistry"), runner);
export const escrow = new ethers.Contract(deployment.CommunityEscrow, loadAbi("CommunityEscrow"), runner);
export const modules = Object.fromEntries(
  MODULES.map((m) => [m.key, new ethers.Contract(deployment[m.key], loadAbi(m.contract), runner)])
);

const moduleKeyHashToKey = Object.fromEntries(MODULES.map((m) => [ethers.id(m.key), m.key]));
const BATCH_SIZE = 40; // residents per transaction

function requireSigner() {
  if (!signer) throw new Error("ORACLE_PRIVATE_KEY is not set in backend/.env - cannot send transactions.");
}

// ---------------------------------------------------------------- hashing

/** Canonical hash of a group of readings. Anyone with the DB rows can recompute it. */
export function hashReadings(rows) {
  const canonical = JSON.stringify(rows.map((r) => [Number(r.id), Number(r.ts), Number(r.value)]));
  return ethers.keccak256(ethers.toUtf8Bytes(canonical));
}

/** Same hash chain as BaseModule._log: dataHash = keccak256(prev, batchHash). */
export function chainHashes(batchHashes) {
  let h = ethers.ZeroHash;
  for (const b of batchHashes) h = ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [h, b]);
  return h;
}

// ------------------------------------------------------------ push usage

/**
 * Pushes every not-yet-pushed reading on-chain: groups by module + resident + month,
 * logs one batch per resident with logUsageBatch, then records the batch hash + tx hash.
 */
export async function pushPendingUsage({ onlyMonth = null } = {}) {
  requireSigner();
  const pending = db
    .prepare(
      `SELECT r.id, r.module, r.resident_id, r.ts, r.value, r.month, res.wallet
         FROM meter_readings r JOIN residents res ON res.id = r.resident_id
        WHERE r.batch_id IS NULL ${onlyMonth ? "AND r.month = ?" : ""}
        ORDER BY r.id`
    )
    .all(...(onlyMonth ? [onlyMonth] : []));

  // module -> month -> wallet -> rows
  const groups = {};
  for (const r of pending) {
    ((groups[r.module] ??= {})[r.month] ??= {})[r.wallet] ??= [];
    groups[r.module][r.month][r.wallet].push(r);
  }

  const summary = [];
  for (const [moduleKey, byMonth] of Object.entries(groups)) {
    const meta = MODULE_BY_KEY[moduleKey];
    const contract = modules[moduleKey];
    for (const [monthStr, byWallet] of Object.entries(byMonth)) {
      const month = Number(monthStr);
      const items = [];
      for (const [wallet, rows] of Object.entries(byWallet)) {
        const rec = await contract.getRecord(wallet, month);
        if (rec.billed) {
          summary.push({ module: moduleKey, month, wallet, skipped: "month already billed" });
          continue;
        }
        if (!(await registry.isActiveResident(wallet))) {
          summary.push({ module: moduleKey, month, wallet, skipped: "not an active resident on-chain" });
          continue;
        }
        const total = rows.reduce((s, r) => s + Number(r.value), 0);
        items.push({ wallet, rows, delta: BigInt(Math.round(total * meta.scale)), hash: hashReadings(rows) });
      }

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const txResp = await contract.logUsageBatch(
          month,
          chunk.map((c) => c.wallet),
          chunk.map((c) => c.delta),
          chunk.map((c) => c.hash)
        );
        const receipt = await txResp.wait();
        tx(() => {
          for (const c of chunk) {
            const residentId = c.rows[0].resident_id;
            const res = db
              .prepare(
                `INSERT INTO usage_batches(module, resident_id, month, delta, batch_hash, tx_hash, created_at)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`
              )
              .run(moduleKey, residentId, month, Number(c.delta), c.hash, receipt.hash, Date.now());
            const batchId = Number(res.lastInsertRowid);
            const upd = db.prepare("UPDATE meter_readings SET batch_id = ? WHERE id = ?");
            for (const r of c.rows) upd.run(batchId, r.id);
          }
        });
        summary.push({ module: moduleKey, month, residents: chunk.length, readings: chunk.reduce((s, c) => s + c.rows.length, 0), tx: receipt.hash });
      }
    }
  }
  return summary;
}

// ------------------------------------------------------------ close month

/** Month end: push remaining readings, then finalise the bill in every module for every active resident. */
export async function closeMonth(month) {
  requireSigner();
  const pushed = await pushPendingUsage({ onlyMonth: month });
  const residents = (await registry.getResidents()).filter(Boolean);
  const active = [];
  for (const w of residents) if (await registry.isActiveResident(w)) active.push(w);

  const finalized = [];
  for (const m of MODULES) {
    const contract = modules[m.key];
    const todo = [];
    for (const w of active) {
      const rec = await contract.getRecord(w, month);
      if (!rec.billed) todo.push(w);
    }
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const chunk = todo.slice(i, i + BATCH_SIZE);
      const txResp = await contract.finalizeBills(month, chunk);
      const receipt = await txResp.wait();
      finalized.push({ module: m.key, residents: chunk.length, tx: receipt.hash });
    }
  }
  await syncEvents();
  return { month, pushed, finalized };
}

export async function settleAll() {
  requireSigner();
  const receipt = await (await escrow.settleAll()).wait();
  await syncEvents();
  return { tx: receipt.hash };
}

// ------------------------------------------------------------ module config

export async function syncModuleConfig() {
  const read = async (c, fns) => {
    const out = {};
    for (const f of fns) out[f] = (await c[f]()).toString();
    return out;
  };
  const rulesFns = {
    WATER: ["tier1LimitLitres", "tier1RatePaise", "tier2RatePaise"],
    ELECTRICITY: ["slab1Limit", "slab2Limit", "slab1RatePaise", "slab2RatePaise", "slab3RatePaise"],
    GAS: ["ratePaisePerM3"],
    EV_CHARGING: ["ratePaisePerKWh"],
    PARKING: ["ownedSlotFeePaise", "visitorRatePaisePerHour"],
    CLUBHOUSE: ["ratePaisePerSlot", "amenityCount"],
    WASTE: ["flatFeePaise"],
    SECURITY: ["flatFeePaise"],
  };
  const stmt = db.prepare(
    `INSERT INTO module_config(module, address, unit, scale, rules_json, updated_at) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(module) DO UPDATE SET address = excluded.address, unit = excluded.unit, scale = excluded.scale,
       rules_json = excluded.rules_json, updated_at = excluded.updated_at`
  );
  for (const m of MODULES) {
    const rules = await read(modules[m.key], rulesFns[m.key]);
    stmt.run(m.key, deployment[m.key], m.unit, m.scale, JSON.stringify(rules), Date.now());
  }
}

// ------------------------------------------------------------ event indexer

const blockTimeCache = new Map();
async function blockTime(bn) {
  if (!blockTimeCache.has(bn)) {
    const b = await provider.getBlock(bn);
    blockTimeCache.set(bn, Number(b.timestamp) * 1000);
    if (blockTimeCache.size > 5000) blockTimeCache.clear();
  }
  return blockTimeCache.get(bn);
}

function residentIdFor(wallet) {
  return (residentByWallet(wallet) || upsertResident({ wallet })).id;
}

let syncing = null;
/** Reads new events from the chain and mirrors them into the off-chain DB (bills, payments, residents). */
export function syncEvents() {
  if (!syncing) syncing = doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  const latest = await provider.getBlockNumber();
  let from = Number(getState("lastSyncedBlock", Number(deployment.deployedAtBlock || 0) - 1)) + 1;
  if (from > latest) return { from, latest, events: 0 };

  const addrToContract = new Map([
    [deployment.ResidentRegistry.toLowerCase(), registry],
    [deployment.CommunityEscrow.toLowerCase(), escrow],
    ...MODULES.map((m) => [deployment[m.key].toLowerCase(), modules[m.key]]),
  ]);
  const addrToModuleKey = new Map(MODULES.map((m) => [deployment[m.key].toLowerCase(), m.key]));
  const addresses = [...addrToContract.keys()];
  let count = 0;

  while (from <= latest) {
    const to = Math.min(from + config.logChunkSize - 1, latest);
    const logs = await provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    for (const log of logs) {
      const contract = addrToContract.get(log.address.toLowerCase());
      let ev;
      try {
        ev = contract.interface.parseLog(log);
      } catch {
        continue;
      }
      if (!ev) continue;
      await applyEvent(ev, log, addrToModuleKey.get(log.address.toLowerCase()));
      count++;
    }
    setState("lastSyncedBlock", to);
    from = to + 1;
  }
  return { latest, events: count };
}

async function applyEvent(ev, log, moduleKey) {
  const a = ev.args;
  const ts = await blockTime(log.blockNumber);
  const insertPayment = db.prepare(
    `INSERT OR IGNORE INTO payments(resident_id, kind, amount_wei, amount_paise, tx_hash, log_index, block_number, ts)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  );

  switch (ev.name) {
    case "ResidentRegistered":
      upsertResident({ wallet: a.wallet, unit_number: a.unitNumber, on_chain: 1, active: 1 });
      break;
    case "ResidentStatusChanged":
      upsertResident({ wallet: a.wallet, active: a.active ? 1 : 0, on_chain: 1 });
      break;
    case "ResidentUnitChanged":
      upsertResident({ wallet: a.wallet, unit_number: a.newUnit });
      break;
    case "SlotAssigned":
      residentIdFor(a.resident);
      db.prepare("UPDATE residents SET parking_slot = ? WHERE wallet = ?").run(a.slot || null, a.resident.toLowerCase());
      break;
    case "BillAdded":
      db.prepare(
        `INSERT INTO bills(id, module, resident_id, month, amount_paise, paid_paise, status, tx_hash, created_at)
         VALUES(?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).run(
        Number(a.billId),
        moduleKeyHashToKey[a.moduleKey] || a.moduleKey,
        residentIdFor(a.resident),
        Number(a.month),
        Number(a.amountPaise),
        Number(a.amountPaise) === 0 ? "paid" : "pending",
        log.transactionHash,
        ts
      );
      break;
    case "BillFinalized":
      db.prepare("UPDATE bills SET usage = ? WHERE id = ?").run(Number(a.usage), Number(a.billId));
      break;
    case "BillPaid":
      db.prepare(
        `UPDATE bills SET paid_paise = paid_paise + ?,
           status = CASE WHEN paid_paise + ? >= amount_paise THEN 'paid' ELSE 'partial' END
         WHERE id = ?`
      ).run(Number(a.paidPaise), Number(a.paidPaise), Number(a.billId));
      break;
    case "Deposited":
      insertPayment.run(residentIdFor(a.resident), "deposit", a.amountWei.toString(), null, log.transactionHash, log.index, log.blockNumber, ts);
      break;
    case "Settled":
      if (a.paidWei > 0n)
        insertPayment.run(residentIdFor(a.resident), "settlement", a.paidWei.toString(), Number(a.paidPaise), log.transactionHash, log.index, log.blockNumber, ts);
      break;
    case "ExcessWithdrawn":
      insertPayment.run(residentIdFor(a.resident), "withdrawal", a.amountWei.toString(), null, log.transactionHash, log.index, log.blockNumber, ts);
      break;
    default:
      break; // UsageLogged etc. are read on demand
  }
}

// ------------------------------------------------------------ integrity check

/**
 * Proves the off-chain readings were not edited after being logged:
 * recompute every batch hash from the current DB rows and compare with what was anchored on-chain.
 */
export async function verifyIntegrity(wallet, moduleKey, month) {
  const resident = residentByWallet(wallet);
  if (!resident) throw new Error("Unknown resident");
  const contract = modules[moduleKey];

  const filter = contract.filters.UsageLogged(wallet, month);
  const fromBlock = Number(deployment.deployedAtBlock || 0);
  const latest = await provider.getBlockNumber();
  const onchain = [];
  for (let f = fromBlock; f <= latest; f += config.logChunkSize) {
    const evs = await contract.queryFilter(filter, f, Math.min(f + config.logChunkSize - 1, latest));
    for (const e of evs) onchain.push({ batchHash: e.args.batchHash, delta: e.args.delta.toString(), tx: e.transactionHash });
  }
  const rec = await contract.getRecord(wallet, month);
  const chainConsistent = chainHashes(onchain.map((o) => o.batchHash)) === rec.dataHash;
  const onchainHashes = new Set(onchain.map((o) => o.batchHash));

  const batches = db
    .prepare("SELECT * FROM usage_batches WHERE resident_id = ? AND module = ? AND month = ? ORDER BY id")
    .all(resident.id, moduleKey, month);
  const rowsStmt = db.prepare("SELECT id, ts, value FROM meter_readings WHERE batch_id = ? ORDER BY id");
  const results = batches.map((b) => {
    const rows = rowsStmt.all(b.id);
    const recomputed = hashReadings(rows);
    return {
      batchId: b.id,
      readings: rows.length,
      storedHash: b.batch_hash,
      recomputedHash: recomputed,
      anchoredOnChain: onchainHashes.has(recomputed),
      tx: b.tx_hash,
    };
  });
  const tampered = results.filter((r) => !r.anchoredOnChain);
  return {
    wallet,
    module: moduleKey,
    month,
    onChainUsage: rec.usage.toString(),
    onChainDataHash: rec.dataHash,
    onChainBatches: onchain.length,
    hashChainConsistent: chainConsistent,
    offChainBatches: results.length,
    tamperedBatches: tampered.length,
    ok: chainConsistent && tampered.length === 0,
    batches: results,
  };
}
