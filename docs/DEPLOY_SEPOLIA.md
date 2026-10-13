# Deploying AquaLedger to Sepolia with Remix + MetaMask

This follows the KT plan: Remix IDE in the browser, MetaMask for signing, Sepolia testnet.
Budget about 30–40 minutes the first time.

## 0. Before you start

1. **MetaMask**: install the extension and create (or import) a wallet. Use a wallet that holds no real money.
2. **Show test networks**: in MetaMask, open the network menu, turn on "Show test networks", and select **Sepolia**.
3. **Create three accounts in MetaMask** (Account menu, then "Add account"):
   - **Admin**: deploys the contracts and runs the society. This is you.
   - **Oracle**: the backend's data-feed wallet. It pushes readings and closes months. You will export its private key into `backend/.env`, so it must only ever hold test ETH.
   - **Resident 1, Resident 2, …**: demo residents. You need at least two for the demo.
4. **Get Sepolia ETH** for the Admin account from a Sepolia faucet. Search for "Sepolia faucet"; the Google Cloud Web3 faucet and the Alchemy faucet both work. Then send some from Admin to the other accounts in MetaMask:
   - Oracle: about 0.05 ETH (it pays gas for every push and month close).
   - Each resident: about 0.01 ETH (enough for deposits and gas).

   Deploying all 10 contracts costs roughly 0.01–0.05 Sepolia ETH, depending on gas prices.

> Money conversion: the escrow uses **1 paise = 1,000,000,000 wei** (1e9). So ₹10,000 = 0.001 ETH, and
> a typical monthly bill of ₹7,000 is 0.0007 ETH. Faucet ETH goes a long way.

## 1. Compile in Remix

1. Open <https://remix.ethereum.org>.
2. In the File explorer, click **Upload files** and choose `blockchain/remix/AquaLedger_All.sol`.
   This one file holds all 12 contracts and interfaces. (`blockchain/contracts/` has the same code split into
   separate files. Upload that whole folder instead if you want to show the structure.)
3. Open the **Solidity compiler** tab:
   - Compiler: **0.8.26**
   - Click **Advanced configurations**: enable **Optimization** with 200 runs, and set **EVM version** to `cancun`.
   - Click **Compile AquaLedger_All.sol**. You should see a green tick. A few warnings are fine.

## 2. Deploy, in this order

Open the **Deploy & run transactions** tab. Set **Environment** to **Injected Provider – MetaMask**, and check
that it shows *Sepolia (11155111)* and your **Admin** account.

For each contract: pick it in the **Contract** dropdown, fill in the constructor arguments, click **Deploy**,
then confirm in MetaMask. Copy each address from "Deployed Contracts" into a notepad as you go.

| # | Contract | Constructor arguments |
|---|----------|-----------------------|
| 1 | `ResidentRegistry` | none |
| 2 | `CommunityEscrow` | `registry_` = address from #1, `weiPerPaise_` = `1000000000` |
| 3 | `WaterModule` | `registry_` = #1, `escrow_` = #2 |
| 4 | `ElectricityModule` | #1, #2 |
| 5 | `GasModule` | #1, #2 |
| 6 | `EVChargingModule` | #1, #2 |
| 7 | `ParkingModule` | #1, #2 |
| 8 | `ClubhouseModule` | #1, #2 |
| 9 | `WasteModule` | #1, #2 |
| 10 | `SecurityModule` | #1, #2 |

Don't deploy `BaseModule`, `IResidentRegistry` or `ICommunityEscrow`. Those are the abstract base contract
and the interfaces.

## 3. Wire them together

These two calls are required. Without them, month close fails with `NotModule`, and every push fails with
`NotAdmin`.

1. **Let the modules post bills.** Expand the deployed `CommunityEscrow`, then call `setModules` with:
   - `modules`: `["0xWater","0xElectricity","0xGas","0xEV","0xParking","0xClubhouse","0xWaste","0xSecurity"]`
     (the 8 module addresses in quotes, inside square brackets)
   - `enabled`: `true`
2. **Make the backend's oracle wallet an admin.** Expand `ResidentRegistry`, then call `setAdmin` with
   `account` = your Oracle account address and `enabled` = `true`.

Optional: you can register residents here with `registerResident(wallet, "A-101")`. It's easier from the
dashboard's Admin, Residents tab.

## 4. Save the addresses for the backend and frontend

1. Copy `deployments/sepolia.template.json` to `deployments/11155111.json` and paste in the 10 addresses.
2. Set `deployedAtBlock`. Open the ResidentRegistry address on <https://sepolia.etherscan.io> and copy the
   block number of its "Contract Creation" transaction. The backend starts reading events from that block.
   With 0, it would scan the whole chain.

## 5. Point the backend at Sepolia

In `backend/.env`:

```env
PORT=4000
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
CHAIN_ID=11155111
ORACLE_PRIVATE_KEY=0x<Oracle account private key: MetaMask, Account details, Show private key>
ADMIN_API_KEY=<any long random string>
DB_PATH=data/aqualedger-sepolia.db
SYNC_INTERVAL_MS=20000
```

A free Alchemy or Infura Sepolia URL is more reliable than the public RPC, if you have one.

```bash
cd backend
npm install
npm start
```

The startup log should print `Oracle wallet: 0x…` and **no** "not an admin" warning.

## 6. Run the frontend

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173> in the browser that has MetaMask. Connect with your **Admin** account.

## 7. First run on Sepolia

1. **Admin, Residents**: register Resident 1 as `A-101` and Resident 2 as `A-102`. Optionally give A-101
   a parking slot, such as `P-01`.
2. Feed some data (the backend must be running):
   ```bash
   cd backend
   node src/simulate.js --backfill            # this month so far, for every registered resident
   ```
   Or use the live feed during the demo:
   `node src/simulate.js --live --interval 15 --push-every 4`
3. **Admin, Month end, Push readings**: the readings are fingerprinted and logged on-chain. Every push is a
   Sepolia transaction, so expect roughly 15 seconds per module.
4. Switch MetaMask to **Resident 1**. The page now shows that home's dashboard. Deposit a buffer, for
   example ₹10,000.
5. Switch back to **Admin**:
   - **Month end, Close month**: every module calculates its bill and posts it to the escrow.
   - Then **Settle all**, then **Withdraw to my wallet**.
6. Show the debt flag: Resident 2 deposits less than their bill before *Settle all*. Their meter turns red
   with "Pending debt", and the shortfall rolls into next month.

Each transaction hash in the dashboard links to Sepolia Etherscan.

### Closing the current month during a demo

A month can only be closed once, and a closed month refuses new readings. For a live demo, backfill a past
month as well: `node src/simulate.js --backfill 202609`. Close that one and keep the current month open for
the live feed.

## Optional: verify the contracts on Etherscan

On each contract's Etherscan page, open **Contract, Verify and Publish**. Choose *Solidity (Single file)*,
compiler `v0.8.26`, optimization *Yes* with 200 runs, and EVM `cancun`. Paste `AquaLedger_All.sol`, and give
the ABI-encoded constructor arguments when asked. Remix shows these in the deploy transaction's "input" data.
Verified contracts let anyone read the billing formulas on Etherscan, which is a strong point for the
transparency argument.

## Alternative: one-command deploy with Foundry

If you have Foundry installed (<https://book.getfoundry.sh>), this deploys and wires everything, and writes
`deployments/11155111.json` for you. You still need to run `setAdmin` for the oracle account afterwards.

```bash
cd blockchain
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $ADMIN_PRIVATE_KEY
cast send <ResidentRegistry> "setAdmin(address,bool)" <ORACLE_ADDRESS> true --rpc-url $SEPOLIA_RPC_URL --private-key $ADMIN_PRIVATE_KEY
```
