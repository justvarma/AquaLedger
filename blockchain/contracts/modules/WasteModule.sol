// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

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
