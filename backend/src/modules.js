// Metadata for the 8 modules. `key` matches the module name hashed on-chain (keccak256("WATER") ...)
// and the key in deployments/<chainId>.json.
//
// `scale`: readings are stored off-chain in human units (e.g. 12.34 m3). Solidity has no decimals,
// so before pushing on-chain the value is multiplied by `scale` and rounded (12.34 m3 -> 1234).
export const MODULES = [
  { key: "WATER", contract: "WaterModule", label: "Water", unit: "L", scale: 1, billing: "usage" },
  { key: "ELECTRICITY", contract: "ElectricityModule", label: "Electricity", unit: "kWh", scale: 1, billing: "usage" },
  { key: "GAS", contract: "GasModule", label: "Gas", unit: "m³", scale: 100, billing: "usage" },
  { key: "EV_CHARGING", contract: "EVChargingModule", label: "EV Charging", unit: "kWh", scale: 100, billing: "usage" },
  { key: "PARKING", contract: "ParkingModule", label: "Parking", unit: "visitor hrs", scale: 1, billing: "mixed" },
  { key: "CLUBHOUSE", contract: "ClubhouseModule", label: "Clubhouse", unit: "bookings", scale: 1, billing: "per-use" },
  { key: "WASTE", contract: "WasteModule", label: "Waste", unit: "collections", scale: 1, billing: "flat" },
  { key: "SECURITY", contract: "SecurityModule", label: "Security", unit: "access events", scale: 1, billing: "flat" },
];

export const MODULE_BY_KEY = Object.fromEntries(MODULES.map((m) => [m.key, m]));

export function normalizeModuleKey(input) {
  const k = String(input || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  const alias = { EV: "EV_CHARGING", POWER: "ELECTRICITY", CLUB: "CLUBHOUSE", AMENITY: "CLUBHOUSE" };
  const key = alias[k] || k;
  if (!MODULE_BY_KEY[key]) throw new Error(`Unknown module "${input}". Use one of ${MODULES.map((m) => m.key).join(", ")}`);
  return key;
}

/** YYYYMM (number) for a JS timestamp, using UTC+5:30 (India) so months match the residents' calendar. */
export function monthOf(tsMs) {
  const d = new Date(tsMs + 5.5 * 3600 * 1000);
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

export function currentMonth() {
  return monthOf(Date.now());
}

export function monthBounds(month) {
  const y = Math.floor(month / 100);
  const m = month % 100;
  const start = Date.UTC(y, m - 1, 1) - 5.5 * 3600 * 1000;
  const end = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 5.5 * 3600 * 1000;
  return { start, end };
}
