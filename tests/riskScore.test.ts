import { describe, expect, it } from 'vitest';
import { scorePool } from '../src/risk/riskScore';
import type { VelocityResult } from '../src/risk/velocityGuard';

function velocity(rollingDropPercent: number): VelocityResult {
  return {
    rollingDropPercent,
    maxSingleDrop: rollingDropPercent,
    snapshotCount: 8,
    isBreached: rollingDropPercent >= 25,
  };
}

describe('scorePool', () => {
  it('returns LOW for drop < 10%', () => {
    expect(scorePool(velocity(9.99)).level).toBe('LOW');
  });

  it('returns MEDIUM for drop 10-24%', () => {
    expect(scorePool(velocity(10)).level).toBe('MEDIUM');
    expect(scorePool(velocity(24.99)).level).toBe('MEDIUM');
  });

  it('returns HIGH for drop 25-49%', () => {
    expect(scorePool(velocity(25)).level).toBe('HIGH');
    expect(scorePool(velocity(49.99)).level).toBe('HIGH');
  });

  it('returns CRITICAL for drop >= 50%', () => {
    expect(scorePool(velocity(50)).level).toBe('CRITICAL');
  });

  it('sets confidence from snapshot count', () => {
    expect(scorePool({ ...velocity(5), snapshotCount: 3 }).confidence).toBe('LOW');
    expect(scorePool({ ...velocity(5), snapshotCount: 5 }).confidence).toBe('MEDIUM');
    expect(scorePool({ ...velocity(5), snapshotCount: 7 }).confidence).toBe('HIGH');
  });
});
