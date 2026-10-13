// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

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
