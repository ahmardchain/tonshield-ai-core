import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Sender } from '@ton/core';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';
import type { TonClient } from '@ton/ton';
import type { OpenedContract } from '@ton/ton';
import type { Config } from '../config/env';
import type { DatabaseConnection } from '../db/sqlite';
import { getAgentWallet, saveAgentWallet } from './walletStore';

const AES_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface AgentWalletServiceOptions {
  db: DatabaseConnection;
  config: Config;
  tonClient: TonClient;
  logger?: Pick<Console, 'warn'>;
}

export interface LoadedAgentWallet {
  address: string;
  wallet: OpenedContract<WalletContractV4>;
  sender: Sender;
}

export class AgentWalletNotFoundError extends Error {
  public constructor(userId: number) {
    super(`No agent wallet exists for user ${userId}. Run /create_agent_wallet first.`);
    this.name = 'AgentWalletNotFoundError';
  }
}

function encryptMnemonic(mnemonic: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  const encrypted = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptMnemonic(encryptedMnemonic: string, key: Buffer): string {
  const [ivBase64, authTagBase64, ciphertextBase64] = encryptedMnemonic.split(':');

  if (ivBase64 === undefined || authTagBase64 === undefined || ciphertextBase64 === undefined) {
    throw new Error('Encrypted mnemonic payload is malformed.');
  }

  const decipher = createDecipheriv(AES_ALGORITHM, key, Buffer.from(ivBase64, 'base64'), {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextBase64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export class AgentWalletService {
  private readonly logger: Pick<Console, 'warn'>;

  public constructor(private readonly options: AgentWalletServiceOptions) {
    this.logger = options.logger ?? console;
  }

  public async generateAgentWallet(userId: number): Promise<string> {
    const mnemonic = await mnemonicNew(24);
    const keyPair = await mnemonicToPrivateKey(mnemonic);

    // PRODUCTION TODO: Replace with TON Agentic Wallet Standard or audited contract wallet.
    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });

    const address = wallet.address.toString({
      testOnly: this.options.config.network === 'testnet',
    });
    const mnemonicPhrase = mnemonic.join(' ');
    const encryptedMnemonic = encryptMnemonic(
      mnemonicPhrase,
      this.options.config.agentWalletEncryptionKey,
    );

    saveAgentWallet(this.options.db, {
      userId,
      address,
      encryptedMnemonic,
      network: this.options.config.network,
    });

    this.logger.warn(
      `[TonShield AI] One-time operator backup for user ${userId} agent wallet mnemonic: ${mnemonicPhrase}`,
    );

    return address;
  }

  public async decryptAndLoadWallet(userId: number): Promise<LoadedAgentWallet> {
    const stored = getAgentWallet(this.options.db, userId);

    if (stored === undefined) {
      throw new AgentWalletNotFoundError(userId);
    }

    const mnemonicPhrase = decryptMnemonic(
      stored.encryptedMnemonic,
      this.options.config.agentWalletEncryptionKey,
    );
    const keyPair = await mnemonicToPrivateKey(mnemonicPhrase.split(' '));

    // PRODUCTION TODO: Replace with TON Agentic Wallet Standard or audited contract wallet.
    const walletContract = WalletContractV4.create({
      workchain: 0,
      publicKey: keyPair.publicKey,
    });
    const wallet = this.options.tonClient.open(walletContract);

    return {
      address: stored.address,
      wallet,
      sender: wallet.sender(keyPair.secretKey),
    };
  }
}

export const agentWalletCrypto = {
  encryptMnemonic,
  decryptMnemonic,
};
