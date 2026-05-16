import { Address } from '@ton/core';
import type { TonClient } from '@ton/ton';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseConnection } from '../src/db/sqlite';
import { initializeDatabase } from '../src/db/sqlite';
import {
  formatScanCard,
  type TokenSafetyReport,
} from '../src/safety/tokenScanner';
import {
  formatSmallPrice,
  formatTaxBadge,
  formatUsdValue,
  PriceService,
} from '../src/safety/priceService';
import type { StonClient } from '../src/ston/stonClient';

let db: DatabaseConnection | undefined;

const tokenAddress = Address.parseRaw(`0:${'1'.repeat(64)}`).toString();
const adminAddress = Address.parseRaw(`0:${'2'.repeat(64)}`);
const zeroAddress = Address.parseRaw(`0:${'0'.repeat(64)}`);

function createDb(): DatabaseConnection {
  db = initializeDatabase(':memory:');
  return db;
}

function mockStack(admin: Address | null, mintable = 1, totalSupply = 1_000_000_000n) {
  return {
    readBigNumber: vi.fn().mockReturnValue(totalSupply),
    readNumber: vi.fn().mockReturnValue(mintable),
    readAddressOpt: vi.fn().mockReturnValue(admin),
  };
}

function mockTonClient(stack: unknown): TonClient {
  return {
    runMethod: vi.fn().mockResolvedValue({ stack }),
  } as unknown as TonClient;
}

function mockQuoteStonClient(quotes: unknown[]): StonClient {
  return {
    getSwapQuote: vi.fn().mockImplementation(async () => {
      const quote = quotes.shift();
      if (quote instanceof Error) throw quote;
      return quote;
    }),
  } as unknown as StonClient;
}

function createPriceService(stonClient: StonClient, tonClient?: TonClient): PriceService {
  return new PriceService(
    createDb(),
    tonClient ?? mockTonClient(mockStack(null)),
    stonClient,
  );
}

function marketReport(overrides: Partial<TokenSafetyReport> = {}): TokenSafetyReport {
  return {
    tokenAddress,
    honeypot: {
      result: 'PASS',
      roundTripLossPercent: 2,
      buyTaxPercent: 1,
      sellTaxPercent: 1,
      message: 'ok',
    },
    contract: {
      codeHash: null,
      verified: false,
      buyTaxPercent: null,
      sellTaxPercent: null,
      renounced: true,
      mintable: false,
      adminAddress: null,
      message: 'unverified',
    },
    liquidityLock: {
      locked: true,
      lockExpiry: null,
      lockerAddress: null,
      largestLpHolderPercent: 10,
      message: 'locked',
    },
    concentration: {
      devWalletAddress: adminAddress.toString(),
      devWalletPercent: 34,
      largestHolderPercent: 34,
      message: 'dev concentration',
    },
    marketData: {
      tokenAddress,
      priceTon: 0.000282,
      priceUsd: 0.00054,
      fdvUsd: 40_460,
      athFdvUsd: 670_840,
      lpValueUsd: 21_870,
      buyTaxPercent: 10,
      sellTaxPercent: 10,
      renounced: true,
      mintable: false,
      totalSupply: '100000000000000',
      tonUsdRate: 1.91,
    },
    overallRisk: 'HIGH',
    recommendation: 'Proceed with extreme caution.',
    fromCache: false,
    scannedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = undefined;
  vi.restoreAllMocks();
});

describe('formatSmallPrice', () => {
  it('formats 0.000282 as 0.0₃282', () => {
    expect(formatSmallPrice(0.000282)).toBe('0.0₃282');
  });

  it('formats 0.00000054 as 0.0₆54', () => {
    expect(formatSmallPrice(0.00000054)).toBe('0.0₆54');
  });

  it('formats 0.0123 as 0.0123', () => {
    expect(formatSmallPrice(0.0123)).toBe('0.0123');
  });

  it('formats 0.5 as 0.5000', () => {
    expect(formatSmallPrice(0.5)).toBe('0.5000');
  });

  it('returns 0 for zero input', () => {
    expect(formatSmallPrice(0)).toBe('0');
  });

  it('handles prices >= 0.01 with toFixed(4)', () => {
    expect(formatSmallPrice(1.23456)).toBe('1.2346');
  });
});

describe('formatUsdValue', () => {
  it('formats 40460 as $40.46K', () => {
    expect(formatUsdValue(40_460)).toBe('$40.46K');
  });

  it('formats 1234567 as $1.23M', () => {
    expect(formatUsdValue(1_234_567)).toBe('$1.23M');
  });

  it('formats 1000000000 as $1.00B', () => {
    expect(formatUsdValue(1_000_000_000)).toBe('$1.00B');
  });

  it('formats 500 as $500.00', () => {
    expect(formatUsdValue(500)).toBe('$500.00');
  });

  it('returns N/A for null input', () => {
    expect(formatUsdValue(null)).toBe('N/A');
  });

  it('returns N/A for zero input', () => {
    expect(formatUsdValue(0)).toBe('N/A');
  });
});

describe('formatTaxBadge', () => {
  it('shows 0% for zero taxes', () => {
    expect(formatTaxBadge(0, 0)).toContain('Buy: 0% | Sell: 0%');
  });

  it('formats buy and sell tax correctly', () => {
    expect(formatTaxBadge(10, 12.5)).toContain('Buy: 10.0% | Sell: 12.5%');
  });

  it('shows warning badge when combined tax exceeds 15%', () => {
    expect(formatTaxBadge(10, 6)).toContain('⚠️ TAX');
  });

  it('shows normal badge when combined tax is under 15%', () => {
    expect(formatTaxBadge(5, 5)).toContain('💰 TAX');
  });
});

describe('PriceService.checkRenounced', () => {
  it('returns renounced true when admin address is null', async () => {
    const service = createPriceService({} as StonClient, mockTonClient(mockStack(null)));

    const result = await service.checkRenounced(tokenAddress);

    expect(result.renounced).toBe(true);
  });

  it('returns renounced true when admin address is zero address', async () => {
    const service = createPriceService(
      {} as StonClient,
      mockTonClient(mockStack(zeroAddress)),
    );

    const result = await service.checkRenounced(tokenAddress);

    expect(result.renounced).toBe(true);
  });

  it('returns renounced false when admin address exists', async () => {
    const service = createPriceService(
      {} as StonClient,
      mockTonClient(mockStack(adminAddress)),
    );

    const result = await service.checkRenounced(tokenAddress);

    expect(result.renounced).toBe(false);
  });

  it('returns mintable flag from contract data', async () => {
    const service = createPriceService(
      {} as StonClient,
      mockTonClient(mockStack(adminAddress, 0)),
    );

    const result = await service.checkRenounced(tokenAddress);

    expect(result.mintable).toBe(false);
  });

  it('handles API failure gracefully with safe defaults', async () => {
    const tonClient = {
      runMethod: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as TonClient;
    const service = createPriceService({} as StonClient, tonClient);

    const result = await service.checkRenounced(tokenAddress);

    expect(result.renounced).toBe(false);
    expect(result.mintable).toBe(true);
  });
});

describe('PriceService.detectSeparateTaxes', () => {
  it('returns zero taxes when quotes match expected output', async () => {
    const service = createPriceService(
      mockQuoteStonClient([
        { askAmount: '100000000', offerAmount: '100000000' },
        { askAmount: '100000000' },
      ]),
    );

    const result = await service.detectSeparateTaxes(tokenAddress, 1000);

    expect(result.buyTaxPercent).toBe(0);
    expect(result.sellTaxPercent).toBe(0);
  });

  it('calculates buy tax from quote shortfall', async () => {
    const service = createPriceService(
      mockQuoteStonClient([
        { askAmount: '90000000', offerAmount: '100000000' },
        { askAmount: '90000000' },
      ]),
    );

    const result = await service.detectSeparateTaxes(tokenAddress, 1000);

    expect(result.buyTaxPercent).toBeCloseTo(10);
  });

  it('calculates sell tax from round-trip shortfall', async () => {
    const service = createPriceService(
      mockQuoteStonClient([
        { askAmount: '100000000', offerAmount: '100000000' },
        { askAmount: '85000000' },
      ]),
    );

    const result = await service.detectSeparateTaxes(tokenAddress, 1000);

    expect(result.sellTaxPercent).toBeCloseTo(15);
  });

  it('flags isSuspicious when combined tax exceeds 15%', async () => {
    const service = createPriceService(
      mockQuoteStonClient([
        { askAmount: '90000000', offerAmount: '100000000' },
        { askAmount: '81000000' },
      ]),
    );

    const result = await service.detectSeparateTaxes(tokenAddress, 1000);

    expect(result.combinedTaxPercent).toBeGreaterThan(15);
    expect(result.isSuspicious).toBe(true);
  });

  it('handles API failure gracefully with zero values', async () => {
    const service = createPriceService(mockQuoteStonClient([new Error('quote failed')]));

    const result = await service.detectSeparateTaxes(tokenAddress, 1000);

    expect(result.buyTaxPercent).toBe(0);
    expect(result.sellTaxPercent).toBe(0);
  });
});

describe('formatScanCard', () => {
  it('renders tax line with buy and sell percent', () => {
    expect(formatScanCard(marketReport(), 'pool-a')).toContain('Buy: 10.0% | Sell: 10.0%');
  });

  it('renders price in TON with subscript format', () => {
    expect(formatScanCard(marketReport(), 'pool-a')).toContain('0.0₃282 TON');
  });

  it('renders USD price in parentheses', () => {
    expect(formatScanCard(marketReport(), 'pool-a')).toContain('($0.0₃54)');
  });

  it('renders LP Lock checkmark when locked', () => {
    expect(formatScanCard(marketReport(), 'pool-a')).toContain('🔒 LP Lock:    ✅');
  });

  it('renders LP Lock cross when unlocked', () => {
    expect(
      formatScanCard(
        marketReport({ liquidityLock: { ...marketReport().liquidityLock, locked: false } }),
        'pool-a',
      ),
    ).toContain('🔒 LP Lock:    ❌');
  });

  it('renders Renounced checkmark when renounced', () => {
    expect(formatScanCard(marketReport(), 'pool-a')).toContain('🔑 Renounced:  ✅');
  });

  it('renders Renounced cross when not renounced', () => {
    expect(
      formatScanCard(
        marketReport({ marketData: { ...marketReport().marketData!, renounced: false } }),
        'pool-a',
      ),
    ).toContain('🔑 Renounced:  ❌');
  });

  it('renders ATH FDV value when available', () => {
    expect(formatScanCard(marketReport(), 'pool-a')).toContain('📊 ATH FDV:   $670.84K');
  });

  it('renders N/A when market data is null', () => {
    expect(formatScanCard(marketReport({ marketData: null }), 'pool-a')).toContain('FDV:    N/A');
  });

  it('shows cached note when fromCache is true', () => {
    expect(formatScanCard(marketReport({ fromCache: true }), 'pool-a')).toContain(
      'Cached result',
    );
  });

  it('shows CRITICAL emoji for critical risk', () => {
    expect(formatScanCard(marketReport({ overallRisk: 'CRITICAL' }), 'pool-a')).toContain(
      'Overall Risk: 🚨 CRITICAL',
    );
  });
});
