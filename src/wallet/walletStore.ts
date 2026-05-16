import type { Config } from '../config/env';
import type { AgentWalletRow, DatabaseConnection } from '../db/sqlite';
import { execute, getOne, upsertUser } from '../db/sqlite';

export interface StoredAgentWallet {
  userId: number;
  address: string;
  encryptedMnemonic: string;
  network: Config['network'];
  createdAt: string;
}

export function saveAgentWallet(
  db: DatabaseConnection,
  params: {
    userId: number;
    address: string;
    encryptedMnemonic: string;
    network: Config['network'];
  },
): void {
  upsertUser(db, params.userId);
  execute(
    db,
    `
      INSERT INTO agent_wallets (user_id, address, encrypted_mnemonic, network)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        address = excluded.address,
        encrypted_mnemonic = excluded.encrypted_mnemonic,
        network = excluded.network
    `,
    params.userId,
    params.address,
    params.encryptedMnemonic,
    params.network,
  );
}

export function getAgentWallet(
  db: DatabaseConnection,
  userId: number,
): StoredAgentWallet | undefined {
  const row = getOne<AgentWalletRow>(
    db,
    'SELECT * FROM agent_wallets WHERE user_id = ? LIMIT 1',
    userId,
  );

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

export function hasAgentWallet(db: DatabaseConnection, userId: number): boolean {
  return getAgentWallet(db, userId) !== undefined;
}
