"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const sqlite_1 = require("../src/db/sqlite");
const slippageService_1 = require("../src/ston/slippageService");
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
function createService(userId = 7001, config = testConfig()) {
    db = (0, sqlite_1.initializeDatabase)(':memory:');
    (0, sqlite_1.upsertUser)(db, userId);
    return new slippageService_1.SlippageService(db, config);
}
(0, vitest_1.afterEach)(() => {
    db?.close();
    db = undefined;
});
(0, vitest_1.describe)('SlippageService.resolveSlippage', () => {
    (0, vitest_1.it)('returns inline override at highest priority', () => {
        const service = createService();
        service.setTokenSlippage(7001, 'token-a', 900);
        service.setGlobalSlippage(7001, 700);
        const resolved = service.resolveSlippage(7001, 'token-a', 1200);
        (0, vitest_1.expect)(resolved.slippageBps).toBe(1200);
        (0, vitest_1.expect)(resolved.source).toBe('inline');
    });
    (0, vitest_1.it)('returns token-specific setting when no inline override', () => {
        const service = createService();
        service.setGlobalSlippage(7001, 700);
        service.setTokenSlippage(7001, 'token-a', 900);
        const resolved = service.resolveSlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(900);
        (0, vitest_1.expect)(resolved.source).toBe('token');
    });
    (0, vitest_1.it)('returns global setting when no token-specific setting', () => {
        const service = createService();
        service.setGlobalSlippage(7001, 700);
        const resolved = service.resolveSlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(700);
        (0, vitest_1.expect)(resolved.source).toBe('global');
    });
    (0, vitest_1.it)('returns system default when no user settings exist', () => {
        const service = createService(7001, testConfig({ defaultSlippageBps: 450 }));
        const resolved = service.resolveSlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(450);
        (0, vitest_1.expect)(resolved.source).toBe('system_default');
    });
    (0, vitest_1.it)('ignores token setting for different token address', () => {
        const service = createService();
        service.setTokenSlippage(7001, 'token-a', 900);
        const resolved = service.resolveSlippage(7001, 'token-b');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(500);
        (0, vitest_1.expect)(resolved.source).toBe('system_default');
    });
});
(0, vitest_1.describe)('SlippageService.resolveEmergencySlippage', () => {
    (0, vitest_1.it)('returns emergency setting when configured', () => {
        const service = createService();
        service.setEmergencySlippage(7001, 3000);
        const resolved = service.resolveEmergencySlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(3000);
        (0, vitest_1.expect)(resolved.source).toBe('emergency');
        (0, vitest_1.expect)(resolved.isEmergencyDoubled).toBe(false);
    });
    (0, vitest_1.it)('doubles normal slippage when no emergency setting', () => {
        const service = createService();
        service.setGlobalSlippage(7001, 1800);
        const resolved = service.resolveEmergencySlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(3600);
    });
    (0, vitest_1.it)('clamps doubled slippage to EMERGENCY_FLOOR_BPS minimum of 2500', () => {
        const service = createService();
        service.setGlobalSlippage(7001, 500);
        const resolved = service.resolveEmergencySlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(2500);
    });
    (0, vitest_1.it)('clamps doubled slippage to EMERGENCY_CEILING_BPS maximum of 4900', () => {
        const service = createService();
        service.setGlobalSlippage(7001, 3000);
        const resolved = service.resolveEmergencySlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.slippageBps).toBe(4900);
    });
    (0, vitest_1.it)('marks result as isEmergencyDoubled when doubling applied', () => {
        const service = createService();
        const resolved = service.resolveEmergencySlippage(7001, 'token-a');
        (0, vitest_1.expect)(resolved.isEmergencyDoubled).toBe(true);
    });
});
(0, vitest_1.describe)('SlippageService.validateSlippageInput', () => {
    (0, vitest_1.it)('accepts valid percentage string "5"', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('5');
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.slippageBps).toBe(500);
    });
    (0, vitest_1.it)('accepts percentage with symbol "15%"', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('15%');
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.slippageBps).toBe(1500);
    });
    (0, vitest_1.it)('accepts decimal "0.5"', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('0.5');
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.slippageBps).toBe(50);
    });
    (0, vitest_1.it)('rejects non-numeric input', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('wat');
        (0, vitest_1.expect)(result.valid).toBe(false);
    });
    (0, vitest_1.it)('rejects value above 49%', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('50');
        (0, vitest_1.expect)(result.valid).toBe(false);
    });
    (0, vitest_1.it)('rejects negative value', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('-1');
        (0, vitest_1.expect)(result.valid).toBe(false);
    });
    (0, vitest_1.it)('rejects zero', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('0');
        (0, vitest_1.expect)(result.valid).toBe(false);
    });
    (0, vitest_1.it)('sets sandwichWarning true at exactly 49%', () => {
        const result = slippageService_1.SlippageService.validateSlippageInput('49');
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.sandwichWarning).toBe(true);
    });
});
(0, vitest_1.describe)('parseInlineSlippage', () => {
    (0, vitest_1.it)('parses --slippage flag from args array', () => {
        (0, vitest_1.expect)((0, slippageService_1.parseInlineSlippage)(['pool', 'token', '2', '--slippage', '15'])).toBe(1500);
    });
    (0, vitest_1.it)('parses -s shorthand flag', () => {
        (0, vitest_1.expect)((0, slippageService_1.parseInlineSlippage)(['pool', 'token', '2', '-s', '12.5'])).toBe(1250);
    });
    (0, vitest_1.it)('returns undefined when flag not present', () => {
        (0, vitest_1.expect)((0, slippageService_1.parseInlineSlippage)(['pool', 'token', '2'])).toBeUndefined();
    });
    (0, vitest_1.it)('returns undefined when flag value is invalid', () => {
        (0, vitest_1.expect)((0, slippageService_1.parseInlineSlippage)(['pool', 'token', '2', '--slippage', 'nope'])).toBeUndefined();
    });
    (0, vitest_1.it)('returns undefined when flag has no following value', () => {
        (0, vitest_1.expect)((0, slippageService_1.parseInlineSlippage)(['pool', 'token', '2', '--slippage'])).toBeUndefined();
    });
});
(0, vitest_1.describe)('SlippageService.getUserSlippageSummary', () => {
    (0, vitest_1.it)('shows system default when no settings configured', () => {
        const service = createService();
        (0, vitest_1.expect)(service.getUserSlippageSummary(7001)).toContain('System default: 5%');
    });
    (0, vitest_1.it)('shows global setting when configured', () => {
        const service = createService();
        service.setGlobalSlippage(7001, 800);
        (0, vitest_1.expect)(service.getUserSlippageSummary(7001)).toContain('Global default:    8%');
    });
    (0, vitest_1.it)('shows emergency setting when configured', () => {
        const service = createService();
        service.setEmergencySlippage(7001, 3000);
        (0, vitest_1.expect)(service.getUserSlippageSummary(7001)).toContain('Emergency exits:   30%');
    });
    (0, vitest_1.it)('lists token-specific settings', () => {
        const service = createService();
        service.setTokenSlippage(7001, 'EQTokenAddressExample', 1500);
        (0, vitest_1.expect)(service.getUserSlippageSummary(7001)).toContain('EQTokenA...mple');
    });
});
(0, vitest_1.describe)('upsertSlippageSetting and getSlippageSetting', () => {
    (0, vitest_1.it)('stores and retrieves global setting', () => {
        const targetDb = (0, sqlite_1.initializeDatabase)(':memory:');
        db = targetDb;
        (0, sqlite_1.upsertUser)(targetDb, 8001);
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8001, 600, 'global');
        (0, vitest_1.expect)((0, sqlite_1.getSlippageSetting)(targetDb, 8001, 'global')?.slippage_bps).toBe(600);
    });
    (0, vitest_1.it)('stores and retrieves token-specific setting', () => {
        const targetDb = (0, sqlite_1.initializeDatabase)(':memory:');
        db = targetDb;
        (0, sqlite_1.upsertUser)(targetDb, 8002);
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8002, 1200, 'token', 'token-a');
        (0, vitest_1.expect)((0, sqlite_1.getSlippageSetting)(targetDb, 8002, 'token', 'token-a')?.slippage_bps).toBe(1200);
    });
    (0, vitest_1.it)('stores and retrieves emergency setting', () => {
        const targetDb = (0, sqlite_1.initializeDatabase)(':memory:');
        db = targetDb;
        (0, sqlite_1.upsertUser)(targetDb, 8003);
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8003, 3000, 'emergency');
        (0, vitest_1.expect)((0, sqlite_1.getSlippageSetting)(targetDb, 8003, 'emergency')?.slippage_bps).toBe(3000);
    });
    (0, vitest_1.it)('updates existing setting on conflict', () => {
        const targetDb = (0, sqlite_1.initializeDatabase)(':memory:');
        db = targetDb;
        (0, sqlite_1.upsertUser)(targetDb, 8004);
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8004, 600, 'global');
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8004, 700, 'global');
        (0, vitest_1.expect)((0, sqlite_1.getSlippageSetting)(targetDb, 8004, 'global')?.slippage_bps).toBe(700);
    });
    (0, vitest_1.it)('deleteSlippageSetting removes correct row only', () => {
        const targetDb = (0, sqlite_1.initializeDatabase)(':memory:');
        db = targetDb;
        (0, sqlite_1.upsertUser)(targetDb, 8005);
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8005, 600, 'global');
        (0, sqlite_1.upsertSlippageSetting)(targetDb, 8005, 1500, 'token', 'token-a');
        (0, sqlite_1.deleteSlippageSetting)(targetDb, 8005, 'token', 'token-a');
        const rows = (0, sqlite_1.getAll)(targetDb, 'SELECT * FROM slippage_settings WHERE user_id = ?', 8005);
        (0, vitest_1.expect)(rows).toHaveLength(1);
        (0, vitest_1.expect)(rows[0]?.setting_type).toBe('global');
    });
});
