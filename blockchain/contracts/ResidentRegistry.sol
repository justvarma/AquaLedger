// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResidentRegistry} from "./interfaces/IAquaLedger.sol";

/// @title ResidentRegistry
/// @notice Shared identity layer for AquaLedger. Every module contract and the escrow
///         ask this contract "is this wallet an admin?" and "is this wallet an active resident?"
///         instead of keeping their own lists.
contract ResidentRegistry is IResidentRegistry {
    struct Resident {
        string unitNumber; // e.g. "A-101"
        bool active;
        uint64 registeredAt; // 0 = never registered
    }

    address public owner;
    mapping(address => bool) public override isAdmin;
    mapping(address => Resident) public residents;
    mapping(bytes32 => address) public unitToWallet; // keccak(unitNumber) => wallet
    address[] private residentList;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdminUpdated(address indexed account, bool isAdmin);
    event ResidentRegistered(address indexed wallet, string unitNumber);
    event ResidentStatusChanged(address indexed wallet, bool active);
    event ResidentUnitChanged(address indexed wallet, string oldUnit, string newUnit);

    error NotOwner();
    error NotAdmin();
    error ZeroAddress();
    error AlreadyRegistered(address wallet);
    error NotRegistered(address wallet);
    error UnitTaken(string unitNumber);
    error EmptyUnit();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert NotAdmin();
        _;
    }

    constructor() {
        owner = msg.sender;
        isAdmin[msg.sender] = true;
        emit OwnershipTransferred(address(0), msg.sender);
        emit AdminUpdated(msg.sender, true);
    }

    // ---------------------------------------------------------------- admins

    function setAdmin(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        isAdmin[account] = enabled;
        emit AdminUpdated(account, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
        isAdmin[newOwner] = true;
        emit AdminUpdated(newOwner, true);
    }

    // ------------------------------------------------------------- residents

    function registerResident(address wallet, string calldata unitNumber) external onlyAdmin {
        if (wallet == address(0)) revert ZeroAddress();
        if (bytes(unitNumber).length == 0) revert EmptyUnit();
        if (residents[wallet].registeredAt != 0) revert AlreadyRegistered(wallet);
        bytes32 unitKey = keccak256(bytes(unitNumber));
        if (unitToWallet[unitKey] != address(0)) revert UnitTaken(unitNumber);

        residents[wallet] = Resident({unitNumber: unitNumber, active: true, registeredAt: uint64(block.timestamp)});
        unitToWallet[unitKey] = wallet;
        residentList.push(wallet);
        emit ResidentRegistered(wallet, unitNumber);
    }

    function setResidentActive(address wallet, bool active) external onlyAdmin {
        if (residents[wallet].registeredAt == 0) revert NotRegistered(wallet);
        residents[wallet].active = active;
        emit ResidentStatusChanged(wallet, active);
    }

    function changeUnit(address wallet, string calldata newUnit) external onlyAdmin {
        Resident storage r = residents[wallet];
        if (r.registeredAt == 0) revert NotRegistered(wallet);
        if (bytes(newUnit).length == 0) revert EmptyUnit();
        bytes32 newKey = keccak256(bytes(newUnit));
        if (unitToWallet[newKey] != address(0)) revert UnitTaken(newUnit);

        string memory oldUnit = r.unitNumber;
        delete unitToWallet[keccak256(bytes(oldUnit))];
        unitToWallet[newKey] = wallet;
        r.unitNumber = newUnit;
        emit ResidentUnitChanged(wallet, oldUnit, newUnit);
    }

    // ----------------------------------------------------------------- views

    function isRegistered(address wallet) external view override returns (bool) {
        return residents[wallet].registeredAt != 0;
    }

    function isActiveResident(address wallet) external view override returns (bool) {
        return residents[wallet].active;
    }

    function getResidents() external view override returns (address[] memory) {
        return residentList;
    }

    function residentCount() external view returns (uint256) {
        return residentList.length;
    }

    function unitOf(address wallet) external view returns (string memory) {
        return residents[wallet].unitNumber;
    }
}
