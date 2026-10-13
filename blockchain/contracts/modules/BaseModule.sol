// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResidentRegistry, ICommunityEscrow} from "../interfaces/IAquaLedger.sol";

/// @title BaseModule
/// @notice Shared logic for every AquaLedger module (water, electricity, gas, ...).
///
/// What lives on-chain per resident per month:
///   - `usage`      running total of usage pushed by the data feed (unit depends on module)
///   - `batches`    how many reading batches were logged
///   - `dataHash`   hash chain over every off-chain reading batch:
///                  dataHash = keccak256(previousDataHash, batchHash)
///                  Anyone holding the raw readings in the off-chain DB can recompute this chain and
///                  prove the readings were not edited after they were logged.
///   - `billPaise`  the final bill, computed by the module's own formula, then posted to the escrow.
///
/// Raw readings themselves stay off-chain (KT section 9) to keep gas low.
abstract contract BaseModule {
    struct UsageRecord {
        uint256 usage;
        uint32 batches;
        bytes32 dataHash;
        uint64 updatedAt;
        uint256 billPaise;
        bool billed;
        uint256 billId; // id in CommunityEscrow (valid only when billed)
    }

    IResidentRegistry public immutable registry;
    ICommunityEscrow public immutable escrow;
    bytes32 public immutable moduleKey;
    string public moduleName;
    string public usageUnit;

    mapping(address => mapping(uint32 => UsageRecord)) internal records;

    event UsageLogged(
        address indexed resident, uint32 indexed month, uint256 delta, uint256 newTotal, bytes32 batchHash, bytes32 dataHash
    );
    event BillFinalized(address indexed resident, uint32 indexed month, uint256 usage, uint256 billPaise, uint256 billId);
    event RatesUpdated();

    error NotAdmin();
    error NotActiveResident(address wallet);
    error InvalidMonth(uint32 month);
    error AlreadyBilled(address resident, uint32 month);
    error LengthMismatch();

    modifier onlyAdmin() {
        if (!registry.isAdmin(msg.sender)) revert NotAdmin();
        _;
    }

    modifier validMonth(uint32 month) {
        uint32 mm = month % 100;
        if (mm == 0 || mm > 12 || month < 200001) revert InvalidMonth(month);
        _;
    }

    constructor(address registry_, address escrow_, string memory name_, string memory unit_) {
        registry = IResidentRegistry(registry_);
        escrow = ICommunityEscrow(escrow_);
        moduleName = name_;
        usageUnit = unit_;
        moduleKey = keccak256(bytes(name_));
    }

    // --------------------------------------------------------- usage logging

    /// @notice Data feed (an admin/oracle wallet) logs one batch of readings for a resident.
    /// @param delta      usage contained in this batch (in this module's unit)
    /// @param batchHash  keccak256 of the raw off-chain readings in this batch
    function logUsage(address resident, uint32 month, uint256 delta, bytes32 batchHash)
        public
        onlyAdmin
        validMonth(month)
    {
        _log(resident, month, delta, batchHash);
    }

    /// @notice Same as logUsage, for many residents in one transaction (saves gas on Sepolia).
    function logUsageBatch(
        uint32 month,
        address[] calldata residents_,
        uint256[] calldata deltas,
        bytes32[] calldata batchHashes
    ) external onlyAdmin validMonth(month) {
        if (residents_.length != deltas.length || deltas.length != batchHashes.length) revert LengthMismatch();
        for (uint256 i = 0; i < residents_.length; i++) {
            _log(residents_[i], month, deltas[i], batchHashes[i]);
        }
    }

    function _log(address resident, uint32 month, uint256 delta, bytes32 batchHash) internal {
        if (!registry.isActiveResident(resident)) revert NotActiveResident(resident);
        UsageRecord storage r = records[resident][month];
        if (r.billed) revert AlreadyBilled(resident, month);
        r.usage += delta;
        r.batches += 1;
        r.dataHash = keccak256(abi.encodePacked(r.dataHash, batchHash));
        r.updatedAt = uint64(block.timestamp);
        emit UsageLogged(resident, month, delta, r.usage, batchHash, r.dataHash);
    }

    // --------------------------------------------------------------- billing

    /// @notice Month end: compute the bill with this module's formula and post it to the escrow.
    function finalizeBill(address resident, uint32 month) public onlyAdmin validMonth(month) returns (uint256) {
        return _finalize(resident, month);
    }

    function finalizeBills(uint32 month, address[] calldata residents_) external onlyAdmin validMonth(month) {
        for (uint256 i = 0; i < residents_.length; i++) {
            _finalize(residents_[i], month);
        }
    }

    function _finalize(address resident, uint32 month) internal returns (uint256 bill) {
        if (!registry.isActiveResident(resident)) revert NotActiveResident(resident);
        UsageRecord storage r = records[resident][month];
        if (r.billed) revert AlreadyBilled(resident, month);
        bill = calculateBill(resident, r.usage);
        r.billPaise = bill;
        r.billed = true;
        r.updatedAt = uint64(block.timestamp);
        r.billId = escrow.addBill(resident, moduleKey, month, bill);
        emit BillFinalized(resident, month, r.usage, bill, r.billId);
    }

    // ----------------------------------------------------------------- views

    function getRecord(address resident, uint32 month) external view returns (UsageRecord memory) {
        return records[resident][month];
    }

    /// @notice What the bill would be right now, before month end.
    function previewBill(address resident, uint32 month) external view returns (uint256) {
        return calculateBill(resident, records[resident][month].usage);
    }

    /// @notice Each module implements its own billing formula (KT section 7). Amount in paise.
    function calculateBill(address resident, uint256 usage) public view virtual returns (uint256);
}
