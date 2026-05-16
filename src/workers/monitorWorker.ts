import type {
  DefensiveSwapExecutor,
  TelegramAlertSink,
  TriggerEngine,
} from '../risk/triggerEngine';
import type { VelocityGuard } from '../risk/velocityGuard';
import { checkPriceTargets } from '../risk/velocityGuard';
import type { StonClient } from '../ston/stonClient';
import type { DatabaseConnection } from '../db/sqlite';
import { getRiskSettings, listWatchedPools } from '../db/sqlite';

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Positions are opened by the /buy command handler via openPosition() in sqlite.ts.
// The monitor worker reads armed_pools and risk_settings independently.
// No position management logic lives here — separation of concerns is intentional.

export interface MonitorWorkerOptions {
  db: DatabaseConnection;
  stonClient: StonClient;
  velocityGuard: VelocityGuard;
  triggerEngine: TriggerEngine;
  telegram?: TelegramAlertSink;
  swapExecutor?: DefensiveSwapExecutor;
  intervalSeconds: number;
  logger?: Pick<Console, 'error' | 'log'>;
}

interface TriggerEngineInternals {
  options?: {
    telegram?: TelegramAlertSink;
    swapExecutor?: DefensiveSwapExecutor;
  };
}

export class MonitorWorker {
  private interval: NodeJS.Timeout | null = null;
  private readonly lastAlertTimestamps = new Map<string, number>();
  private readonly logger: Pick<Console, 'error' | 'log'>;

  public constructor(private readonly options: MonitorWorkerOptions) {
    this.logger = options.logger ?? console;
  }

  public startMonitoring(): void {
    if (this.interval !== null) {
      return;
    }

    void this.pollAllPools();
    this.interval = setInterval(() => {
      void this.pollAllPools();
    }, this.options.intervalSeconds * 1000);
    this.logger.log(`TonShield monitor started (${this.options.intervalSeconds}s interval).`);
  }

  public stopMonitoring(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async pollAllPools(): Promise<void> {
    const watchedPools = listWatchedPools(this.options.db);

    for (const watchedPool of watchedPools) {
      try {
        const poolData = await this.options.stonClient.getPoolData(watchedPool.pool_address);
        this.options.velocityGuard.recordSnapshot(watchedPool.pool_address, poolData.depthTon);
        const velocity = this.options.velocityGuard.calculateVelocityDrop(watchedPool.pool_address);
        const riskSettings = getRiskSettings(
          this.options.db,
          watchedPool.user_id,
          watchedPool.pool_address,
        );

        if (riskSettings !== undefined && riskSettings.entry_price_ton !== null) {
          const tokenAddress = poolData.tokenAddresses[0] ?? 'unknown';
          const currentPriceTon = await this.options.stonClient.getTokenPrice(tokenAddress);
          const priceCheck = checkPriceTargets(
            riskSettings.entry_price_ton,
            currentPriceTon,
            riskSettings.take_profit_percent,
            riskSettings.stop_loss_percent,
          );

          if (
            priceCheck.shouldTakeProfit &&
            this.shouldAlert(watchedPool.user_id, watchedPool.pool_address, 'tp')
          ) {
            await this.executePriceTargetExit(
              watchedPool.user_id,
              watchedPool.pool_address,
              tokenAddress,
              `🎯 Take profit target reached for ${watchedPool.pool_address}. Executing exit.`,
            );
          }

          if (
            priceCheck.shouldStopLoss &&
            this.shouldAlert(watchedPool.user_id, watchedPool.pool_address, 'sl')
          ) {
            await this.executePriceTargetExit(
              watchedPool.user_id,
              watchedPool.pool_address,
              tokenAddress,
              `🛡️ Stop loss triggered for ${watchedPool.pool_address}. Executing protective exit.`,
            );
          }
        }

        if (velocity === null || !velocity.isBreached) {
          continue;
        }

        if (!this.shouldAlert(watchedPool.user_id, watchedPool.pool_address)) {
          continue;
        }

        await this.options.triggerEngine.handleBreach(
          watchedPool.user_id,
          watchedPool.pool_address,
          velocity,
          poolData.tokenAddresses[0] ?? 'unknown',
          1,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown monitor error.';
        this.logger.error(`Monitor poll failed for ${watchedPool.pool_address}: ${message}`);
      }
    }
  }

  private shouldAlert(userId: number, poolAddress: string, prefix?: 'tp' | 'sl'): boolean {
    const key =
      prefix === undefined ? `${userId}:${poolAddress}` : `${prefix}:${userId}:${poolAddress}`;
    const last = this.lastAlertTimestamps.get(key);
    const now = Date.now();
    if (last === undefined || now - last >= ALERT_COOLDOWN_MS) {
      this.lastAlertTimestamps.set(key, now);
      return true;
    }
    return false;
  }

  private async executePriceTargetExit(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    alertMessage: string,
  ): Promise<void> {
    const internals = this.options.triggerEngine as unknown as TriggerEngineInternals;
    const telegram = this.options.telegram ?? internals.options?.telegram;
    const swapExecutor = this.options.swapExecutor ?? internals.options?.swapExecutor;

    await telegram?.sendMessage(userId, alertMessage);
    await swapExecutor?.executeDefensiveSwap(userId, poolAddress, tokenAddress, 1);
  }
}

export function startMonitoring(worker: MonitorWorker): void {
  worker.startMonitoring();
}

export function stopMonitoring(worker: MonitorWorker): void {
  worker.stopMonitoring();
}
