"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const ton_1 = require("@ton/ton");
const sqlite_1 = require("../src/db/sqlite");
const networkGuard_1 = require("../src/ston/networkGuard");
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
function createExecutor(config) {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    (0, sqlite_1.upsertUser)(db, 3001);
    return new swapBuilder_1.StonFiExecutor({
        db,
        config,
        tonClient: new ton_1.TonClient({
            endpoint: config.toncenterEndpoint,
            apiKey: config.toncenterApiKey,
        }),
        stonClient: {},
        budgetPolicy: {},
        agentWallet: {},
    });
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
});
(0, vitest_1.describe)('network guard', () => {
    (0, vitest_1.it)('blocks execution when NETWORK=mainnet and ENABLE_MAINNET_EXECUTION=false', async () => {
        const executor = createExecutor(testConfig({ network: 'mainnet', enableMainnetExecution: false }));
        const result = await executor.executeDefensiveSwap(3001, 'pool-a', 'token-a', 1);
        (0, vitest_1.expect)(result.status).toBe('blocked_mainnet_guard');
    });
    (0, vitest_1.it)('logs blocked_mainnet_guard status to swap_attempts', async () => {
        const executor = createExecutor(testConfig({ network: 'mainnet', enableMainnetExecution: false }));
        await executor.executeDefensiveSwap(3001, 'pool-b', 'token-b', 1);
        const attempt = (0, sqlite_1.getOne)(db, 'SELECT * FROM swap_attempts WHERE user_id = ? AND pool_address = ? LIMIT 1', 3001, 'pool-b');
        (0, vitest_1.expect)(attempt?.status).toBe('blocked_mainnet_guard');
    });
    (0, vitest_1.it)('keeps direct executor mainnet execution blocked even when the double guard is enabled', async () => {
        const executor = createExecutor(testConfig({ network: 'mainnet', enableMainnetExecution: true }));
        const result = await executor.executeDefensiveSwap(3001, 'pool-c', 'token-c', 1);
        (0, vitest_1.expect)(result.status).toBe('blocked_mainnet_guard');
    });
    (0, vitest_1.it)('allows testnet execution by default', () => {
        (0, vitest_1.expect)((0, networkGuard_1.canExecuteLiveTransactions)(testConfig({ network: 'testnet' }))).toBe(true);
    });
});
