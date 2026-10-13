// Load a real dataset (electricity / EV charging CSVs, etc.) into the off-chain DB through the API.
//
// The CSV needs a timestamp column and a value column. Map them with flags:
//
//   node src/importCsv.js --file data/ev_sessions.csv --module EV_CHARGING \
//        --wallet 0xabc...            (all rows belong to one resident)   OR  --wallet-column unit_wallet
//        --ts-column start_time --value-column kwh_delivered
//        [--ts-format iso|unix|unixms]  [--multiply 1]  [--shift-to-month 202610]  [--limit 5000]
//
// --multiply converts units (e.g. Wh -> kWh: --multiply 0.001).
// --shift-to-month moves old dataset dates into a chosen billing month so it lines up with the demo
// (keeps day-of-month and time-of-day).
//
// Datasets that work well (download them yourself):
//   - UCI "Individual household electric power consumption"  (Global_active_power, 1-min readings)
//   - ACN-Data / Caltech EV charging sessions, or any public EV-session CSV (kWhDelivered per session)
import fs from "node:fs";
import { config } from "./config.js";
import { normalizeModuleKey } from "./modules.js";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i];
}
const API = args.api || `http://localhost:${config.port}`;
const KEY = args.key || config.adminApiKey;

if (!args.file || !args.module || !(args.wallet || args["wallet-column"]) || !args["ts-column"] || !args["value-column"]) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 18).join("\n"));
  process.exit(1);
}

const moduleKey = normalizeModuleKey(args.module);
const sep = args.sep || (args.file.endsWith(".txt") ? ";" : ",");
const multiply = Number(args.multiply || 1);
const limit = Number(args.limit || Infinity);

function splitLine(line) {
  // handles simple quoted fields
  const out = [];
  let cur = "";
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === sep && !q) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseTs(v) {
  const fmt = args["ts-format"] || "iso";
  if (fmt === "unix") return Number(v) * 1000;
  if (fmt === "unixms") return Number(v);
  // UCI uses "16/12/2006" + separate Time column - pass --time-column Time
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) {
    const [d, m, y] = v.split("/").map(Number);
    return Date.UTC(y, m - 1, d) - 5.5 * 3600 * 1000;
  }
  return Date.parse(v);
}

const lines = fs.readFileSync(args.file, "utf8").split(/\r?\n/).filter(Boolean);
const header = splitLine(lines[0]);
const col = (name) => {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`Column "${name}" not found. Columns: ${header.join(", ")}`);
  return i;
};
const tsI = col(args["ts-column"]);
const valI = col(args["value-column"]);
const timeI = args["time-column"] ? col(args["time-column"]) : -1;
const walletI = args["wallet-column"] ? col(args["wallet-column"]) : -1;

let shiftMs = 0;
const readings = [];
for (const line of lines.slice(1)) {
  if (readings.length >= limit) break;
  const f = splitLine(line);
  let ts = parseTs(f[tsI]);
  if (timeI >= 0) {
    const [h, m, s] = f[timeI].split(":").map(Number);
    ts += ((h || 0) * 3600 + (m || 0) * 60 + (s || 0)) * 1000;
  }
  const value = Number(f[valI]) * multiply;
  if (!Number.isFinite(ts) || !Number.isFinite(value) || value < 0) continue;
  if (args["shift-to-month"] && readings.length === 0) {
    const target = Number(args["shift-to-month"]);
    const d = new Date(ts);
    shiftMs = Date.UTC(Math.floor(target / 100), (target % 100) - 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()) - ts;
  }
  readings.push({ module: moduleKey, wallet: walletI >= 0 ? f[walletI] : args.wallet, value, ts: ts + shiftMs, source: "dataset" });
}

let accepted = 0;
for (let i = 0; i < readings.length; i += 2000) {
  const res = await fetch(API + "/api/readings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ readings: readings.slice(i, i + 2000) }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  accepted += json.accepted;
  if (json.rejected.length) console.warn("rejected sample:", json.rejected.slice(0, 3));
}
console.log(`Imported ${accepted}/${readings.length} ${moduleKey} readings from ${args.file}`);
