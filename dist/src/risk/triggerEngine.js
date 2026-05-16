"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TriggerEngine = void 0;
const sqlite_1 = require("../db/sqlite");
const riskScore_1 = require("./riskScore");
class TriggerEngine {
    options;
    defaultTokenAddress;
    defaultAmountTon;
    constructor(options) {
        this.options = options;
        this.defaultTokenAddress = options.defaultTokenAddress ?? 'unknown';
        this.defaultAmountTon = options.defaultAmountTon ?? 1;
    }
    async handleBreach(userId, poolAddress, velocityResult, tokenAddress = this.defaultTokenAddress, amountTon = this.defaultAmountTon) {
        const risk = (0, riskScore_1.scorePool)(velocityResult);
        (0, sqlite_1.insertRiskEvent)(this.options.db, userId, poolAddress, risk.level, risk.rollingDropPercent);
        await this.options.telegram.sendMessage(userId, [
            `TonShield AI alert: ${risk.level} risk detected.`,
            `Pool: ${poolAddress}`,
            `Rolling drop: ${risk.rollingDropPercent.toFixed(2)}%`,
            `Confidence: ${risk.confidence}`,
            `Recommendation: ${risk.recommendation}`,
        ].join('\n'));
        const armed = (0, sqlite_1.isPoolArmed)(this.options.db, userId, poolAddress);
        if (!armed) {
            return { riskLevel: risk.level, action: 'alert_only' };
        }
        if (this.options.config.network === 'mainnet' && !this.options.config.enableMainnetExecution) {
            const reason = 'Mainnet execution blocked because ENABLE_MAINNET_EXECUTION is not explicitly true.';
            this.options.swapExecutor.logBlockedMainnetAttempt(userId, poolAddress, tokenAddress, amountTon, reason);
            await this.options.telegram.sendMessage(userId, `Execution blocked: ${reason}`);
            return { riskLevel: risk.level, action: 'blocked_mainnet_guard' };
        }
        if (this.options.config.paperTrade) {
            await this.options.swapExecutor.simulateDefensiveSwap(userId, poolAddress, amountTon);
            return { riskLevel: risk.level, action: 'paper_simulated' };
        }
        if (this.options.config.network === 'testnet') {
            await this.options.swapExecutor.executeDefensiveSwap(userId, poolAddress, tokenAddress, amountTon);
            return { riskLevel: risk.level, action: 'testnet_executed' };
        }
        const reason = 'Mainnet execution requires an independent audit before this MVP should use it.';
        this.options.swapExecutor.logBlockedMainnetAttempt(userId, poolAddress, tokenAddress, amountTon, reason);
        await this.options.telegram.sendMessage(userId, `Execution blocked: ${reason}`);
        return { riskLevel: risk.level, action: 'blocked_mainnet_guard' };
    }
}
exports.TriggerEngine = TriggerEngine;
