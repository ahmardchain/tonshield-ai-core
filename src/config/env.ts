import dotenv from 'dotenv';

dotenv.config();

export type Network = 'testnet' | 'mainnet';

export interface Config {
  telegramBotToken: string;
  toncenterApiKey: string;
  toncenterEndpoint: string;
  network: Network;
  enableMainnetExecution: boolean;
  agentWalletEncryptionKey: Buffer;
  databasePath: string;
  monitorIntervalSeconds: number;
  riskDropThresholdPercent: number;
  defaultSlippageBps: number;
  paperTrade: boolean;
}

interface EnvSpec {
  name: string;
  purpose: string;
  required: boolean;
  defaultValue?: string;
}

const ENV_SPECS: EnvSpec[] = [
  {
    name: 'TELEGRAM_BOT_TOKEN',
    purpose: 'Telegraf bot token used to receive commands and send alerts.',
    required: true,
  },
  {
    name: 'TONCENTER_API_KEY',
    purpose: 'TON Center API key used by TonClient for wallet and transaction RPC calls.',
    required: true,
  },
  {
    name: 'TONCENTER_ENDPOINT',
    purpose: 'TON Center JSON-RPC endpoint. Defaults to the TON testnet endpoint.',
    required: false,
    defaultValue: 'https://testnet.toncenter.com/api/v2/jsonRPC',
  },
  {
    name: 'NETWORK',
    purpose: 'Execution network selector. Must be either testnet or mainnet.',
    required: false,
    defaultValue: 'testnet',
  },
  {
    name: 'ENABLE_MAINNET_EXECUTION',
    purpose: 'Second explicit guard required before any mainnet transaction execution.',
    required: false,
    defaultValue: 'false',
  },
  {
    name: 'AGENT_WALLET_ENCRYPTION_KEY',
    purpose: '64-character hex key used for AES-256-GCM encryption of agent wallet mnemonics.',
    required: true,
  },
  {
    name: 'DATABASE_PATH',
    purpose: 'SQLite database file path.',
    required: false,
    defaultValue: './tonshield.db',
  },
  {
    name: 'MONITOR_INTERVAL_SECONDS',
    purpose: 'Polling interval for watched pools.',
    required: false,
    defaultValue: '30',
  },
  {
    name: 'RISK_DROP_THRESHOLD_PERCENT',
    purpose: 'Rolling liquidity-depth drop percentage that triggers alerts.',
    required: false,
    defaultValue: '25',
  },
  {
    name: 'DEFAULT_SLIPPAGE_BPS',
    purpose: 'Default swap slippage tolerance in basis points.',
    required: false,
    defaultValue: '500',
  },
  {
    name: 'PAPER_TRADE',
    purpose: 'When true, armed defenses simulate swaps instead of broadcasting transactions.',
    required: false,
    defaultValue: 'true',
  },
];

type Environment = Record<string, string | undefined>;

export class ConfigurationError extends Error {
  public readonly missingVariables: string[];

  public constructor(message: string, missingVariables: string[] = []) {
    super(message);
    this.name = 'ConfigurationError';
    this.missingVariables = missingVariables;
  }
}

function requiredValue(env: Environment, spec: EnvSpec): string | undefined {
  return env[spec.name] ?? spec.defaultValue;
}

function parseBoolean(name: string, value: string): boolean {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new ConfigurationError(`${name} must be either "true" or "false". Received: ${value}`);
}

function parsePositiveNumber(name: string, value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive number. Received: ${value}`);
  }

  return parsed;
}

function parseNetwork(value: string): Network {
  if (value === 'testnet' || value === 'mainnet') {
    return value;
  }

  throw new ConfigurationError(`NETWORK must be either "testnet" or "mainnet". Received: ${value}`);
}

function parseEncryptionKey(value: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ConfigurationError(
      'AGENT_WALLET_ENCRYPTION_KEY must be a 32-byte key encoded as exactly 64 hex characters.',
    );
  }

  return Buffer.from(value, 'hex');
}

export function loadConfig(env: Environment = process.env): Config {
  const missing = ENV_SPECS.filter((spec) => spec.required && !env[spec.name]);

  if (missing.length > 0) {
    const details = missing.map((spec) => `- ${spec.name}: ${spec.purpose}`).join('\n');

    throw new ConfigurationError(
      `Missing required environment variables:\n${details}`,
      missing.map((spec) => spec.name),
    );
  }

  const values = new Map<string, string>();

  for (const spec of ENV_SPECS) {
    const value = requiredValue(env, spec);

    if (value !== undefined) {
      values.set(spec.name, value);
    }
  }

  return {
    telegramBotToken: values.get('TELEGRAM_BOT_TOKEN') ?? '',
    toncenterApiKey: values.get('TONCENTER_API_KEY') ?? '',
    toncenterEndpoint:
      values.get('TONCENTER_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC',
    network: parseNetwork(values.get('NETWORK') ?? 'testnet'),
    enableMainnetExecution: parseBoolean(
      'ENABLE_MAINNET_EXECUTION',
      values.get('ENABLE_MAINNET_EXECUTION') ?? 'false',
    ),
    agentWalletEncryptionKey: parseEncryptionKey(values.get('AGENT_WALLET_ENCRYPTION_KEY') ?? ''),
    databasePath: values.get('DATABASE_PATH') ?? './tonshield.db',
    monitorIntervalSeconds: parsePositiveNumber(
      'MONITOR_INTERVAL_SECONDS',
      values.get('MONITOR_INTERVAL_SECONDS') ?? '30',
    ),
    riskDropThresholdPercent: parsePositiveNumber(
      'RISK_DROP_THRESHOLD_PERCENT',
      values.get('RISK_DROP_THRESHOLD_PERCENT') ?? '25',
    ),
    defaultSlippageBps: parsePositiveNumber(
      'DEFAULT_SLIPPAGE_BPS',
      values.get('DEFAULT_SLIPPAGE_BPS') ?? '500',
    ),
    paperTrade: parseBoolean('PAPER_TRADE', values.get('PAPER_TRADE') ?? 'true'),
  };
}

export const config: Config = loadConfig();
