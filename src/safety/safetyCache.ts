/**
 * TTL-aware cache layer for token safety and bubble map results.
 * Prevents redundant API calls for recently scanned tokens.
 */

export const SAFETY_CACHE_TTL_MINUTES = 60;
export const BUBBLE_CACHE_TTL_MINUTES = 60;
export const HOLDER_CACHE_TTL_MINUTES = 30;

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
export type HoneypotResult = 'PASS' | 'FAIL' | 'WARN' | 'ERROR';
export type BubbleRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';

export function calculateOverallRisk(checks: {
  honeypotResult: HoneypotResult;
  contractVerified: boolean;
  liquidityLocked: boolean;
  devWalletPercent: number;
  bubbleRisk?: BubbleRisk;
  suspiciousSupplyPercent?: number;
}): RiskLevel {
  /**
   * Aggregates all individual check results into a single risk level.
   * CRITICAL: honeypot confirmed OR dev holds >40% OR suspicious supply >50%
   * HIGH: contract unverified AND unlocked liquidity OR dev >20% OR suspicious >30%
   * MEDIUM: any single warning flag
   * LOW: all checks pass
   */
  if (
    checks.honeypotResult === 'FAIL' ||
    checks.devWalletPercent > 40 ||
    (checks.suspiciousSupplyPercent ?? 0) > 50
  ) {
    return 'CRITICAL';
  }

  if (
    (!checks.contractVerified && !checks.liquidityLocked) ||
    checks.devWalletPercent > 20 ||
    (checks.suspiciousSupplyPercent ?? 0) > 30 ||
    checks.bubbleRisk === 'CRITICAL'
  ) {
    return 'HIGH';
  }

  if (
    checks.honeypotResult === 'WARN' ||
    !checks.contractVerified ||
    !checks.liquidityLocked ||
    checks.devWalletPercent > 10 ||
    (checks.suspiciousSupplyPercent ?? 0) > 15 ||
    checks.bubbleRisk === 'HIGH'
  ) {
    return 'MEDIUM';
  }

  return 'LOW';
}

export function riskEmoji(level: string): string {
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

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  return `${value.toFixed(2)}%`;
}
