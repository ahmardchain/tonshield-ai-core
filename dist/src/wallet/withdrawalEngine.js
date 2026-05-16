"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WithdrawalEngine = void 0;
const core_1 = require("@ton/core");
const sqlite_1 = require("../db/sqlite");
const stonClient_1 = require("../ston/stonClient");
const GAS_RESERVE_TON = 0.15;
const JETTON_TRANSFER_GAS_TON = 0.05;
class WithdrawalEngine {
    db;
    config;
    tonClient;
    agentWallet;
    constructor(db, config, tonClient, agentWallet) {
        this.db = db;
        this.config = config;
        this.tonClient = tonClient;
        this.agentWallet = agentWallet;
    }
    async withdrawTon(userId, destinationAddress, amountTon) {
        /**
         * Sends TON from the agent wallet to the user's specified destination.
         * Always reserves GAS_RESERVE_TON to keep agent wallet operational.
         * Logs attempt before execution.
         */
        const attemptId = (0, sqlite_1.logWithdrawalAttempt)(this.db, userId, 'ton', destinationAddress, amountTon);
        try {
            const loaded = await this.agentWallet.decryptAndLoadWallet(userId);
            const balance = await this.tonClient.getBalance(core_1.Address.parse(loaded.address));
            const balanceTon = Number(balance) / 1e9;
            const maxWithdrawable = balanceTon - GAS_RESERVE_TON;
            if (amountTon > maxWithdrawable) {
                const message = `Withdrawal amount ${amountTon} TON exceeds withdrawable balance. Maximum withdrawable: ${maxWithdrawable.toFixed(4)} TON (${GAS_RESERVE_TON} TON reserved for gas).`;
                (0, sqlite_1.updateWithdrawalAttempt)(this.db, attemptId, 'rejected', undefined, message);
                return { attemptId, status: 'rejected', errorMessage: message };
            }
            const destination = core_1.Address.parse(destinationAddress);
            await loaded.sender.send({
                to: destination,
                value: (0, core_1.toNano)(amountTon.toString()),
                bounce: false,
                body: (0, core_1.beginCell)().endCell(),
            });
            const txHash = `withdraw_ton:${attemptId}:${Date.now()}`;
            (0, sqlite_1.updateWithdrawalAttempt)(this.db, attemptId, 'success', txHash);
            return { attemptId, status: 'success', txHash };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown withdrawal error.';
            (0, sqlite_1.updateWithdrawalAttempt)(this.db, attemptId, 'failed', undefined, message);
            return { attemptId, status: 'failed', errorMessage: message };
        }
    }
    async withdrawAllTon(userId, destinationAddress) {
        /**
         * Withdraws entire TON balance minus gas reserve.
         * Calculates withdrawable amount from live chain balance.
         */
        const loaded = await this.agentWallet.decryptAndLoadWallet(userId);
        const balance = await this.tonClient.getBalance(core_1.Address.parse(loaded.address));
        const balanceTon = Number(balance) / 1e9;
        const withdrawableAmount = Math.max(0, balanceTon - GAS_RESERVE_TON);
        if (withdrawableAmount <= 0) {
            return {
                attemptId: 0,
                status: 'rejected',
                errorMessage: `Agent wallet balance is too low to withdraw. Minimum ${GAS_RESERVE_TON} TON must remain for gas.`,
            };
        }
        return this.withdrawTon(userId, destinationAddress, withdrawableAmount);
    }
    async withdrawToken(userId, tokenAddress, destinationAddress) {
        /**
         * Transfers all held Jettons of a specific token from agent wallet
         * to the user's destination address using the Jetton transfer opcode.
         * Discovers agent wallet's specific Jetton wallet contract first.
         */
        const attemptId = (0, sqlite_1.logWithdrawalAttempt)(this.db, userId, 'token', destinationAddress, undefined, tokenAddress);
        try {
            const loaded = await this.agentWallet.decryptAndLoadWallet(userId);
            const jettonWalletAddress = await (0, stonClient_1.discoverJettonWalletAddress)(this.tonClient, tokenAddress, loaded.address);
            const jettonWalletData = await this.tonClient.runMethod(jettonWalletAddress, 'get_wallet_data', []);
            const jettonBalance = jettonWalletData.stack.readBigNumber();
            if (jettonBalance <= 0n) {
                const message = 'No token balance found in agent wallet for this token address.';
                (0, sqlite_1.updateWithdrawalAttempt)(this.db, attemptId, 'rejected', undefined, message);
                return { attemptId, status: 'rejected', errorMessage: message };
            }
            const destination = core_1.Address.parse(destinationAddress);
            const transferBody = (0, core_1.beginCell)()
                .storeUint(0xf8a7ea5, 32)
                .storeUint(BigInt(Date.now()), 64)
                .storeCoins(jettonBalance)
                .storeAddress(destination)
                .storeAddress(core_1.Address.parse(loaded.address))
                .storeBit(false)
                .storeCoins((0, core_1.toNano)('0.01'))
                .storeMaybeRef(null)
                .endCell();
            await loaded.sender.send({
                to: jettonWalletAddress,
                value: (0, core_1.toNano)(JETTON_TRANSFER_GAS_TON.toString()),
                bounce: false,
                body: transferBody,
            });
            const txHash = `withdraw_token:${attemptId}:${Date.now()}`;
            (0, sqlite_1.updateWithdrawalAttempt)(this.db, attemptId, 'success', txHash);
            return { attemptId, status: 'success', txHash };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown token withdrawal error.';
            (0, sqlite_1.updateWithdrawalAttempt)(this.db, attemptId, 'failed', undefined, message);
            return { attemptId, status: 'failed', errorMessage: message };
        }
    }
    tonscanLink(txHash) {
        const base = this.config.network === 'testnet'
            ? 'https://testnet.tonscan.org/tx'
            : 'https://tonscan.org/tx';
        return `${base}/${txHash}`;
    }
}
exports.WithdrawalEngine = WithdrawalEngine;
