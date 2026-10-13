// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

/// @title ParkingModule
/// @notice Owned slot: Rs 500 flat per month. Visitor parking: Rs 20 per hour.
///         Usage = visitor hours in the month.
contract ParkingModule is BaseModule {
    uint256 public ownedSlotFeePaise = 50_000; // Rs 500
    uint256 public visitorRatePaisePerHour = 2_000; // Rs 20

    mapping(address => string) public ownedSlot; // resident => slot label ("" = none)

    event SlotAssigned(address indexed resident, string slot);

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "PARKING", "visitor hours") {}

    function assignSlot(address resident, string calldata slot) external onlyAdmin {
        ownedSlot[resident] = slot;
        emit SlotAssigned(resident, slot);
    }

    function setRates(uint256 slotFeePaise, uint256 visitorPaisePerHour) external onlyAdmin {
        ownedSlotFeePaise = slotFeePaise;
        visitorRatePaisePerHour = visitorPaisePerHour;
        emit RatesUpdated();
    }

    function hasOwnedSlot(address resident) public view returns (bool) {
        return bytes(ownedSlot[resident]).length > 0;
    }

    function calculateBill(address resident, uint256 visitorHours) public view override returns (uint256) {
        uint256 flat = hasOwnedSlot(resident) ? ownedSlotFeePaise : 0;
        return flat + visitorHours * visitorRatePaisePerHour;
    }
}
