/**
 * TokenSafetyScanner — Four-layer pre-buy safety analysis.
 *
 * Check 1: Honeypot detection via round-trip swap simulation
 * Check 2: Contract code hash verification against known safe implementations
 * Check 3: Liquidity lock status via LP holder distribution
 * Check 4: Developer wallet supply concentration
 *
 * All checks run in parallel. Results cached for SAFETY_CACHE_TTL_MINUTES.
 * Critical failures block the buy. High/Medium risks warn the user.
 */

import { Address } from '@ton/core';
import type { TonClient } from '@ton/ton';
import type { DatabaseConnection, TokenSafetyCacheRow } from '../db/sqlite';
import { getTokenSafetyCache, saveTokenSafetyCache } from '../db/sqlite';
import type { StonClient } from '../ston/stonClient';
import type { FullMarketData } from './priceService';
import {
  formatSmallPrice,
  formatTaxBadge,
  formatUsdValue,
  PriceService,
} from './priceService';
import type { HoneypotResult, RiskLevel } from './safetyCache';
import { calculateOverallRisk, SAFETY_CACHE_TTL_MINUTES } from './safetyCache';

// Known verified Jetton contract code hashes (standard TEP-74 implementations)
const VERIFIED_JETTON_CODE_HASHES = new Set([
  'b5ee9c724101010100...', // Standard Jetton Minter v1
  'b5ee9c724101020100...', // Standard Jetton Minter v2
  // PRODUCTION TODO: populate with real verified hashes from TON repository
]);

// Known DEX pool and router addresses — excluded from concentration checks
export const KNOWN_DEX_ADDRESSES = new Set([
  'EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTDSDLR0I4MhiTfQRK', // STON.fi v1 router
  'EQBsGx9ArADUrREB34W-ghgsCgBShvfUr4Jvlu-0KGc33Rbt', // STON.fi v2 router
  // PRODUCTION TODO: add DeDust router addresses
]);

// Known locker contract addresses on TON
const KNOWN_LOCKER_ADDRESSES = new Set<string>([
  // PRODUCTION TODO: add TON Locker and verified timelock contract addresses
  // These are left as placeholders — populate from TON Locker documentation
]);

const MAX_HONEYPOT_LOSS_PERCENT = 20;

export interface HoneypotCheckResult {
  result: HoneypotResult;
  roundTripLossPercent: number;
  buyTaxPercent: number;
  sellTaxPercent: number;
  message: string;
}

export interface ContractCheckResult {
  codeHash: string | null;
  verified: boolean;
  buyTaxPercent: number | null;
  sellTaxPercent: number | null;
  renounced: boolean;
  mintable: boolean;
  adminAddress: string | null;
  message: string;
}

export interface LiquidityLockResult {
  locked: boolean;
  lockExpiry: string | null;
  lockerAddress: string | null;
  largestLpHolderPercent: number;
  message: string;
}

export interface ConcentrationResult {
  devWalletAddress: string | null;
  devWalletPercent: number;
  largestHolderPercent: number;
  message: string;
}

export interface TokenSafetyReport {
  tokenAddress: string;
  honeypot: HoneypotCheckResult;
  contract: ContractCheckResult;
  liquidityLock: LiquidityLockResult;
  concentration: ConcentrationResult;
  marketData: FullMarketData | null;
  overallRisk: RiskLevel;
  recommendation: string;
  fromCache: boolean;
  scannedAt: string;
}

export interface TokenScannerOptions {
  db: DatabaseConnection;
  tonClient: TonClient;
  stonClient: StonClient;
  priceService: PriceService;
  toncenterApiKey: string;
  toncenterEndpoint: string;
}

export class TokenSafetyScanner {
  private readonly baseUrl: string;
  private readonly options: TokenScannerOptions;

  public constructor(
    options:
      | TokenScannerOptions
      | (Omit<TokenScannerOptions, 'priceService'> & {
          priceService?: PriceService;
        }),
  ) {
    this.options = {
      ...options,
      priceService:
        options.priceService ?? new PriceService(options.db, options.tonClient, options.stonClient),
    };
    this.baseUrl = options.toncenterEndpoint.replace('/jsonRPC', '');
  }

  public async scanToken(
    tokenAddress: string,
    poolAddress: string,
    forceRefresh = false,
  ): Promise<TokenSafetyReport> {
    /**
     * Runs all four safety checks against a token.
     * Returns cached result if available and not expired.
     * All checks run in parallel via Promise.allSettled for resilience.
     */
    if (!forceRefresh) {
      const cached = getTokenSafetyCache(
        this.options.db,
        tokenAddress,
        SAFETY_CACHE_TTL_MINUTES,
      );

      if (cached !== undefined) {
        return this.formatCachedReport(tokenAddress, cached);
      }
    }

    const [honeypotResult, contractResult, liquidityResult, concentrationResult] =
      await Promise.allSettled([
        this.checkHoneypot(tokenAddress, poolAddress),
        this.checkContractCode(tokenAddress),
        this.checkLiquidityLock(poolAddress),
        this.checkSupplyConcentration(tokenAddress),
      ]);

    const honeypot = this.unwrapSettled(honeypotResult, {
      result: 'ERROR' as HoneypotResult,
      roundTripLossPercent: 0,
      buyTaxPercent: 0,
      sellTaxPercent: 0,
      message: 'Honeypot check failed — API error.',
    });

    const contract = this.unwrapSettled(contractResult, {
      codeHash: null,
      verified: false,
      buyTaxPercent: null,
      sellTaxPercent: null,
      renounced: false,
      mintable: true,
      adminAddress: null,
      message: 'Contract check failed — API error.',
    });

    const liquidityLock = this.unwrapSettled(liquidityResult, {
      locked: false,
      lockExpiry: null,
      lockerAddress: null,
      largestLpHolderPercent: 100,
      message: 'Liquidity lock check failed — API error.',
    });

    const concentration = this.unwrapSettled(concentrationResult, {
      devWalletAddress: null,
      devWalletPercent: 0,
      largestHolderPercent: 0,
      message: 'Concentration check failed — API error.',
    });

    let marketData: FullMarketData | null = null;

    try {
      const poolData = await this.options.stonClient.getPoolData(poolAddress);
      marketData = await this.options.priceService.fetchFullMarketData(
        tokenAddress,
        poolAddress,
        poolData.depthTon,
        forceRefresh,
      );
    } catch {
      marketData = null;
    }

    const overallRisk = calculateOverallRisk({
      honeypotResult: honeypot.result,
      contractVerified: contract.verified,
      liquidityLocked: liquidityLock.locked,
      devWalletPercent: concentration.devWalletPercent,
    });

    saveTokenSafetyCache(this.options.db, {
      token_address: tokenAddress,
      honeypot_result: honeypot.result,
      honeypot_round_trip_loss_percent: honeypot.roundTripLossPercent,
      contract_code_hash: contract.codeHash,
      contract_verified: contract.verified ? 1 : 0,
      buy_tax_percent: honeypot.buyTaxPercent,
      sell_tax_percent: honeypot.sellTaxPercent,
      liquidity_locked: liquidityLock.locked ? 1 : 0,
      lock_expiry: liquidityLock.lockExpiry,
      locker_address: liquidityLock.lockerAddress,
      largest_holder_percent: concentration.largestHolderPercent,
      dev_wallet_address: concentration.devWalletAddress,
      dev_wallet_percent: concentration.devWalletPercent,
      overall_risk: overallRisk,
    });

    return {
      tokenAddress,
      honeypot,
      contract,
      liquidityLock,
      concentration,
      marketData,
      overallRisk,
      recommendation: this.buildRecommendation(overallRisk, honeypot),
      fromCache: false,
      scannedAt: new Date().toISOString(),
    };
  }

  private async checkHoneypot(
    tokenAddress: string,
    poolAddress: string,
  ): Promise<HoneypotCheckResult> {
    /**
     * Uses PriceService to detect buy and sell taxes independently.
     * Combined tax/loss above MAX_HONEYPOT_LOSS_PERCENT is treated
     * as a honeypot warning or failure.
     */
    if (poolAddress.trim().length === 0) {
      return {
        result: 'ERROR',
        roundTripLossPercent: 0,
        buyTaxPercent: 0,
        sellTaxPercent: 0,
        message: 'Pool address is required for honeypot simulation.',
      };
    }

    let poolDepthTon = 1000;
    try {
      poolDepthTon = (await this.options.stonClient.getPoolData(poolAddress)).depthTon;
    } catch {
      poolDepthTon = 1000;
    }

    const taxResult = await this.options.priceService.detectSeparateTaxes(
      tokenAddress,
      poolDepthTon,
    );

    if (taxResult.buyTaxPercent >= 100) {
      return {
        result: 'FAIL',
        roundTripLossPercent: 100,
        buyTaxPercent: taxResult.buyTaxPercent,
        sellTaxPercent: taxResult.sellTaxPercent,
        message: 'Buy simulation returned zero tokens — likely honeypot.',
      };
    }

    const roundTripLossPercent = taxResult.combinedTaxPercent;

    if (roundTripLossPercent > MAX_HONEYPOT_LOSS_PERCENT) {
      return {
        result: roundTripLossPercent > 50 ? 'FAIL' : 'WARN',
        roundTripLossPercent,
        buyTaxPercent: taxResult.buyTaxPercent,
        sellTaxPercent: taxResult.sellTaxPercent,
        message: `Round-trip loss ${roundTripLossPercent.toFixed(2)}% — ${
          roundTripLossPercent > 50 ? 'likely honeypot' : 'high tax warning'
        }.`,
      };
    }

    return {
      result: 'PASS',
      roundTripLossPercent,
      buyTaxPercent: taxResult.buyTaxPercent,
      sellTaxPercent: taxResult.sellTaxPercent,
      message: `Sell simulation successful. Round-trip loss: ${roundTripLossPercent.toFixed(2)}%`,
    };
  }

  private async checkContractCode(tokenAddress: string): Promise<ContractCheckResult> {
    /**
     * Fetches the Jetton master contract state and checks code hash
     * against known safe standard implementations.
     * Unknown hashes are flagged as unverified.
     */
    const renounceResult = await this.options.priceService.checkRenounced(tokenAddress);

    try {
      const state = await this.options.tonClient.getContractState(Address.parse(tokenAddress));
      const codeHash = state.code ? Buffer.from(state.code).toString('hex').slice(0, 64) : null;
      const verified = codeHash !== null && VERIFIED_JETTON_CODE_HASHES.has(codeHash);

      return {
        codeHash,
        verified,
        buyTaxPercent: null,
        sellTaxPercent: null,
        renounced: renounceResult.renounced,
        mintable: renounceResult.mintable,
        adminAddress: renounceResult.adminAddress,
        message: verified
          ? 'Contract matches verified standard Jetton implementation.'
          : 'Contract code is unverified — unknown Jetton implementation.',
      };
    } catch {
      return {
        codeHash: null,
        verified: false,
        buyTaxPercent: null,
        sellTaxPercent: null,
        renounced: renounceResult.renounced,
        mintable: renounceResult.mintable,
        adminAddress: renounceResult.adminAddress,
        message: 'Contract state unavailable — treat as unverified.',
      };
    }
  }

  private async checkLiquidityLock(poolAddress: string): Promise<LiquidityLockResult> {
    /**
     * Queries LP token holder distribution for the pool.
     * If any non-locker wallet holds >50% of LP tokens, liquidity is unlocked.
     * Known locker contract addresses are treated as locked supply.
     */
    try {
      const response = await fetch(
        `${this.baseUrl}/getTokenHolders?address=${poolAddress}&limit=10`,
        {
          headers: { 'X-API-Key': this.options.toncenterApiKey },
        },
      );

      const data = (await response.json()) as {
        result?: Array<{ address: string; balance: string }>;
      };
      const holders = data.result ?? [];

      if (holders.length === 0) {
        return {
          locked: false,
          lockExpiry: null,
          lockerAddress: null,
          largestLpHolderPercent: 100,
          message: 'No LP holder data available — treat as unlocked.',
        };
      }

      const totalBalance = holders.reduce((sum, holder) => sum + BigInt(holder.balance), 0n);
      const largestHolder = holders[0];
      const largestPercent =
        totalBalance > 0n
          ? Number((BigInt(largestHolder?.balance ?? '0') * 10000n) / totalBalance) / 100
          : 100;
      const largestAddress = largestHolder?.address ?? '';
      const isLocker = KNOWN_LOCKER_ADDRESSES.has(largestAddress);

      return {
        locked: isLocker || largestPercent < 50,
        lockExpiry: null,
        lockerAddress: isLocker ? largestAddress : null,
        largestLpHolderPercent: largestPercent,
        message: isLocker
          ? `LP locked by verified locker contract ${largestAddress}.`
          : largestPercent >= 50
            ? `Largest LP holder controls ${largestPercent.toFixed(2)}% — unlocked liquidity risk.`
            : `LP distribution appears healthy. Largest holder: ${largestPercent.toFixed(2)}%.`,
      };
    } catch {
      return {
        locked: false,
        lockExpiry: null,
        lockerAddress: null,
        largestLpHolderPercent: 100,
        message: 'Liquidity lock check failed — API error.',
      };
    }
  }

  private async checkSupplyConcentration(tokenAddress: string): Promise<ConcentrationResult> {
    /**
     * Fetches top token holders and identifies the deployer/dev wallet.
     * Dev wallet is identified by being the first transaction sender
     * to the master contract at deployment.
     * Known DEX addresses are excluded from concentration calculation.
     */
    try {
      const [holdersResponse, txResponse] = await Promise.all([
        fetch(`${this.baseUrl}/getTokenHolders?address=${tokenAddress}&limit=20`, {
          headers: { 'X-API-Key': this.options.toncenterApiKey },
        }),
        fetch(`${this.baseUrl}/getTransactions?address=${tokenAddress}&limit=5&archival=false`, {
          headers: { 'X-API-Key': this.options.toncenterApiKey },
        }),
      ]);

      const holdersData = (await holdersResponse.json()) as {
        result?: Array<{ address: string; balance: string }>;
      };
      const txData = (await txResponse.json()) as {
        result?: Array<{ in_msg?: { source?: string } }>;
      };

      const holders = holdersData.result ?? [];
      const deployerAddress = txData.result?.at(-1)?.in_msg?.source ?? null;
      const totalBalance = holders.reduce((sum, holder) => sum + BigInt(holder.balance), 0n);

      if (totalBalance === 0n || holders.length === 0) {
        return {
          devWalletAddress: deployerAddress,
          devWalletPercent: 0,
          largestHolderPercent: 0,
          message: 'No holder data available.',
        };
      }

      const nonDexHolders = holders.filter((holder) => !KNOWN_DEX_ADDRESSES.has(holder.address));
      const devHolder =
        deployerAddress !== null
          ? nonDexHolders.find((holder) => holder.address === deployerAddress)
          : nonDexHolders[0];
      const devPercent =
        devHolder !== undefined
          ? Number((BigInt(devHolder.balance) * 10000n) / totalBalance) / 100
          : 0;
      const largestNonDex = nonDexHolders[0];
      const largestPercent =
        largestNonDex !== undefined
          ? Number((BigInt(largestNonDex.balance) * 10000n) / totalBalance) / 100
          : 0;

      return {
        devWalletAddress: devHolder?.address ?? deployerAddress,
        devWalletPercent: devPercent,
        largestHolderPercent: largestPercent,
        message:
          devPercent > 20
            ? `Dev wallet holds ${devPercent.toFixed(2)}% of supply — dump risk.`
            : `Dev wallet holds ${devPercent.toFixed(2)}% of supply.`,
      };
    } catch {
      return {
        devWalletAddress: null,
        devWalletPercent: 0,
        largestHolderPercent: 0,
        message: 'Concentration check failed — API error.',
      };
    }
  }

  private buildRecommendation(risk: RiskLevel, honeypot: HoneypotCheckResult): string {
    if (honeypot.result === 'FAIL') {
      return 'DO NOT BUY — Honeypot confirmed. Selling this token is likely impossible.';
    }

    if (risk === 'CRITICAL') {
      return 'DO NOT BUY — Critical risk factors detected. High probability of total loss.';
    }

    if (risk === 'HIGH') {
      return 'Proceed with extreme caution. Use minimum position size only.';
    }

    if (risk === 'MEDIUM') {
      return 'Moderate risk detected. Verify liquidity lock and team identity before buying.';
    }

    return 'No critical risks detected. Standard trading caution applies.';
  }

  private formatCachedReport(
    tokenAddress: string,
    cached: TokenSafetyCacheRow,
  ): TokenSafetyReport {
    return {
      tokenAddress,
      honeypot: {
        result: cached.honeypot_result as HoneypotResult,
        roundTripLossPercent: cached.honeypot_round_trip_loss_percent ?? 0,
        buyTaxPercent: cached.buy_tax_percent ?? 0,
        sellTaxPercent: cached.sell_tax_percent ?? 0,
        message: `Cached result: ${cached.honeypot_result}`,
      },
      contract: {
        codeHash: cached.contract_code_hash,
        verified: cached.contract_verified === 1,
        buyTaxPercent: cached.buy_tax_percent,
        sellTaxPercent: cached.sell_tax_percent,
        renounced: false,
        mintable: true,
        adminAddress: null,
        message: cached.contract_verified === 1 ? 'Verified (cached).' : 'Unverified (cached).',
      },
      liquidityLock: {
        locked: cached.liquidity_locked === 1,
        lockExpiry: cached.lock_expiry,
        lockerAddress: cached.locker_address,
        largestLpHolderPercent: 0,
        message: cached.liquidity_locked === 1 ? 'Locked (cached).' : 'Unlocked (cached).',
      },
      concentration: {
        devWalletAddress: cached.dev_wallet_address,
        devWalletPercent: cached.dev_wallet_percent ?? 0,
        largestHolderPercent: cached.largest_holder_percent ?? 0,
        message: `Dev holds ${cached.dev_wallet_percent?.toFixed(2) ?? 'N/A'}% (cached).`,
      },
      marketData: null,
      overallRisk: cached.overall_risk as RiskLevel,
      recommendation: this.buildRecommendation(cached.overall_risk as RiskLevel, {
        result: cached.honeypot_result as HoneypotResult,
        roundTripLossPercent: cached.honeypot_round_trip_loss_percent ?? 0,
        buyTaxPercent: cached.buy_tax_percent ?? 0,
        sellTaxPercent: cached.sell_tax_percent ?? 0,
        message: '',
      }),
      fromCache: true,
      scannedAt: cached.scanned_at,
    };
  }

  private unwrapSettled<T>(result: PromiseSettledResult<T>, fallback: T): T {
    return result.status === 'fulfilled' ? result.value : fallback;
  }
}

export function formatScanCard(report: TokenSafetyReport, poolAddress: string): string {
  /**
   * Formats the complete token scan result as a professional
   * trading bot card matching the TAX/Price/FDV/LP style.
   *
   * Format:
   * -------------------------
   * TAX   Buy: X% | Sell: X%
   *
   * 💲 Price:  0.0₃282 TON ($0.0₃54)
   * 📈 FDV:    $40.46K
   * 💧 LP:     $21.87K
   * 🔒 LP Lock:    ✅ / ❌
   * 🔑 Renounced:  ✅ / ❌
   * 📊 ATH FDV:   $670.84K
   *
   * Honeypot:     ✅ PASS
   * Contract:     ⚠️ UNVERIFIED
   * Bubble Risk:  🟡 MEDIUM
   *
   * Overall Risk: 🔴 HIGH
   * Dev holds 34% of supply
   * -------------------------
   */
  void poolAddress;

  const shortToken = `${report.tokenAddress.slice(0, 8)}...${report.tokenAddress.slice(-4)}`;
  const market = report.marketData;
  const taxLine =
    market !== null
      ? formatTaxBadge(market.buyTaxPercent, market.sellTaxPercent)
      : '💰 TAX   Buy: N/A | Sell: N/A';
  const priceTonFormatted = market !== null ? formatSmallPrice(market.priceTon) : 'N/A';
  const priceUsdFormatted =
    market !== null ? `($${formatSmallPrice(market.priceUsd)})` : '';
  const priceLine = `💲 Price:  ${priceTonFormatted} TON ${priceUsdFormatted}`.trim();
  const fdvLine = `📈 FDV:    ${market !== null ? formatUsdValue(market.fdvUsd) : 'N/A'}`;
  const lpLine = `💧 LP:     ${market !== null ? formatUsdValue(market.lpValueUsd) : 'N/A'}`;
  const lpLockEmoji = report.liquidityLock.locked ? '✅' : '❌';
  const lpLockLine = `🔒 LP Lock:    ${lpLockEmoji}`;
  const renouncedEmoji = market !== null && market.renounced ? '✅' : '❌';
  const renouncedLine = `🔑 Renounced:  ${renouncedEmoji}`;
  const athFdvLine = `📊 ATH FDV:   ${
    market !== null ? formatUsdValue(market.athFdvUsd) : 'N/A'
  }`;
  const honeypotLine = (() => {
    switch (report.honeypot.result) {
      case 'PASS':
        return '✅ PASS';
      case 'WARN':
        return `⚠️ WARN — ${report.honeypot.roundTripLossPercent.toFixed(1)}% loss`;
      case 'FAIL':
        return '🚨 FAIL — Honeypot confirmed';
      default:
        return '⚪ ERROR';
    }
  })();
  const contractLine = report.contract.verified ? '✅ VERIFIED' : '⚠️ UNVERIFIED';
  const devConcentrationLine =
    report.concentration.devWalletPercent > 0
      ? `Dev holds ${report.concentration.devWalletPercent.toFixed(1)}% of supply`
      : 'Dev wallet not identified';
  const riskEmojis: Record<string, string> = {
    LOW: '🟢',
    MEDIUM: '🟡',
    HIGH: '🔴',
    CRITICAL: '🚨',
    UNKNOWN: '⚪',
  };
  const overallEmoji = riskEmojis[report.overallRisk] ?? '⚪';
  const cachedNote = report.fromCache ? '\n⏱️ Cached result. Use /scan_token force to refresh.' : '';

  return [
    `🔍 Token Scan — ${shortToken}`,
    '─────────────────────────',
    taxLine,
    '',
    priceLine,
    fdvLine,
    lpLine,
    lpLockLine,
    renouncedLine,
    athFdvLine,
    '',
    `Honeypot:     ${honeypotLine}`,
    `Contract:     ${contractLine}`,
    `Concentration: ${devConcentrationLine}`,
    '',
    `Overall Risk: ${overallEmoji} ${report.overallRisk}`,
    report.recommendation,
    '─────────────────────────',
    cachedNote,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
    .trim();
}
