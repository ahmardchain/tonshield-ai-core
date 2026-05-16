import type { BudgetPolicyRow, DatabaseConnection } from '../db/sqlite';
import { execute, getOne, upsertUser } from '../db/sqlite';

export interface BudgetPolicy {
  userId: number;
  maxBudgetTon: number;
  currentSpentTon: number;
  perTradeLimitTon: number;
  updatedAt: string;
}

export class BudgetExceededError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class InvalidBudgetPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidBudgetPolicyError';
  }
}

function toPolicy(row: BudgetPolicyRow): BudgetPolicy {
  return {
    userId: row.user_id,
    maxBudgetTon: row.max_budget_ton,
    currentSpentTon: row.current_spent_ton,
    perTradeLimitTon: row.per_trade_limit_ton,
    updatedAt: row.updated_at,
  };
}

export class BudgetPolicyService {
  public constructor(private readonly db: DatabaseConnection) {}

  public setBudget(
    userId: number,
    maxBudgetTon: number,
    perTradeLimitTon = Math.min(maxBudgetTon, 1),
  ): BudgetPolicy {
    if (!Number.isFinite(maxBudgetTon) || maxBudgetTon <= 0) {
      throw new InvalidBudgetPolicyError('maxBudgetTon must be greater than 0.');
    }

    if (!Number.isFinite(perTradeLimitTon) || perTradeLimitTon <= 0) {
      throw new InvalidBudgetPolicyError('perTradeLimitTon must be greater than 0.');
    }

    if (perTradeLimitTon > maxBudgetTon) {
      throw new InvalidBudgetPolicyError(
        'perTradeLimitTon must be less than or equal to maxBudgetTon.',
      );
    }

    upsertUser(this.db, userId);
    execute(
      this.db,
      `
        INSERT INTO budget_policies (user_id, max_budget_ton, current_spent_ton, per_trade_limit_ton)
        VALUES (?, ?, 0, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          max_budget_ton = excluded.max_budget_ton,
          per_trade_limit_ton = excluded.per_trade_limit_ton,
          current_spent_ton = MIN(budget_policies.current_spent_ton, excluded.max_budget_ton),
          updated_at = CURRENT_TIMESTAMP
      `,
      userId,
      maxBudgetTon,
      perTradeLimitTon,
    );

    const policy = this.getPolicy(userId);

    if (policy === undefined) {
      throw new InvalidBudgetPolicyError('Budget policy could not be saved.');
    }

    return policy;
  }

  public getPolicy(userId: number): BudgetPolicy | undefined {
    const row = getOne<BudgetPolicyRow>(
      this.db,
      'SELECT * FROM budget_policies WHERE user_id = ? LIMIT 1',
      userId,
    );

    return row === undefined ? undefined : toPolicy(row);
  }

  public validateAndReserve(userId: number, amountTon: number): BudgetPolicy {
    if (!Number.isFinite(amountTon) || amountTon <= 0) {
      throw new BudgetExceededError('Transaction amount must be greater than 0 TON.');
    }

    const reserve = this.db.transaction((targetUserId: number, amount: number) => {
      const policy = this.getPolicy(targetUserId);

      if (policy === undefined) {
        throw new BudgetExceededError('No budget policy is configured for this user.');
      }

      if (amount > policy.perTradeLimitTon) {
        throw new BudgetExceededError(
          `Transaction amount ${amount} TON exceeds per-trade limit ${policy.perTradeLimitTon} TON.`,
        );
      }

      if (policy.currentSpentTon + amount > policy.maxBudgetTon) {
        throw new BudgetExceededError(
          `Budget cap would be exceeded: current spent ${policy.currentSpentTon} TON + amount ${amount} TON > max budget ${policy.maxBudgetTon} TON.`,
        );
      }

      const result = execute(
        this.db,
        `
          UPDATE budget_policies
          SET current_spent_ton = current_spent_ton + ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
            AND ? <= per_trade_limit_ton
            AND current_spent_ton + ? <= max_budget_ton
        `,
        amount,
        targetUserId,
        amount,
        amount,
      );

      if (result.changes !== 1) {
        throw new BudgetExceededError('Budget changed during reservation; transaction rejected.');
      }

      const updatedPolicy = this.getPolicy(targetUserId);

      if (updatedPolicy === undefined) {
        throw new BudgetExceededError('Budget policy disappeared during reservation.');
      }

      return updatedPolicy;
    });

    return reserve(userId, amountTon);
  }
}
