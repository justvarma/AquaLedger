// Demo of why the readings are anchored on-chain: quietly edit one reading in the off-chain DB
// (what a dishonest admin might try), then run the integrity check and watch it fail.
//
//   node src/tamperDemo.js <wallet> [MODULE] [YYYYMM]          inflate one pushed reading by 50
//   node src/tamperDemo.js --undo <wallet> [MODULE] [YYYYMM]   restore the original value
import { db, residentByWallet, getState, setState } from "./db.js";
import { normalizeModuleKey, currentMonth } from "./modules.js";

const argv = process.argv.slice(2);
const undo = argv[0] === "--undo";
if (undo) argv.shift();
const [wallet, mod = "WATER", month = currentMonth()] = argv;
if (!wallet) {
  console.log("Usage: node src/tamperDemo.js [--undo] <wallet> [MODULE] [YYYYMM]");
  process.exit(1);
}
const res = residentByWallet(wallet);
if (!res) throw new Error("unknown resident");
const row = db
  .prepare(
    "SELECT id, value FROM meter_readings WHERE resident_id = ? AND module = ? AND month = ? AND batch_id IS NOT NULL ORDER BY id LIMIT 1"
  )
  .get(res.id, normalizeModuleKey(mod), Number(month));
if (!row) throw new Error("no pushed readings for that resident/module/month yet");
const key = `tamper:${row.id}`;
if (undo) {
  const original = getState(key);
  if (original === null) throw new Error("nothing to undo for that reading");
  db.prepare("UPDATE meter_readings SET value = ? WHERE id = ?").run(Number(original), row.id);
  db.prepare("DELETE FROM sync_state WHERE key = ?").run(key);
  console.log(`reading #${row.id}: restored to ${original}`);
} else {
  if (getState(key) === null) setState(key, row.value);
  db.prepare("UPDATE meter_readings SET value = value + 50 WHERE id = ?").run(row.id);
  console.log(`reading #${row.id}: ${row.value} -> ${row.value + 50}`);
}
console.log(`Now open the dashboard (Admin > Integrity) or GET /api/verify?wallet=${wallet}&module=${mod}&month=${month}`);
