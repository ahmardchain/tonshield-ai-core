"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.agentWalletCrypto = exports.AgentWalletService = exports.AgentWalletNotFoundError = void 0;
const node_crypto_1 = require("node:crypto");
const crypto_1 = require("@ton/crypto");
const ton_1 = require("@ton/ton");
const walletStore_1 = require("./walletStore");
const AES_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
class AgentWalletNotFoundError extends Error {
    constructor(userId) {
        super(`No agent wallet exists for user ${userId}. Run /create_agent_wallet first.`);
        this.name = 'AgentWalletNotFoundError';
    }
}
exports.AgentWalletNotFoundError = AgentWalletNotFoundError;
function encryptMnemonic(mnemonic, key) {
    const iv = (0, node_crypto_1.randomBytes)(IV_BYTES);
    const cipher = (0, node_crypto_1.createCipheriv)(AES_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
    const encrypted = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}
function decryptMnemonic(encryptedMnemonic, key) {
    const [ivBase64, authTagBase64, ciphertextBase64] = encryptedMnemonic.split(':');
    if (ivBase64 === undefined || authTagBase64 === undefined || ciphertextBase64 === undefined) {
        throw new Error('Encrypted mnemonic payload is malformed.');
    }
    const decipher = (0, node_crypto_1.createDecipheriv)(AES_ALGORITHM, key, Buffer.from(ivBase64, 'base64'), {
        authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(Buffer.from(authTagBase64, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(ciphertextBase64, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}
class AgentWalletService {
    options;
    logger;
    constructor(options) {
        this.options = options;
        this.logger = options.logger ?? console;
    }
    async generateAgentWallet(userId) {
        const mnemonic = await (0, crypto_1.mnemonicNew)(24);
        const keyPair = await (0, crypto_1.mnemonicToPrivateKey)(mnemonic);
        // PRODUCTION TODO: Replace with TON Agentic Wallet Standard or audited contract wallet.
        const wallet = ton_1.WalletContractV4.create({
            workchain: 0,
            publicKey: keyPair.publicKey,
        });
        const address = wallet.address.toString({
            testOnly: this.options.config.network === 'testnet',
        });
        const mnemonicPhrase = mnemonic.join(' ');
        const encryptedMnemonic = encryptMnemonic(mnemonicPhrase, this.options.config.agentWalletEncryptionKey);
        (0, walletStore_1.saveAgentWallet)(this.options.db, {
            userId,
            address,
            encryptedMnemonic,
            network: this.options.config.network,
        });
        this.logger.warn(`[TonShield AI] One-time operator backup for user ${userId} agent wallet mnemonic: ${mnemonicPhrase}`);
        return address;
    }
    async decryptAndLoadWallet(userId) {
        const stored = (0, walletStore_1.getAgentWallet)(this.options.db, userId);
        if (stored === undefined) {
            throw new AgentWalletNotFoundError(userId);
        }
        const mnemonicPhrase = decryptMnemonic(stored.encryptedMnemonic, this.options.config.agentWalletEncryptionKey);
        const keyPair = await (0, crypto_1.mnemonicToPrivateKey)(mnemonicPhrase.split(' '));
        // PRODUCTION TODO: Replace with TON Agentic Wallet Standard or audited contract wallet.
        const walletContract = ton_1.WalletContractV4.create({
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
exports.AgentWalletService = AgentWalletService;
exports.agentWalletCrypto = {
    encryptMnemonic,
    decryptMnemonic,
};
