// Simulated data feed - stands in for the meters/sensors the project doesn't have (KT section 4, build step 4).
// Talks to the backend over HTTP exactly like a real device would.
//
//   node src/simulate.js --backfill 202610            one month of readings for every resident (up to today)
//   node src/simulate.js --live --interval 10          a new "hour" of readings every 10 s
//   node src/simulate.js --live --interval 10 --push-every 6   ...and push them on-chain every 6 ticks
//
// Options: --api http://localhost:4000   --key <ADMIN_API_KEY>   --seed 42
import { config } from "./config.js";
import { monthBounds, currentMonth } from "./modules.js";

const args = parseArgs(process.argv.slice(2));
const API = args.api || `http://localhost:${config.port}`;
const KEY = args.key || config.adminApiKey;
const HOUR = 3600 * 1000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[k] = true;
    else out[k] = argv[++i];
  }
  return out;
}

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error || res.status}`);
  return json;
}

// Small seeded RNG so each resident keeps a consistent "household profile" between runs.
function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function profileFor(wallet) {
  const r = rng(wallet + (args.seed || ""));
  return {
    waterPerDay: 350 + r() * 300, // litres: ~10.5k-19.5k / month, so some homes cross the 15k tier
    kwhPerDay: 3 + r() * 9, // 90-360 units / month, covers all three slabs
    gasPerDay: 0.2 + r() * 0.4, // m3
    hasEV: r() < 0.5,
    evKwhPerSession: 10 + r() * 25,
    visitorRate: 0.1 + r() * 0.25, // chance of a visitor per day
    clubRate: 0.03 + r() * 0.07,
  };
}

// Typical Indian household load shape: morning and evening peaks.
const HOUR_SHAPE = [0.2, 0.15, 0.1, 0.1, 0.2, 0.8, 1.8, 2.2, 1.6, 1.0, 0.8, 0.8, 0.9, 0.9, 0.7, 0.6, 0.7, 1.0, 1.6, 2.0, 1.9, 1.4, 0.9, 0.5];
const SHAPE_SUM = HOUR_SHAPE.reduce((a, b) => a + b, 0);

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Readings for one resident for one hour starting at `ts`. */
function hourReadings(wallet, p, ts, rand) {
  const hourOfDay = new Date(ts + 5.5 * HOUR).getUTCHours();
  const w = HOUR_SHAPE[hourOfDay] / SHAPE_SUM;
  const noise = () => 0.7 + rand() * 0.6;
  const out = [
    { module: "WATER", value: round(p.waterPerDay * w * noise(), 1) },
    { module: "ELECTRICITY", value: round(p.kwhPerDay * w * noise(), 3) },
    { module: "GAS", value: round(p.gasPerDay * w * noise(), 3) },
  ];
  if (p.hasEV && hourOfDay >= 19 && rand() < 0.25 / 5) out.push({ module: "EV_CHARGING", value: round(p.evKwhPerSession * noise(), 2) });
  if (hourOfDay >= 10 && hourOfDay <= 21 && rand() < p.visitorRate / 12)
    out.push({ module: "PARKING", value: 1 + Math.floor(rand() * 4) });
  if (hourOfDay >= 6 && hourOfDay <= 21 && rand() < p.clubRate / 16) out.push({ module: "CLUBHOUSE", value: 1 });
  if (hourOfDay === 7 && rand() < 0.93) out.push({ module: "WASTE", value: 1 }); // daily pickup, sometimes missed
  if (rand() < 0.1) out.push({ module: "SECURITY", value: 1 + Math.floor(rand() * 2) }); // gate entries
  return out.map((o) => ({ ...o, wallet, ts }));
}

async function activeResidents() {
  const list = await api("/api/residents");
  const res = list.filter((r) => r.on_chain && r.active);
  if (!res.length) throw new Error("No active on-chain residents yet. Register residents first (dashboard Admin tab or demo-setup).");
  return res;
}

async function postInChunks(readings) {
  let accepted = 0;
  for (let i = 0; i < readings.length; i += 2000) {
    const r = await api("/api/readings", { readings: readings.slice(i, i + 2000) });
    accepted += r.accepted;
    if (r.rejected.length) console.warn("rejected:", r.rejected.slice(0, 3));
  }
  return accepted;
}

async function backfill(month) {
  const residents = await activeResidents();
  const { start, end } = monthBounds(month);
  const stop = Math.min(end, Date.now());
  const readings = [];
  for (const r of residents) {
    const p = profileFor(r.wallet);
    const rand = rng(r.wallet + month);
    for (let ts = start; ts < stop; ts += HOUR) readings.push(...hourReadings(r.wallet, p, ts, rand));
  }
  const n = await postInChunks(readings);
  console.log(`Backfilled ${n} readings for ${residents.length} residents, month ${month}.`);
}

async function live() {
  const intervalS = Number(args.interval || 10);
  const pushEvery = Number(args["push-every"] || 0);
  let tick = 0;
  console.log(`Live feed: one simulated hour every ${intervalS}s${pushEvery ? `, pushing on-chain every ${pushEvery} ticks` : ""}. Ctrl+C to stop.`);
  const rand = rng(String(Date.now()));
  for (;;) {
    try {
      const residents = await activeResidents();
      const now = Date.now();
      const readings = residents.flatMap((r) => hourReadings(r.wallet, profileFor(r.wallet), now, rand));
      const n = await postInChunks(readings);
      tick++;
      console.log(`[tick ${tick}] ${n} readings`);
      if (pushEvery && tick % pushEvery === 0) {
        const out = await api("/api/admin/push", {});
        console.log(`  pushed on-chain:`, out.pushed.map((p) => `${p.module}${p.tx ? " " + p.tx.slice(0, 10) : " skipped"}`).join(", ") || "nothing new");
      }
    } catch (e) {
      console.error("tick failed:", e.message);
    }
    await new Promise((r) => setTimeout(r, intervalS * 1000));
  }
}

if (args.backfill) {
  await backfill(args.backfill === true ? currentMonth() : Number(args.backfill));
} else if (args.live) {
  await live();
} else {
  console.log("Usage: node src/simulate.js --backfill [YYYYMM] | --live [--interval 10] [--push-every 6]");
}
