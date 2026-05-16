"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitorWorker = void 0;
exports.startMonitoring = startMonitoring;
exports.stopMonitoring = stopMonitoring;
const velocityGuard_1 = require("../risk/velocityGuard");
const sqlite_1 = require("../db/sqlite");
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
class MonitorWorker {
    options;
    interval = null;
    lastAlertTimestamps = new Map();
    logger;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? console;
    }
    startMonitoring() {
        if (this.interval !== null) {
            return;
        }
        void this.pollAllPools();
        this.interval = setInterval(() => {
            void this.pollAllPools();
        }, this.options.intervalSeconds * 1000);
        this.logger.log(`TonShield monitor started (${this.options.intervalSeconds}s interval).`);
    }
    stopMonitoring() {
        if (this.interval !== null) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    async pollAllPools() {
        const watchedPools = (0, sqlite_1.listWatchedPools)(this.options.db);
        for (const watchedPool of watchedPools) {
            try {
                const poolData = await this.options.stonClient.getPoolData(watchedPool.pool_address);
                this.options.velocityGuard.recordSnapshot(watchedPool.pool_address, poolData.depthTon);
                const velocity = this.options.velocityGuard.calculateVelocityDrop(watchedPool.pool_address);
                const riskSettings = (0, sqlite_1.getRiskSettings)(this.options.db, watchedPool.user_id, watchedPool.pool_address);
                if (riskSettings !== undefined && riskSettings.entry_price_ton !== null) {
                    const tokenAddress = poolData.tokenAddresses[0] ?? 'unknown';
                    const currentPriceTon = await this.options.stonClient.getTokenPrice(tokenAddress);
                    const priceCheck = (0, velocityGuard_1.checkPriceTargets)(riskSettings.entry_price_ton, currentPriceTon, riskSettings.take_profit_percent, riskSettings.stop_loss_percent);
                    if (priceCheck.shouldTakeProfit &&
                        this.shouldAlert(watchedPool.user_id, watchedPool.pool_address, 'tp')) {
                        await this.executePriceTargetExit(watchedPool.user_id, watchedPool.pool_address, tokenAddress, `🎯 Take profit target reached for ${watchedPool.pool_address}. Executing exit.`);
                    }
                    if (priceCheck.shouldStopLoss &&
                        this.shouldAlert(watchedPool.user_id, watchedPool.pool_address, 'sl')) {
                        await this.executePriceTargetExit(watchedPool.user_id, watchedPool.pool_address, tokenAddress, `🛡️ Stop loss triggered for ${watchedPool.pool_address}. Executing protective exit.`);
                    }
                }
                if (velocity === null || !velocity.isBreached) {
                    continue;
                }
                if (!this.shouldAlert(watchedPool.user_id, watchedPool.pool_address)) {
                    continue;
                }
                await this.options.triggerEngine.handleBreach(watchedPool.user_id, watchedPool.pool_address, velocity, poolData.tokenAddresses[0] ?? 'unknown', 1);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown monitor error.';
                this.logger.error(`Monitor poll failed for ${watchedPool.pool_address}: ${message}`);
            }
        }
    }
    shouldAlert(userId, poolAddress, prefix) {
        const key = prefix === undefined ? `${userId}:${poolAddress}` : `${prefix}:${userId}:${poolAddress}`;
        const last = this.lastAlertTimestamps.get(key);
        const now = Date.now();
        if (last === undefined || now - last >= ALERT_COOLDOWN_MS) {
            this.lastAlertTimestamps.set(key, now);
            return true;
        }
        return false;
    }
    async executePriceTargetExit(userId, poolAddress, tokenAddress, alertMessage) {
        const internals = this.options.triggerEngine;
        const telegram = this.options.telegram ?? internals.options?.telegram;
        const swapExecutor = this.options.swapExecutor ?? internals.options?.swapExecutor;
        await telegram?.sendMessage(userId, alertMessage);
        await swapExecutor?.executeDefensiveSwap(userId, poolAddress, tokenAddress, 1);
    }
}
exports.MonitorWorker = MonitorWorker;
function startMonitoring(worker) {
    worker.startMonitoring();
}
function stopMonitoring(worker) {
    worker.stopMonitoring();
}
