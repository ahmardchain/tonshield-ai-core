"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const riskScore_1 = require("../src/risk/riskScore");
function velocity(rollingDropPercent) {
    return {
        rollingDropPercent,
        maxSingleDrop: rollingDropPercent,
        snapshotCount: 8,
        isBreached: rollingDropPercent >= 25,
    };
}
(0, vitest_1.describe)('scorePool', () => {
    (0, vitest_1.it)('returns LOW for drop < 10%', () => {
        (0, vitest_1.expect)((0, riskScore_1.scorePool)(velocity(9.99)).level).toBe('LOW');
    });
    (0, vitest_1.it)('returns MEDIUM for drop 10-24%', () => {
        (0, vitest_1.expect)((0, riskScore_1.scorePool)(velocity(10)).level).toBe('MEDIUM');
        (0, vitest_1.expect)((0, riskScore_1.scorePool)(velocity(24.99)).level).toBe('MEDIUM');
    });
    (0, vitest_1.it)('returns HIGH for drop 25-49%', () => {
        (0, vitest_1.expect)((0, riskScore_1.scorePool)(velocity(25)).level).toBe('HIGH');
        (0, vitest_1.expect)((0, riskScore_1.scorePool)(velocity(49.99)).level).toBe('HIGH');
    });
    (0, vitest_1.it)('returns CRITICAL for drop >= 50%', () => {
        (0, vitest_1.expect)((0, riskScore_1.scorePool)(velocity(50)).level).toBe('CRITICAL');
    });
    (0, vitest_1.it)('sets confidence from snapshot count', () => {
        (0, vitest_1.expect)((0, riskScore_1.scorePool)({ ...velocity(5), snapshotCount: 3 }).confidence).toBe('LOW');
        (0, vitest_1.expect)((0, riskScore_1.scorePool)({ ...velocity(5), snapshotCount: 5 }).confidence).toBe('MEDIUM');
        (0, vitest_1.expect)((0, riskScore_1.scorePool)({ ...velocity(5), snapshotCount: 7 }).confidence).toBe('HIGH');
    });
});
