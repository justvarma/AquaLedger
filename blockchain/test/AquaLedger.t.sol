// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ResidentRegistry} from "../contracts/ResidentRegistry.sol";
import {CommunityEscrow} from "../contracts/CommunityEscrow.sol";
import {BaseModule} from "../contracts/modules/BaseModule.sol";
import {WaterModule} from "../contracts/modules/WaterModule.sol";
import {ElectricityModule} from "../contracts/modules/ElectricityModule.sol";
import {GasModule} from "../contracts/modules/GasModule.sol";
import {EVChargingModule} from "../contracts/modules/EVChargingModule.sol";
import {ParkingModule} from "../contracts/modules/ParkingModule.sol";
import {ClubhouseModule} from "../contracts/modules/ClubhouseModule.sol";
import {WasteModule} from "../contracts/modules/WasteModule.sol";
import {SecurityModule} from "../contracts/modules/SecurityModule.sol";

contract AquaLedgerTest is Test {
    ResidentRegistry registry;
    CommunityEscrow escrow;
    WaterModule water;
    ElectricityModule power;
    GasModule gas;
    EVChargingModule ev;
    ParkingModule parking;
    ClubhouseModule club;
    WasteModule waste;
    SecurityModule security;

    address admin = address(this);
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address mallory = makeAddr("mallory");

    uint32 constant OCT = 202610;
    uint32 constant NOV = 202611;
    uint256 constant WEI_PER_PAISE = 1e10;

    receive() external payable {}

    function setUp() public {
        registry = new ResidentRegistry();
        escrow = new CommunityEscrow(address(registry), WEI_PER_PAISE);
        water = new WaterModule(address(registry), address(escrow));
        power = new ElectricityModule(address(registry), address(escrow));
        gas = new GasModule(address(registry), address(escrow));
        ev = new EVChargingModule(address(registry), address(escrow));
        parking = new ParkingModule(address(registry), address(escrow));
        club = new ClubhouseModule(address(registry), address(escrow));
        waste = new WasteModule(address(registry), address(escrow));
        security = new SecurityModule(address(registry), address(escrow));

        address[] memory mods = new address[](8);
        mods[0] = address(water);
        mods[1] = address(power);
        mods[2] = address(gas);
        mods[3] = address(ev);
        mods[4] = address(parking);
        mods[5] = address(club);
        mods[6] = address(waste);
        mods[7] = address(security);
        escrow.setModules(mods, true);

        registry.registerResident(alice, "A-101");
        registry.registerResident(bob, "B-202");
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    // ============================================================ registry

    function test_registry_roles() public view {
        assertTrue(registry.isAdmin(admin));
        assertTrue(registry.isActiveResident(alice));
        assertEq(registry.unitOf(bob), "B-202");
        assertEq(registry.residentCount(), 2);
    }

    function test_registry_rejectsDuplicateUnitAndNonAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(ResidentRegistry.UnitTaken.selector, "A-101"));
        registry.registerResident(mallory, "A-101");

        vm.prank(mallory);
        vm.expectRevert(ResidentRegistry.NotAdmin.selector);
        registry.registerResident(mallory, "Z-999");
    }

    function test_registry_deactivatedResidentCannotBeBilled() public {
        registry.setResidentActive(bob, false);
        vm.expectRevert(abi.encodeWithSelector(BaseModule.NotActiveResident.selector, bob));
        water.logUsage(bob, OCT, 100, bytes32(0));
    }

    // ============================================================ formulas

    function test_water_tiers() public view {
        assertEq(water.calculateBill(alice, 10_000), 50_000); // 10k L * Rs0.05 = Rs500
        assertEq(water.calculateBill(alice, 15_000), 75_000); // Rs750
        // 15k at 0.05 + 5k at 0.08 = 750 + 400 = Rs1150
        assertEq(water.calculateBill(alice, 20_000), 115_000);
    }

    function test_electricity_slabs() public view {
        assertEq(power.calculateBill(alice, 80), 24_000); // 80*3 = Rs240
        assertEq(power.calculateBill(alice, 250), 105_000); // 300 + 150*5 = Rs1050
        assertEq(power.calculateBill(alice, 350), 165_000); // 300 + 1000 + 50*7 = Rs1650
    }

    function test_gas_ev_scaled_units() public view {
        assertEq(gas.calculateBill(alice, 1250), 50_000); // 12.50 m3 * Rs40 = Rs500
        assertEq(ev.calculateBill(alice, 4525), 36_200); // 45.25 kWh * Rs8 = Rs362
    }

    function test_parking_owned_and_visitor() public {
        assertEq(parking.calculateBill(alice, 3), 6_000); // 3 visitor hours, no slot
        parking.assignSlot(alice, "P-12");
        assertEq(parking.calculateBill(alice, 3), 56_000); // Rs500 + Rs60
    }

    function test_flat_modules_ignore_usage() public view {
        assertEq(waste.calculateBill(alice, 0), 15_000);
        assertEq(waste.calculateBill(alice, 30), 15_000);
        assertEq(security.calculateBill(alice, 999), 30_000);
    }

    function test_admin_can_change_rates() public {
        water.setRates(10_000, 6, 10);
        assertEq(water.calculateBill(alice, 12_000), 10_000 * 6 + 2_000 * 10);
        vm.prank(mallory);
        vm.expectRevert(BaseModule.NotAdmin.selector);
        water.setRates(1, 1, 1);
    }

    // ===================================================== usage logging

    function test_usage_hash_chain_is_recomputable() public {
        bytes32 h1 = keccak256("readings batch 1");
        bytes32 h2 = keccak256("readings batch 2");
        water.logUsage(alice, OCT, 4_000, h1);
        water.logUsage(alice, OCT, 6_000, h2);

        BaseModule.UsageRecord memory r = water.getRecord(alice, OCT);
        assertEq(r.usage, 10_000);
        assertEq(r.batches, 2);
        bytes32 expected = keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), h1)), h2));
        assertEq(r.dataHash, expected);
    }

    function test_batch_logging_and_length_check() public {
        address[] memory who = new address[](2);
        who[0] = alice;
        who[1] = bob;
        uint256[] memory amt = new uint256[](2);
        amt[0] = 120;
        amt[1] = 340;
        bytes32[] memory hs = new bytes32[](2);
        power.logUsageBatch(OCT, who, amt, hs);
        assertEq(power.getRecord(bob, OCT).usage, 340);

        uint256[] memory bad = new uint256[](1);
        vm.expectRevert(BaseModule.LengthMismatch.selector);
        power.logUsageBatch(OCT, who, bad, hs);
    }

    function test_only_admin_can_log_and_bad_month_rejected() public {
        vm.prank(alice);
        vm.expectRevert(BaseModule.NotAdmin.selector);
        water.logUsage(alice, OCT, 1, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(BaseModule.InvalidMonth.selector, uint32(202613)));
        water.logUsage(alice, 202613, 1, bytes32(0));
    }

    function test_cannot_log_or_bill_twice_after_finalize() public {
        water.logUsage(alice, OCT, 1_000, bytes32(0));
        water.finalizeBill(alice, OCT);
        vm.expectRevert(abi.encodeWithSelector(BaseModule.AlreadyBilled.selector, alice, OCT));
        water.logUsage(alice, OCT, 1, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(BaseModule.AlreadyBilled.selector, alice, OCT));
        water.finalizeBill(alice, OCT);
    }

    // ====================================================== clubhouse

    function test_clubhouse_booking_by_resident() public {
        uint64 slot = 1_791_000_000 - ((1_791_000_000 + 19_800) % 7200); // even hour IST
        vm.prank(alice);
        club.book(0, slot, OCT);
        assertEq(club.getRecord(alice, OCT).usage, 1);
        assertFalse(club.isSlotFree(0, slot));
        assertTrue(club.isSlotFree(1, slot)); // other amenity free

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ClubhouseModule.SlotNotAligned.selector, slot + 3600));
        club.book(1, slot + 3600, OCT);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(ClubhouseModule.SlotTaken.selector, uint8(0), slot));
        club.book(0, slot, OCT);

        vm.prank(mallory); // not a resident
        vm.expectRevert(abi.encodeWithSelector(BaseModule.NotActiveResident.selector, mallory));
        club.book(1, slot, OCT);
    }

    // ========================================================== escrow

    function _billAliceOctober() internal returns (uint256 totalPaise) {
        water.logUsage(alice, OCT, 12_000, bytes32(0)); // Rs600
        power.logUsage(alice, OCT, 150, bytes32(0)); // 300 + 250 = Rs550
        water.finalizeBill(alice, OCT);
        power.finalizeBill(alice, OCT);
        waste.finalizeBill(alice, OCT); // Rs150
        return 60_000 + 55_000 + 15_000; // Rs1300
    }

    function test_escrow_only_modules_can_add_bills() public {
        vm.expectRevert(CommunityEscrow.NotModule.selector);
        escrow.addBill(alice, keccak256("WATER"), OCT, 100);
    }

    function test_escrow_non_resident_cannot_deposit() public {
        vm.deal(mallory, 1 ether);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(CommunityEscrow.NotActiveResident.selector, mallory));
        escrow.deposit{value: 1 ether}();
    }

    /// Rules 1-4: deposit buffer, bill, admin takes exact amount, excess carries forward.
    function test_escrow_settle_exact_and_excess_carries_forward() public {
        vm.prank(alice);
        escrow.deposit{value: 0.002 ether}(); // = Rs2000 at 1e10 wei/paise

        uint256 total = _billAliceOctober();
        assertEq(escrow.outstandingPaise(alice), total);

        uint256 paid = escrow.settle(alice);
        assertEq(paid, total);
        assertEq(escrow.outstandingPaise(alice), 0);
        assertFalse(escrow.hasPendingDebt(alice));
        assertEq(escrow.collectedWei(), total * WEI_PER_PAISE);
        // Rs700 left over stays as buffer for November
        assertEq(escrow.balanceOf(alice), 0.002 ether - total * WEI_PER_PAISE);

        CommunityEscrow.Bill[] memory bills = escrow.getBillsOf(alice);
        assertEq(bills.length, 3);
        for (uint256 i = 0; i < bills.length; i++) {
            assertEq(bills[i].paidPaise, bills[i].amountPaise);
        }

        // admin withdraws what was collected
        uint256 before = address(this).balance;
        escrow.withdrawCollected(address(this), escrow.collectedWei());
        assertEq(address(this).balance - before, total * WEI_PER_PAISE);
        assertEq(escrow.collectedWei(), 0);
    }

    /// Rule 5: shortfall -> partial payment, debt flag, carried into next month.
    function test_escrow_shortfall_sets_debt_and_carries_to_next_month() public {
        vm.prank(alice);
        escrow.deposit{value: 0.001 ether}(); // Rs1000 < Rs1300 bill

        _billAliceOctober();
        escrow.settle(alice);
        assertEq(escrow.balanceOf(alice), 0);
        assertEq(escrow.outstandingPaise(alice), 30_000); // Rs300 short
        assertTrue(escrow.hasPendingDebt(alice));

        // oldest bills paid first: water (Rs600) full, electricity (Rs550) part-paid Rs400, waste unpaid
        CommunityEscrow.Bill[] memory bills = escrow.getBillsOf(alice);
        assertEq(bills[0].paidPaise, 60_000);
        assertEq(bills[1].paidPaise, 40_000);
        assertEq(bills[2].paidPaise, 0);

        // November: Rs150 waste bill + carried Rs300 debt
        waste.finalizeBill(alice, NOV);
        assertEq(escrow.outstandingPaise(alice), 45_000);

        vm.prank(alice);
        escrow.deposit{value: 0.001 ether}();
        escrow.settle(alice);
        assertEq(escrow.outstandingPaise(alice), 0);
        assertFalse(escrow.hasPendingDebt(alice));
        assertEq(escrow.balanceOf(alice), 0.001 ether - 45_000 * WEI_PER_PAISE);
    }

    function test_escrow_resident_can_self_settle_but_not_others() public {
        vm.prank(alice);
        escrow.deposit{value: 0.01 ether}();
        _billAliceOctober();

        vm.prank(bob);
        vm.expectRevert(CommunityEscrow.NotAuthorized.selector);
        escrow.settle(alice);

        vm.prank(alice);
        escrow.settle(alice);
        assertEq(escrow.outstandingPaise(alice), 0);
    }

    function test_escrow_withdraw_excess_blocked_while_owing() public {
        vm.prank(alice);
        escrow.deposit{value: 0.01 ether}();
        _billAliceOctober();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CommunityEscrow.HasOutstanding.selector, uint256(130_000)));
        escrow.withdrawExcess(1);

        escrow.settle(alice);
        uint256 bal = escrow.balanceOf(alice);
        uint256 before = alice.balance;
        vm.prank(alice);
        escrow.withdrawExcess(bal);
        assertEq(alice.balance - before, bal);
        assertEq(escrow.balanceOf(alice), 0);
    }

    function test_escrow_settleAll() public {
        vm.prank(alice);
        escrow.deposit{value: 0.01 ether}();
        vm.prank(bob);
        escrow.deposit{value: 0.01 ether}();
        _billAliceOctober();
        security.finalizeBill(bob, OCT);

        uint256 total = escrow.settleAll();
        assertEq(total, 130_000 + 30_000);
        assertEq(escrow.outstandingPaise(alice) + escrow.outstandingPaise(bob), 0);
    }

    function test_escrow_settle_with_empty_balance_flags_debt() public {
        _billAliceOctober();
        uint256 paid = escrow.settle(alice);
        assertEq(paid, 0);
        assertTrue(escrow.hasPendingDebt(alice));
    }

    function test_account_summary() public {
        vm.prank(alice);
        escrow.deposit{value: 0.001 ether}();
        _billAliceOctober();
        (uint256 bal, uint256 owedP, uint256 owedW, bool debt, uint256 n) = escrow.accountSummary(alice);
        assertEq(bal, 0.001 ether);
        assertEq(owedP, 130_000);
        assertEq(owedW, 130_000 * WEI_PER_PAISE);
        assertFalse(debt);
        assertEq(n, 3);
    }

    /// Fuzz: whatever the deposit and usage, money is conserved and debt flag matches outstanding.
    function testFuzz_escrow_conservation(uint96 depositWei, uint32 litres, uint16 units) public {
        vm.assume(depositWei > 0 && depositWei <= 5 ether);
        vm.prank(alice);
        escrow.deposit{value: depositWei}();
        water.logUsage(alice, OCT, litres, bytes32(0));
        power.logUsage(alice, OCT, units, bytes32(0));
        water.finalizeBill(alice, OCT);
        power.finalizeBill(alice, OCT);
        uint256 billed = escrow.outstandingPaise(alice);

        uint256 paid = escrow.settle(alice);
        assertEq(paid + escrow.outstandingPaise(alice), billed);
        assertEq(escrow.balanceOf(alice) + escrow.collectedWei(), depositWei);
        assertEq(escrow.hasPendingDebt(alice), escrow.outstandingPaise(alice) > 0);
        assertEq(address(escrow).balance, depositWei);
    }
}
