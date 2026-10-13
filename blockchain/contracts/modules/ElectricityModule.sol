// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

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
