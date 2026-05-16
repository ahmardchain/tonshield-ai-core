import { afterEach, describe, expect, it } from 'vitest';
import { TonClient } from '@ton/ton';
import type { Config } from '../src/config/env';
import type { DatabaseConnection, SwapAttemptRow } from '../src/db/sqlite';
import { getOne, initializeDatabase, upsertUser } from '../src/db/sqlite';
import type { AgentWalletService } from '../src/wallet/agentWallet';
import type { BudgetPolicyService } from '../src/wallet/budgetPolicy';
import type { StonClient } from '../src/ston/stonClient';
import { canExecuteLiveTransactions } from '../src/ston/networkGuard';
import { StonFiExecutor } from '../src/ston/swapBuilder';

let db: DatabaseConnection | undefined;

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'token',
    toncenterApiKey: 'toncenter',
    toncenterEndpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
    network: 'testnet',
    enableMainnetExecution: false,
    agentWalletEncryptionKey: Buffer.alloc(32),
    databasePath: ':memory:',
    monitorIntervalSeconds: 30,
    riskDropThresholdPercent: 25,
    defaultSlippageBps: 500,
    paperTrade: false,
    ...overrides,
  };
}

function createExecutor(config: Config): StonFiExecutor {
  db = initializeDatabase(':memory:');
  upsertUser(db, 3001);
  return new StonFiExecutor({
    db,
    config,
    tonClient: new TonClient({
      endpoint: config.toncenterEndpoint,
      apiKey: config.toncenterApiKey,
    }),
    stonClient: {} as StonClient,
    budgetPolicy: {} as BudgetPolicyService,
    agentWallet: {} as AgentWalletService,
  });
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('network guard', () => {
  it('blocks execution when NETWORK=mainnet and ENABLE_MAINNET_EXECUTION=false', async () => {
    const executor = createExecutor(
      testConfig({ network: 'mainnet', enableMainnetExecution: false }),
    );

    const result = await executor.executeDefensiveSwap(3001, 'pool-a', 'token-a', 1);

    expect(result.status).toBe('blocked_mainnet_guard');
  });

  it('logs blocked_mainnet_guard status to swap_attempts', async () => {
    const executor = createExecutor(
      testConfig({ network: 'mainnet', enableMainnetExecution: false }),
    );

    await executor.executeDefensiveSwap(3001, 'pool-b', 'token-b', 1);
    const attempt = getOne<SwapAttemptRow>(
      db as DatabaseConnection,
      'SELECT * FROM swap_attempts WHERE user_id = ? AND pool_address = ? LIMIT 1',
      3001,
      'pool-b',
    );

    expect(attempt?.status).toBe('blocked_mainnet_guard');
  });

  it('keeps direct executor mainnet execution blocked even when the double guard is enabled', async () => {
    const executor = createExecutor(
      testConfig({ network: 'mainnet', enableMainnetExecution: true }),
    );

    const result = await executor.executeDefensiveSwap(3001, 'pool-c', 'token-c', 1);

    expect(result.status).toBe('blocked_mainnet_guard');
  });

  it('allows testnet execution by default', () => {
    expect(canExecuteLiveTransactions(testConfig({ network: 'testnet' }))).toBe(true);
  });
});
