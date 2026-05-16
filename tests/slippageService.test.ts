import { afterEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config/env';
import type { DatabaseConnection, SlippageSettingRow } from '../src/db/sqlite';
import {
  deleteSlippageSetting,
  getAll,
  getSlippageSetting,
  initializeDatabase,
  upsertSlippageSetting,
  upsertUser,
} from '../src/db/sqlite';
import {
  parseInlineSlippage,
  SlippageService,
} from '../src/ston/slippageService';

let db: DatabaseConnection | undefined;

function testConfig(overrides: Partial<Config> = {}): Config {
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

function createService(userId = 7001, config: Config = testConfig()): SlippageService {
  db = initializeDatabase(':memory:');
  upsertUser(db, userId);
  return new SlippageService(db, config);
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe('SlippageService.resolveSlippage', () => {
  it('returns inline override at highest priority', () => {
    const service = createService();
    service.setTokenSlippage(7001, 'token-a', 900);
    service.setGlobalSlippage(7001, 700);

    const resolved = service.resolveSlippage(7001, 'token-a', 1200);

    expect(resolved.slippageBps).toBe(1200);
    expect(resolved.source).toBe('inline');
  });

  it('returns token-specific setting when no inline override', () => {
    const service = createService();
    service.setGlobalSlippage(7001, 700);
    service.setTokenSlippage(7001, 'token-a', 900);

    const resolved = service.resolveSlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(900);
    expect(resolved.source).toBe('token');
  });

  it('returns global setting when no token-specific setting', () => {
    const service = createService();
    service.setGlobalSlippage(7001, 700);

    const resolved = service.resolveSlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(700);
    expect(resolved.source).toBe('global');
  });

  it('returns system default when no user settings exist', () => {
    const service = createService(7001, testConfig({ defaultSlippageBps: 450 }));

    const resolved = service.resolveSlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(450);
    expect(resolved.source).toBe('system_default');
  });

  it('ignores token setting for different token address', () => {
    const service = createService();
    service.setTokenSlippage(7001, 'token-a', 900);

    const resolved = service.resolveSlippage(7001, 'token-b');

    expect(resolved.slippageBps).toBe(500);
    expect(resolved.source).toBe('system_default');
  });
});

describe('SlippageService.resolveEmergencySlippage', () => {
  it('returns emergency setting when configured', () => {
    const service = createService();
    service.setEmergencySlippage(7001, 3000);

    const resolved = service.resolveEmergencySlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(3000);
    expect(resolved.source).toBe('emergency');
    expect(resolved.isEmergencyDoubled).toBe(false);
  });

  it('doubles normal slippage when no emergency setting', () => {
    const service = createService();
    service.setGlobalSlippage(7001, 1800);

    const resolved = service.resolveEmergencySlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(3600);
  });

  it('clamps doubled slippage to EMERGENCY_FLOOR_BPS minimum of 2500', () => {
    const service = createService();
    service.setGlobalSlippage(7001, 500);

    const resolved = service.resolveEmergencySlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(2500);
  });

  it('clamps doubled slippage to EMERGENCY_CEILING_BPS maximum of 4900', () => {
    const service = createService();
    service.setGlobalSlippage(7001, 3000);

    const resolved = service.resolveEmergencySlippage(7001, 'token-a');

    expect(resolved.slippageBps).toBe(4900);
  });

  it('marks result as isEmergencyDoubled when doubling applied', () => {
    const service = createService();

    const resolved = service.resolveEmergencySlippage(7001, 'token-a');

    expect(resolved.isEmergencyDoubled).toBe(true);
  });
});

describe('SlippageService.validateSlippageInput', () => {
  it('accepts valid percentage string "5"', () => {
    const result = SlippageService.validateSlippageInput('5');

    expect(result.valid).toBe(true);
    expect(result.slippageBps).toBe(500);
  });

  it('accepts percentage with symbol "15%"', () => {
    const result = SlippageService.validateSlippageInput('15%');

    expect(result.valid).toBe(true);
    expect(result.slippageBps).toBe(1500);
  });

  it('accepts decimal "0.5"', () => {
    const result = SlippageService.validateSlippageInput('0.5');

    expect(result.valid).toBe(true);
    expect(result.slippageBps).toBe(50);
  });

  it('rejects non-numeric input', () => {
    const result = SlippageService.validateSlippageInput('wat');

    expect(result.valid).toBe(false);
  });

  it('rejects value above 49%', () => {
    const result = SlippageService.validateSlippageInput('50');

    expect(result.valid).toBe(false);
  });

  it('rejects negative value', () => {
    const result = SlippageService.validateSlippageInput('-1');

    expect(result.valid).toBe(false);
  });

  it('rejects zero', () => {
    const result = SlippageService.validateSlippageInput('0');

    expect(result.valid).toBe(false);
  });

  it('sets sandwichWarning true at exactly 49%', () => {
    const result = SlippageService.validateSlippageInput('49');

    expect(result.valid).toBe(true);
    expect(result.sandwichWarning).toBe(true);
  });
});

describe('parseInlineSlippage', () => {
  it('parses --slippage flag from args array', () => {
    expect(parseInlineSlippage(['pool', 'token', '2', '--slippage', '15'])).toBe(1500);
  });

  it('parses -s shorthand flag', () => {
    expect(parseInlineSlippage(['pool', 'token', '2', '-s', '12.5'])).toBe(1250);
  });

  it('returns undefined when flag not present', () => {
    expect(parseInlineSlippage(['pool', 'token', '2'])).toBeUndefined();
  });

  it('returns undefined when flag value is invalid', () => {
    expect(parseInlineSlippage(['pool', 'token', '2', '--slippage', 'nope'])).toBeUndefined();
  });

  it('returns undefined when flag has no following value', () => {
    expect(parseInlineSlippage(['pool', 'token', '2', '--slippage'])).toBeUndefined();
  });
});

describe('SlippageService.getUserSlippageSummary', () => {
  it('shows system default when no settings configured', () => {
    const service = createService();

    expect(service.getUserSlippageSummary(7001)).toContain('System default: 5%');
  });

  it('shows global setting when configured', () => {
    const service = createService();
    service.setGlobalSlippage(7001, 800);

    expect(service.getUserSlippageSummary(7001)).toContain('Global default:    8%');
  });

  it('shows emergency setting when configured', () => {
    const service = createService();
    service.setEmergencySlippage(7001, 3000);

    expect(service.getUserSlippageSummary(7001)).toContain('Emergency exits:   30%');
  });

  it('lists token-specific settings', () => {
    const service = createService();
    service.setTokenSlippage(7001, 'EQTokenAddressExample', 1500);

    expect(service.getUserSlippageSummary(7001)).toContain('EQTokenA...mple');
  });
});

describe('upsertSlippageSetting and getSlippageSetting', () => {
  it('stores and retrieves global setting', () => {
    const targetDb = initializeDatabase(':memory:');
    db = targetDb;
    upsertUser(targetDb, 8001);

    upsertSlippageSetting(targetDb, 8001, 600, 'global');

    expect(getSlippageSetting(targetDb, 8001, 'global')?.slippage_bps).toBe(600);
  });

  it('stores and retrieves token-specific setting', () => {
    const targetDb = initializeDatabase(':memory:');
    db = targetDb;
    upsertUser(targetDb, 8002);

    upsertSlippageSetting(targetDb, 8002, 1200, 'token', 'token-a');

    expect(getSlippageSetting(targetDb, 8002, 'token', 'token-a')?.slippage_bps).toBe(1200);
  });

  it('stores and retrieves emergency setting', () => {
    const targetDb = initializeDatabase(':memory:');
    db = targetDb;
    upsertUser(targetDb, 8003);

    upsertSlippageSetting(targetDb, 8003, 3000, 'emergency');

    expect(getSlippageSetting(targetDb, 8003, 'emergency')?.slippage_bps).toBe(3000);
  });

  it('updates existing setting on conflict', () => {
    const targetDb = initializeDatabase(':memory:');
    db = targetDb;
    upsertUser(targetDb, 8004);

    upsertSlippageSetting(targetDb, 8004, 600, 'global');
    upsertSlippageSetting(targetDb, 8004, 700, 'global');

    expect(getSlippageSetting(targetDb, 8004, 'global')?.slippage_bps).toBe(700);
  });

  it('deleteSlippageSetting removes correct row only', () => {
    const targetDb = initializeDatabase(':memory:');
    db = targetDb;
    upsertUser(targetDb, 8005);
    upsertSlippageSetting(targetDb, 8005, 600, 'global');
    upsertSlippageSetting(targetDb, 8005, 1500, 'token', 'token-a');

    deleteSlippageSetting(targetDb, 8005, 'token', 'token-a');
    const rows = getAll<SlippageSettingRow>(
      targetDb,
      'SELECT * FROM slippage_settings WHERE user_id = ?',
      8005,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.setting_type).toBe('global');
  });
});
