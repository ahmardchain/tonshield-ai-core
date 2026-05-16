import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseConnection } from '../src/db/sqlite';
import { initializeDatabase } from '../src/db/sqlite';
import {
  BudgetExceededError,
  BudgetPolicyService,
  InvalidBudgetPolicyError,
} from '../src/wallet/budgetPolicy';

let db: DatabaseConnection | undefined;

function createService(): BudgetPolicyService {
  db = initializeDatabase(':memory:');
  return new BudgetPolicyService(db);
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('BudgetPolicyService', () => {
  it('blocks spend when currentSpent + amount > maxBudget', () => {
    const service = createService();
    service.setBudget(1001, 5, 3);
    service.validateAndReserve(1001, 3);

    expect(() => service.validateAndReserve(1001, 3)).toThrow(BudgetExceededError);
  });

  it('allows spend when within budget', () => {
    const service = createService();
    service.setBudget(1002, 5, 3);

    const updated = service.validateAndReserve(1002, 2);

    expect(updated.currentSpentTon).toBe(2);
    expect(updated.maxBudgetTon).toBe(5);
  });

  it('blocks spend when amount > perTradeLimit', () => {
    const service = createService();
    service.setBudget(1003, 5, 1.5);

    expect(() => service.validateAndReserve(1003, 2)).toThrow(BudgetExceededError);
  });

  it('atomically updates spent amount on success', () => {
    const service = createService();
    service.setBudget(1004, 5, 5);

    service.validateAndReserve(1004, 1.25);
    service.validateAndReserve(1004, 2.25);
    const policy = service.getPolicy(1004);

    expect(policy?.currentSpentTon).toBe(3.5);
  });

  it('rejects invalid budget definitions', () => {
    const service = createService();

    expect(() => service.setBudget(1005, 0, 1)).toThrow(InvalidBudgetPolicyError);
    expect(() => service.setBudget(1005, 2, 0)).toThrow(InvalidBudgetPolicyError);
    expect(() => service.setBudget(1005, 2, 3)).toThrow(InvalidBudgetPolicyError);
  });

  it('rejects reservations without a configured policy', () => {
    const service = createService();

    expect(() => service.validateAndReserve(1006, 1)).toThrow(BudgetExceededError);
  });

  it('rejects non-positive reservation amounts', () => {
    const service = createService();
    service.setBudget(1007, 2, 1);

    expect(() => service.validateAndReserve(1007, 0)).toThrow(BudgetExceededError);
  });
});
