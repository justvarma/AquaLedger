// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

/// @title ClubhouseModule
/// @notice Rs 200 per 2-hour slot. Usage = number of bookings in the month.
///         Residents book directly from the dashboard (book()), so every booking is on-chain;
///         an admin can also log bookings made at the front desk with logUsage().
contract ClubhouseModule is BaseModule {
    uint256 public ratePaisePerSlot = 20_000; // Rs 200
    uint256 public constant SLOT_SECONDS = 2 hours;
    // Slots start on even hours India time (UTC+5:30): 06:00, 08:00, ... IST
    uint256 public constant TZ_OFFSET = 5 hours + 30 minutes;

    // 0 = Gym, 1 = Party hall, 2 = Pool  (add more by raising amenityCount)
    uint8 public amenityCount = 3;
    mapping(bytes32 => address) public slotBookedBy; // keccak(amenity, slotStart) => resident

    event Booked(address indexed resident, uint8 indexed amenity, uint64 slotStart, uint32 month);

    error InvalidAmenity(uint8 amenity);
    error SlotNotAligned(uint64 slotStart);
    error SlotTaken(uint8 amenity, uint64 slotStart);

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "CLUBHOUSE", "bookings") {}

    function setRate(uint256 paisePerSlot) external onlyAdmin {
        ratePaisePerSlot = paisePerSlot;
        emit RatesUpdated();
    }

    function setAmenityCount(uint8 count) external onlyAdmin {
        amenityCount = count;
    }

    /// @param slotStart unix time of the slot start; must sit on an even hour in IST (e.g. 18:00 IST).
    /// @param month     billing month (YYYYMM) this booking belongs to.
    function book(uint8 amenity, uint64 slotStart, uint32 month) external validMonth(month) {
        if (amenity >= amenityCount) revert InvalidAmenity(amenity);
        if ((slotStart + TZ_OFFSET) % SLOT_SECONDS != 0) revert SlotNotAligned(slotStart);
        bytes32 key = keccak256(abi.encodePacked(amenity, slotStart));
        if (slotBookedBy[key] != address(0)) revert SlotTaken(amenity, slotStart);
        slotBookedBy[key] = msg.sender;
        _log(msg.sender, month, 1, keccak256(abi.encodePacked(msg.sender, amenity, slotStart)));
        emit Booked(msg.sender, amenity, slotStart, month);
    }

    function isSlotFree(uint8 amenity, uint64 slotStart) external view returns (bool) {
        return slotBookedBy[keccak256(abi.encodePacked(amenity, slotStart))] == address(0);
    }

    function calculateBill(address, uint256 bookings) public view override returns (uint256) {
        return bookings * ratePaisePerSlot;
    }
}
