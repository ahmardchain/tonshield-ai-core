"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StonFiExecutor = exports.NetworkGuardError = void 0;
exports.buildDefensiveSwapPayload = buildDefensiveSwapPayload;
exports.buildBuySwapPayload = buildBuySwapPayload;
exports.buildTonscanLink = buildTonscanLink;
const core_1 = require("@ton/core");
const StonSdk = __importStar(require("@ston-fi/sdk"));
const sqlite_1 = require("../db/sqlite");
const slippageService_1 = require("./slippageService");
const routerResolver_1 = require("./routerResolver");
const networkGuard_1 = require("./networkGuard");
// Option A: keep NetworkGuardError beside the executor that actually throws and catches it.
class NetworkGuardError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NetworkGuardError';
    }
}
exports.NetworkGuardError = NetworkGuardError;
function asBigInt(value, fallback) {
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
function asAddress(value) {
    if (value instanceof core_1.Address) {
        return value;
    }
    if (typeof value === 'string') {
        return core_1.Address.parse(value);
    }
    return core_1.Address.parse(routerResolver_1.TESTNET_STON_ROUTER_ADDRESS);
}
async function buildDefensiveSwapPayload(params) {
    const sdk = StonSdk;
    const routerAddress = routerResolver_1.TESTNET_STON_ROUTER_ADDRESS;
    const ptonAddress = routerResolver_1.TESTNET_PTON_MASTER_ADDRESS;
    // PRODUCTION TODO: Integrate TON Agentic Wallet execution rights standard.
    const router = params.tonClient.open(sdk.DEX.v2_1.Router.CPI.create(routerAddress));
    const proxyTon = sdk.pTON.v2_1.create(ptonAddress);
    const quoteResult = (await params.stonClient.getSwapQuote(params.tokenAddress, params.amountTon, params.slippageBps));
    const minimumAskAmount = BigInt(quoteResult.minAskAmount);
    const txParams = await router.getSwapJettonToTonTxParams({
        userWalletAddress: params.userWalletAddress,
        offerJettonAddress: params.tokenAddress,
        offerAmount: (0, core_1.toNano)(params.amountTon.toString()),
        minAskAmount: minimumAskAmount,
        proxyTon,
        queryId: BigInt(Date.now()),
        slippageTolerance: (params.slippageBps / 10_000).toString(),
    });
    return {
        to: asAddress(txParams.to),
        value: asBigInt(txParams.value ?? txParams.gasAmount, (0, core_1.toNano)('0.25')),
        payload: txParams.body ?? txParams.payload ?? (0, core_1.beginCell)().endCell(),
    };
}
async function buildBuySwapPayload(params) {
    /**
     * Builds a TON → Jetton swap payload using the STON.fi SDK.
     * This is the entry swap — the reverse of the defensive exit swap.
     * PRODUCTION TODO: Integrate TON Agentic Wallet execution rights standard.
     */
    const sdk = StonSdk;
    const routerAddress = routerResolver_1.TESTNET_STON_ROUTER_ADDRESS;
    const ptonAddress = routerResolver_1.TESTNET_PTON_MASTER_ADDRESS;
    const quote = (await params.stonClient.getSwapQuote(params.tokenAddress, params.amountTon, params.slippageBps));
    const minimumAskAmount = BigInt(quote.minAskAmount);
    const router = params.tonClient.open(sdk.DEX.v2_1.Router.CPI.create(routerAddress));
    const proxyTon = sdk.pTON.v2_1.create(ptonAddress);
    const txParams = await router.getSwapTonToJettonTxParams({
        userWalletAddress: params.userWalletAddress,
        proxyTon,
        offerAmount: (0, core_1.toNano)(params.amountTon.toString()),
        askJettonAddress: params.tokenAddress,
        minAskAmount: minimumAskAmount,
        queryId: BigInt(Date.now()),
        slippageTolerance: (params.slippageBps / 10_000).toString(),
    });
    const entryPriceTon = Number(quote.offerAmount) > 0 ? params.amountTon / Number(quote.offerAmount) : 0;
    return {
        to: asAddress(txParams.to),
        value: asBigInt(txParams.value ?? txParams.gasAmount, (0, core_1.toNano)('0.3')),
        payload: txParams.body ?? txParams.payload ?? (0, core_1.beginCell)().endCell(),
        estimatedTokenOut: quote.askAmount,
        minTokenOut: quote.minAskAmount,
        entryPriceTon,
    };
}
class StonFiExecutor {
    options;
    constructor(options) {
        this.options = {
            ...options,
            slippageService: options.slippageService ?? new slippageService_1.SlippageService(options.db, options.config),
        };
    }
    async executeDefensiveSwap(userId, poolAddress, tokenAddress, amountTon) {
        const attemptId = this.logSwapAttempt(userId, poolAddress, tokenAddress, amountTon, 'live', 'pending');
        try {
            if (!(0, networkGuard_1.canExecuteLiveTransactions)(this.options.config)) {
                const message = 'Mainnet execution blocked. Set NETWORK=mainnet and ENABLE_MAINNET_EXECUTION=true only after audit approval.';
                this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
                throw new NetworkGuardError(message);
            }
            if (this.options.config.network === 'mainnet') {
                const message = 'Mainnet execution remains disabled in this MVP until independent security audit approval.';
                this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
                throw new NetworkGuardError(message);
            }
            this.options.budgetPolicy.validateAndReserve(userId, amountTon);
            const loadedWallet = await this.options.agentWallet.decryptAndLoadWallet(userId);
            const emergencyResolution = this.options.slippageService.resolveEmergencySlippage(userId, tokenAddress);
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
        }
        catch (error) {
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
    async simulateDefensiveSwap(userId, poolAddress, amountTon) {
        const poolData = await this.options.stonClient.getPoolData(poolAddress);
        const tokenAddress = poolData.tokenAddresses[0] ?? 'unknown';
        const emergencyResolution = this.options.slippageService.resolveEmergencySlippage(userId, tokenAddress);
        const quote = await this.options.stonClient.getSwapQuote(tokenAddress, amountTon, emergencyResolution.slippageBps);
        const attemptId = this.logSwapAttempt(userId, poolAddress, tokenAddress, amountTon, 'paper', 'simulated');
        return {
            attemptId,
            status: 'simulated',
            quote,
        };
    }
    async executeBuySwap(userId, poolAddress, tokenAddress, amountTon, options) {
        /**
         * Executes a TON → Jetton buy swap from the agent wallet.
         * Records the attempt before execution and opens a position on success.
         */
        const attemptId = this.logSwapAttempt(userId, poolAddress, tokenAddress, amountTon, 'live', 'pending');
        try {
            if (!(0, networkGuard_1.canExecuteLiveTransactions)(this.options.config)) {
                const message = 'Mainnet execution blocked. Set NETWORK=mainnet and ENABLE_MAINNET_EXECUTION=true only after audit approval.';
                this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
                throw new NetworkGuardError(message);
            }
            if (this.options.config.network === 'mainnet') {
                const message = 'Mainnet buy execution remains disabled in this MVP until independent security audit approval.';
                this.updateSwapAttempt(attemptId, 'blocked_mainnet_guard', undefined, message);
                throw new NetworkGuardError(message);
            }
            this.options.budgetPolicy.validateAndReserve(userId, amountTon);
            const loadedWallet = await this.options.agentWallet.decryptAndLoadWallet(userId);
            const slippageResolution = this.options.slippageService.resolveSlippage(userId, tokenAddress, options?.inlineSlippageBps);
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
        }
        catch (error) {
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
    async simulateBuySwap(userId, poolAddress, tokenAddress, amountTon, options) {
        /**
         * Simulates a TON → Jetton buy swap without broadcasting.
         * Returns the quote details for paper trading mode.
         */
        const slippageResolution = this.options.slippageService.resolveSlippage(userId, tokenAddress, options?.inlineSlippageBps);
        const quote = (await this.options.stonClient.getSwapQuote(tokenAddress, amountTon, slippageResolution.slippageBps));
        const entryPriceTon = Number(quote.offerAmount) > 0 ? amountTon / Number(quote.offerAmount) : 0;
        const attemptId = this.logSwapAttempt(userId, poolAddress, tokenAddress, amountTon, 'paper', 'simulated');
        return {
            attemptId,
            status: 'simulated',
            quote,
            entryPriceTon,
            estimatedTokenOut: quote.askAmount,
        };
    }
    logBlockedMainnetAttempt(userId, poolAddress, tokenAddress, amountTon, reason) {
        return this.logSwapAttempt(userId, poolAddress, tokenAddress, amountTon, 'live', 'blocked_mainnet_guard', undefined, reason);
    }
    logSwapAttempt(userId, poolAddress, tokenAddress, amountTon, mode, status, txHash, errorMessage) {
        (0, sqlite_1.upsertUser)(this.options.db, userId);
        const result = (0, sqlite_1.execute)(this.options.db, `
        INSERT INTO swap_attempts
          (user_id, pool_address, token_address, amount_ton, mode, status, tx_hash, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, userId, poolAddress, tokenAddress, amountTon, mode, status, txHash ?? null, errorMessage ?? null);
        return Number(result.lastInsertRowid);
    }
    updateSwapAttempt(attemptId, status, txHash, errorMessage) {
        (0, sqlite_1.execute)(this.options.db, `
        UPDATE swap_attempts
        SET status = ?,
            tx_hash = COALESCE(?, tx_hash),
            error_message = COALESCE(?, error_message)
        WHERE id = ?
      `, status, txHash ?? null, errorMessage ?? null, attemptId);
    }
}
exports.StonFiExecutor = StonFiExecutor;
function buildTonscanLink(txHash, network) {
    const base = network === 'testnet' ? 'https://testnet.tonscan.org/tx' : 'https://tonscan.org/tx';
    return `${base}/${txHash}`;
}
