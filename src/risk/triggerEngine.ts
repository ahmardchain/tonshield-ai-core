import type { Config } from '../config/env';
import type { DatabaseConnection } from '../db/sqlite';
import { insertRiskEvent, isPoolArmed } from '../db/sqlite';
import type { VelocityResult } from './velocityGuard';
import { scorePool } from './riskScore';

export interface TelegramAlertSink {
  sendMessage(userId: number, message: string): Promise<void>;
}

export interface DefensiveSwapExecutor {
  executeDefensiveSwap(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
  ): Promise<unknown>;
  simulateDefensiveSwap(userId: number, poolAddress: string, amountTon: number): Promise<unknown>;
  logBlockedMainnetAttempt(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
    reason: string,
  ): number;
}

export interface TriggerEngineOptions {
  db: DatabaseConnection;
  config: Config;
  telegram: TelegramAlertSink;
  swapExecutor: DefensiveSwapExecutor;
  defaultTokenAddress?: string;
  defaultAmountTon?: number;
}

export interface TriggerResult {
  riskLevel: string;
  action: 'alert_only' | 'paper_simulated' | 'testnet_executed' | 'blocked_mainnet_guard';
}

export class TriggerEngine {
  private readonly defaultTokenAddress: string;
  private readonly defaultAmountTon: number;

  public constructor(private readonly options: TriggerEngineOptions) {
    this.defaultTokenAddress = options.defaultTokenAddress ?? 'unknown';
    this.defaultAmountTon = options.defaultAmountTon ?? 1;
  }

  public async handleBreach(
    userId: number,
    poolAddress: string,
    velocityResult: VelocityResult,
    tokenAddress = this.defaultTokenAddress,
    amountTon = this.defaultAmountTon,
  ): Promise<TriggerResult> {
    const risk = scorePool(velocityResult);
    insertRiskEvent(this.options.db, userId, poolAddress, risk.level, risk.rollingDropPercent);

    await this.options.telegram.sendMessage(
      userId,
      [
        `TonShield AI alert: ${risk.level} risk detected.`,
        `Pool: ${poolAddress}`,
        `Rolling drop: ${risk.rollingDropPercent.toFixed(2)}%`,
        `Confidence: ${risk.confidence}`,
        `Recommendation: ${risk.recommendation}`,
      ].join('\n'),
    );

    const armed = isPoolArmed(this.options.db, userId, poolAddress);

    if (!armed) {
      return { riskLevel: risk.level, action: 'alert_only' };
    }

    if (this.options.config.network === 'mainnet' && !this.options.config.enableMainnetExecution) {
      const reason =
        'Mainnet execution blocked because ENABLE_MAINNET_EXECUTION is not explicitly true.';
      this.options.swapExecutor.logBlockedMainnetAttempt(
        userId,
        poolAddress,
        tokenAddress,
        amountTon,
        reason,
      );
      await this.options.telegram.sendMessage(userId, `Execution blocked: ${reason}`);
      return { riskLevel: risk.level, action: 'blocked_mainnet_guard' };
    }

    if (this.options.config.paperTrade) {
      await this.options.swapExecutor.simulateDefensiveSwap(userId, poolAddress, amountTon);
      return { riskLevel: risk.level, action: 'paper_simulated' };
    }

    if (this.options.config.network === 'testnet') {
      await this.options.swapExecutor.executeDefensiveSwap(
        userId,
        poolAddress,
        tokenAddress,
        amountTon,
      );
      return { riskLevel: risk.level, action: 'testnet_executed' };
    }

    const reason = 'Mainnet execution requires an independent audit before this MVP should use it.';
    this.options.swapExecutor.logBlockedMainnetAttempt(
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      reason,
    );
    await this.options.telegram.sendMessage(userId, `Execution blocked: ${reason}`);
    return { riskLevel: risk.level, action: 'blocked_mainnet_guard' };
  }
}
