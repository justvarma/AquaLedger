// Money and date helpers. Bills are stored on-chain in paise (1 rupee = 100 paise).

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export const paiseToRupees = (p) => Number(p) / 100;
export const formatPaise = (p, whole = false) => (whole ? inr0 : inr).format(paiseToRupees(p ?? 0));

/** wei -> paise using the escrow's conversion rate */
export const weiToPaise = (wei, weiPerPaise) => (weiPerPaise ? BigInt(wei) / BigInt(weiPerPaise) : 0n);
export const rupeesToWei = (rupees, weiPerPaise) => BigInt(Math.round(Number(rupees) * 100)) * BigInt(weiPerPaise);

export function formatEth(wei, digits = 5) {
  const n = Number(BigInt(wei)) / 1e18;
  return `${n.toLocaleString("en-IN", { maximumFractionDigits: digits })} ETH`;
}

export function formatNumber(v, digits = 2) {
  return Number(v).toLocaleString("en-IN", { maximumFractionDigits: digits });
}

export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const shortHash = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");

// ---- months (YYYYMM, India time)
const IST = 5.5 * 3600 * 1000;
export function monthOf(ts = Date.now()) {
  const d = new Date(ts + IST);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}
export function recentMonths(n = 6) {
  const out = [];
  let m = monthOf();
  for (let i = 0; i < n; i++) {
    out.push(m);
    m = m % 100 === 1 ? m - 100 + 11 : m - 1;
  }
  return out;
}
export function monthLabel(m) {
  const y = Math.floor(m / 100);
  const mm = m % 100;
  return new Date(Date.UTC(y, mm - 1, 1)).toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}
export function formatDateTime(ts) {
  return new Date(ts).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

export function explorerTx(chainId, hash) {
  if (Number(chainId) === 11155111) return `https://sepolia.etherscan.io/tx/${hash}`;
  return null;
}
export function explorerAddress(chainId, addr) {
  if (Number(chainId) === 11155111) return `https://sepolia.etherscan.io/address/${addr}`;
  return null;
}

/** Turn an ethers / MetaMask error into one readable line. */
export function errorText(e) {
  if (!e) return "Something went wrong";
  if (e.code === "ACTION_REJECTED" || e.code === 4001) return "You rejected the request in MetaMask.";
  if (e.revert?.name) return `Contract rejected it: ${e.revert.name}${e.revert.args?.length ? ` (${e.revert.args.join(", ")})` : ""}`;
  return e.shortMessage || e.reason || e.info?.error?.message || e.message || String(e);
}
