"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const triggerEngine_1 = require("../src/risk/triggerEngine");
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
function breachedVelocity() {
    return {
        rollingDropPercent: 40,
        maxSingleDrop: 45,
        snapshotCount: 8,
        isBreached: true,
    };
}
function createEngine(config) {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    (0, sqlite_1.upsertUser)(db, 2001);
    const telegram = { sendMessage: vitest_1.vi.fn().mockResolvedValue(undefined) };
    const executor = {
        executeDefensiveSwap: vitest_1.vi.fn().mockResolvedValue({ status: 'success' }),
        simulateDefensiveSwap: vitest_1.vi.fn().mockResolvedValue({ status: 'simulated' }),
        logBlockedMainnetAttempt: vitest_1.vi.fn().mockReturnValue(1),
    };
    const engine = new triggerEngine_1.TriggerEngine({
        db,
        config,
        telegram,
        swapExecutor: executor,
        defaultTokenAddress: 'token-a',
    });
    return { engine, executor };
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
});
(0, vitest_1.describe)('TriggerEngine', () => {
    (0, vitest_1.it)('calls executeDefensiveSwap when pool is armed and network is testnet', async () => {
        const { engine, executor } = createEngine(testConfig({ paperTrade: false }));
        (0, sqlite_1.addArmedPool)(db, 2001, 'pool-a');
        const result = await engine.handleBreach(2001, 'pool-a', breachedVelocity());
        (0, vitest_1.expect)(result.action).toBe('testnet_executed');
        (0, vitest_1.expect)(executor.executeDefensiveSwap).toHaveBeenCalledWith(2001, 'pool-a', 'token-a', 1);
    });
    (0, vitest_1.it)('calls simulateDefensiveSwap when paper mode is active', async () => {
        const { engine, executor } = createEngine(testConfig({ paperTrade: true }));
        (0, sqlite_1.addArmedPool)(db, 2001, 'pool-b');
        const result = await engine.handleBreach(2001, 'pool-b', breachedVelocity());
        (0, vitest_1.expect)(result.action).toBe('paper_simulated');
        (0, vitest_1.expect)(executor.simulateDefensiveSwap).toHaveBeenCalledWith(2001, 'pool-b', 1);
        (0, vitest_1.expect)(executor.executeDefensiveSwap).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('does not execute when pool is not armed', async () => {
        const { engine, executor } = createEngine(testConfig({ paperTrade: false }));
        const result = await engine.handleBreach(2001, 'pool-c', breachedVelocity());
        (0, vitest_1.expect)(result.action).toBe('alert_only');
        (0, vitest_1.expect)(executor.executeDefensiveSwap).not.toHaveBeenCalled();
        (0, vitest_1.expect)(executor.simulateDefensiveSwap).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('logs a blocked attempt when armed pool breaches on guarded mainnet', async () => {
        const { engine, executor } = createEngine(testConfig({ network: 'mainnet', enableMainnetExecution: false, paperTrade: false }));
        (0, sqlite_1.addArmedPool)(db, 2001, 'pool-d');
        const result = await engine.handleBreach(2001, 'pool-d', breachedVelocity());
        (0, vitest_1.expect)(result.action).toBe('blocked_mainnet_guard');
        (0, vitest_1.expect)(executor.logBlockedMainnetAttempt).toHaveBeenCalledWith(2001, 'pool-d', 'token-a', 1, vitest_1.expect.stringContaining('Mainnet execution blocked'));
        (0, vitest_1.expect)(executor.executeDefensiveSwap).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('still blocks mainnet execution after both flags because MVP mainnet is unaudited', async () => {
        const { engine, executor } = createEngine(testConfig({ network: 'mainnet', enableMainnetExecution: true, paperTrade: false }));
        (0, sqlite_1.addArmedPool)(db, 2001, 'pool-e');
        const result = await engine.handleBreach(2001, 'pool-e', breachedVelocity());
        (0, vitest_1.expect)(result.action).toBe('blocked_mainnet_guard');
        (0, vitest_1.expect)(executor.logBlockedMainnetAttempt).toHaveBeenCalledWith(2001, 'pool-e', 'token-a', 1, vitest_1.expect.stringContaining('independent audit'));
    });
});
