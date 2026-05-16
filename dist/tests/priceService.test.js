"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@ton/core");
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const tokenScanner_1 = require("../src/safety/tokenScanner");
const priceService_1 = require("../src/safety/priceService");
let db;
const tokenAddress = core_1.Address.parseRaw(`0:${'1'.repeat(64)}`).toString();
const adminAddress = core_1.Address.parseRaw(`0:${'2'.repeat(64)}`);
const zeroAddress = core_1.Address.parseRaw(`0:${'0'.repeat(64)}`);
function createDb() {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    return db;
}
function mockStack(admin, mintable = 1, totalSupply = 1000000000n) {
    return {
        readBigNumber: vitest_1.vi.fn().mockReturnValue(totalSupply),
        readNumber: vitest_1.vi.fn().mockReturnValue(mintable),
        readAddressOpt: vitest_1.vi.fn().mockReturnValue(admin),
    };
}
function mockTonClient(stack) {
    return {
        runMethod: vitest_1.vi.fn().mockResolvedValue({ stack }),
    };
}
function mockQuoteStonClient(quotes) {
    return {
        getSwapQuote: vitest_1.vi.fn().mockImplementation(async () => {
            const quote = quotes.shift();
            if (quote instanceof Error)
                throw quote;
            return quote;
        }),
    };
}
function createPriceService(stonClient, tonClient) {
    return new priceService_1.PriceService(createDb(), tonClient ?? mockTonClient(mockStack(null)), stonClient);
}
function marketReport(overrides = {}) {
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
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
    vitest_1.vi.restoreAllMocks();
});
(0, vitest_1.describe)('formatSmallPrice', () => {
    (0, vitest_1.it)('formats 0.000282 as 0.0₃282', () => {
        (0, vitest_1.expect)((0, priceService_1.formatSmallPrice)(0.000282)).toBe('0.0₃282');
    });
    (0, vitest_1.it)('formats 0.00000054 as 0.0₆54', () => {
        (0, vitest_1.expect)((0, priceService_1.formatSmallPrice)(0.00000054)).toBe('0.0₆54');
    });
    (0, vitest_1.it)('formats 0.0123 as 0.0123', () => {
        (0, vitest_1.expect)((0, priceService_1.formatSmallPrice)(0.0123)).toBe('0.0123');
    });
    (0, vitest_1.it)('formats 0.5 as 0.5000', () => {
        (0, vitest_1.expect)((0, priceService_1.formatSmallPrice)(0.5)).toBe('0.5000');
    });
    (0, vitest_1.it)('returns 0 for zero input', () => {
        (0, vitest_1.expect)((0, priceService_1.formatSmallPrice)(0)).toBe('0');
    });
    (0, vitest_1.it)('handles prices >= 0.01 with toFixed(4)', () => {
        (0, vitest_1.expect)((0, priceService_1.formatSmallPrice)(1.23456)).toBe('1.2346');
    });
});
(0, vitest_1.describe)('formatUsdValue', () => {
    (0, vitest_1.it)('formats 40460 as $40.46K', () => {
        (0, vitest_1.expect)((0, priceService_1.formatUsdValue)(40_460)).toBe('$40.46K');
    });
    (0, vitest_1.it)('formats 1234567 as $1.23M', () => {
        (0, vitest_1.expect)((0, priceService_1.formatUsdValue)(1_234_567)).toBe('$1.23M');
    });
    (0, vitest_1.it)('formats 1000000000 as $1.00B', () => {
        (0, vitest_1.expect)((0, priceService_1.formatUsdValue)(1_000_000_000)).toBe('$1.00B');
    });
    (0, vitest_1.it)('formats 500 as $500.00', () => {
        (0, vitest_1.expect)((0, priceService_1.formatUsdValue)(500)).toBe('$500.00');
    });
    (0, vitest_1.it)('returns N/A for null input', () => {
        (0, vitest_1.expect)((0, priceService_1.formatUsdValue)(null)).toBe('N/A');
    });
    (0, vitest_1.it)('returns N/A for zero input', () => {
        (0, vitest_1.expect)((0, priceService_1.formatUsdValue)(0)).toBe('N/A');
    });
});
(0, vitest_1.describe)('formatTaxBadge', () => {
    (0, vitest_1.it)('shows 0% for zero taxes', () => {
        (0, vitest_1.expect)((0, priceService_1.formatTaxBadge)(0, 0)).toContain('Buy: 0% | Sell: 0%');
    });
    (0, vitest_1.it)('formats buy and sell tax correctly', () => {
        (0, vitest_1.expect)((0, priceService_1.formatTaxBadge)(10, 12.5)).toContain('Buy: 10.0% | Sell: 12.5%');
    });
    (0, vitest_1.it)('shows warning badge when combined tax exceeds 15%', () => {
        (0, vitest_1.expect)((0, priceService_1.formatTaxBadge)(10, 6)).toContain('⚠️ TAX');
    });
    (0, vitest_1.it)('shows normal badge when combined tax is under 15%', () => {
        (0, vitest_1.expect)((0, priceService_1.formatTaxBadge)(5, 5)).toContain('💰 TAX');
    });
});
(0, vitest_1.describe)('PriceService.checkRenounced', () => {
    (0, vitest_1.it)('returns renounced true when admin address is null', async () => {
        const service = createPriceService({}, mockTonClient(mockStack(null)));
        const result = await service.checkRenounced(tokenAddress);
        (0, vitest_1.expect)(result.renounced).toBe(true);
    });
    (0, vitest_1.it)('returns renounced true when admin address is zero address', async () => {
        const service = createPriceService({}, mockTonClient(mockStack(zeroAddress)));
        const result = await service.checkRenounced(tokenAddress);
        (0, vitest_1.expect)(result.renounced).toBe(true);
    });
    (0, vitest_1.it)('returns renounced false when admin address exists', async () => {
        const service = createPriceService({}, mockTonClient(mockStack(adminAddress)));
        const result = await service.checkRenounced(tokenAddress);
        (0, vitest_1.expect)(result.renounced).toBe(false);
    });
    (0, vitest_1.it)('returns mintable flag from contract data', async () => {
        const service = createPriceService({}, mockTonClient(mockStack(adminAddress, 0)));
        const result = await service.checkRenounced(tokenAddress);
        (0, vitest_1.expect)(result.mintable).toBe(false);
    });
    (0, vitest_1.it)('handles API failure gracefully with safe defaults', async () => {
        const tonClient = {
            runMethod: vitest_1.vi.fn().mockRejectedValue(new Error('boom')),
        };
        const service = createPriceService({}, tonClient);
        const result = await service.checkRenounced(tokenAddress);
        (0, vitest_1.expect)(result.renounced).toBe(false);
        (0, vitest_1.expect)(result.mintable).toBe(true);
    });
});
(0, vitest_1.describe)('PriceService.detectSeparateTaxes', () => {
    (0, vitest_1.it)('returns zero taxes when quotes match expected output', async () => {
        const service = createPriceService(mockQuoteStonClient([
            { askAmount: '100000000', offerAmount: '100000000' },
            { askAmount: '100000000' },
        ]));
        const result = await service.detectSeparateTaxes(tokenAddress, 1000);
        (0, vitest_1.expect)(result.buyTaxPercent).toBe(0);
        (0, vitest_1.expect)(result.sellTaxPercent).toBe(0);
    });
    (0, vitest_1.it)('calculates buy tax from quote shortfall', async () => {
        const service = createPriceService(mockQuoteStonClient([
            { askAmount: '90000000', offerAmount: '100000000' },
            { askAmount: '90000000' },
        ]));
        const result = await service.detectSeparateTaxes(tokenAddress, 1000);
        (0, vitest_1.expect)(result.buyTaxPercent).toBeCloseTo(10);
    });
    (0, vitest_1.it)('calculates sell tax from round-trip shortfall', async () => {
        const service = createPriceService(mockQuoteStonClient([
            { askAmount: '100000000', offerAmount: '100000000' },
            { askAmount: '85000000' },
        ]));
        const result = await service.detectSeparateTaxes(tokenAddress, 1000);
        (0, vitest_1.expect)(result.sellTaxPercent).toBeCloseTo(15);
    });
    (0, vitest_1.it)('flags isSuspicious when combined tax exceeds 15%', async () => {
        const service = createPriceService(mockQuoteStonClient([
            { askAmount: '90000000', offerAmount: '100000000' },
            { askAmount: '81000000' },
        ]));
        const result = await service.detectSeparateTaxes(tokenAddress, 1000);
        (0, vitest_1.expect)(result.combinedTaxPercent).toBeGreaterThan(15);
        (0, vitest_1.expect)(result.isSuspicious).toBe(true);
    });
    (0, vitest_1.it)('handles API failure gracefully with zero values', async () => {
        const service = createPriceService(mockQuoteStonClient([new Error('quote failed')]));
        const result = await service.detectSeparateTaxes(tokenAddress, 1000);
        (0, vitest_1.expect)(result.buyTaxPercent).toBe(0);
        (0, vitest_1.expect)(result.sellTaxPercent).toBe(0);
    });
});
(0, vitest_1.describe)('formatScanCard', () => {
    (0, vitest_1.it)('renders tax line with buy and sell percent', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport(), 'pool-a')).toContain('Buy: 10.0% | Sell: 10.0%');
    });
    (0, vitest_1.it)('renders price in TON with subscript format', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport(), 'pool-a')).toContain('0.0₃282 TON');
    });
    (0, vitest_1.it)('renders USD price in parentheses', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport(), 'pool-a')).toContain('($0.0₃54)');
    });
    (0, vitest_1.it)('renders LP Lock checkmark when locked', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport(), 'pool-a')).toContain('🔒 LP Lock:    ✅');
    });
    (0, vitest_1.it)('renders LP Lock cross when unlocked', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport({ liquidityLock: { ...marketReport().liquidityLock, locked: false } }), 'pool-a')).toContain('🔒 LP Lock:    ❌');
    });
    (0, vitest_1.it)('renders Renounced checkmark when renounced', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport(), 'pool-a')).toContain('🔑 Renounced:  ✅');
    });
    (0, vitest_1.it)('renders Renounced cross when not renounced', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport({ marketData: { ...marketReport().marketData, renounced: false } }), 'pool-a')).toContain('🔑 Renounced:  ❌');
    });
    (0, vitest_1.it)('renders ATH FDV value when available', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport(), 'pool-a')).toContain('📊 ATH FDV:   $670.84K');
    });
    (0, vitest_1.it)('renders N/A when market data is null', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport({ marketData: null }), 'pool-a')).toContain('FDV:    N/A');
    });
    (0, vitest_1.it)('shows cached note when fromCache is true', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport({ fromCache: true }), 'pool-a')).toContain('Cached result');
    });
    (0, vitest_1.it)('shows CRITICAL emoji for critical risk', () => {
        (0, vitest_1.expect)((0, tokenScanner_1.formatScanCard)(marketReport({ overallRisk: 'CRITICAL' }), 'pool-a')).toContain('Overall Risk: 🚨 CRITICAL');
    });
});
