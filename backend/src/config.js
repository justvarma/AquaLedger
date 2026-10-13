// Loads .env, the deployment file and the contract ABIs. No external dotenv dependency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, "..");
export const PROJECT_ROOT = path.resolve(BACKEND_ROOT, "..");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.join(BACKEND_ROOT, ".env"));

const env = process.env;

export const config = {
  port: Number(env.PORT || 4000),
  rpcUrl: env.RPC_URL || "http://127.0.0.1:8545",
  chainId: Number(env.CHAIN_ID || 31337),
  // Wallet the backend uses to push usage on-chain. Must be made an admin in ResidentRegistry.
  // TESTNET ONLY - never put a key that holds real funds here.
  oraclePrivateKey: env.ORACLE_PRIVATE_KEY || "",
  // Shared secret for scripts (simulator, curl). The dashboard uses wallet signatures instead.
  adminApiKey: env.ADMIN_API_KEY || "change-me",
  dbPath: path.resolve(BACKEND_ROOT, env.DB_PATH || "data/aqualedger.db"),
  syncIntervalMs: Number(env.SYNC_INTERVAL_MS || 15000),
  logChunkSize: Number(env.LOG_CHUNK_SIZE || 9000), // public Sepolia RPCs cap eth_getLogs ranges
  corsOrigin: env.CORS_ORIGIN || "*",
};

export function loadDeployment() {
  const file = env.DEPLOYMENT_FILE
    ? path.resolve(BACKEND_ROOT, env.DEPLOYMENT_FILE)
    : path.join(PROJECT_ROOT, "deployments", `${config.chainId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Deployment file not found: ${file}\n` +
        `Deploy the contracts first (see docs/DEPLOY_SEPOLIA.md) and save the addresses there.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function loadAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "abi", `${name}.json`), "utf8"));
}
