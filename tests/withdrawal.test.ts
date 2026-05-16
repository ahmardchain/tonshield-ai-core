import { Address, toNano } from '@ton/core';
import type { TonClient } from '@ton/ton';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config/env';
import type { DatabaseConnection, WithdrawalAttemptRow } from '../src/db/sqlite';
import { getOne, initializeDatabase, upsertUser } from '../src/db/sqlite';
import type { AgentWalletService } from '../src/wallet/agentWallet';
import { WithdrawalEngine } from '../src/wallet/withdrawalEngine';

let db: DatabaseConnection | undefined;

const agentAddress = Address.parseRaw(`0:${'0'.repeat(64)}`).toString();
const destinationAddress = Address.parseRaw(`0:${'1'.repeat(64)}`).toString();
const tokenAddress = Address.parseRaw(`0:${'2'.repeat(64)}`).toString();
const jettonWalletAddress = Address.parseRaw(`0:${'3'.repeat(64)}`);

function testConfig(): Config {
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
  };
}

function mockAgentWallet(send = vi.fn().mockResolvedValue(undefined)): AgentWalletService {
  return {
    decryptAndLoadWallet: vi.fn().mockResolvedValue({
      address: agentAddress,
      wallet: {},
      sender: { send },
    }),
  } as unknown as AgentWalletService;
}

function mockTonClient(balance: bigint): TonClient {
  return {
    getBalance: vi.fn().mockResolvedValue(balance),
    runMethod: vi.fn(),
  } as unknown as TonClient;
}

function createEngine(
  userId: number,
  tonClient: TonClient,
  agentWallet: AgentWalletService = mockAgentWallet(),
): WithdrawalEngine {
  db = initializeDatabase(':memory:');
  upsertUser(db, userId);
  return new WithdrawalEngine(db, testConfig(), tonClient, agentWallet);
}

afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
});

describe('WithdrawalEngine', () => {
  it('withdrawTon rejects when amount exceeds balance minus gas reserve', async () => {
    const engine = createEngine(9101, mockTonClient(toNano('1')));

    const result = await engine.withdrawTon(9101, destinationAddress, 0.9);

    expect(result.status).toBe('rejected');
    expect(result.errorMessage).toContain('exceeds withdrawable balance');
  });

  it('withdrawTon logs attempt to database before execution', async () => {
    const engine = createEngine(9102, mockTonClient(toNano('1')));

    await engine.withdrawTon(9102, destinationAddress, 0.9);
    const attempt = getOne<WithdrawalAttemptRow>(
      db as DatabaseConnection,
      'SELECT * FROM withdrawal_attempts WHERE user_id = ? LIMIT 1',
      9102,
    );

    expect(attempt).toBeDefined();
    expect(attempt?.withdrawal_type).toBe('ton');
    expect(attempt?.destination_address).toBe(destinationAddress);
  });

  it('withdrawAllTon calculates correct withdrawable amount', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const engine = createEngine(9103, mockTonClient(toNano('1')), mockAgentWallet(send));

    const result = await engine.withdrawAllTon(9103, destinationAddress);

    expect(result.status).toBe('success');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].value).toBe(toNano('0.85'));
  });

  it('withdrawToken rejects when Jetton balance is zero', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const tonClient = {
      getBalance: vi.fn(),
      runMethod: vi
        .fn()
        .mockResolvedValueOnce({ stack: { readAddress: () => jettonWalletAddress } })
        .mockResolvedValueOnce({ stack: { readBigNumber: () => 0n } }),
    } as unknown as TonClient;
    const engine = createEngine(9104, tonClient, mockAgentWallet(send));

    const result = await engine.withdrawToken(9104, tokenAddress, destinationAddress);

    expect(result.status).toBe('rejected');
    expect(result.errorMessage).toBe('No token balance found in agent wallet for this token address.');
    expect(send).not.toHaveBeenCalled();
  });
});
