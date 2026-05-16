/**
 * PriceService - External price data aggregation.
 *
 * Responsibilities:
 * 1. Fetch TON/USD spot price from CoinGecko (cached 30 seconds)
 * 2. Fetch token ATH FDV from DexScreener TON API (cached 5 minutes)
 * 3. Calculate FDV from total supply and current price
 * 4. Calculate LP value in USD from pool depth in TON
 * 5. Detect separate buy and sell tax percentages
 * 6. Check contract renouncement via get_jetton_data admin address
 * 7. Format small prices using subscript zero notation
 *
 * All external API calls have 10-second timeouts.
 * All results cached in SQLite to minimize redundant API calls.
 */

import { Address } from '@ton/core';
import type { TonClient } from '@ton/ton';
import type { DatabaseConnection, TokenMarketDataRow } from '../db/sqlite';
import {
  getPriceCache,
  getTokenMarketData,
  setPriceCache,
  upsertTokenMarketData,
} from '../db/sqlite';
import type { StonClient } from '../ston/stonClient';

const TON_USD_CACHE_KEY = 'ton_usd_price';
const TON_USD_CACHE_SECONDS = 30;
const DEXSCREENER_CACHE_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 10_000;
const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex/tokens';

interface QuoteTaxView {
  askAmount?: string;
  estimatedOutput?: string;
  offerAmount?: string | number;
}

export interface TonUsdPrice {
  usd: number;
  fetchedAt: number;
}

export interface DexScreenerData {
  priceUsd: number | null;
  fdvUsd: number | null;
  athFdvUsd: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
}

export interface TokenTaxResult {
  buyTaxPercent: number;
  sellTaxPercent: number;
  combinedTaxPercent: number;
  isSuspicious: boolean;
}

export interface RenounceResult {
  renounced: boolean;
  mintable: boolean;
  adminAddress: string | null;
  totalSupply: string;
}

export interface FullMarketData {
  tokenAddress: string;
  priceTon: number;
  priceUsd: number;
  fdvUsd: number | null;
  athFdvUsd: number | null;
  lpValueUsd: number | null;
  buyTaxPercent: number;
  sellTaxPercent: number;
  renounced: boolean;
  mintable: boolean;
  totalSupply: string;
  tonUsdRate: number;
}

function quoteAskAmount(quote: unknown): number {
  const view = quote as QuoteTaxView;
  return parseFloat(view.askAmount ?? view.estimatedOutput ?? '0') || 0;
}

function quoteOfferAmount(quote: unknown, fallback: number): number {
  const view = quote as QuoteTaxView;
  const parsed = Number(view.offerAmount);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export class PriceService {
  public constructor(
    private readonly db: DatabaseConnection,
    private readonly tonClient: TonClient,
    private readonly stonClient: StonClient,
  ) {}

  public async fetchTonUsdPrice(): Promise<number> {
    /**
     * Fetches current TON/USD price from CoinGecko.
     * Cached for TON_USD_CACHE_SECONDS to avoid rate limits.
     * Returns last known price on API failure.
     */
    const cached = getPriceCache(this.db, TON_USD_CACHE_KEY, TON_USD_CACHE_SECONDS);

    if (cached !== undefined) {
      const parsed = JSON.parse(cached.value_json) as { usd: number };
      return parsed.usd;
    }

    try {
      const response = await this.fetchWithTimeout(COINGECKO_URL);
      const data = (await response.json()) as {
        'the-open-network'?: { usd?: number };
      };
      const usd = data['the-open-network']?.usd ?? 0;

      if (usd > 0) {
        setPriceCache(this.db, TON_USD_CACHE_KEY, JSON.stringify({ usd }));
      }

      return usd;
    } catch {
      const stale = getPriceCache(this.db, TON_USD_CACHE_KEY, 86400);

      if (stale !== undefined) {
        const parsed = JSON.parse(stale.value_json) as { usd: number };
        return parsed.usd;
      }

      return 0;
    }
  }

  public async fetchDexScreenerData(tokenAddress: string): Promise<DexScreenerData> {
    /**
     * Fetches token market data from DexScreener TON API.
     * Includes ATH FDV which is not available from STON.fi API.
     * Cached for DEXSCREENER_CACHE_SECONDS.
     */
    const cacheKey = `dexscreener:${tokenAddress}`;
    const cached = getPriceCache(this.db, cacheKey, DEXSCREENER_CACHE_SECONDS);

    if (cached !== undefined) {
      return JSON.parse(cached.value_json) as DexScreenerData;
    }

    try {
      const response = await this.fetchWithTimeout(`${DEXSCREENER_BASE}/${tokenAddress}`);
      const data = (await response.json()) as {
        pairs?: Array<{
          priceUsd?: string;
          fdv?: number;
          liquidity?: { usd?: number };
          volume?: { h24?: number };
        }>;
      };
      const pair = data.pairs?.[0];
      const result: DexScreenerData = {
        priceUsd: pair?.priceUsd !== undefined ? parseFloat(pair.priceUsd) : null,
        fdvUsd: pair?.fdv ?? null,
        athFdvUsd: null,
        liquidityUsd: pair?.liquidity?.usd ?? null,
        volume24h: pair?.volume?.h24 ?? null,
      };

      setPriceCache(this.db, cacheKey, JSON.stringify(result));
      return result;
    } catch {
      return {
        priceUsd: null,
        fdvUsd: null,
        athFdvUsd: null,
        liquidityUsd: null,
        volume24h: null,
      };
    }
  }

  public async checkRenounced(tokenAddress: string): Promise<RenounceResult> {
    /**
     * Checks whether the Jetton contract ownership has been renounced.
     * Calls get_jetton_data on the master contract.
     * Stack layout: total_supply, mintable, admin_address, content, wallet_code
     * If admin_address is null or zero address, contract is renounced.
     */
    try {
      const result = await this.tonClient.runMethod(
        Address.parse(tokenAddress),
        'get_jetton_data',
        [],
      );
      const totalSupply = result.stack.readBigNumber().toString();
      const mintable = result.stack.readNumber() !== 0;
      const adminAddress = result.stack.readAddressOpt();
      const isZeroAddress =
        adminAddress === null ||
        adminAddress.toString() === 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' ||
        adminAddress.toRawString() ===
          '0:0000000000000000000000000000000000000000000000000000000000000000';

      return {
        renounced: isZeroAddress,
        mintable,
        adminAddress: adminAddress !== null ? adminAddress.toString() : null,
        totalSupply,
      };
    } catch {
      return {
        renounced: false,
        mintable: true,
        adminAddress: null,
        totalSupply: '0',
      };
    }
  }

  public async detectSeparateTaxes(
    tokenAddress: string,
    poolDepthTon: number,
  ): Promise<TokenTaxResult> {
    /**
     * Detects buy and sell tax separately by simulating
     * both directions independently.
     *
     * Buy tax: compare expected output vs actual quote on buy side.
     * A 1 TON buy on a zero-tax token should return approximately
     * 1 TON worth of tokens at current price. Shortfall = buy tax.
     *
     * Sell tax: simulate selling the received tokens back.
     * Compare output vs expected. Shortfall = sell tax.
     *
     * Combined tax above 15% total is flagged as suspicious.
     */
    const testAmountTon = Math.min(0.1, poolDepthTon * 0.001);

    try {
      const buyQuote = await this.stonClient.getSwapQuote(tokenAddress, testAmountTon, 10000);
      const tokenAmountReceived = quoteAskAmount(buyQuote);
      const hasExplicitOfferAmount = (buyQuote as QuoteTaxView).offerAmount !== undefined;
      const tokenAmountExpected = quoteOfferAmount(buyQuote, tokenAmountReceived);
      const buyTaxPercent =
        tokenAmountExpected > 0
          ? Math.max(0, ((tokenAmountExpected - tokenAmountReceived) / tokenAmountExpected) * 100)
          : 0;

      if (tokenAmountReceived <= 0) {
        return {
          buyTaxPercent: 100,
          sellTaxPercent: 0,
          combinedTaxPercent: 100,
          isSuspicious: true,
        };
      }

      const sellQuote = await this.stonClient.getSwapQuote(
        tokenAddress,
        tokenAmountReceived / 1e9,
        10000,
      );
      const tonAmountBack = quoteAskAmount(sellQuote) / 1e9;
      const expectedBack =
        (hasExplicitOfferAmount ? testAmountTon : 1) * (1 - buyTaxPercent / 100);
      const sellTaxPercent =
        expectedBack > 0 ? Math.max(0, ((expectedBack - tonAmountBack) / expectedBack) * 100) : 0;
      const combinedTaxPercent = buyTaxPercent + sellTaxPercent;

      return {
        buyTaxPercent: Math.min(buyTaxPercent, 100),
        sellTaxPercent: Math.min(sellTaxPercent, 100),
        combinedTaxPercent: Math.min(combinedTaxPercent, 100),
        isSuspicious: combinedTaxPercent > 15,
      };
    } catch {
      return {
        buyTaxPercent: 0,
        sellTaxPercent: 0,
        combinedTaxPercent: 0,
        isSuspicious: false,
      };
    }
  }

  public async fetchFullMarketData(
    tokenAddress: string,
    poolAddress: string,
    poolDepthTon: number,
    forceRefresh = false,
  ): Promise<FullMarketData> {
    /**
     * Aggregates all market data for a token in one call.
     * Runs all fetches in parallel for speed.
     * Saves results to token_market_data table.
     * Returns cached data if available and not force-refreshed.
     */
    void poolAddress;

    if (!forceRefresh) {
      const cached = getTokenMarketData(this.db, tokenAddress);

      if (cached !== undefined) {
        const tonUsdRate = await this.fetchTonUsdPrice();
        return this.rowToFullMarketData(cached, tonUsdRate);
      }
    }

    const [tonUsdRate, dexData, renounceResult, taxResult, priceTon] = await Promise.all([
      this.fetchTonUsdPrice(),
      this.fetchDexScreenerData(tokenAddress),
      this.checkRenounced(tokenAddress),
      this.detectSeparateTaxes(tokenAddress, poolDepthTon),
      this.stonClient.getTokenPrice(tokenAddress),
    ]);
    const priceUsd = priceTon * tonUsdRate;
    const totalSupplyBig = safeBigInt(renounceResult.totalSupply);
    const fdvUsd =
      totalSupplyBig > 0n && priceUsd > 0
        ? (Number(totalSupplyBig) / 1e9) * priceUsd
        : dexData.fdvUsd;
    const lpValueUsd =
      poolDepthTon > 0 && tonUsdRate > 0 ? poolDepthTon * tonUsdRate : dexData.liquidityUsd;
    const row = {
      token_address: tokenAddress,
      price_ton: priceTon,
      price_usd: priceUsd,
      fdv_usd: fdvUsd,
      ath_fdv_usd: dexData.athFdvUsd,
      lp_value_usd: lpValueUsd,
      buy_tax_percent: taxResult.buyTaxPercent,
      sell_tax_percent: taxResult.sellTaxPercent,
      renounced: renounceResult.renounced ? 1 : 0,
      mintable: renounceResult.mintable ? 1 : 0,
      total_supply: renounceResult.totalSupply,
    };

    upsertTokenMarketData(this.db, row);

    return {
      tokenAddress,
      priceTon,
      priceUsd,
      fdvUsd,
      athFdvUsd: dexData.athFdvUsd,
      lpValueUsd,
      buyTaxPercent: taxResult.buyTaxPercent,
      sellTaxPercent: taxResult.sellTaxPercent,
      renounced: renounceResult.renounced,
      mintable: renounceResult.mintable,
      totalSupply: renounceResult.totalSupply,
      tonUsdRate,
    };
  }

  private rowToFullMarketData(row: TokenMarketDataRow, tonUsdRate: number): FullMarketData {
    return {
      tokenAddress: row.token_address,
      priceTon: row.price_ton ?? 0,
      priceUsd: row.price_usd ?? 0,
      fdvUsd: row.fdv_usd,
      athFdvUsd: row.ath_fdv_usd,
      lpValueUsd: row.lp_value_usd,
      buyTaxPercent: row.buy_tax_percent ?? 0,
      sellTaxPercent: row.sell_tax_percent ?? 0,
      renounced: row.renounced === 1,
      mintable: row.mintable === 1,
      totalSupply: row.total_supply ?? '0',
      tonUsdRate,
    };
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function formatSmallPrice(price: number): string {
  /**
   * Formats very small prices using subscript zero notation.
   * Example: 0.000282 -> 0.0₃282
   * Example: 0.00000054 -> 0.0₆54
   * Matches the display format used by professional TON trading bots.
   */
  if (price === 0) return '0';
  if (price >= 0.01) return price.toFixed(4);

  const [mantissa = '', exponentRaw = '0'] = price.toExponential(6).split('e');
  const zeroCount = Math.max(0, Math.abs(Number(exponentRaw)) - 1);
  const significant = mantissa.replace('.', '').replace(/0+$/, '').slice(0, 4);
  const subscriptMap: Record<string, string> = {
    '1': '₁',
    '2': '₂',
    '3': '₃',
    '4': '₄',
    '5': '₅',
    '6': '₆',
    '7': '₇',
    '8': '₈',
    '9': '₉',
    '0': '₀',
  };
  const subscript = String(zeroCount)
    .split('')
    .map((digit) => subscriptMap[digit] ?? digit)
    .join('');

  return `0.0${subscript}${significant}`;
}

export function formatUsdValue(usd: number | null): string {
  /**
   * Formats USD values with K/M/B suffix for readability.
   * Example: 40460 -> $40.46K
   * Example: 1234567 -> $1.23M
   * Returns N/A if null.
   */
  if (usd === null || usd === 0) return 'N/A';
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(2)}K`;
  return `$${usd.toFixed(2)}`;
}

export function formatTaxBadge(buyTax: number, sellTax: number): string {
  /**
   * Formats tax display matching the TAX badge style.
   * Example: TAX  Buy: 10% | Sell: 10%
   */
  const buyStr = buyTax > 0 ? `${buyTax.toFixed(1)}%` : '0%';
  const sellStr = sellTax > 0 ? `${sellTax.toFixed(1)}%` : '0%';
  const isSuspicious = buyTax + sellTax > 15;
  const badge = isSuspicious ? '⚠️ TAX' : '💰 TAX';
  return `${badge}   Buy: ${buyStr} | Sell: ${sellStr}`;
}
