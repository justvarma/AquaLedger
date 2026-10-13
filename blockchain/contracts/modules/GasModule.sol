// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

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
