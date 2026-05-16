import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '../src/db/sqlite';
import { getAll, initializeDatabase } from '../src/db/sqlite';
import { VelocityGuard } from '../src/risk/velocityGuard';

let db: DatabaseConnection | undefined;

function createGuard(threshold = 25): VelocityGuard {
  db = initializeDatabase(':memory:');
  return new VelocityGuard(db, threshold);
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('VelocityGuard', () => {
  it('returns null when fewer than 3 snapshots exist', () => {
    const guard = createGuard();
    guard.recordSnapshot('pool-a', 100);
    guard.recordSnapshot('pool-a', 90);

    expect(guard.calculateVelocityDrop('pool-a')).toBeNull();
  });

  it('correctly calculates rolling drop percentage', () => {
    const guard = createGuard();
    guard.recordSnapshot('pool-b', 100);
    guard.recordSnapshot('pool-b', 80);
    guard.recordSnapshot('pool-b', 60);

    const result = guard.calculateVelocityDrop('pool-b');

    expect(result?.rollingDropPercent).toBeCloseTo(22.5);
    expect(result?.maxSingleDrop).toBeCloseTo(25);
    expect(result?.snapshotCount).toBe(3);
  });

  it('sets isBreached = true when drop >= threshold', () => {
    const guard = createGuard(20);
    guard.recordSnapshot('pool-c', 100);
    guard.recordSnapshot('pool-c', 80);
    guard.recordSnapshot('pool-c', 60);

    expect(guard.calculateVelocityDrop('pool-c')?.isBreached).toBe(true);
  });

  it('sets isBreached = false when drop < threshold', () => {
    const guard = createGuard(30);
    guard.recordSnapshot('pool-d', 100);
    guard.recordSnapshot('pool-d', 95);
    guard.recordSnapshot('pool-d', 90);

    expect(guard.calculateVelocityDrop('pool-d')?.isBreached).toBe(false);
  });

  it('keeps only the last 10 snapshots per pool address', () => {
    const guard = createGuard();

    for (let index = 0; index < 12; index += 1) {
      guard.recordSnapshot('pool-e', 100 - index);
    }

    const rows = getAll<{ id: number }>(db as DatabaseConnection, 'SELECT id FROM pool_snapshots');
    expect(rows).toHaveLength(10);
  });

  it('rejects negative snapshot depth', () => {
    const guard = createGuard();

    expect(() => guard.recordSnapshot('pool-f', -1)).toThrow(
      'depthTon must be a non-negative number.',
    );
  });

  it('treats rising liquidity as zero drop', () => {
    const guard = createGuard();
    guard.recordSnapshot('pool-g', 100);
    guard.recordSnapshot('pool-g', 110);
    guard.recordSnapshot('pool-g', 120);

    expect(guard.calculateVelocityDrop('pool-g')?.rollingDropPercent).toBe(0);
  });
});
