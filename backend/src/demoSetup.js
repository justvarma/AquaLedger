// One-shot setup for a LOCAL demo chain (anvil / hardhat node). Uses the well-known dev accounts.
//   - makes the oracle wallet an admin
//   - registers 5 residents with unit numbers (on-chain) + contact info (off-chain)
//   - gives two residents an owned parking slot
//   - each resident deposits a buffer into escrow (one deliberately small, to demo the debt flag)
//
//   node src/demoSetup.js
//
// On Sepolia do these steps from the dashboard's Admin tab instead (or Remix) - see docs/DEPLOY_SEPOLIA.md.
import { ethers } from "ethers";
import { config } from "./config.js";
import { upsertResident } from "./db.js";
import { registry, escrow, modules, provider, syncEvents, oracleAddress } from "./chain.js";

if (config.chainId !== 31337) {
  console.error("demoSetup.js is for the local chain only (CHAIN_ID=31337).");
  process.exit(1);
}

// Default anvil/hardhat mnemonic accounts (public test keys - worthless outside a local chain)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 owner/admin (deployer)
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 oracle (backend)
];
// resident accounts 2..6 are derived from the default dev mnemonic
const mnemonic = "test test test test test test test test test test test junk";
const wallet = (i) => ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`).connect(provider);

const owner = new ethers.NonceManager(new ethers.Wallet(KEYS[0], provider));
const residents = [
  { i: 2, unit: "A-101", name: "Ananya Menon", phone: "+91 90000 00101", deposit: "0.0012", slot: "P-01" },
  { i: 3, unit: "A-102", name: "Rahul Nair", phone: "+91 90000 00102", deposit: "0.001" },
  { i: 4, unit: "B-201", name: "Fathima K", phone: "+91 90000 00201", deposit: "0.0004" }, // Rs 4,000 buffer - will fall short
  { i: 5, unit: "B-202", name: "Arjun Pillai", phone: "+91 90000 00202", deposit: "0.0012", slot: "P-02" },
  { i: 6, unit: "C-301", name: "Meera Iyer", phone: "+91 90000 00301", deposit: "0.001" },
];

const reg = registry.connect(owner);
if (oracleAddress && !(await registry.isAdmin(oracleAddress))) {
  await (await reg.setAdmin(oracleAddress, true)).wait();
  console.log(`oracle ${oracleAddress} is now an admin`);
}

for (const r of residents) {
  const w = wallet(r.i);
  if (!(await registry.isRegistered(w.address))) {
    await (await reg.registerResident(w.address, r.unit)).wait();
    console.log(`registered ${r.unit} -> ${w.address}`);
  }
  upsertResident({ wallet: w.address, unit_number: r.unit, name: r.name, phone: r.phone, email: `${r.unit.toLowerCase()}@example.com` });
  if (r.slot && !(await modules.PARKING.hasOwnedSlot(w.address))) {
    await (await modules.PARKING.connect(owner).assignSlot(w.address, r.slot)).wait();
  }
  if ((await escrow.balanceOf(w.address)) === 0n) {
    await (await escrow.connect(w).deposit({ value: ethers.parseEther(r.deposit) })).wait();
    console.log(`  ${r.unit} deposited ${r.deposit} ETH`);
  }
}

await syncEvents();
console.log("\nDemo residents (import these keys into MetaMask to log in as a resident - LOCAL CHAIN ONLY):");
for (const r of residents) {
  const w = wallet(r.i);
  console.log(`  ${r.unit.padEnd(6)} ${w.address}  key ${w.privateKey}`);
}
console.log(`  admin  ${new ethers.Wallet(KEYS[0]).address}  key ${KEYS[0]}`);
process.exit(0);
