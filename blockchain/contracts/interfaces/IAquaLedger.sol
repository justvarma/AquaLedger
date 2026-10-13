// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only view of the shared ResidentRegistry used by every module and the escrow.
interface IResidentRegistry {
    function isAdmin(address account) external view returns (bool);
    function isActiveResident(address wallet) external view returns (bool);
    function isRegistered(address wallet) external view returns (bool);
    function getResidents() external view returns (address[] memory);
}

/// @notice The part of CommunityEscrow that module contracts call into.
interface ICommunityEscrow {
    function addBill(address resident, bytes32 moduleKey, uint32 month, uint256 amountPaise)
        external
        returns (uint256 billId);
}
