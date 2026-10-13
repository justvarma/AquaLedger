// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// contracts/interfaces/IAquaLedger.sol

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

// contracts/modules/BaseModule.sol

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

// contracts/CommunityEscrow.sol

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

// contracts/ResidentRegistry.sol

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

// contracts/modules/ClubhouseModule.sol

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

// contracts/modules/EVChargingModule.sol

/// @title EVChargingModule
/// @notice Rs 8 per kWh charged. Usage is logged in hundredths of a kWh (1550 = 15.50 kWh).
///         Each logged batch is normally one charging session.
contract EVChargingModule is BaseModule {
    uint256 public constant SCALE = 100;
    uint256 public ratePaisePerKWh = 800; // Rs 8

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "EV_CHARGING", "kWh x100") {}

    function setRate(uint256 paisePerKWh) external onlyAdmin {
        ratePaisePerKWh = paisePerKWh;
        emit RatesUpdated();
    }

    function calculateBill(address, uint256 centiKWh) public view override returns (uint256) {
        return (centiKWh * ratePaisePerKWh) / SCALE;
    }
}

// contracts/modules/ElectricityModule.sol

/// @title ElectricityModule
/// @notice Usage in units (kWh). Slab billing:
///         units 1-100 at Rs 3, units 101-300 at Rs 5, units above 300 at Rs 7.
contract ElectricityModule is BaseModule {
    uint256 public slab1Limit = 100;
    uint256 public slab2Limit = 300;
    uint256 public slab1RatePaise = 300;
    uint256 public slab2RatePaise = 500;
    uint256 public slab3RatePaise = 700;

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "ELECTRICITY", "kWh") {}

    function setRates(uint256 limit1, uint256 limit2, uint256 rate1, uint256 rate2, uint256 rate3)
        external
        onlyAdmin
    {
        require(limit1 < limit2, "slab limits");
        slab1Limit = limit1;
        slab2Limit = limit2;
        slab1RatePaise = rate1;
        slab2RatePaise = rate2;
        slab3RatePaise = rate3;
        emit RatesUpdated();
    }

    function calculateBill(address, uint256 units) public view override returns (uint256 bill) {
        if (units <= slab1Limit) return units * slab1RatePaise;
        bill = slab1Limit * slab1RatePaise;
        if (units <= slab2Limit) return bill + (units - slab1Limit) * slab2RatePaise;
        bill += (slab2Limit - slab1Limit) * slab2RatePaise;
        bill += (units - slab2Limit) * slab3RatePaise;
    }
}

// contracts/modules/GasModule.sol

/// @title GasModule
/// @notice Rs 40 per cubic metre. Solidity has no decimals, so usage is logged in
///         hundredths of a cubic metre (1234 = 12.34 m3).
contract GasModule is BaseModule {
    uint256 public constant SCALE = 100;
    uint256 public ratePaisePerM3 = 4000; // Rs 40

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "GAS", "m3 x100") {}

    function setRate(uint256 paisePerM3) external onlyAdmin {
        ratePaisePerM3 = paisePerM3;
        emit RatesUpdated();
    }

    function calculateBill(address, uint256 centiM3) public view override returns (uint256) {
        return (centiM3 * ratePaisePerM3) / SCALE;
    }
}

// contracts/modules/ParkingModule.sol

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

// contracts/modules/SecurityModule.sol

/// @title SecurityModule
/// @notice Flat Rs 300 per unit per month. Usage = gate access events logged for the unit
///         (visitor entries, deliveries) - recorded for transparency, not billed.
contract SecurityModule is BaseModule {
    uint256 public flatFeePaise = 30_000; // Rs 300

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "SECURITY", "access events") {}

    function setFlatFee(uint256 paise) external onlyAdmin {
        flatFeePaise = paise;
        emit RatesUpdated();
    }

    function calculateBill(address, uint256) public view override returns (uint256) {
        return flatFeePaise;
    }
}

// contracts/modules/WasteModule.sol

/// @title WasteModule
/// @notice Flat Rs 150 per unit per month. Usage = number of collections logged, kept on-chain
///         purely for transparency (residents can see the collector actually came).
contract WasteModule is BaseModule {
    uint256 public flatFeePaise = 15_000; // Rs 150

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "WASTE", "collections") {}

    function setFlatFee(uint256 paise) external onlyAdmin {
        flatFeePaise = paise;
        emit RatesUpdated();
    }

    function calculateBill(address, uint256) public view override returns (uint256) {
        return flatFeePaise;
    }
}

// contracts/modules/WaterModule.sol

/// @title WaterModule
/// @notice Usage in litres. Rs 0.05/L up to 15,000 L a month, Rs 0.08/L for every litre above that.
///         (Tier 2 applies only to the litres above the threshold, like a tax slab.)
contract WaterModule is BaseModule {
    uint256 public tier1LimitLitres = 15_000;
    uint256 public tier1RatePaise = 5; // Rs 0.05 per litre
    uint256 public tier2RatePaise = 8; // Rs 0.08 per litre

    constructor(address registry_, address escrow_) BaseModule(registry_, escrow_, "WATER", "litres") {}

    function setRates(uint256 limitLitres, uint256 rate1Paise, uint256 rate2Paise) external onlyAdmin {
        tier1LimitLitres = limitLitres;
        tier1RatePaise = rate1Paise;
        tier2RatePaise = rate2Paise;
        emit RatesUpdated();
    }

    function calculateBill(address, uint256 litres) public view override returns (uint256) {
        if (litres <= tier1LimitLitres) return litres * tier1RatePaise;
        return tier1LimitLitres * tier1RatePaise + (litres - tier1LimitLitres) * tier2RatePaise;
    }
}

// contracts/_AllForRemix.sol
