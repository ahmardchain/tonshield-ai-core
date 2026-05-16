"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const velocityGuard_1 = require("../src/risk/velocityGuard");
let db;
function createGuard(threshold = 25) {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    return new velocityGuard_1.VelocityGuard(db, threshold);
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
});
(0, vitest_1.describe)('VelocityGuard', () => {
    (0, vitest_1.it)('returns null when fewer than 3 snapshots exist', () => {
        const guard = createGuard();
        guard.recordSnapshot('pool-a', 100);
        guard.recordSnapshot('pool-a', 90);
        (0, vitest_1.expect)(guard.calculateVelocityDrop('pool-a')).toBeNull();
    });
    (0, vitest_1.it)('correctly calculates rolling drop percentage', () => {
        const guard = createGuard();
        guard.recordSnapshot('pool-b', 100);
        guard.recordSnapshot('pool-b', 80);
        guard.recordSnapshot('pool-b', 60);
        const result = guard.calculateVelocityDrop('pool-b');
        (0, vitest_1.expect)(result?.rollingDropPercent).toBeCloseTo(22.5);
        (0, vitest_1.expect)(result?.maxSingleDrop).toBeCloseTo(25);
        (0, vitest_1.expect)(result?.snapshotCount).toBe(3);
    });
    (0, vitest_1.it)('sets isBreached = true when drop >= threshold', () => {
        const guard = createGuard(20);
        guard.recordSnapshot('pool-c', 100);
        guard.recordSnapshot('pool-c', 80);
        guard.recordSnapshot('pool-c', 60);
        (0, vitest_1.expect)(guard.calculateVelocityDrop('pool-c')?.isBreached).toBe(true);
    });
    (0, vitest_1.it)('sets isBreached = false when drop < threshold', () => {
        const guard = createGuard(30);
        guard.recordSnapshot('pool-d', 100);
        guard.recordSnapshot('pool-d', 95);
        guard.recordSnapshot('pool-d', 90);
        (0, vitest_1.expect)(guard.calculateVelocityDrop('pool-d')?.isBreached).toBe(false);
    });
    (0, vitest_1.it)('keeps only the last 10 snapshots per pool address', () => {
        const guard = createGuard();
        for (let index = 0; index < 12; index += 1) {
            guard.recordSnapshot('pool-e', 100 - index);
        }
        const rows = (0, sqlite_1.getAll)(db, 'SELECT id FROM pool_snapshots');
        (0, vitest_1.expect)(rows).toHaveLength(10);
    });
    (0, vitest_1.it)('rejects negative snapshot depth', () => {
        const guard = createGuard();
        (0, vitest_1.expect)(() => guard.recordSnapshot('pool-f', -1)).toThrow('depthTon must be a non-negative number.');
    });
    (0, vitest_1.it)('treats rising liquidity as zero drop', () => {
        const guard = createGuard();
        guard.recordSnapshot('pool-g', 100);
        guard.recordSnapshot('pool-g', 110);
        guard.recordSnapshot('pool-g', 120);
        (0, vitest_1.expect)(guard.calculateVelocityDrop('pool-g')?.rollingDropPercent).toBe(0);
    });
});
