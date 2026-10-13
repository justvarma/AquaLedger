// MetaMask + contract helpers.
import { BrowserProvider, Contract } from "ethers";
import ResidentRegistry from "../../../abi/ResidentRegistry.json";
import CommunityEscrow from "../../../abi/CommunityEscrow.json";
import WaterModule from "../../../abi/WaterModule.json";
import ElectricityModule from "../../../abi/ElectricityModule.json";
import GasModule from "../../../abi/GasModule.json";
import EVChargingModule from "../../../abi/EVChargingModule.json";
import ParkingModule from "../../../abi/ParkingModule.json";
import ClubhouseModule from "../../../abi/ClubhouseModule.json";
import WasteModule from "../../../abi/WasteModule.json";
import SecurityModule from "../../../abi/SecurityModule.json";

const MODULE_ABIS = {
  WATER: WaterModule,
  ELECTRICITY: ElectricityModule,
  GAS: GasModule,
  EV_CHARGING: EVChargingModule,
  PARKING: ParkingModule,
  CLUBHOUSE: ClubhouseModule,
  WASTE: WasteModule,
  SECURITY: SecurityModule,
};

const NETWORKS = {
  11155111: {
    chainId: "0xaa36a7",
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
  },
  31337: {
    chainId: "0x7a69",
    chainName: "AquaLedger Local (anvil)",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
  },
};

export const networkName = (id) => NETWORKS[id]?.chainName || `chain ${id}`;
export const hasMetaMask = () => typeof window !== "undefined" && !!window.ethereum;

export async function connectWallet() {
  if (!hasMetaMask()) throw new Error("MetaMask not found. Install the MetaMask browser extension and reload.");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const network = await provider.getNetwork();
  return { provider, signer, address: await signer.getAddress(), chainId: Number(network.chainId) };
}

export async function switchNetwork(chainId) {
  const net = NETWORKS[chainId];
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: net.chainId }] });
  } catch (e) {
    if (e.code === 4902 || e?.data?.originalError?.code === 4902) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [net] });
    } else throw e;
  }
}

/** Build contract objects bound to the signer (writes) - reads go through the same MetaMask provider. */
export function makeContracts(deployment, signer) {
  const modules = {};
  for (const [key, abi] of Object.entries(MODULE_ABIS)) modules[key] = new Contract(deployment[key], abi, signer);
  return {
    registry: new Contract(deployment.ResidentRegistry, ResidentRegistry, signer),
    escrow: new Contract(deployment.CommunityEscrow, CommunityEscrow, signer),
    modules,
  };
}

/** Send a tx and wait for 1 confirmation. Returns the receipt. */
export async function sendTx(promise, onSent) {
  const tx = await promise;
  onSent?.(tx.hash);
  return tx.wait();
}
