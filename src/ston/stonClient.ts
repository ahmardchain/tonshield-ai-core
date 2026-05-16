import { Address, beginCell } from '@ton/core';
import { StonApiClient } from '@ston-fi/api';
import type { TonClient } from '@ton/ton';
import type { Config } from '../config/env';

const STON_MAINNET_API_BASE_URL = 'https://api.ston.fi';
const REQUEST_TIMEOUT_MS = 10_000;

export interface PoolData {
  poolAddress: string;
  depthTon: number;
  tokenAddresses: string[];
  feeTier: string | null;
  raw: unknown;
}

export interface SwapQuote {
  offerAddress: string;
  askAddress: string;
  offerUnits: string;
  estimatedOutput: string;
  minimumReceived: string;
  slippageBps: number;
  raw: unknown;
}

export class StonClientError extends Error {
  public constructor(
    public readonly operation: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StonClientError';
  }
}

interface StonApiClientShape {
  getPool?: (poolAddress: string) => Promise<unknown>;
  getRouters?: () => Promise<unknown>;
  simulateSwap?: (params: Record<string, string>) => Promise<unknown>;
}

type StonApiClientConstructor = new (options?: Record<string, unknown>) => StonApiClientShape;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function findFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function findFirstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key]);

    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function normalizeReserveToTon(value: number): number {
  if (value > 100_000_000) {
    return value / 1_000_000_000;
  }

  return value;
}

function extractPayload(response: unknown): Record<string, unknown> {
  const record = asRecord(response);
  const nestedKeys = ['pool', 'data', 'result'];

  for (const key of nestedKeys) {
    const nested = asRecord(record[key]);

    if (Object.keys(nested).length > 0) {
      return nested;
    }
  }

  return record;
}

function extractTokenAddresses(pool: Record<string, unknown>): string[] {
  const candidates = [
    pool.token0_address,
    pool.token1_address,
    pool.asset0_address,
    pool.asset1_address,
    pool.token0Address,
    pool.token1Address,
    pool.asset0Address,
    pool.asset1Address,
  ];
  const fromFlatFields = candidates.flatMap((candidate) => {
    const value = stringValue(candidate);
    return value === undefined ? [] : [value];
  });

  const assets = Array.isArray(pool.assets) ? pool.assets : [];
  const fromAssets = assets.flatMap((asset) => {
    const assetRecord = asRecord(asset);
    const value = findFirstString(assetRecord, ['address', 'contract_address', 'contractAddress']);
    return value === undefined ? [] : [value];
  });

  return [...new Set([...fromFlatFields, ...fromAssets])];
}

async function withTimeout<T>(operation: string, promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new StonClientError(operation, `${operation} timed out after 10 seconds.`));
    }, REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export class StonClient {
  private readonly apiClient: StonApiClientShape;
  private readonly baseUrl: string;

  public constructor(private readonly config: Config) {
    this.baseUrl = STON_MAINNET_API_BASE_URL;

    if (config.network === 'testnet') {
      // STON.fi documents api.ston.fi as mainnet-only; testnet execution uses SDK router constants.
      this.baseUrl = STON_MAINNET_API_BASE_URL;
    }

    const ApiClient = StonApiClient as unknown as StonApiClientConstructor;
    this.apiClient = new ApiClient({
      baseUrl: this.baseUrl,
      baseURL: this.baseUrl,
    });
  }

  public async getPoolData(poolAddress: string): Promise<PoolData> {
    try {
      const response = await withTimeout(
        'getPoolData',
        this.apiClient.getPool !== undefined
          ? this.apiClient.getPool(poolAddress)
          : this.fetchJson(`/v1/pools/${encodeURIComponent(poolAddress)}`),
      );
      const pool = extractPayload(response);
      const reserve0 = findFirstNumber(pool, ['reserve0', 'reserve0_units', 'asset0_reserve']);
      const reserve1 = findFirstNumber(pool, ['reserve1', 'reserve1_units', 'asset1_reserve']);
      const tvl = findFirstNumber(pool, ['tvl', 'tvl_ton', 'liquidity', 'total_liquidity']);
      const depthTon =
        tvl !== undefined
          ? normalizeReserveToTon(tvl)
          : normalizeReserveToTon(reserve0 ?? 0) + normalizeReserveToTon(reserve1 ?? 0);

      return {
        poolAddress,
        depthTon,
        tokenAddresses: extractTokenAddresses(pool),
        feeTier: findFirstString(pool, ['fee', 'fee_tier', 'feeTier']) ?? null,
        raw: response,
      };
    } catch (error) {
      if (error instanceof StonClientError) {
        throw error;
      }

      throw new StonClientError(
        'getPoolData',
        `Failed to fetch STON.fi pool ${poolAddress}.`,
        error,
      );
    }
  }

  public async getSwapQuote(
    tokenAddress: string,
    amountTon: number,
    slippageBps: number,
  ): Promise<SwapQuote> {
    try {
      const offerUnits = Math.round(amountTon * 1_000_000_000).toString();
      const slippageTolerance = (slippageBps / 10_000).toString();
      const payload = {
        offerAddress: tokenAddress,
        askAddress: 'ton',
        offerUnits,
        slippageTolerance,
      };
      const response = await withTimeout(
        'getSwapQuote',
        this.apiClient.simulateSwap !== undefined
          ? this.apiClient.simulateSwap(payload)
          : this.fetchJson('/v1/swap/simulate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
      );
      const quote = extractPayload(response);

      return {
        offerAddress: findFirstString(quote, ['offerAddress', 'offer_address']) ?? tokenAddress,
        askAddress: findFirstString(quote, ['askAddress', 'ask_address']) ?? 'ton',
        offerUnits: findFirstString(quote, ['offerUnits', 'offer_units']) ?? offerUnits,
        estimatedOutput:
          findFirstString(quote, [
            'askUnits',
            'ask_units',
            'estimatedOutput',
            'estimated_output',
          ]) ?? '0',
        minimumReceived:
          findFirstString(quote, ['minAskUnits', 'min_ask_units', 'minimumReceived']) ?? '0',
        slippageBps,
        raw: response,
      };
    } catch (error) {
      if (error instanceof StonClientError) {
        throw error;
      }

      throw new StonClientError(
        'getSwapQuote',
        `Failed to fetch STON.fi quote for token ${tokenAddress}.`,
        error,
      );
    }
  }

  public async getRouters(): Promise<unknown> {
    try {
      return await withTimeout(
        'getRouters',
        this.apiClient.getRouters !== undefined
          ? this.apiClient.getRouters()
          : this.fetchJson('/v1/routers'),
      );
    } catch (error) {
      if (error instanceof StonClientError) {
        throw error;
      }

      throw new StonClientError('getRouters', 'Failed to fetch STON.fi routers.', error);
    }
  }

  public async getTokenPrice(tokenAddress: string): Promise<number> {
    /**
     * Fetches the current price of a token in TON from the STON.fi API.
     * Returns 0 if the token price cannot be determined.
     */
    try {
      const response = await this.fetchWithTimeout(`${this.baseUrl}/assets/${tokenAddress}`);
      const data = (await response.json()) as { dex_price_usd?: string; dex_price_ton?: string };
      return parseFloat(data.dex_price_ton ?? '0') || 0;
    } catch {
      return 0;
    }
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new StonClientError(
          'fetchJson',
          `STON.fi API returned ${response.status} ${response.statusText}.`,
        );
      }

      const payload: unknown = await response.json();
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function discoverJettonWalletAddress(
  tonClient: TonClient,
  tokenAddress: string,
  ownerAddress: string,
): Promise<Address> {
  const ownerCell = beginCell().storeAddress(Address.parse(ownerAddress)).endCell();
  const result = await tonClient.runMethod(Address.parse(tokenAddress), 'get_wallet_address', [
    { type: 'slice', cell: ownerCell },
  ]);

  return result.stack.readAddress();
}
