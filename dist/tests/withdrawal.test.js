"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@ton/core");
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const withdrawalEngine_1 = require("../src/wallet/withdrawalEngine");
let db;
const agentAddress = core_1.Address.parseRaw(`0:${'0'.repeat(64)}`).toString();
const destinationAddress = core_1.Address.parseRaw(`0:${'1'.repeat(64)}`).toString();
const tokenAddress = core_1.Address.parseRaw(`0:${'2'.repeat(64)}`).toString();
const jettonWalletAddress = core_1.Address.parseRaw(`0:${'3'.repeat(64)}`);
function testConfig() {
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
function mockAgentWallet(send = vitest_1.vi.fn().mockResolvedValue(undefined)) {
    return {
        decryptAndLoadWallet: vitest_1.vi.fn().mockResolvedValue({
            address: agentAddress,
            wallet: {},
            sender: { send },
        }),
    };
}
function mockTonClient(balance) {
    return {
        getBalance: vitest_1.vi.fn().mockResolvedValue(balance),
        runMethod: vitest_1.vi.fn(),
    };
}
function createEngine(userId, tonClient, agentWallet = mockAgentWallet()) {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    (0, sqlite_1.upsertUser)(db, userId);
    return new withdrawalEngine_1.WithdrawalEngine(db, testConfig(), tonClient, agentWallet);
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
    vitest_1.vi.restoreAllMocks();
});
(0, vitest_1.describe)('WithdrawalEngine', () => {
    (0, vitest_1.it)('withdrawTon rejects when amount exceeds balance minus gas reserve', async () => {
        const engine = createEngine(9101, mockTonClient((0, core_1.toNano)('1')));
        const result = await engine.withdrawTon(9101, destinationAddress, 0.9);
        (0, vitest_1.expect)(result.status).toBe('rejected');
        (0, vitest_1.expect)(result.errorMessage).toContain('exceeds withdrawable balance');
    });
    (0, vitest_1.it)('withdrawTon logs attempt to database before execution', async () => {
        const engine = createEngine(9102, mockTonClient((0, core_1.toNano)('1')));
        await engine.withdrawTon(9102, destinationAddress, 0.9);
        const attempt = (0, sqlite_1.getOne)(db, 'SELECT * FROM withdrawal_attempts WHERE user_id = ? LIMIT 1', 9102);
        (0, vitest_1.expect)(attempt).toBeDefined();
        (0, vitest_1.expect)(attempt?.withdrawal_type).toBe('ton');
        (0, vitest_1.expect)(attempt?.destination_address).toBe(destinationAddress);
    });
    (0, vitest_1.it)('withdrawAllTon calculates correct withdrawable amount', async () => {
        const send = vitest_1.vi.fn().mockResolvedValue(undefined);
        const engine = createEngine(9103, mockTonClient((0, core_1.toNano)('1')), mockAgentWallet(send));
        const result = await engine.withdrawAllTon(9103, destinationAddress);
        (0, vitest_1.expect)(result.status).toBe('success');
        (0, vitest_1.expect)(send).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(send.mock.calls[0]?.[0].value).toBe((0, core_1.toNano)('0.85'));
    });
    (0, vitest_1.it)('withdrawToken rejects when Jetton balance is zero', async () => {
        const send = vitest_1.vi.fn().mockResolvedValue(undefined);
        const tonClient = {
            getBalance: vitest_1.vi.fn(),
            runMethod: vitest_1.vi
                .fn()
                .mockResolvedValueOnce({ stack: { readAddress: () => jettonWalletAddress } })
                .mockResolvedValueOnce({ stack: { readBigNumber: () => 0n } }),
        };
        const engine = createEngine(9104, tonClient, mockAgentWallet(send));
        const result = await engine.withdrawToken(9104, tokenAddress, destinationAddress);
        (0, vitest_1.expect)(result.status).toBe('rejected');
        (0, vitest_1.expect)(result.errorMessage).toBe('No token balance found in agent wallet for this token address.');
        (0, vitest_1.expect)(send).not.toHaveBeenCalled();
    });
});
