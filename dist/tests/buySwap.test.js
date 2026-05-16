"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const swapBuilder_1 = require("../src/ston/swapBuilder");
let db;
function testConfig(overrides = {}) {
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
function fixedStonClient() {
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
    };
}
function createExecutor(config, stonClient = fixedStonClient()) {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    return new swapBuilder_1.StonFiExecutor({
        db,
        config,
        tonClient: {},
        stonClient,
        budgetPolicy: {},
        agentWallet: {},
    });
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
});
(0, vitest_1.describe)('executeBuySwap', () => {
    (0, vitest_1.it)('blocks buy on mainnet when ENABLE_MAINNET_EXECUTION is false', async () => {
        const executor = createExecutor(testConfig({ network: 'mainnet', enableMainnetExecution: false }));
        const result = await executor.executeBuySwap(9001, 'pool-a', 'token-a', 2);
        (0, vitest_1.expect)(result.status).toBe('blocked_mainnet_guard');
    });
    (0, vitest_1.it)('logs buy attempt to swap_attempts before execution', async () => {
        const executor = createExecutor(testConfig({ network: 'mainnet', enableMainnetExecution: false }));
        await executor.executeBuySwap(9002, 'pool-b', 'token-b', 2);
        const attempt = (0, sqlite_1.getOne)(db, 'SELECT * FROM swap_attempts WHERE user_id = ? AND pool_address = ? LIMIT 1', 9002, 'pool-b');
        (0, vitest_1.expect)(attempt).toBeDefined();
        (0, vitest_1.expect)(attempt?.mode).toBe('live');
        (0, vitest_1.expect)(attempt?.pool_address).toBe('pool-b');
    });
    (0, vitest_1.it)('returns simulated result in paper trade mode', async () => {
        const executor = createExecutor(testConfig({ paperTrade: true }));
        const result = await executor.simulateBuySwap(9003, 'pool-c', 'token-c', 2);
        (0, vitest_1.expect)(result.status).toBe('simulated');
        (0, vitest_1.expect)(result.entryPriceTon).toBeGreaterThan(0);
        (0, vitest_1.expect)(result.estimatedTokenOut).toBe('400');
    });
    (0, vitest_1.it)('opens position record after successful buy', () => {
        db = (0, sqlite_1.initializeDatabase)(':memory:');
        (0, sqlite_1.upsertUser)(db, 9004);
        const positionId = (0, sqlite_1.openPosition)(db, 9004, 'pool-d', 'token-d', 0.5, 2, 'tx-open');
        const position = (0, sqlite_1.getOne)(db, 'SELECT * FROM positions WHERE id = ? LIMIT 1', positionId);
        (0, vitest_1.expect)(position?.status).toBe('open');
        (0, vitest_1.expect)(position?.entry_price_ton).toBe(0.5);
    });
});
