"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canExecuteLiveTransactions = canExecuteLiveTransactions;
function canExecuteLiveTransactions(config) {
    return (config.network === 'testnet' || (config.network === 'mainnet' && config.enableMainnetExecution));
}
