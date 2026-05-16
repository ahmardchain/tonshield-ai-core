import { Address } from '@ton/core';
import type { TonClient } from '@ton/ton';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection, WalletGraphEdgeRow } from '../src/db/sqlite';
import { getAll, initializeDatabase } from '../src/db/sqlite';
import { BubbleMapAnalyzer } from '../src/safety/bubbleMap';
import { calculateOverallRisk } from '../src/safety/safetyCache';
import { TokenSafetyScanner } from '../src/safety/tokenScanner';
import type { StonClient } from '../src/ston/stonClient';

let db: DatabaseConnection | undefined;

const tokenAddress = Address.parseRaw(`0:${'1'.repeat(64)}`).toString();
const poolAddress = Address.parseRaw(`0:${'2'.repeat(64)}`).toString();
const devAddress = Address.parseRaw(`0:${'3'.repeat(64)}`).toString();
const walletA = Address.parseRaw(`0:${'4'.repeat(64)}`).toString();
const walletB = Address.parseRaw(`0:${'5'.repeat(64)}`).toString();
const walletC = Address.parseRaw(`0:${'6'.repeat(64)}`).toString();
const walletD = Address.parseRaw(`0:${'7'.repeat(64)}`).toString();

function jsonResponse(payload: unknown): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function createDb(): DatabaseConnection {
  db = initializeDatabase(':memory:');
  return db;
}

function mockToncenterFetch(params: {
  lpHolders?: Array<{ address: string; balance: string }>;
  tokenHolders?: Array<{ address: string; balance: string }>;
  deployer?: string;
} = {}): void {
  const lpHolders = params.lpHolders ?? [
    { address: walletA, balance: '400' },
    { address: walletB, balance: '350' },
    { address: walletC, balance: '250' },
  ];
  const tokenHolders = params.tokenHolders ?? [
    { address: params.deployer ?? devAddress, balance: '50' },
    { address: walletA, balance: '450' },
    { address: walletB, balance: '500' },
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.includes('getTransactions')) {
        return jsonResponse({
          result: [{ in_msg: { source: walletD } }, { in_msg: { source: params.deployer ?? devAddress } }],
        });
      }

      if (url.includes(poolAddress)) {
        return jsonResponse({ result: lpHolders });
      }

      return jsonResponse({ result: tokenHolders });
    }),
  );
}

function mockBubbleFetch(timestamps: Record<string, number>, fundingSource = devAddress): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const match = /address=([^&]+)/.exec(url);
      const address = match?.[1] ?? '';
      const timestamp = timestamps[address] ?? null;

      return jsonResponse({
        result:
          timestamp === null
            ? []
            : [{ utime: timestamp, in_msg: { source: fundingSource } }],
      });
    }),
  );
}

function mockTonClient(code = Buffer.from('unknown-code')): TonClient {
  return {
    getContractState: vi.fn().mockResolvedValue({ code }),
  } as unknown as TonClient;
}

function mockStonClient(firstAskAmount: string, secondAskAmount = '900000000'): StonClient {
  return {
    getSwapQuote: vi
      .fn()
      .mockResolvedValueOnce({ askAmount: firstAskAmount })
      .mockResolvedValueOnce({ askAmount: secondAskAmount }),
  } as unknown as StonClient;
}

function createScanner(stonClient: StonClient, tonClient: TonClient = mockTonClient()): TokenSafetyScanner {
  return new TokenSafetyScanner({
    db: createDb(),
    tonClient,
    stonClient,
    toncenterApiKey: 'test-key',
    toncenterEndpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
  });
}

afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TokenSafetyScanner', () => {
  it('returns FAIL honeypot result when buy quote returns zero tokens', async () => {
    mockToncenterFetch();
    const scanner = createScanner(mockStonClient('0'));

    const report = await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(report.honeypot.result).toBe('FAIL');
  });

  it('returns WARN when round-trip loss is between 20% and 50%', async () => {
    mockToncenterFetch();
    const scanner = createScanner(mockStonClient('1000000000', '700000000'));

    const report = await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(report.honeypot.result).toBe('WARN');
    expect(report.honeypot.roundTripLossPercent).toBeCloseTo(30);
  });

  it('returns PASS when round-trip loss is under 20%', async () => {
    mockToncenterFetch();
    const scanner = createScanner(mockStonClient('1000000000', '900000000'));

    const report = await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(report.honeypot.result).toBe('PASS');
    expect(report.honeypot.roundTripLossPercent).toBeCloseTo(10);
  });

  it('marks contract as unverified when code hash is unknown', async () => {
    mockToncenterFetch();
    const scanner = createScanner(mockStonClient('1000000000', '900000000'));

    const report = await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(report.contract.verified).toBe(false);
    expect(report.contract.message).toContain('unverified');
  });

  it('calculates overall risk as CRITICAL when honeypot is FAIL', async () => {
    mockToncenterFetch();
    const scanner = createScanner(mockStonClient('0'));

    const report = await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(report.overallRisk).toBe('CRITICAL');
  });

  it('calculates overall risk as HIGH when dev holds over 20%', async () => {
    mockToncenterFetch({
      tokenHolders: [
        { address: devAddress, balance: '250' },
        { address: walletA, balance: '750' },
      ],
    });
    const scanner = createScanner(mockStonClient('1000000000', '900000000'));

    const report = await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(report.concentration.devWalletPercent).toBe(25);
    expect(report.overallRisk).toBe('HIGH');
  });

  it('calculates overall risk as LOW when all checks pass', () => {
    const risk = calculateOverallRisk({
      honeypotResult: 'PASS',
      contractVerified: true,
      liquidityLocked: true,
      devWalletPercent: 3,
    });

    expect(risk).toBe('LOW');
  });

  it('returns cached result within TTL window', async () => {
    mockToncenterFetch();
    const stonClient = mockStonClient('1000000000', '900000000');
    const scanner = createScanner(stonClient);

    await scanner.scanToken(tokenAddress, poolAddress);
    const second = await scanner.scanToken(tokenAddress, poolAddress);

    expect(second.fromCache).toBe(true);
    expect(stonClient.getSwapQuote).toHaveBeenCalledTimes(2);
  });

  it('forces fresh scan when forceRefresh is true', async () => {
    mockToncenterFetch();
    const stonClient = {
      getSwapQuote: vi
        .fn()
        .mockResolvedValueOnce({ askAmount: '1000000000' })
        .mockResolvedValueOnce({ askAmount: '900000000' })
        .mockResolvedValueOnce({ askAmount: '1000000000' })
        .mockResolvedValueOnce({ askAmount: '900000000' }),
    } as unknown as StonClient;
    const scanner = createScanner(stonClient);

    await scanner.scanToken(tokenAddress, poolAddress);
    await scanner.scanToken(tokenAddress, poolAddress, true);

    expect(stonClient.getSwapQuote).toHaveBeenCalledTimes(4);
  });
});

describe('BubbleMapAnalyzer', () => {
  it('detects synchronized timing cluster when 3+ wallets buy within window', async () => {
    const deployTimestamp = 1_000_000;
    mockBubbleFetch({
      [walletA]: deployTimestamp + 1,
      [walletB]: deployTimestamp + 5,
      [walletC]: deployTimestamp + 9,
    });
    const analyzer = new BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');

    const report = await analyzer.runQuickScan(
      tokenAddress,
      [
        { address: walletA, percentOfSupply: 5 },
        { address: walletB, percentOfSupply: 6 },
        { address: walletC, percentOfSupply: 7 },
      ],
      deployTimestamp,
    );

    expect(report.clustersFound).toBeGreaterThan(0);
    expect(report.clusters[0]?.connectionType).toBe('synchronized_timing');
  });

  it('detects dormancy cluster when 3+ wallets have no history before launch', async () => {
    const deployTimestamp = 1_000_000;
    mockBubbleFetch({
      [walletA]: deployTimestamp - 3_600,
      [walletB]: deployTimestamp - 7_200,
      [walletC]: deployTimestamp - 10_800,
    });
    const analyzer = new BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');

    const report = await analyzer.runQuickScan(
      tokenAddress,
      [
        { address: walletA, percentOfSupply: 2 },
        { address: walletB, percentOfSupply: 3 },
        { address: walletC, percentOfSupply: 4 },
      ],
      deployTimestamp,
    );

    expect(report.clusters.some((cluster) => cluster.connectionType === 'dormancy')).toBe(true);
  });

  it('deduplicates overlapping clusters correctly', async () => {
    const deployTimestamp = 1_000_000;
    mockBubbleFetch({
      [walletA]: deployTimestamp + 1,
      [walletB]: deployTimestamp + 5,
      [walletC]: deployTimestamp + 9,
    });
    const analyzer = new BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');

    const report = await analyzer.runDeepScan(
      tokenAddress,
      [
        { address: walletA, percentOfSupply: 5 },
        { address: walletB, percentOfSupply: 6 },
        { address: walletC, percentOfSupply: 7 },
      ],
      deployTimestamp,
    );

    expect(report.clustersFound).toBe(1);
  });

  it('scores bubble risk as CRITICAL when suspicious supply exceeds 50%', async () => {
    const deployTimestamp = 1_000_000;
    mockBubbleFetch({
      [walletA]: deployTimestamp + 1,
      [walletB]: deployTimestamp + 5,
      [walletC]: deployTimestamp + 9,
    });
    const analyzer = new BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');

    const report = await analyzer.runQuickScan(
      tokenAddress,
      [
        { address: walletA, percentOfSupply: 20 },
        { address: walletB, percentOfSupply: 20 },
        { address: walletC, percentOfSupply: 20 },
      ],
      deployTimestamp,
    );

    expect(report.bubbleRisk).toBe('CRITICAL');
  });

  it('scores bubble risk as LOW when no clusters found', async () => {
    const deployTimestamp = 1_000_000;
    mockBubbleFetch({
      [walletA]: deployTimestamp - 86400 * 30,
      [walletB]: deployTimestamp - 86400 * 31,
    });
    const analyzer = new BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');

    const report = await analyzer.runQuickScan(
      tokenAddress,
      [
        { address: walletA, percentOfSupply: 5 },
        { address: walletB, percentOfSupply: 6 },
      ],
      deployTimestamp,
    );

    expect(report.clustersFound).toBe(0);
    expect(report.bubbleRisk).toBe('LOW');
  });

  it('saves wallet graph edges to database on cluster detection', async () => {
    const targetDb = createDb();
    const deployTimestamp = 1_000_000;
    mockBubbleFetch({
      [walletA]: deployTimestamp + 1,
      [walletB]: deployTimestamp + 5,
      [walletC]: deployTimestamp + 9,
    });
    const analyzer = new BubbleMapAnalyzer(targetDb, 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');

    await analyzer.runQuickScan(
      tokenAddress,
      [
        { address: walletA, percentOfSupply: 5 },
        { address: walletB, percentOfSupply: 6 },
        { address: walletC, percentOfSupply: 7 },
      ],
      deployTimestamp,
    );
    const edges = getAll<WalletGraphEdgeRow>(
      targetDb,
      'SELECT * FROM wallet_graph_edges WHERE token_address = ?',
      tokenAddress,
    );

    expect(edges.length).toBeGreaterThan(0);
  });
});

describe('calculateOverallRisk', () => {
  it('returns CRITICAL when honeypot fails', () => {
    expect(
      calculateOverallRisk({
        honeypotResult: 'FAIL',
        contractVerified: true,
        liquidityLocked: true,
        devWalletPercent: 1,
      }),
    ).toBe('CRITICAL');
  });

  it('returns CRITICAL when dev holds over 40%', () => {
    expect(
      calculateOverallRisk({
        honeypotResult: 'PASS',
        contractVerified: true,
        liquidityLocked: true,
        devWalletPercent: 41,
      }),
    ).toBe('CRITICAL');
  });

  it('returns HIGH when contract unverified and liquidity unlocked together', () => {
    expect(
      calculateOverallRisk({
        honeypotResult: 'PASS',
        contractVerified: false,
        liquidityLocked: false,
        devWalletPercent: 1,
      }),
    ).toBe('HIGH');
  });

  it('returns MEDIUM when only one warning flag present', () => {
    expect(
      calculateOverallRisk({
        honeypotResult: 'PASS',
        contractVerified: false,
        liquidityLocked: true,
        devWalletPercent: 1,
      }),
    ).toBe('MEDIUM');
  });

  it('returns LOW when all checks pass', () => {
    expect(
      calculateOverallRisk({
        honeypotResult: 'PASS',
        contractVerified: true,
        liquidityLocked: true,
        devWalletPercent: 1,
      }),
    ).toBe('LOW');
  });
});
