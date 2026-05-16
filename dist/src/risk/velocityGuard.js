"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VelocityGuard = void 0;
exports.checkPriceTargets = checkPriceTargets;
const sqlite_1 = require("../db/sqlite");
class VelocityGuard {
    db;
    riskDropThresholdPercent;
    constructor(db, riskDropThresholdPercent) {
        this.db = db;
        this.riskDropThresholdPercent = riskDropThresholdPercent;
    }
    recordSnapshot(poolAddress, depthTon) {
        if (!Number.isFinite(depthTon) || depthTon < 0) {
            throw new Error('depthTon must be a non-negative number.');
        }
        (0, sqlite_1.execute)(this.db, 'INSERT INTO pool_snapshots (pool_address, depth_ton) VALUES (?, ?)', poolAddress, depthTon);
        (0, sqlite_1.execute)(this.db, `
        DELETE FROM pool_snapshots
        WHERE pool_address = ?
          AND id NOT IN (
            SELECT id
            FROM pool_snapshots
            WHERE pool_address = ?
            ORDER BY captured_at DESC, id DESC
            LIMIT 10
          )
      `, poolAddress, poolAddress);
    }
    calculateVelocityDrop(poolAddress) {
        const newestFirst = (0, sqlite_1.getAll)(this.db, `
        SELECT *
        FROM pool_snapshots
        WHERE pool_address = ?
        ORDER BY captured_at DESC, id DESC
        LIMIT 8
      `, poolAddress);
        if (newestFirst.length < 3) {
            return null;
        }
        const chronological = [...newestFirst].reverse();
        const drops = chronological.slice(1).map((snapshot, index) => {
            const previous = chronological[index];
            if (previous === undefined || previous.depth_ton <= 0) {
                return 0;
            }
            const drop = ((previous.depth_ton - snapshot.depth_ton) / previous.depth_ton) * 100;
            return Math.max(0, drop);
        });
        const rollingDropPercent = drops.length === 0 ? 0 : drops.reduce((sum, drop) => sum + drop, 0) / drops.length;
        const maxSingleDrop = drops.length === 0 ? 0 : Math.max(...drops);
        return {
            rollingDropPercent,
            maxSingleDrop,
            snapshotCount: newestFirst.length,
            isBreached: rollingDropPercent >= this.riskDropThresholdPercent,
        };
    }
}
exports.VelocityGuard = VelocityGuard;
function checkPriceTargets(entryPriceTon, currentPriceTon, takeProfitPercent, stopLossPercent) {
    if (entryPriceTon <= 0 || currentPriceTon < 0) {
        return {
            shouldTakeProfit: false,
            shouldStopLoss: false,
            currentPriceChangePct: 0,
        };
    }
    const currentPriceChangePct = ((currentPriceTon - entryPriceTon) / entryPriceTon) * 100;
    return {
        shouldTakeProfit: currentPriceChangePct >= takeProfitPercent,
        shouldStopLoss: currentPriceChangePct <= -stopLossPercent,
        currentPriceChangePct,
    };
}
