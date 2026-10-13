// Plain-language billing formulas, built from the live rates the backend reads off each module contract.
import { formatPaise } from "./format.js";

const r = (rules, k) => Number(rules?.[k] ?? 0);

export function describeFormula(key, rules) {
  if (!rules) return "";
  switch (key) {
    case "WATER":
      return `${formatPaise(r(rules, "tier1RatePaise"))} per litre up to ${r(rules, "tier1LimitLitres").toLocaleString("en-IN")} L, then ${formatPaise(
        r(rules, "tier2RatePaise")
      )} per litre above that`;
    case "ELECTRICITY":
      return `${formatPaise(r(rules, "slab1RatePaise"))}/unit for the first ${r(rules, "slab1Limit")}, ${formatPaise(
        r(rules, "slab2RatePaise")
      )}/unit up to ${r(rules, "slab2Limit")}, ${formatPaise(r(rules, "slab3RatePaise"))}/unit beyond`;
    case "GAS":
      return `${formatPaise(r(rules, "ratePaisePerM3"))} per cubic metre`;
    case "EV_CHARGING":
      return `${formatPaise(r(rules, "ratePaisePerKWh"))} per kWh charged`;
    case "PARKING":
      return `Owned slot ${formatPaise(r(rules, "ownedSlotFeePaise"))} a month, visitors ${formatPaise(r(rules, "visitorRatePaisePerHour"))} an hour`;
    case "CLUBHOUSE":
      return `${formatPaise(r(rules, "ratePaisePerSlot"))} per 2-hour booking`;
    case "WASTE":
      return `Flat ${formatPaise(r(rules, "flatFeePaise"))} per home per month — pickups logged for transparency`;
    case "SECURITY":
      return `Flat ${formatPaise(r(rules, "flatFeePaise"))} per home per month — gate entries logged for transparency`;
    default:
      return "";
  }
}

/** Setter function + editable fields for the admin Rates panel. `paise` marks money fields. */
export const RATE_SETTERS = {
  WATER: {
    fn: "setRates",
    fields: [
      { key: "tier1LimitLitres", label: "Tier 1 limit (litres)" },
      { key: "tier1RatePaise", label: "Tier 1 rate per litre", paise: true },
      { key: "tier2RatePaise", label: "Tier 2 rate per litre", paise: true },
    ],
  },
  ELECTRICITY: {
    fn: "setRates",
    fields: [
      { key: "slab1Limit", label: "Slab 1 up to (units)" },
      { key: "slab2Limit", label: "Slab 2 up to (units)" },
      { key: "slab1RatePaise", label: "Slab 1 rate", paise: true },
      { key: "slab2RatePaise", label: "Slab 2 rate", paise: true },
      { key: "slab3RatePaise", label: "Slab 3 rate", paise: true },
    ],
  },
  GAS: { fn: "setRate", fields: [{ key: "ratePaisePerM3", label: "Rate per m³", paise: true }] },
  EV_CHARGING: { fn: "setRate", fields: [{ key: "ratePaisePerKWh", label: "Rate per kWh", paise: true }] },
  PARKING: {
    fn: "setRates",
    fields: [
      { key: "ownedSlotFeePaise", label: "Owned slot per month", paise: true },
      { key: "visitorRatePaisePerHour", label: "Visitor per hour", paise: true },
    ],
  },
  CLUBHOUSE: { fn: "setRate", fields: [{ key: "ratePaisePerSlot", label: "Per 2-hour slot", paise: true }] },
  WASTE: { fn: "setFlatFee", fields: [{ key: "flatFeePaise", label: "Flat fee per month", paise: true }] },
  SECURITY: { fn: "setFlatFee", fields: [{ key: "flatFeePaise", label: "Flat fee per month", paise: true }] },
};

export const AMENITIES = ["Gym", "Party hall", "Pool"];
