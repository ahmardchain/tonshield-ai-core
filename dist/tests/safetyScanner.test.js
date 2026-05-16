"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@ton/core");
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const bubbleMap_1 = require("../src/safety/bubbleMap");
const safetyCache_1 = require("../src/safety/safetyCache");
const tokenScanner_1 = require("../src/safety/tokenScanner");
let db;
const tokenAddress = core_1.Address.parseRaw(`0:${'1'.repeat(64)}`).toString();
const poolAddress = core_1.Address.parseRaw(`0:${'2'.repeat(64)}`).toString();
const devAddress = core_1.Address.parseRaw(`0:${'3'.repeat(64)}`).toString();
const walletA = core_1.Address.parseRaw(`0:${'4'.repeat(64)}`).toString();
const walletB = core_1.Address.parseRaw(`0:${'5'.repeat(64)}`).toString();
const walletC = core_1.Address.parseRaw(`0:${'6'.repeat(64)}`).toString();
const walletD = core_1.Address.parseRaw(`0:${'7'.repeat(64)}`).toString();
function jsonResponse(payload) {
    return {
        json: vitest_1.vi.fn().mockResolvedValue(payload),
    };
}
function createDb() {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    return db;
}
function mockToncenterFetch(params = {}) {
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
    vitest_1.vi.stubGlobal('fetch', vitest_1.vi.fn(async (input) => {
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
    }));
}
function mockBubbleFetch(timestamps, fundingSource = devAddress) {
    vitest_1.vi.stubGlobal('fetch', vitest_1.vi.fn(async (input) => {
        const url = String(input);
        const match = /address=([^&]+)/.exec(url);
        const address = match?.[1] ?? '';
        const timestamp = timestamps[address] ?? null;
        return jsonResponse({
            result: timestamp === null
                ? []
                : [{ utime: timestamp, in_msg: { source: fundingSource } }],
        });
    }));
}
function mockTonClient(code = Buffer.from('unknown-code')) {
    return {
        getContractState: vitest_1.vi.fn().mockResolvedValue({ code }),
    };
}
function mockStonClient(firstAskAmount, secondAskAmount = '900000000') {
    return {
        getSwapQuote: vitest_1.vi
            .fn()
            .mockResolvedValueOnce({ askAmount: firstAskAmount })
            .mockResolvedValueOnce({ askAmount: secondAskAmount }),
    };
}
function createScanner(stonClient, tonClient = mockTonClient()) {
    return new tokenScanner_1.TokenSafetyScanner({
        db: createDb(),
        tonClient,
        stonClient,
        toncenterApiKey: 'test-key',
        toncenterEndpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
    });
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
    vitest_1.vi.restoreAllMocks();
    vitest_1.vi.unstubAllGlobals();
});
(0, vitest_1.describe)('TokenSafetyScanner', () => {
    (0, vitest_1.it)('returns FAIL honeypot result when buy quote returns zero tokens', async () => {
        mockToncenterFetch();
        const scanner = createScanner(mockStonClient('0'));
        const report = await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(report.honeypot.result).toBe('FAIL');
    });
    (0, vitest_1.it)('returns WARN when round-trip loss is between 20% and 50%', async () => {
        mockToncenterFetch();
        const scanner = createScanner(mockStonClient('1000000000', '700000000'));
        const report = await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(report.honeypot.result).toBe('WARN');
        (0, vitest_1.expect)(report.honeypot.roundTripLossPercent).toBeCloseTo(30);
    });
    (0, vitest_1.it)('returns PASS when round-trip loss is under 20%', async () => {
        mockToncenterFetch();
        const scanner = createScanner(mockStonClient('1000000000', '900000000'));
        const report = await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(report.honeypot.result).toBe('PASS');
        (0, vitest_1.expect)(report.honeypot.roundTripLossPercent).toBeCloseTo(10);
    });
    (0, vitest_1.it)('marks contract as unverified when code hash is unknown', async () => {
        mockToncenterFetch();
        const scanner = createScanner(mockStonClient('1000000000', '900000000'));
        const report = await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(report.contract.verified).toBe(false);
        (0, vitest_1.expect)(report.contract.message).toContain('unverified');
    });
    (0, vitest_1.it)('calculates overall risk as CRITICAL when honeypot is FAIL', async () => {
        mockToncenterFetch();
        const scanner = createScanner(mockStonClient('0'));
        const report = await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(report.overallRisk).toBe('CRITICAL');
    });
    (0, vitest_1.it)('calculates overall risk as HIGH when dev holds over 20%', async () => {
        mockToncenterFetch({
            tokenHolders: [
                { address: devAddress, balance: '250' },
                { address: walletA, balance: '750' },
            ],
        });
        const scanner = createScanner(mockStonClient('1000000000', '900000000'));
        const report = await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(report.concentration.devWalletPercent).toBe(25);
        (0, vitest_1.expect)(report.overallRisk).toBe('HIGH');
    });
    (0, vitest_1.it)('calculates overall risk as LOW when all checks pass', () => {
        const risk = (0, safetyCache_1.calculateOverallRisk)({
            honeypotResult: 'PASS',
            contractVerified: true,
            liquidityLocked: true,
            devWalletPercent: 3,
        });
        (0, vitest_1.expect)(risk).toBe('LOW');
    });
    (0, vitest_1.it)('returns cached result within TTL window', async () => {
        mockToncenterFetch();
        const stonClient = mockStonClient('1000000000', '900000000');
        const scanner = createScanner(stonClient);
        await scanner.scanToken(tokenAddress, poolAddress);
        const second = await scanner.scanToken(tokenAddress, poolAddress);
        (0, vitest_1.expect)(second.fromCache).toBe(true);
        (0, vitest_1.expect)(stonClient.getSwapQuote).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('forces fresh scan when forceRefresh is true', async () => {
        mockToncenterFetch();
        const stonClient = {
            getSwapQuote: vitest_1.vi
                .fn()
                .mockResolvedValueOnce({ askAmount: '1000000000' })
                .mockResolvedValueOnce({ askAmount: '900000000' })
                .mockResolvedValueOnce({ askAmount: '1000000000' })
                .mockResolvedValueOnce({ askAmount: '900000000' }),
        };
        const scanner = createScanner(stonClient);
        await scanner.scanToken(tokenAddress, poolAddress);
        await scanner.scanToken(tokenAddress, poolAddress, true);
        (0, vitest_1.expect)(stonClient.getSwapQuote).toHaveBeenCalledTimes(4);
    });
});
(0, vitest_1.describe)('BubbleMapAnalyzer', () => {
    (0, vitest_1.it)('detects synchronized timing cluster when 3+ wallets buy within window', async () => {
        const deployTimestamp = 1_000_000;
        mockBubbleFetch({
            [walletA]: deployTimestamp + 1,
            [walletB]: deployTimestamp + 5,
            [walletC]: deployTimestamp + 9,
        });
        const analyzer = new bubbleMap_1.BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');
        const report = await analyzer.runQuickScan(tokenAddress, [
            { address: walletA, percentOfSupply: 5 },
            { address: walletB, percentOfSupply: 6 },
            { address: walletC, percentOfSupply: 7 },
        ], deployTimestamp);
        (0, vitest_1.expect)(report.clustersFound).toBeGreaterThan(0);
        (0, vitest_1.expect)(report.clusters[0]?.connectionType).toBe('synchronized_timing');
    });
    (0, vitest_1.it)('detects dormancy cluster when 3+ wallets have no history before launch', async () => {
        const deployTimestamp = 1_000_000;
        mockBubbleFetch({
            [walletA]: deployTimestamp - 3_600,
            [walletB]: deployTimestamp - 7_200,
            [walletC]: deployTimestamp - 10_800,
        });
        const analyzer = new bubbleMap_1.BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');
        const report = await analyzer.runQuickScan(tokenAddress, [
            { address: walletA, percentOfSupply: 2 },
            { address: walletB, percentOfSupply: 3 },
            { address: walletC, percentOfSupply: 4 },
        ], deployTimestamp);
        (0, vitest_1.expect)(report.clusters.some((cluster) => cluster.connectionType === 'dormancy')).toBe(true);
    });
    (0, vitest_1.it)('deduplicates overlapping clusters correctly', async () => {
        const deployTimestamp = 1_000_000;
        mockBubbleFetch({
            [walletA]: deployTimestamp + 1,
            [walletB]: deployTimestamp + 5,
            [walletC]: deployTimestamp + 9,
        });
        const analyzer = new bubbleMap_1.BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');
        const report = await analyzer.runDeepScan(tokenAddress, [
            { address: walletA, percentOfSupply: 5 },
            { address: walletB, percentOfSupply: 6 },
            { address: walletC, percentOfSupply: 7 },
        ], deployTimestamp);
        (0, vitest_1.expect)(report.clustersFound).toBe(1);
    });
    (0, vitest_1.it)('scores bubble risk as CRITICAL when suspicious supply exceeds 50%', async () => {
        const deployTimestamp = 1_000_000;
        mockBubbleFetch({
            [walletA]: deployTimestamp + 1,
            [walletB]: deployTimestamp + 5,
            [walletC]: deployTimestamp + 9,
        });
        const analyzer = new bubbleMap_1.BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');
        const report = await analyzer.runQuickScan(tokenAddress, [
            { address: walletA, percentOfSupply: 20 },
            { address: walletB, percentOfSupply: 20 },
            { address: walletC, percentOfSupply: 20 },
        ], deployTimestamp);
        (0, vitest_1.expect)(report.bubbleRisk).toBe('CRITICAL');
    });
    (0, vitest_1.it)('scores bubble risk as LOW when no clusters found', async () => {
        const deployTimestamp = 1_000_000;
        mockBubbleFetch({
            [walletA]: deployTimestamp - 86400 * 30,
            [walletB]: deployTimestamp - 86400 * 31,
        });
        const analyzer = new bubbleMap_1.BubbleMapAnalyzer(createDb(), 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');
        const report = await analyzer.runQuickScan(tokenAddress, [
            { address: walletA, percentOfSupply: 5 },
            { address: walletB, percentOfSupply: 6 },
        ], deployTimestamp);
        (0, vitest_1.expect)(report.clustersFound).toBe(0);
        (0, vitest_1.expect)(report.bubbleRisk).toBe('LOW');
    });
    (0, vitest_1.it)('saves wallet graph edges to database on cluster detection', async () => {
        const targetDb = createDb();
        const deployTimestamp = 1_000_000;
        mockBubbleFetch({
            [walletA]: deployTimestamp + 1,
            [walletB]: deployTimestamp + 5,
            [walletC]: deployTimestamp + 9,
        });
        const analyzer = new bubbleMap_1.BubbleMapAnalyzer(targetDb, 'test-key', 'https://testnet.toncenter.com/api/v2/jsonRPC');
        await analyzer.runQuickScan(tokenAddress, [
            { address: walletA, percentOfSupply: 5 },
            { address: walletB, percentOfSupply: 6 },
            { address: walletC, percentOfSupply: 7 },
        ], deployTimestamp);
        const edges = (0, sqlite_1.getAll)(targetDb, 'SELECT * FROM wallet_graph_edges WHERE token_address = ?', tokenAddress);
        (0, vitest_1.expect)(edges.length).toBeGreaterThan(0);
    });
});
(0, vitest_1.describe)('calculateOverallRisk', () => {
    (0, vitest_1.it)('returns CRITICAL when honeypot fails', () => {
        (0, vitest_1.expect)((0, safetyCache_1.calculateOverallRisk)({
            honeypotResult: 'FAIL',
            contractVerified: true,
            liquidityLocked: true,
            devWalletPercent: 1,
        })).toBe('CRITICAL');
    });
    (0, vitest_1.it)('returns CRITICAL when dev holds over 40%', () => {
        (0, vitest_1.expect)((0, safetyCache_1.calculateOverallRisk)({
            honeypotResult: 'PASS',
            contractVerified: true,
            liquidityLocked: true,
            devWalletPercent: 41,
        })).toBe('CRITICAL');
    });
    (0, vitest_1.it)('returns HIGH when contract unverified and liquidity unlocked together', () => {
        (0, vitest_1.expect)((0, safetyCache_1.calculateOverallRisk)({
            honeypotResult: 'PASS',
            contractVerified: false,
            liquidityLocked: false,
            devWalletPercent: 1,
        })).toBe('HIGH');
    });
    (0, vitest_1.it)('returns MEDIUM when only one warning flag present', () => {
        (0, vitest_1.expect)((0, safetyCache_1.calculateOverallRisk)({
            honeypotResult: 'PASS',
            contractVerified: false,
            liquidityLocked: true,
            devWalletPercent: 1,
        })).toBe('MEDIUM');
    });
    (0, vitest_1.it)('returns LOW when all checks pass', () => {
        (0, vitest_1.expect)((0, safetyCache_1.calculateOverallRisk)({
            honeypotResult: 'PASS',
            contractVerified: true,
            liquidityLocked: true,
            devWalletPercent: 1,
        })).toBe('LOW');
    });
});
