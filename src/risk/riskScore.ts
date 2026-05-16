import type { VelocityResult } from './velocityGuard';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RiskConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskScore {
  level: RiskLevel;
  rollingDropPercent: number;
  confidence: RiskConfidence;
  recommendation: string;
}

function confidenceFromSnapshotCount(snapshotCount: number): RiskConfidence {
  if (snapshotCount >= 7) {
    return 'HIGH';
  }

  if (snapshotCount >= 5) {
    return 'MEDIUM';
  }

  return 'LOW';
}

export function scorePool(velocityResult: VelocityResult): RiskScore {
  const drop = velocityResult.rollingDropPercent;
  let level: RiskLevel;
  let recommendation: string;

  if (drop < 10) {
    level = 'LOW';
    recommendation = 'Continue monitoring; no defensive action recommended.';
  } else if (drop < 25) {
    level = 'MEDIUM';
    recommendation = 'Watch closely and consider reducing exposure manually.';
  } else if (drop < 50) {
    level = 'HIGH';
    recommendation = 'Liquidity is deteriorating; armed pools may execute a defensive swap.';
  } else {
    level = 'CRITICAL';
    recommendation = 'Severe liquidity loss detected; defensive action is strongly recommended.';
  }

  return {
    level,
    rollingDropPercent: drop,
    confidence: confidenceFromSnapshotCount(velocityResult.snapshotCount),
    recommendation,
  };
}
