// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

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
