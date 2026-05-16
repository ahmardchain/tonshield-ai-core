import { Address, beginCell, toNano } from '@ton/core';
import type { Contract } from '@ton/core';
import type { Cell } from '@ton/core';
import type { TonClient } from '@ton/ton';
import * as StonSdk from '@ston-fi/sdk';
import type { Config } from '../config/env';
import type { DatabaseConnection } from '../db/sqlite';
import { execute, upsertUser } from '../db/sqlite';
import type { AgentWalletService } from '../wallet/agentWallet';
import type { BudgetPolicyService } from '../wallet/budgetPolicy';
import { SlippageService } from './slippageService';
import type { StonClient } from './stonClient';
import { TESTNET_PTON_MASTER_ADDRESS, TESTNET_STON_ROUTER_ADDRESS } from './routerResolver';
import { canExecuteLiveTransactions } from './networkGuard';

export interface DefensiveSwapPayloadParams {
  tonClient: TonClient;
  stonClient: StonClient;
  userWalletAddress: string;
  tokenAddress: string;
  amountTon: number;
  slippageBps: number;
  network: Config['network'];
}

export interface DefensiveSwapPayload {
  to: Address;
  value: bigint;
  payload: Cell;
}

export interface BuySwapPayloadParams {
  tonClient: TonClient;
  userWalletAddress: string;
  tokenAddress: string;
  amountTon: number;
  slippageBps: number;
  network: Config['network'];
  stonClient: StonClient;
}

export interface BuySwapPayload {
  to: Address;
  value: bigint;
  payload: Cell;
  estimatedTokenOut: string;
  minTokenOut: string;
  entryPriceTon: number;
}

export interface SwapExecutionResult {
  attemptId: number;
  status: 'success' | 'failed' | 'blocked_mainnet_guard' | 'simulated';
  txHash?: string;
  quote?: unknown;
}

// Option A: keep NetworkGuardError beside the executor that actually throws and catches it.
export class NetworkGuardError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NetworkGuardError';
  }
}

interface SdkFacade {
  DEX: {
    v2_1: {
      Router: {
        CPI: {
          create(address: string): unknown;
        };
      };
    };
  };
  pTON: {
    v2_1: {
      create(address: string): unknown;
    };
  };
}

interface SwapTxParams {
  to?: Address | string;
  value?: bigint | string | number;
  body?: Cell;
  payload?: Cell;
  gasAmount?: bigint | string | number;
}

interface TestnetRouter {
  getSwapJettonToTonTxParams(params: Record<string, unknown>): Promise<SwapTxParams>;
}

type BuyQuote = Awaited<ReturnType<StonClient['getSwapQuote']>> & {
  askAmount: string;
  minAskAmount: string;
  offerAmount: string | number;
};

function asBigInt(value: bigint | string | number | undefined, fallback: bigint): bigint {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }

  if (typeof value === 'string' && value.length > 0) {
    return BigInt(value);
  }

  return fallback;
}

function asAddress(value: Address | string | undefined): Address {
  if (value instanceof Address) {
    return value;
  }

  if (typeof value === 'string') {
    return Address.parse(value);
  }

  return Address.parse(TESTNET_STON_ROUTER_ADDRESS);
}

export async function buildDefensiveSwapPayload(
  params: DefensiveSwapPayloadParams,
): Promise<DefensiveSwapPayload> {
  const sdk = StonSdk as unknown as SdkFacade;
  const routerAddress = TESTNET_STON_ROUTER_ADDRESS;
  const ptonAddress = TESTNET_PTON_MASTER_ADDRESS;

  // PRODUCTION TODO: Integrate TON Agentic Wallet execution rights standard.
  const router = params.tonClient.open(
    sdk.DEX.v2_1.Router.CPI.create(routerAddress) as Contract,
  ) as unknown as TestnetRouter;
  const proxyTon = sdk.pTON.v2_1.create(ptonAddress);
  const quoteResult = (await params.stonClient.getSwapQuote(
    params.tokenAddress,
    params.amountTon,
    params.slippageBps,
  )) as Awaited<ReturnType<StonClient['getSwapQuote']>> & { minAskAmount: string };
  const minimumAskAmount = BigInt(quoteResult.minAskAmount);
  const txParams = await router.getSwapJettonToTonTxParams({
    userWalletAddress: params.userWalletAddress,
    offerJettonAddress: params.tokenAddress,
    offerAmount: toNano(params.amountTon.toString()),
    minAskAmount: minimumAskAmount,
    proxyTon,
    queryId: BigInt(Date.now()),
    slippageTolerance: (params.slippageBps / 10_000).toString(),
  });

  return {
    to: asAddress(txParams.to),
    value: asBigInt(txParams.value ?? txParams.gasAmount, toNano('0.25')),
    payload: txParams.body ?? txParams.payload ?? beginCell().endCell(),
  };
}

export async function buildBuySwapPayload(params: BuySwapPayloadParams): Promise<BuySwapPayload> {
  /**
   * Builds a TON → Jetton swap payload using the STON.fi SDK.
   * This is the entry swap — the reverse of the defensive exit swap.
   * PRODUCTION TODO: Integrate TON Agentic Wallet execution rights standard.
   */
  const sdk = StonSdk as unknown as SdkFacade;
  const routerAddress = TESTNET_STON_ROUTER_ADDRESS;
  const ptonAddress = TESTNET_PTON_MASTER_ADDRESS;

  const quote = (await params.stonClient.getSwapQuote(
    params.tokenAddress,
    params.amountTon,
    params.slippageBps,
  )) as BuyQuote;

  const minimumAskAmount = BigInt(quote.minAskAmount);
  const router = params.tonClient.open(
    sdk.DEX.v2_1.Router.CPI.create(routerAddress) as Contract,
  ) as unknown as {
    getSwapTonToJettonTxParams(params: Record<string, unknown>): Promise<SwapTxParams>;
  };

  const proxyTon = sdk.pTON.v2_1.create(ptonAddress);

  const txParams = await router.getSwapTonToJettonTxParams({
    userWalletAddress: params.userWalletAddress,
    proxyTon,
    offerAmount: toNano(params.amountTon.toString()),
    askJettonAddress: params.tokenAddress,
    minAskAmount: minimumAskAmount,
    queryId: BigInt(Date.now()),
    slippageTolerance: (params.slippageBps / 10_000).toString(),
  });

  const entryPriceTon =
    Number(quote.offerAmount) > 0 ? params.amountTon / Number(quote.offerAmount) : 0;

  return {
    to: asAddress(txParams.to),
    value: asBigInt(txParams.value ?? txParams.gasAmount, toNano('0.3')),
    payload: txParams.body ?? txParams.payload ?? beginCell().endCell(),
    estimatedTokenOut: quote.askAmount,
    minTokenOut: quote.minAskAmount,
    entryPriceTon,
  };
}

export interface StonFiExecutorOptions {
  db: DatabaseConnection;
  config: Config;
  tonClient: TonClient;
  stonClient: StonClient;
  budgetPolicy: BudgetPolicyService;
  agentWallet: AgentWalletService;
  slippageService: SlippageService;
}

export class StonFiExecutor {
  private readonly options: StonFiExecutorOptions;

  public constructor(
    options:
      | StonFiExecutorOptions
      | (Omit<StonFiExecutorOptions, 'slippageService'> & {
          slippageService?: SlippageService;
        }),
  ) {
    this.options = {
      ...options,
      slippageService: options.slippageService ?? new SlippageService(options.db, options.config),
    };
  }

  public async executeDefensiveSwap(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
  ): Promise<SwapExecutionResult> {
    const attemptId = this.logSwapAttempt(
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      'live',
      'pending',
    );

    try {
      if (!canExecuteLiveTransactions(this.options.config)) {
        const message =
          'Mainnet execution blocked. Set NETWORK=mainnet and ENABLE_MAINNET_EXECUTION=true only after audit approval.';
        this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
        throw new NetworkGuardError(message);
      }

      if (this.options.config.network === 'mainnet') {
        const message =
          'Mainnet execution remains disabled in this MVP until independent security audit approval.';
        this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
        throw new NetworkGuardError(message);
      }

      this.options.budgetPolicy.validateAndReserve(userId, amountTon);
      const loadedWallet = await this.options.agentWallet.decryptAndLoadWallet(userId);
      const emergencyResolution = this.options.slippageService.resolveEmergencySlippage(
        userId,
        tokenAddress,
      );
      const resolvedSlippageBps = emergencyResolution.slippageBps;
      const payload = await buildDefensiveSwapPayload({
        tonClient: this.options.tonClient,
        stonClient: this.options.stonClient,
        userWalletAddress: loadedWallet.address,
        tokenAddress,
        amountTon,
        slippageBps: resolvedSlippageBps,
        network: this.options.config.network,
      });

      await loadedWallet.sender.send({
        to: payload.to,
        value: payload.value,
        body: payload.payload,
        bounce: true,
      });

      const txHash = `submitted:${attemptId}`;
      this.updateSwapAttempt(attemptId, 'success', txHash);

      return {
        attemptId,
        status: 'success',
        txHash,
      };
    } catch (error) {
      if (error instanceof NetworkGuardError) {
        return {
          attemptId,
          status: 'blocked_mainnet_guard',
        };
      }

      const message = error instanceof Error ? error.message : 'Unknown swap execution failure.';
      this.updateSwapAttempt(attemptId, 'failed', undefined, message);

      return {
        attemptId,
        status: 'failed',
      };
    }
  }

  public async simulateDefensiveSwap(
    userId: number,
    poolAddress: string,
    amountTon: number,
  ): Promise<SwapExecutionResult> {
    const poolData = await this.options.stonClient.getPoolData(poolAddress);
    const tokenAddress = poolData.tokenAddresses[0] ?? 'unknown';
    const emergencyResolution = this.options.slippageService.resolveEmergencySlippage(
      userId,
      tokenAddress,
    );
    const quote = await this.options.stonClient.getSwapQuote(
      tokenAddress,
      amountTon,
      emergencyResolution.slippageBps,
    );
    const attemptId = this.logSwapAttempt(
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      'paper',
      'simulated',
    );

    return {
      attemptId,
      status: 'simulated',
      quote,
    };
  }

  public async executeBuySwap(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
    options?: { inlineSlippageBps?: number },
  ): Promise<SwapExecutionResult & { entryPriceTon: number; estimatedTokenOut: string }> {
    /**
     * Executes a TON → Jetton buy swap from the agent wallet.
     * Records the attempt before execution and opens a position on success.
     */
    const attemptId = this.logSwapAttempt(
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      'live',
      'pending',
    );

    try {
      if (!canExecuteLiveTransactions(this.options.config)) {
        const message =
          'Mainnet execution blocked. Set NETWORK=mainnet and ENABLE_MAINNET_EXECUTION=true only after audit approval.';
        this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
        throw new NetworkGuardError(message);
      }

      if (this.options.config.network === 'mainnet') {
        const message =
          'Mainnet buy execution remains disabled in this MVP until independent security audit approval.';
        this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
        throw new NetworkGuardError(message);
      }

      this.options.budgetPolicy.validateAndReserve(userId, amountTon);
      const loadedWallet = await this.options.agentWallet.decryptAndLoadWallet(userId);
      const slippageResolution = this.options.slippageService.resolveSlippage(
        userId,
        tokenAddress,
        options?.inlineSlippageBps,
      );
      const resolvedSlippageBps = slippageResolution.slippageBps;

      const payload = await buildBuySwapPayload({
        tonClient: this.options.tonClient,
        userWalletAddress: loadedWallet.address,
        tokenAddress,
        amountTon,
        slippageBps: resolvedSlippageBps,
        network: this.options.config.network,
        stonClient: this.options.stonClient,
      });

      await loadedWallet.sender.send({
        to: payload.to,
        value: payload.value,
        body: payload.payload,
        bounce: true,
      });

      const txHash = `buy:${attemptId}:${Date.now()}`;
      this.updateSwapAttempt(attemptId, 'success', txHash);

      return {
        attemptId,
        status: 'success',
        txHash,
        entryPriceTon: payload.entryPriceTon,
        estimatedTokenOut: payload.estimatedTokenOut,
      };
    } catch (error) {
      if (error instanceof NetworkGuardError) {
        return {
          attemptId,
          status: 'blocked_mainnet_guard',
          entryPriceTon: 0,
          estimatedTokenOut: '0',
        };
      }

      const message = error instanceof Error ? error.message : 'Unknown buy execution failure.';
      this.updateSwapAttempt(attemptId, 'failed', undefined, message);

      return {
        attemptId,
        status: 'failed',
        entryPriceTon: 0,
        estimatedTokenOut: '0',
      };
    }
  }

  public async simulateBuySwap(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
    options?: { inlineSlippageBps?: number },
  ): Promise<SwapExecutionResult & { entryPriceTon: number; estimatedTokenOut: string }> {
    /**
     * Simulates a TON → Jetton buy swap without broadcasting.
     * Returns the quote details for paper trading mode.
     */
    const slippageResolution = this.options.slippageService.resolveSlippage(
      userId,
      tokenAddress,
      options?.inlineSlippageBps,
    );
    const quote = (await this.options.stonClient.getSwapQuote(
      tokenAddress,
      amountTon,
      slippageResolution.slippageBps,
    )) as BuyQuote;

    const entryPriceTon = Number(quote.offerAmount) > 0 ? amountTon / Number(quote.offerAmount) : 0;

    const attemptId = this.logSwapAttempt(
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      'paper',
      'simulated',
    );

    return {
      attemptId,
      status: 'simulated',
      quote,
      entryPriceTon,
      estimatedTokenOut: quote.askAmount,
    };
  }

  public logBlockedMainnetAttempt(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
    reason: string,
  ): number {
    return this.logSwapAttempt(
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      'live',
      'blocked_mainnet_guard',
      undefined,
      reason,
    );
  }

  private logSwapAttempt(
    userId: number,
    poolAddress: string,
    tokenAddress: string,
    amountTon: number,
    mode: 'live' | 'paper',
    status: string,
    txHash?: string,
    errorMessage?: string,
  ): number {
    upsertUser(this.options.db, userId);
    const result = execute(
      this.options.db,
      `
        INSERT INTO swap_attempts
          (user_id, pool_address, token_address, amount_ton, mode, status, tx_hash, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      userId,
      poolAddress,
      tokenAddress,
      amountTon,
      mode,
      status,
      txHash ?? null,
      errorMessage ?? null,
    );

    return Number(result.lastInsertRowid);
  }

  private updateSwapAttempt(
    attemptId: number,
    status: string,
    txHash?: string,
    errorMessage?: string,
  ): void {
    execute(
      this.options.db,
      `
        UPDATE swap_attempts
        SET status = ?,
            tx_hash = COALESCE(?, tx_hash),
            error_message = COALESCE(?, error_message)
        WHERE id = ?
      `,
      status,
      txHash ?? null,
      errorMessage ?? null,
      attemptId,
    );
  }
}

export function buildTonscanLink(txHash: string, network: Config['network']): string {
  const base = network === 'testnet' ? 'https://testnet.tonscan.org/tx' : 'https://tonscan.org/tx';
  return `${base}/${txHash}`;
}
