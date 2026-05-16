"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveAgentWallet = saveAgentWallet;
exports.getAgentWallet = getAgentWallet;
exports.hasAgentWallet = hasAgentWallet;
const sqlite_1 = require("../db/sqlite");
function saveAgentWallet(db, params) {
    (0, sqlite_1.upsertUser)(db, params.userId);
    (0, sqlite_1.execute)(db, `
      INSERT INTO agent_wallets (user_id, address, encrypted_mnemonic, network)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        address = excluded.address,
        encrypted_mnemonic = excluded.encrypted_mnemonic,
        network = excluded.network
    `, params.userId, params.address, params.encryptedMnemonic, params.network);
}
function getAgentWallet(db, userId) {
    const row = (0, sqlite_1.getOne)(db, 'SELECT * FROM agent_wallets WHERE user_id = ? LIMIT 1', userId);
    if (row === undefined) {
        return undefined;
    }
    return {
        userId: row.user_id,
        address: row.address,
        encryptedMnemonic: row.encrypted_mnemonic,
        network: row.network === 'mainnet' ? 'mainnet' : 'testnet',
        createdAt: row.created_at,
    };
}
function hasAgentWallet(db, userId) {
    return getAgentWallet(db, userId) !== undefined;
}
