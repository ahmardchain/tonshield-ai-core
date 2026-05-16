import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config/env';
import type { DatabaseConnection } from '../src/db/sqlite';
import { addArmedPool, initializeDatabase, upsertUser } from '../src/db/sqlite';
import { TriggerEngine } from '../src/risk/triggerEngine';
import type { VelocityResult } from '../src/risk/velocityGuard';

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

function breachedVelocity(): VelocityResult {
  return {
    rollingDropPercent: 40,
    maxSingleDrop: 45,
    snapshotCount: 8,
    isBreached: true,
  };
}

function createEngine(config: Config) {
  db = initializeDatabase(':memory:');
  upsertUser(db, 2001);
  const telegram = { sendMessage: vi.fn().mockResolvedValue(undefined) };
  const executor = {
    executeDefensiveSwap: vi.fn().mockResolvedValue({ status: 'success' }),
    simulateDefensiveSwap: vi.fn().mockResolvedValue({ status: 'simulated' }),
    logBlockedMainnetAttempt: vi.fn().mockReturnValue(1),
  };
  const engine = new TriggerEngine({
    db,
    config,
    telegram,
    swapExecutor: executor,
    defaultTokenAddress: 'token-a',
  });

  return { engine, executor };
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('TriggerEngine', () => {
  it('calls executeDefensiveSwap when pool is armed and network is testnet', async () => {
    const { engine, executor } = createEngine(testConfig({ paperTrade: false }));
    addArmedPool(db as DatabaseConnection, 2001, 'pool-a');

    const result = await engine.handleBreach(2001, 'pool-a', breachedVelocity());

    expect(result.action).toBe('testnet_executed');
    expect(executor.executeDefensiveSwap).toHaveBeenCalledWith(2001, 'pool-a', 'token-a', 1);
  });

  it('calls simulateDefensiveSwap when paper mode is active', async () => {
    const { engine, executor } = createEngine(testConfig({ paperTrade: true }));
    addArmedPool(db as DatabaseConnection, 2001, 'pool-b');

    const result = await engine.handleBreach(2001, 'pool-b', breachedVelocity());

    expect(result.action).toBe('paper_simulated');
    expect(executor.simulateDefensiveSwap).toHaveBeenCalledWith(2001, 'pool-b', 1);
    expect(executor.executeDefensiveSwap).not.toHaveBeenCalled();
  });

  it('does not execute when pool is not armed', async () => {
    const { engine, executor } = createEngine(testConfig({ paperTrade: false }));

    const result = await engine.handleBreach(2001, 'pool-c', breachedVelocity());

    expect(result.action).toBe('alert_only');
    expect(executor.executeDefensiveSwap).not.toHaveBeenCalled();
    expect(executor.simulateDefensiveSwap).not.toHaveBeenCalled();
  });

  it('logs a blocked attempt when armed pool breaches on guarded mainnet', async () => {
    const { engine, executor } = createEngine(
      testConfig({ network: 'mainnet', enableMainnetExecution: false, paperTrade: false }),
    );
    addArmedPool(db as DatabaseConnection, 2001, 'pool-d');

    const result = await engine.handleBreach(2001, 'pool-d', breachedVelocity());

    expect(result.action).toBe('blocked_mainnet_guard');
    expect(executor.logBlockedMainnetAttempt).toHaveBeenCalledWith(
      2001,
      'pool-d',
      'token-a',
      1,
      expect.stringContaining('Mainnet execution blocked'),
    );
    expect(executor.executeDefensiveSwap).not.toHaveBeenCalled();
  });

  it('still blocks mainnet execution after both flags because MVP mainnet is unaudited', async () => {
    const { engine, executor } = createEngine(
      testConfig({ network: 'mainnet', enableMainnetExecution: true, paperTrade: false }),
    );
    addArmedPool(db as DatabaseConnection, 2001, 'pool-e');

    const result = await engine.handleBreach(2001, 'pool-e', breachedVelocity());

    expect(result.action).toBe('blocked_mainnet_guard');
    expect(executor.logBlockedMainnetAttempt).toHaveBeenCalledWith(
      2001,
      'pool-e',
      'token-a',
      1,
      expect.stringContaining('independent audit'),
    );
  });
});
