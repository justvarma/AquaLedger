// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseModule} from "./BaseModule.sol";

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
