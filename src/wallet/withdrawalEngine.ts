import { Address, beginCell, toNano } from '@ton/core';
import type { TonClient } from '@ton/ton';
import type { Config } from '../config/env';
import type { DatabaseConnection } from '../db/sqlite';
import { logWithdrawalAttempt, updateWithdrawalAttempt } from '../db/sqlite';
import { discoverJettonWalletAddress } from '../ston/stonClient';
import type { AgentWalletService } from './agentWallet';

const GAS_RESERVE_TON = 0.15;
const JETTON_TRANSFER_GAS_TON = 0.05;

export interface WithdrawalResult {
  attemptId: number;
  status: 'success' | 'failed' | 'rejected';
  txHash?: string;
  errorMessage?: string;
}

export class WithdrawalEngine {
  public constructor(
    private readonly db: DatabaseConnection,
    private readonly config: Config,
    private readonly tonClient: TonClient,
    private readonly agentWallet: AgentWalletService,
  ) {}

  public async withdrawTon(
    userId: number,
    destinationAddress: string,
    amountTon: number,
  ): Promise<WithdrawalResult> {
    /**
     * Sends TON from the agent wallet to the user's specified destination.
     * Always reserves GAS_RESERVE_TON to keep agent wallet operational.
     * Logs attempt before execution.
     */
    const attemptId = logWithdrawalAttempt(this.db, userId, 'ton', destinationAddress, amountTon);

    try {
      const loaded = await this.agentWallet.decryptAndLoadWallet(userId);

      const balance = await this.tonClient.getBalance(Address.parse(loaded.address));
      const balanceTon = Number(balance) / 1e9;
      const maxWithdrawable = balanceTon - GAS_RESERVE_TON;

      if (amountTon > maxWithdrawable) {
        const message = `Withdrawal amount ${amountTon} TON exceeds withdrawable balance. Maximum withdrawable: ${maxWithdrawable.toFixed(4)} TON (${GAS_RESERVE_TON} TON reserved for gas).`;
        updateWithdrawalAttempt(this.db, attemptId, 'rejected', undefined, message);
        return { attemptId, status: 'rejected', errorMessage: message };
      }

      const destination = Address.parse(destinationAddress);

      await loaded.sender.send({
        to: destination,
        value: toNano(amountTon.toString()),
        bounce: false,
        body: beginCell().endCell(),
      });

      const txHash = `withdraw_ton:${attemptId}:${Date.now()}`;
      updateWithdrawalAttempt(this.db, attemptId, 'success', txHash);

      return { attemptId, status: 'success', txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown withdrawal error.';
      updateWithdrawalAttempt(this.db, attemptId, 'failed', undefined, message);
      return { attemptId, status: 'failed', errorMessage: message };
    }
  }

  public async withdrawAllTon(
    userId: number,
    destinationAddress: string,
  ): Promise<WithdrawalResult> {
    /**
     * Withdraws entire TON balance minus gas reserve.
     * Calculates withdrawable amount from live chain balance.
     */
    const loaded = await this.agentWallet.decryptAndLoadWallet(userId);
    const balance = await this.tonClient.getBalance(Address.parse(loaded.address));
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

  public async withdrawToken(
    userId: number,
    tokenAddress: string,
    destinationAddress: string,
  ): Promise<WithdrawalResult> {
    /**
     * Transfers all held Jettons of a specific token from agent wallet
     * to the user's destination address using the Jetton transfer opcode.
     * Discovers agent wallet's specific Jetton wallet contract first.
     */
    const attemptId = logWithdrawalAttempt(
      this.db,
      userId,
      'token',
      destinationAddress,
      undefined,
      tokenAddress,
    );

    try {
      const loaded = await this.agentWallet.decryptAndLoadWallet(userId);

      const jettonWalletAddress = await discoverJettonWalletAddress(
        this.tonClient,
        tokenAddress,
        loaded.address,
      );

      const jettonWalletData = await this.tonClient.runMethod(
        jettonWalletAddress,
        'get_wallet_data',
        [],
      );
      const jettonBalance = jettonWalletData.stack.readBigNumber();

      if (jettonBalance <= 0n) {
        const message = 'No token balance found in agent wallet for this token address.';
        updateWithdrawalAttempt(this.db, attemptId, 'rejected', undefined, message);
        return { attemptId, status: 'rejected', errorMessage: message };
      }

      const destination = Address.parse(destinationAddress);

      const transferBody = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(BigInt(Date.now()), 64)
        .storeCoins(jettonBalance)
        .storeAddress(destination)
        .storeAddress(Address.parse(loaded.address))
        .storeBit(false)
        .storeCoins(toNano('0.01'))
        .storeMaybeRef(null)
        .endCell();

      await loaded.sender.send({
        to: jettonWalletAddress,
        value: toNano(JETTON_TRANSFER_GAS_TON.toString()),
        bounce: false,
        body: transferBody,
      });

      const txHash = `withdraw_token:${attemptId}:${Date.now()}`;
      updateWithdrawalAttempt(this.db, attemptId, 'success', txHash);

      return { attemptId, status: 'success', txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown token withdrawal error.';
      updateWithdrawalAttempt(this.db, attemptId, 'failed', undefined, message);
      return { attemptId, status: 'failed', errorMessage: message };
    }
  }

  public tonscanLink(txHash: string): string {
    const base =
      this.config.network === 'testnet'
        ? 'https://testnet.tonscan.org/tx'
        : 'https://tonscan.org/tx';
    return `${base}/${txHash}`;
  }
}
