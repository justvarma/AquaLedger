// Backend (off-chain) API client.
export const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\/$/, "");

let adminAuth = null; // { address, ts, signature } - re-signed every ~9 minutes

/** Admin endpoints are authorised by a MetaMask signature; the backend checks the signer is an on-chain admin. */
async function adminHeaders(signer) {
  const address = await signer.getAddress();
  if (!adminAuth || adminAuth.address !== address || Date.now() - adminAuth.ts > 9 * 60 * 1000) {
    const ts = Date.now();
    const signature = await signer.signMessage(`AquaLedger admin request ${ts}`);
    adminAuth = { address, ts, signature };
  }
  return { "x-aqua-address": adminAuth.address, "x-aqua-timestamp": String(adminAuth.ts), "x-aqua-signature": adminAuth.signature };
}

async function request(path, { method = "GET", body, signer } = {}) {
  const headers = { "content-type": "application/json", ...(signer ? await adminHeaders(signer) : {}) };
  let res;
  try {
    res = await fetch(API_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`Can't reach the AquaLedger backend at ${API_URL}. Start it with "npm start" in the backend folder.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Backend error ${res.status}`);
  return json;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)).toString();

export const api = {
  config: () => request("/api/config"),
  residents: (signer) => request("/api/residents", { signer }),
  saveResident: (signer, body) => request("/api/residents", { method: "POST", body, signer }),
  daily: (wallet, module, month) => request(`/api/usage/daily?${qs({ wallet, module, month })}`),
  readings: (wallet, module, month) => request(`/api/readings?${qs({ wallet, module, month })}`),
  bills: (wallet, month) => request(`/api/bills?${qs({ wallet, month })}`),
  payments: (wallet) => request(`/api/payments?${qs({ wallet })}`),
  summary: (month) => request(`/api/summary?${qs({ month })}`),
  verify: (wallet, module, month) => request(`/api/verify?${qs({ wallet, module, month })}`),
  push: (signer, month) => request("/api/admin/push", { method: "POST", body: { month }, signer }),
  closeMonth: (signer, month) => request("/api/admin/close-month", { method: "POST", body: { month }, signer }),
  syncNow: () => request("/api/sync", { method: "POST", body: {} }).catch(() => null),
  sync: (signer) => request("/api/admin/sync", { method: "POST", body: {}, signer }),
};
