// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResidentRegistry, ICommunityEscrow} from "./interfaces/IAquaLedger.sol";

/// @title CommunityEscrow
/// @notice One shared escrow for every AquaLedger module.
///
/// Escrow release rules (KT section 8):
///  1. Resident deposits a monthly buffer (ETH) upfront          -> deposit()
///  2. Each module contract posts the month-end bill here        -> addBill()   (modules only)
///  3. Admin withdraws exactly the billed amount from the buffer -> settle() / settleAll()
///  4. Any excess stays in the resident's balance (carries forward automatically)
///  5. If the balance is short, the unpaid part stays outstanding, the resident is
///     flagged with pending debt, and it is collected with next month's bills.
///
/// Bills are in paise (1 rupee = 100 paise). The escrow holds ETH, so `weiPerPaise`
/// converts between the two. Default demo rate: 1e9 wei per paise
/// (Rs 1 = 0.0000001 ETH, so a Rs 7,000 monthly bill is 0.0007 Sepolia ETH - keeps faucet ETH going a long way).
contract CommunityEscrow is ICommunityEscrow {
    struct Bill {
        address resident;
        bytes32 moduleKey; // keccak256("WATER"), keccak256("ELECTRICITY"), ...
        uint32 month; // YYYYMM, e.g. 202610
        uint128 amountPaise;
        uint128 paidPaise;
        uint64 createdAt;
    }

    IResidentRegistry public immutable registry;
    uint256 public weiPerPaise;

    mapping(address => bool) public isModule;
    mapping(address => uint256) public balanceOf; // resident buffer, in wei
    mapping(address => uint256) public outstandingPaise; // total unpaid bills (incl. carried debt)
    mapping(address => bool) public hasPendingDebt; // set when a settlement falls short

    Bill[] private bills;
    mapping(address => uint256[]) private billIdsOf;
    mapping(address => uint256) private nextUnpaid; // index into billIdsOf[resident] (oldest unpaid first)

    uint256 public collectedWei; // settled money waiting for an admin to withdraw
    uint256 private locked = 1;

    event ModuleUpdated(address indexed module, bool enabled);
    event RateUpdated(uint256 weiPerPaise);
    event Deposited(address indexed resident, uint256 amountWei, uint256 newBalanceWei);
    event ExcessWithdrawn(address indexed resident, uint256 amountWei);
    event BillAdded(
        uint256 indexed billId, address indexed resident, bytes32 indexed moduleKey, uint32 month, uint256 amountPaise
    );
    event BillPaid(uint256 indexed billId, address indexed resident, uint256 paidPaise, bool fullyPaid);
    event Settled(address indexed resident, uint256 paidPaise, uint256 paidWei, uint256 remainingPaise);
    event DebtFlagUpdated(address indexed resident, bool hasDebt, uint256 outstandingPaise);
    event CollectedWithdrawn(address indexed admin, address indexed to, uint256 amountWei);

    error NotAdmin();
    error NotModule();
    error NotAuthorized();
    error NotActiveResident(address wallet);
    error ZeroAmount();
    error InvalidMonth(uint32 month);
    error HasOutstanding(uint256 outstandingPaise);
    error InsufficientBalance(uint256 available, uint256 requested);
    error TransferFailed();
    error Reentrancy();

    modifier onlyAdmin() {
        if (!registry.isAdmin(msg.sender)) revert NotAdmin();
        _;
    }

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(address registry_, uint256 weiPerPaise_) {
        registry = IResidentRegistry(registry_);
        weiPerPaise = weiPerPaise_ == 0 ? 1e9 : weiPerPaise_;
        emit RateUpdated(weiPerPaise);
    }

    // ------------------------------------------------------------ admin setup

    function setModule(address module, bool enabled) public onlyAdmin {
        isModule[module] = enabled;
        emit ModuleUpdated(module, enabled);
    }

    /// @notice Convenience for Remix: authorise all 8 module contracts in one transaction.
    function setModules(address[] calldata modules, bool enabled) external onlyAdmin {
        for (uint256 i = 0; i < modules.length; i++) {
            setModule(modules[i], enabled);
        }
    }

    function setWeiPerPaise(uint256 newRate) external onlyAdmin {
        if (newRate == 0) revert ZeroAmount();
        weiPerPaise = newRate;
        emit RateUpdated(newRate);
    }

    // -------------------------------------------------------------- residents

    /// @notice Rule 1 - resident tops up their monthly buffer.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (!registry.isActiveResident(msg.sender)) revert NotActiveResident(msg.sender);
        balanceOf[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balanceOf[msg.sender]);
    }

    /// @notice A resident with no unpaid bills may take back part of their buffer.
    function withdrawExcess(uint256 amountWei) external nonReentrant {
        if (amountWei == 0) revert ZeroAmount();
        uint256 owed = outstandingPaise[msg.sender];
        if (owed != 0) revert HasOutstanding(owed);
        uint256 bal = balanceOf[msg.sender];
        if (amountWei > bal) revert InsufficientBalance(bal, amountWei);
        balanceOf[msg.sender] = bal - amountWei;
        emit ExcessWithdrawn(msg.sender, amountWei);
        _send(msg.sender, amountWei);
    }

    // ---------------------------------------------------------------- billing

    /// @notice Rule 2 - called by a module contract when it finalises a monthly bill.
    function addBill(address resident, bytes32 moduleKey, uint32 month, uint256 amountPaise)
        external
        override
        returns (uint256 billId)
    {
        if (!isModule[msg.sender]) revert NotModule();
        if (!registry.isRegistered(resident)) revert NotActiveResident(resident);
        if (month % 100 == 0 || month % 100 > 12) revert InvalidMonth(month);

        billId = bills.length;
        bills.push(
            Bill({
                resident: resident,
                moduleKey: moduleKey,
                month: month,
                amountPaise: uint128(amountPaise),
                paidPaise: 0,
                createdAt: uint64(block.timestamp)
            })
        );
        billIdsOf[resident].push(billId);
        outstandingPaise[resident] += amountPaise;
        emit BillAdded(billId, resident, moduleKey, month, amountPaise);
    }

    /// @notice Rules 3-5. Admin (or the resident themselves) settles everything currently owed.
    ///         Pays oldest bills first; partial payment if the buffer is short.
    function settle(address resident) public nonReentrant returns (uint256 paidPaise) {
        if (!registry.isAdmin(msg.sender) && msg.sender != resident) revert NotAuthorized();
        paidPaise = _settle(resident);
    }

    /// @notice Settle every registered resident in one transaction (fine for a demo-sized community).
    function settleAll() external onlyAdmin nonReentrant returns (uint256 totalPaidPaise) {
        address[] memory list = registry.getResidents();
        for (uint256 i = 0; i < list.length; i++) {
            if (outstandingPaise[list[i]] > 0) totalPaidPaise += _settle(list[i]);
        }
    }

    /// @notice Admin moves settled funds out of the escrow (e.g. to the society's account).
    function withdrawCollected(address to, uint256 amountWei) external onlyAdmin nonReentrant {
        if (amountWei == 0) revert ZeroAmount();
        if (amountWei > collectedWei) revert InsufficientBalance(collectedWei, amountWei);
        collectedWei -= amountWei;
        emit CollectedWithdrawn(msg.sender, to, amountWei);
        _send(to, amountWei);
    }

    // ------------------------------------------------------------------ views

    function billCount() external view returns (uint256) {
        return bills.length;
    }

    function getBill(uint256 billId) external view returns (Bill memory) {
        return bills[billId];
    }

    function getBillsOf(address resident) external view returns (Bill[] memory out) {
        uint256[] storage ids = billIdsOf[resident];
        out = new Bill[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = bills[ids[i]];
        }
    }

    function getBillIdsOf(address resident) external view returns (uint256[] memory) {
        return billIdsOf[resident];
    }

    function outstandingWei(address resident) external view returns (uint256) {
        return outstandingPaise[resident] * weiPerPaise;
    }

    /// @notice One call for the dashboard: buffer, amount owed, and debt flag.
    function accountSummary(address resident)
        external
        view
        returns (uint256 balanceWei, uint256 owedPaise, uint256 owedWei, bool pendingDebt, uint256 billTotal)
    {
        balanceWei = balanceOf[resident];
        owedPaise = outstandingPaise[resident];
        owedWei = owedPaise * weiPerPaise;
        pendingDebt = hasPendingDebt[resident];
        billTotal = billIdsOf[resident].length;
    }

    // --------------------------------------------------------------- internal

    function _settle(address resident) internal returns (uint256 paidPaise) {
        uint256 owed = outstandingPaise[resident];
        if (owed == 0) {
            _setDebtFlag(resident, false, 0);
            emit Settled(resident, 0, 0, 0);
            return 0;
        }

        uint256 affordablePaise = balanceOf[resident] / weiPerPaise;
        uint256 budget = affordablePaise < owed ? affordablePaise : owed;

        uint256[] storage ids = billIdsOf[resident];
        uint256 idx = nextUnpaid[resident];
        uint256 remainingBudget = budget;
        while (idx < ids.length && remainingBudget > 0) {
            Bill storage b = bills[ids[idx]];
            uint256 due = uint256(b.amountPaise) - b.paidPaise;
            uint256 pay = due <= remainingBudget ? due : remainingBudget;
            b.paidPaise += uint128(pay);
            remainingBudget -= pay;
            bool full = b.paidPaise == b.amountPaise;
            emit BillPaid(ids[idx], resident, pay, full);
            if (full) idx++;
            else break;
        }
        // skip zero-amount bills sitting at the head of the queue
        while (idx < ids.length && bills[ids[idx]].paidPaise == bills[ids[idx]].amountPaise) idx++;
        nextUnpaid[resident] = idx;

        paidPaise = budget - remainingBudget;
        uint256 paidWei = paidPaise * weiPerPaise;
        balanceOf[resident] -= paidWei;
        outstandingPaise[resident] = owed - paidPaise;
        collectedWei += paidWei;

        emit Settled(resident, paidPaise, paidWei, outstandingPaise[resident]);
        _setDebtFlag(resident, outstandingPaise[resident] > 0, outstandingPaise[resident]);
    }

    function _setDebtFlag(address resident, bool flag, uint256 owed) internal {
        if (hasPendingDebt[resident] != flag) {
            hasPendingDebt[resident] = flag;
        }
        emit DebtFlagUpdated(resident, flag, owed);
    }

    function _send(address to, uint256 amountWei) internal {
        (bool ok,) = payable(to).call{value: amountWei}("");
        if (!ok) revert TransferFailed();
    }
}
