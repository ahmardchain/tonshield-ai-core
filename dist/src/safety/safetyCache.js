"use strict";
/**
 * TTL-aware cache layer for token safety and bubble map results.
 * Prevents redundant API calls for recently scanned tokens.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOLDER_CACHE_TTL_MINUTES = exports.BUBBLE_CACHE_TTL_MINUTES = exports.SAFETY_CACHE_TTL_MINUTES = void 0;
exports.calculateOverallRisk = calculateOverallRisk;
exports.riskEmoji = riskEmoji;
exports.formatPercent = formatPercent;
exports.SAFETY_CACHE_TTL_MINUTES = 60;
exports.BUBBLE_CACHE_TTL_MINUTES = 60;
exports.HOLDER_CACHE_TTL_MINUTES = 30;
function calculateOverallRisk(checks) {
    /**
     * Aggregates all individual check results into a single risk level.
     * CRITICAL: honeypot confirmed OR dev holds >40% OR suspicious supply >50%
     * HIGH: contract unverified AND unlocked liquidity OR dev >20% OR suspicious >30%
     * MEDIUM: any single warning flag
     * LOW: all checks pass
     */
    if (checks.honeypotResult === 'FAIL' ||
        checks.devWalletPercent > 40 ||
        (checks.suspiciousSupplyPercent ?? 0) > 50) {
        return 'CRITICAL';
    }
    if ((!checks.contractVerified && !checks.liquidityLocked) ||
        checks.devWalletPercent > 20 ||
        (checks.suspiciousSupplyPercent ?? 0) > 30 ||
        checks.bubbleRisk === 'CRITICAL') {
        return 'HIGH';
    }
    if (checks.honeypotResult === 'WARN' ||
        !checks.contractVerified ||
        !checks.liquidityLocked ||
        checks.devWalletPercent > 10 ||
        (checks.suspiciousSupplyPercent ?? 0) > 15 ||
        checks.bubbleRisk === 'HIGH') {
        return 'MEDIUM';
    }
    return 'LOW';
}
function riskEmoji(level) {
    switch (level) {
        case 'LOW':
            return '🟢';
        case 'MEDIUM':
            return '🟡';
        case 'HIGH':
            return '🔴';
        case 'CRITICAL':
            return '🚨';
        default:
            return '⚪';
    }
}
function formatPercent(value) {
    if (value === null || value === undefined)
        return 'N/A';
    return `${value.toFixed(2)}%`;
}
