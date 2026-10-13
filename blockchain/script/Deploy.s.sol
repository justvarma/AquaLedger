// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ResidentRegistry} from "../contracts/ResidentRegistry.sol";
import {CommunityEscrow} from "../contracts/CommunityEscrow.sol";
import {WaterModule} from "../contracts/modules/WaterModule.sol";
import {ElectricityModule} from "../contracts/modules/ElectricityModule.sol";
import {GasModule} from "../contracts/modules/GasModule.sol";
import {EVChargingModule} from "../contracts/modules/EVChargingModule.sol";
import {ParkingModule} from "../contracts/modules/ParkingModule.sol";
import {ClubhouseModule} from "../contracts/modules/ClubhouseModule.sol";
import {WasteModule} from "../contracts/modules/WasteModule.sol";
import {SecurityModule} from "../contracts/modules/SecurityModule.sol";

/// Optional alternative to Remix. Deploys all 10 contracts, authorises the modules in the escrow,
/// and writes the addresses to ../deployments/<chainId>.json (the backend and frontend read this file).
///
///   Local:   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key>
///   Sepolia: forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $PRIVATE_KEY
contract Deploy is Script {
    function run() external {
        uint256 weiPerPaise = vm.envOr("WEI_PER_PAISE", uint256(1e9));

        vm.startBroadcast();
        ResidentRegistry registry = new ResidentRegistry();
        CommunityEscrow escrow = new CommunityEscrow(address(registry), weiPerPaise);

        address[] memory mods = new address[](8);
        mods[0] = address(new WaterModule(address(registry), address(escrow)));
        mods[1] = address(new ElectricityModule(address(registry), address(escrow)));
        mods[2] = address(new GasModule(address(registry), address(escrow)));
        mods[3] = address(new EVChargingModule(address(registry), address(escrow)));
        mods[4] = address(new ParkingModule(address(registry), address(escrow)));
        mods[5] = address(new ClubhouseModule(address(registry), address(escrow)));
        mods[6] = address(new WasteModule(address(registry), address(escrow)));
        mods[7] = address(new SecurityModule(address(registry), address(escrow)));
        escrow.setModules(mods, true);
        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "ResidentRegistry", address(registry));
        vm.serializeAddress(k, "CommunityEscrow", address(escrow));
        vm.serializeAddress(k, "WATER", mods[0]);
        vm.serializeAddress(k, "ELECTRICITY", mods[1]);
        vm.serializeAddress(k, "GAS", mods[2]);
        vm.serializeAddress(k, "EV_CHARGING", mods[3]);
        vm.serializeAddress(k, "PARKING", mods[4]);
        vm.serializeAddress(k, "CLUBHOUSE", mods[5]);
        vm.serializeAddress(k, "WASTE", mods[6]);
        string memory json = vm.serializeAddress(k, "SECURITY", mods[7]);

        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Deployment written to", path);
    }
}
