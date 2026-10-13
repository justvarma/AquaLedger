# AquaLedger: blockchain community maintenance platform

AquaLedger runs maintenance for an apartment complex, housing society or shared farm across **8 services**:
water, electricity, gas, EV charging, parking, clubhouse booking, waste and security. For every service it gives:

- **Tamper-proof usage logging**: raw meter readings stay off-chain. Each batch of readings is hashed, and the
  hash is chained on-chain, so any later edit to the database can be detected.
- **Smart-contract bill calculation**: each module contract holds its own billing formula and rates.
- **Escrow payments**: residents deposit a monthly buffer. The escrow releases exactly the billed amount,
  carries any excess forward, and flags a shortfall as pending debt for next month.
- **A transparent dashboard**: residents and admins log in with MetaMask. Bills and balances are read straight
  from the chain, and usage history comes from the off-chain database.

This implements the AquaLedger KT document, sections 1–11.

---

## Architecture

```
                         ┌────────────────────── Ethereum (Sepolia / local anvil) ──────────────────────┐
                         │                                                                               │
                         │   ResidentRegistry  ◄──── isAdmin / isActiveResident ────┐                    │
                         │   (identity, roles)                                       │                    │
                         │                                                           │                    │
                         │   WaterModule  ElectricityModule  GasModule  EVChargingModule                 │
                         │   ParkingModule  ClubhouseModule  WasteModule  SecurityModule                  │
                         │     │  logUsage / logUsageBatch  (usage + hash chain)                         │
                         │     │  finalizeBill  ── calculateBill() ──► addBill()                         │
                         │     ▼                                                                         │
                         │   CommunityEscrow  (deposit · settle · settleAll · debt flag · withdraw)      │
                         └───────▲───────────────────────────────▲───────────────────────────────▲───────┘
                                 │ oracle wallet txs              │ events (indexer)               │ MetaMask txs
┌──────────────┐  POST     ┌─────┴───────────────────────────────┴─────┐    REST          ┌─────────┴─────────┐
│ simulate.js  │ readings  │  backend/ (Node, SQLite)                  │ ◄──────────────► │ frontend/ (React) │
│ importCsv.js ├──────────►│  residents · meter_readings · bills ·     │                  │ resident + admin  │
│ (data feed)  │           │  payments · module_config · usage_batches │                  │ dashboards        │
└──────────────┘           └───────────────────────────────────────────┘                  └───────────────────┘
```

**What lives where** (KT section 9): on-chain holds identities, a monthly usage total per resident and module,
the hash chain of reading batches, final bills, payments and balances. Off-chain holds every raw reading,
contact details, history for the charts, and a mirror of on-chain bills and payments for fast queries.

## Folder layout

| Path | What's in it |
|------|--------------|
| `blockchain/contracts/` | The Solidity source. `ResidentRegistry.sol` and `CommunityEscrow.sol`; `modules/BaseModule.sol` holds the shared logging and billing logic, plus one file per module. |
| `blockchain/remix/AquaLedger_All.sol` | All contracts in **one file** for Remix. |
| `blockchain/test/AquaLedger.t.sol` | 24 tests: registry, every formula, hash chain, booking, all 5 escrow rules, and a fuzz test that money is conserved. |
| `blockchain/script/Deploy.s.sol` | Optional one-command deploy (Foundry). |
| `abi/` | Contract ABIs, shared by the backend and frontend. |
| `deployments/` | Contract addresses per chain (`31337.json` local, `11155111.json` Sepolia). |
| `backend/` | Off-chain API, SQLite database, event indexer, data simulator and CSV dataset importer. |
| `frontend/` | React + ethers dashboard with MetaMask login. |
| `docs/DEPLOY_SEPOLIA.md` | Step-by-step Remix + MetaMask deployment. |

## Billing formulas (KT section 7)

| Module | Formula in the contract | Usage unit on-chain |
|--------|--------------------------|---------------------|
| Water | ₹0.05/L up to 15,000 L, then ₹0.08/L **for the litres above** 15,000 | litres |
| Electricity | Slabs: units 1–100 at ₹3, 101–300 at ₹5, above 300 at ₹7 | kWh |
| Gas | ₹40 per m³ | m³ × 100 (Solidity has no decimals) |
| EV charging | ₹8 per kWh | kWh × 100 |
| Parking | ₹500/month for an owned slot + ₹20 per visitor hour | visitor hours |
| Clubhouse | ₹200 per 2-hour booking (residents book on-chain) | bookings |
| Waste | ₹150 flat per home per month (pickups logged for transparency) | collections |
| Security | ₹300 flat per home per month (gate entries logged) | access events |

All amounts are stored in **paise**. Admins can change any rate from the dashboard (Admin, Rates) or from Remix.

> Interpretation note: the KT says "Tier 2 above 15,000 L: ₹0.08/L". The contract applies ₹0.08 only to the
> litres above 15,000, the same way tax slabs work. To charge the whole bill at ₹0.08 once usage crosses
> 15,000 L instead, change one line in `WaterModule.calculateBill`.

## Escrow rules (KT section 8)

| Rule | How it's implemented |
|------|----------------------|
| 1. Resident deposits a monthly buffer | `CommunityEscrow.deposit()` (payable, active residents only) |
| 2. Bill calculated at month end per module | `Module.finalizeBills(month, residents)` → `calculateBill()` → `escrow.addBill()` |
| 3. Admin withdraws the exact bill amount | `settle(resident)` / `settleAll()` move exactly the billed amount into `collectedWei`; `withdrawCollected()` sends it to the admin |
| 4. Excess carries forward | Anything not billed stays in `balanceOf[resident]` |
| 5. Shortfall → pending debt | Partial payment (oldest bill first), `hasPendingDebt = true`, and the unpaid amount stays in `outstandingPaise`, so next month's settlement collects it |

Residents can also pay their own dues (`settle(self)`) and withdraw their buffer when they owe nothing.

## How "tamper-proof logging" works

1. The data feed sends readings to the backend (`POST /api/readings`). They land in `meter_readings`.
2. On a push, the backend groups each home's new readings into a batch and computes
   `batchHash = keccak256(JSON of [id, timestamp, value] rows)`. It then calls `logUsageBatch`.
3. The contract adds the usage and extends a hash chain: `dataHash = keccak256(previousDataHash, batchHash)`.
4. `GET /api/verify`, or the **Check readings against the chain** button, re-hashes whatever the database holds
   now and compares it with the hashes on-chain. Edit one reading and the check fails.
   `node src/tamperDemo.js <wallet>` does exactly that for a demo, and `--undo` restores the reading.

---

## Quick start: everything on your laptop (no faucet needed)

Requirements: **Node.js 22.13 or newer** (the backend uses Node's built-in SQLite), **Foundry** for the local
chain (<https://book.getfoundry.sh/getting-started/installation>), and MetaMask.

```bash
# 1. local blockchain (leave running)
anvil

# 2. deploy all contracts to it (new terminal)
cd blockchain
forge install foundry-rs/forge-std --no-git   # only if lib/forge-std is missing
forge test                                    # 24 tests should pass
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. backend
cd ../backend
cp .env.example .env
npm install
npm run demo:setup           # oracle becomes admin, 5 homes registered, deposits made (prints MetaMask keys)
npm start                    # API on http://localhost:4000 (leave running)

# 4. data (new terminal, backend folder)
node src/simulate.js --backfill 202609     # a full past month
node src/simulate.js --backfill            # this month so far

# 5. frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev                  # http://localhost:5173
```

**MetaMask for the local chain:** add a network with RPC `http://127.0.0.1:8545` and chain ID `31337`, or
just click "Switch network" in the app. Then **Import account** using the keys `demo:setup` printed: the
`admin` key for the society admin, and the `A-101` … `C-301` keys for residents. These are anvil's public test
keys, so never use them on a real network.

If you restart anvil, the chain is wiped. Redeploy (step 2), delete `backend/data/aqualedger.db`, and run
`demo:setup` again. If MetaMask complains about nonces after a restart, use Settings, Advanced,
**Clear activity tab data**.

## Demo script (KT build step 8: water and one more module, end to end)

1. **Admin, Month end, Close September**, then **Settle all**. Show the Bills table filling up, and
   `B-201`'s red meter with pending debt in Admin, Residents.
2. Log in as **A-101**. Show the meter-style buffer and dues, the **Water** tab (daily chart, the formula, the
   on-chain usage and fingerprint), then **Check readings against the chain** (✓).
3. Run `node src/tamperDemo.js 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC WATER 202609`, then check again
   (✗: one batch changed). Run it with `--undo` afterwards.
4. **Electricity** tab: same flow, with slab billing.
5. Start the live feed: `node src/simulate.js --live --interval 10 --push-every 3`. Watch the October bars and
   "Bill so far" grow.
6. **Clubhouse**: book a slot from the dashboard. It's a resident-signed transaction, and the bill goes up by ₹200.
7. **Deposit** from A-101, then **Pay dues now**. The escrow activity table updates.

## Using real datasets (electricity, EV)

```bash
cd backend
# UCI household power consumption (semicolon separated, 1-minute kW readings → kWh per minute = kW/60)
node src/importCsv.js --file household_power_consumption.txt --module ELECTRICITY \
  --wallet 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  --ts-column Date --time-column Time --value-column Global_active_power --multiply 0.016667 \
  --shift-to-month 202610 --limit 20000

# An EV charging sessions CSV (one row per session)
node src/importCsv.js --file ev_sessions.csv --module EV_CHARGING --wallet 0x... \
  --ts-column connectionTime --value-column kWhDelivered --shift-to-month 202610
```

`--shift-to-month` moves old dataset dates into the billing month you're demoing.

## Backend API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/config` | Addresses, module metadata, live rates |
| GET | `/api/residents` | Public fields only; contact info is admin-only |
| POST | `/api/residents` | admin; saves contact info |
| POST | `/api/readings` | admin; `{ readings: [{ module, wallet, value, ts }] }` |
| GET | `/api/usage/daily?wallet&module&month` | Chart data |
| GET | `/api/readings`, `/api/bills`, `/api/payments`, `/api/summary` | History |
| GET | `/api/verify?wallet&module&month` | Integrity check |
| POST | `/api/admin/push` · `/api/admin/close-month` · `/api/admin/settle-all` · `/api/admin/sync` | admin |

There are two ways to authenticate as admin. Scripts send `x-api-key: <ADMIN_API_KEY>`. The dashboard signs a
timestamped message with MetaMask, and the backend checks on-chain that the signer is a registry admin, so admin
rights come from the contract, not from the server.

## Security notes (for the report)

- Every write is role-gated on-chain: only registry admins log usage, finalize bills, settle, change rates or
  register homes. Only module contracts can post bills to the escrow.
- A closed month can't be changed: once billed, `logUsage` and `finalizeBill` revert with `AlreadyBilled`.
- The escrow uses a reentrancy guard and checks-effects-interactions; ETH only leaves through `withdrawExcess`
  (the resident's own funds, and only when they owe nothing) and `withdrawCollected` (settled money only).
- The oracle wallet is trusted to report usage honestly. That trust boundary is the same as a real utility
  meter's. The hash chain makes any *later* edit detectable, but it can't prove the first reading was true.
  Signed readings from tamper-resistant meters would be the next step, and are worth naming as future work.
