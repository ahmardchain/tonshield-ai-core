import { afterEach, describe, expect, it } from 'vitest';
import type { TonClient } from '@ton/ton';
import type { Config } from '../src/config/env';
import type { DatabaseConnection, PositionRow, SwapAttemptRow } from '../src/db/sqlite';
import { getOne, initializeDatabase, openPosition, upsertUser } from '../src/db/sqlite';
import type { StonClient } from '../src/ston/stonClient';
import { StonFiExecutor } from '../src/ston/swapBuilder';
import type { AgentWalletService } from '../src/wallet/agentWallet';
import type { BudgetPolicyService } from '../src/wallet/budgetPolicy';

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

function fixedStonClient(): StonClient {
  return {
    getSwapQuote: async () => ({
      offerAddress: 'ton',
      askAddress: 'token-a',
      offerUnits: '2000000000',
      estimatedOutput: '400',
      minimumReceived: '390',
      slippageBps: 500,
      raw: {},
      offerAmount: '4',
      askAmount: '400',
      minAskAmount: '390',
    }),
  } as unknown as StonClient;
}

function createExecutor(
  config: Config,
  stonClient: StonClient = fixedStonClient(),
): StonFiExecutor {
  db = initializeDatabase(':memory:');

  return new StonFiExecutor({
    db,
    config,
    tonClient: {} as TonClient,
    stonClient,
    budgetPolicy: {} as BudgetPolicyService,
    agentWallet: {} as AgentWalletService,
  });
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('executeBuySwap', () => {
  it('blocks buy on mainnet when ENABLE_MAINNET_EXECUTION is false', async () => {
    const executor = createExecutor(
      testConfig({ network: 'mainnet', enableMainnetExecution: false }),
    );

    const result = await executor.executeBuySwap(9001, 'pool-a', 'token-a', 2);

    expect(result.status).toBe('blocked_mainnet_guard');
  });

  it('logs buy attempt to swap_attempts before execution', async () => {
    const executor = createExecutor(
      testConfig({ network: 'mainnet', enableMainnetExecution: false }),
    );

    await executor.executeBuySwap(9002, 'pool-b', 'token-b', 2);
    const attempt = getOne<SwapAttemptRow>(
      db as DatabaseConnection,
      'SELECT * FROM swap_attempts WHERE user_id = ? AND pool_address = ? LIMIT 1',
      9002,
      'pool-b',
    );

    expect(attempt).toBeDefined();
    expect(attempt?.mode).toBe('live');
    expect(attempt?.pool_address).toBe('pool-b');
  });

  it('returns simulated result in paper trade mode', async () => {
    const executor = createExecutor(testConfig({ paperTrade: true }));

    const result = await executor.simulateBuySwap(9003, 'pool-c', 'token-c', 2);

    expect(result.status).toBe('simulated');
    expect(result.entryPriceTon).toBeGreaterThan(0);
    expect(result.estimatedTokenOut).toBe('400');
  });

  it('opens position record after successful buy', () => {
    db = initializeDatabase(':memory:');
    upsertUser(db, 9004);

    const positionId = openPosition(db, 9004, 'pool-d', 'token-d', 0.5, 2, 'tx-open');
    const position = getOne<PositionRow>(
      db,
      'SELECT * FROM positions WHERE id = ? LIMIT 1',
      positionId,
    );

    expect(position?.status).toBe('open');
    expect(position?.entry_price_ton).toBe(0.5);
  });
});
