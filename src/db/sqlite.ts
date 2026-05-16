import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type DatabaseConnection = Database.Database;

export interface UserRow {
  user_id: number;
  username: string | null;
  created_at: string;
}

export interface AgentWalletRow {
  user_id: number;
  address: string;
  encrypted_mnemonic: string;
  network: string;
  created_at: string;
}

export interface BudgetPolicyRow {
  user_id: number;
  max_budget_ton: number;
  current_spent_ton: number;
  per_trade_limit_ton: number;
  updated_at: string;
}

export interface WatchedPoolRow {
  id: number;
  user_id: number;
  pool_address: string;
  added_at: string;
}

export interface ArmedPoolRow {
  id: number;
  user_id: number;
  pool_address: string;
  armed_at: string;
}

export interface PoolSnapshotRow {
  id: number;
  pool_address: string;
  depth_ton: number;
  captured_at: string;
}

export interface RiskEventRow {
  id: number;
  user_id: number;
  pool_address: string;
  risk_level: string;
  drop_percent: number;
  triggered_at: string;
}

export interface SwapAttemptRow {
  id: number;
  user_id: number;
  pool_address: string;
  token_address: string;
  amount_ton: number;
  mode: string;
  status: string;
  tx_hash: string | null;
  error_message: string | null;
  attempted_at: string;
}

export interface RiskSettingsRow {
  user_id: number;
  pool_address: string;
  take_profit_percent: number;
  stop_loss_percent: number;
  entry_price_ton: number | null;
  updated_at: string;
}

export interface PositionRow {
  id: number;
  user_id: number;
  pool_address: string;
  token_address: string;
  entry_price_ton: number;
  amount_ton: number;
  status: string;
  opened_at: string;
  closed_at: string | null;
  exit_price_ton: number | null;
  pnl_percent: number | null;
  pnl_ton: number | null;
  tx_hash_open: string | null;
  tx_hash_close: string | null;
}

export interface WithdrawalAttemptRow {
  id: number;
  user_id: number;
  withdrawal_type: string;
  destination_address: string;
  amount_ton: number | null;
  token_address: string | null;
  status: string;
  tx_hash: string | null;
  error_message: string | null;
  attempted_at: string;
}

export interface TokenSafetyCacheRow {
  token_address: string;
  honeypot_result: string;
  honeypot_round_trip_loss_percent: number | null;
  contract_code_hash: string | null;
  contract_verified: number;
  buy_tax_percent: number | null;
  sell_tax_percent: number | null;
  liquidity_locked: number;
  lock_expiry: string | null;
  locker_address: string | null;
  largest_holder_percent: number | null;
  dev_wallet_address: string | null;
  dev_wallet_percent: number | null;
  overall_risk: string;
  scanned_at: string;
}

export interface HolderSnapshotRow {
  id: number;
  token_address: string;
  wallet_address: string;
  balance_raw: string;
  percent_of_supply: number;
  wallet_label: string | null;
  is_dev_wallet: number;
  is_dex_wallet: number;
  captured_at: string;
}

export interface BubbleMapCacheRow {
  token_address: string;
  cluster_count: number;
  suspicious_supply_percent: number;
  bubble_risk: string;
  cluster_data: string;
  wallets_analyzed: number;
  analyzed_at: string;
}

export interface WalletGraphEdgeRow {
  id: number;
  token_address: string;
  from_wallet: string;
  to_wallet: string;
  connection_type: string;
  amount_ton: number | null;
  block_time: number | null;
  discovered_at: string;
}

export interface SlippageSettingRow {
  user_id: number;
  token_address: string;
  slippage_bps: number;
  setting_type: string;
  updated_at: string;
}

export interface PriceCacheRow {
  id: number;
  cache_key: string;
  value_json: string;
  cached_at: string;
}

export interface TokenMarketDataRow {
  token_address: string;
  price_ton: number | null;
  price_usd: number | null;
  fdv_usd: number | null;
  ath_fdv_usd: number | null;
  lp_value_usd: number | null;
  buy_tax_percent: number | null;
  sell_tax_percent: number | null;
  renounced: number;
  mintable: number;
  total_supply: string | null;
  updated_at: string;
}

export function initializeDatabase(databasePath: string): DatabaseConnection {
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const localSchemaPath = join(__dirname, 'schema.sql');
  const sourceSchemaPath = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
  const schemaPath = existsSync(localSchemaPath) ? localSchemaPath : sourceSchemaPath;
  db.exec(readFileSync(schemaPath, 'utf8'));
  return db;
}

export function getOne<T>(
  db: DatabaseConnection,
  sql: string,
  ...params: unknown[]
): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function getAll<T>(db: DatabaseConnection, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function execute(
  db: DatabaseConnection,
  sql: string,
  ...params: unknown[]
): Database.RunResult {
  return db.prepare(sql).run(...params);
}

export function upsertUser(
  db: DatabaseConnection,
  userId: number,
  username: string | null = null,
): void {
  execute(
    db,
    `
      INSERT INTO users (user_id, username)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username)
    `,
    userId,
    username,
  );
}

export function addWatchedPool(db: DatabaseConnection, userId: number, poolAddress: string): void {
  upsertUser(db, userId);
  execute(
    db,
    'INSERT OR IGNORE INTO watched_pools (user_id, pool_address) VALUES (?, ?)',
    userId,
    poolAddress,
  );
}

export function removeWatchedPool(
  db: DatabaseConnection,
  userId: number,
  poolAddress: string,
): void {
  execute(
    db,
    'DELETE FROM watched_pools WHERE user_id = ? AND pool_address = ?',
    userId,
    poolAddress,
  );
  execute(
    db,
    'DELETE FROM armed_pools WHERE user_id = ? AND pool_address = ?',
    userId,
    poolAddress,
  );
}

export function addArmedPool(db: DatabaseConnection, userId: number, poolAddress: string): void {
  upsertUser(db, userId);
  execute(
    db,
    'INSERT OR IGNORE INTO armed_pools (user_id, pool_address) VALUES (?, ?)',
    userId,
    poolAddress,
  );
}

export function removeArmedPool(db: DatabaseConnection, userId: number, poolAddress: string): void {
  execute(
    db,
    'DELETE FROM armed_pools WHERE user_id = ? AND pool_address = ?',
    userId,
    poolAddress,
  );
}

export function isPoolArmed(db: DatabaseConnection, userId: number, poolAddress: string): boolean {
  const row = getOne<{ exists_value: number }>(
    db,
    `
      SELECT 1 AS exists_value
      FROM armed_pools
      WHERE user_id = ? AND pool_address = ?
      LIMIT 1
    `,
    userId,
    poolAddress,
  );

  return row !== undefined;
}

export function listWatchedPools(db: DatabaseConnection, userId?: number): WatchedPoolRow[] {
  if (userId === undefined) {
    return getAll<WatchedPoolRow>(
      db,
      'SELECT * FROM watched_pools ORDER BY added_at DESC, id DESC',
    );
  }

  return getAll<WatchedPoolRow>(
    db,
    'SELECT * FROM watched_pools WHERE user_id = ? ORDER BY added_at DESC, id DESC',
    userId,
  );
}

export function listArmedPools(db: DatabaseConnection, userId: number): ArmedPoolRow[] {
  return getAll<ArmedPoolRow>(
    db,
    'SELECT * FROM armed_pools WHERE user_id = ? ORDER BY armed_at DESC, id DESC',
    userId,
  );
}

export function insertRiskEvent(
  db: DatabaseConnection,
  userId: number,
  poolAddress: string,
  riskLevel: string,
  dropPercent: number,
): void {
  upsertUser(db, userId);
  execute(
    db,
    `
      INSERT INTO risk_events (user_id, pool_address, risk_level, drop_percent)
      VALUES (?, ?, ?, ?)
    `,
    userId,
    poolAddress,
    riskLevel,
    dropPercent,
  );
}

export function upsertRiskSettings(
  db: DatabaseConnection,
  userId: number,
  poolAddress: string,
  takeProfitPercent: number,
  stopLossPercent: number,
  entryPriceTon?: number,
): void {
  execute(
    db,
    `
      INSERT INTO risk_settings
        (user_id, pool_address, take_profit_percent, stop_loss_percent, entry_price_ton)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        pool_address = excluded.pool_address,
        take_profit_percent = excluded.take_profit_percent,
        stop_loss_percent = excluded.stop_loss_percent,
        entry_price_ton = COALESCE(excluded.entry_price_ton, risk_settings.entry_price_ton),
        updated_at = CURRENT_TIMESTAMP
    `,
    userId,
    poolAddress,
    takeProfitPercent,
    stopLossPercent,
    entryPriceTon ?? null,
  );
}

export function getRiskSettings(
  db: DatabaseConnection,
  userId: number,
  poolAddress: string,
): RiskSettingsRow | undefined {
  return getOne<RiskSettingsRow>(
    db,
    'SELECT * FROM risk_settings WHERE user_id = ? AND pool_address = ? LIMIT 1',
    userId,
    poolAddress,
  );
}

export function openPosition(
  db: DatabaseConnection,
  userId: number,
  poolAddress: string,
  tokenAddress: string,
  entryPriceTon: number,
  amountTon: number,
  txHashOpen?: string,
): number {
  const result = execute(
    db,
    `
      INSERT INTO positions
        (user_id, pool_address, token_address, entry_price_ton, amount_ton, tx_hash_open)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    userId,
    poolAddress,
    tokenAddress,
    entryPriceTon,
    amountTon,
    txHashOpen ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function closePosition(
  db: DatabaseConnection,
  positionId: number,
  exitPriceTon: number,
  txHashClose?: string,
): void {
  const position = getOne<PositionRow>(
    db,
    'SELECT * FROM positions WHERE id = ? LIMIT 1',
    positionId,
  );

  if (position === undefined) return;

  const pnlPercent = ((exitPriceTon - position.entry_price_ton) / position.entry_price_ton) * 100;
  const pnlTon = (pnlPercent / 100) * position.amount_ton;

  execute(
    db,
    `
      UPDATE positions SET
        status = 'closed',
        closed_at = CURRENT_TIMESTAMP,
        exit_price_ton = ?,
        pnl_percent = ?,
        pnl_ton = ?,
        tx_hash_close = COALESCE(?, tx_hash_close)
      WHERE id = ?
    `,
    exitPriceTon,
    pnlPercent,
    pnlTon,
    txHashClose ?? null,
    positionId,
  );
}

export function getOpenPositions(db: DatabaseConnection, userId: number): PositionRow[] {
  return getAll<PositionRow>(
    db,
    `SELECT * FROM positions WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC`,
    userId,
  );
}

export function getClosedPositions(
  db: DatabaseConnection,
  userId: number,
  limit = 10,
): PositionRow[] {
  return getAll<PositionRow>(
    db,
    `SELECT * FROM positions WHERE user_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?`,
    userId,
    limit,
  );
}

export function logWithdrawalAttempt(
  db: DatabaseConnection,
  userId: number,
  withdrawalType: string,
  destinationAddress: string,
  amountTon?: number,
  tokenAddress?: string,
): number {
  const result = execute(
    db,
    `
      INSERT INTO withdrawal_attempts
        (user_id, withdrawal_type, destination_address, amount_ton, token_address)
      VALUES (?, ?, ?, ?, ?)
    `,
    userId,
    withdrawalType,
    destinationAddress,
    amountTon ?? null,
    tokenAddress ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function updateWithdrawalAttempt(
  db: DatabaseConnection,
  attemptId: number,
  status: string,
  txHash?: string,
  errorMessage?: string,
): void {
  execute(
    db,
    `
      UPDATE withdrawal_attempts SET
        status = ?,
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

export function logKeyExport(
  db: DatabaseConnection,
  userId: number,
  exportType: string,
): void {
  execute(
    db,
    'INSERT INTO key_export_log (user_id, export_type) VALUES (?, ?)',
    userId,
    exportType,
  );
}

export function getTokenSafetyCache(
  db: DatabaseConnection,
  tokenAddress: string,
  maxAgeMinutes = 60,
): TokenSafetyCacheRow | undefined {
  return getOne<TokenSafetyCacheRow>(
    db,
    `
      SELECT * FROM token_safety_cache
      WHERE token_address = ?
        AND datetime(scanned_at, '+' || ? || ' minutes') > datetime('now')
      LIMIT 1
    `,
    tokenAddress,
    maxAgeMinutes,
  );
}

export function saveTokenSafetyCache(
  db: DatabaseConnection,
  row: Omit<TokenSafetyCacheRow, 'scanned_at'>,
): void {
  execute(
    db,
    `
      INSERT INTO token_safety_cache (
        token_address, honeypot_result, honeypot_round_trip_loss_percent,
        contract_code_hash, contract_verified, buy_tax_percent, sell_tax_percent,
        liquidity_locked, lock_expiry, locker_address, largest_holder_percent,
        dev_wallet_address, dev_wallet_percent, overall_risk
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_address) DO UPDATE SET
        honeypot_result = excluded.honeypot_result,
        honeypot_round_trip_loss_percent = excluded.honeypot_round_trip_loss_percent,
        contract_code_hash = excluded.contract_code_hash,
        contract_verified = excluded.contract_verified,
        buy_tax_percent = excluded.buy_tax_percent,
        sell_tax_percent = excluded.sell_tax_percent,
        liquidity_locked = excluded.liquidity_locked,
        lock_expiry = excluded.lock_expiry,
        locker_address = excluded.locker_address,
        largest_holder_percent = excluded.largest_holder_percent,
        dev_wallet_address = excluded.dev_wallet_address,
        dev_wallet_percent = excluded.dev_wallet_percent,
        overall_risk = excluded.overall_risk,
        scanned_at = CURRENT_TIMESTAMP
    `,
    row.token_address,
    row.honeypot_result,
    row.honeypot_round_trip_loss_percent ?? null,
    row.contract_code_hash ?? null,
    row.contract_verified ? 1 : 0,
    row.buy_tax_percent ?? null,
    row.sell_tax_percent ?? null,
    row.liquidity_locked ? 1 : 0,
    row.lock_expiry ?? null,
    row.locker_address ?? null,
    row.largest_holder_percent ?? null,
    row.dev_wallet_address ?? null,
    row.dev_wallet_percent ?? null,
    row.overall_risk,
  );
}

export function saveBubbleMapCache(
  db: DatabaseConnection,
  tokenAddress: string,
  clusterCount: number,
  suspiciousSupplyPercent: number,
  bubbleRisk: string,
  clusterData: string,
  walletsAnalyzed: number,
): void {
  execute(
    db,
    `
      INSERT INTO bubble_map_cache
        (token_address, cluster_count, suspicious_supply_percent,
         bubble_risk, cluster_data, wallets_analyzed)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_address) DO UPDATE SET
        cluster_count = excluded.cluster_count,
        suspicious_supply_percent = excluded.suspicious_supply_percent,
        bubble_risk = excluded.bubble_risk,
        cluster_data = excluded.cluster_data,
        wallets_analyzed = excluded.wallets_analyzed,
        analyzed_at = CURRENT_TIMESTAMP
    `,
    tokenAddress,
    clusterCount,
    suspiciousSupplyPercent,
    bubbleRisk,
    clusterData,
    walletsAnalyzed,
  );
}

export function getBubbleMapCache(
  db: DatabaseConnection,
  tokenAddress: string,
  maxAgeMinutes = 60,
): BubbleMapCacheRow | undefined {
  return getOne<BubbleMapCacheRow>(
    db,
    `
      SELECT * FROM bubble_map_cache
      WHERE token_address = ?
        AND datetime(analyzed_at, '+' || ? || ' minutes') > datetime('now')
      LIMIT 1
    `,
    tokenAddress,
    maxAgeMinutes,
  );
}

export function saveHolderSnapshots(
  db: DatabaseConnection,
  tokenAddress: string,
  holders: Omit<HolderSnapshotRow, 'id' | 'token_address' | 'captured_at'>[],
): void {
  execute(db, 'DELETE FROM holder_snapshots WHERE token_address = ?', tokenAddress);

  for (const holder of holders) {
    execute(
      db,
      `
        INSERT INTO holder_snapshots
          (token_address, wallet_address, balance_raw, percent_of_supply,
           wallet_label, is_dev_wallet, is_dex_wallet)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      tokenAddress,
      holder.wallet_address,
      holder.balance_raw,
      holder.percent_of_supply,
      holder.wallet_label ?? null,
      holder.is_dev_wallet ? 1 : 0,
      holder.is_dex_wallet ? 1 : 0,
    );
  }
}

export function saveWalletGraphEdge(
  db: DatabaseConnection,
  tokenAddress: string,
  fromWallet: string,
  toWallet: string,
  connectionType: string,
  amountTon?: number,
  blockTime?: number,
): void {
  execute(
    db,
    `
      INSERT INTO wallet_graph_edges
        (token_address, from_wallet, to_wallet, connection_type, amount_ton, block_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    tokenAddress,
    fromWallet,
    toWallet,
    connectionType,
    amountTon ?? null,
    blockTime ?? null,
  );
}

export function upsertSlippageSetting(
  db: DatabaseConnection,
  userId: number,
  slippageBps: number,
  settingType: 'global' | 'token' | 'emergency',
  tokenAddress = '',
): void {
  execute(
    db,
    `
      INSERT INTO slippage_settings
        (user_id, token_address, slippage_bps, setting_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, token_address, setting_type) DO UPDATE SET
        slippage_bps = excluded.slippage_bps,
        updated_at = CURRENT_TIMESTAMP
    `,
    userId,
    tokenAddress,
    slippageBps,
    settingType,
  );
}

export function getSlippageSetting(
  db: DatabaseConnection,
  userId: number,
  settingType: 'global' | 'token' | 'emergency',
  tokenAddress = '',
): SlippageSettingRow | undefined {
  return getOne<SlippageSettingRow>(
    db,
    `
      SELECT * FROM slippage_settings
      WHERE user_id = ?
        AND setting_type = ?
        AND token_address = ?
      LIMIT 1
    `,
    userId,
    settingType,
    tokenAddress,
  );
}

export function getAllSlippageSettings(
  db: DatabaseConnection,
  userId: number,
): SlippageSettingRow[] {
  return getAll<SlippageSettingRow>(
    db,
    `
      SELECT * FROM slippage_settings
      WHERE user_id = ?
      ORDER BY setting_type ASC, token_address ASC
    `,
    userId,
  );
}

export function deleteSlippageSetting(
  db: DatabaseConnection,
  userId: number,
  settingType: 'global' | 'token' | 'emergency',
  tokenAddress = '',
): void {
  execute(
    db,
    `
      DELETE FROM slippage_settings
      WHERE user_id = ?
        AND setting_type = ?
        AND token_address = ?
    `,
    userId,
    settingType,
    tokenAddress,
  );
}

export function getPriceCache(
  db: DatabaseConnection,
  cacheKey: string,
  maxAgeSeconds = 30,
): PriceCacheRow | undefined {
  return getOne<PriceCacheRow>(
    db,
    `
      SELECT * FROM price_cache
      WHERE cache_key = ?
        AND datetime(cached_at, '+' || ? || ' seconds') > datetime('now')
      LIMIT 1
    `,
    cacheKey,
    maxAgeSeconds,
  );
}

export function setPriceCache(
  db: DatabaseConnection,
  cacheKey: string,
  valueJson: string,
): void {
  execute(
    db,
    `
      INSERT INTO price_cache (cache_key, value_json)
      VALUES (?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        value_json = excluded.value_json,
        cached_at = CURRENT_TIMESTAMP
    `,
    cacheKey,
    valueJson,
  );
}

export function upsertTokenMarketData(
  db: DatabaseConnection,
  row: Omit<TokenMarketDataRow, 'updated_at'>,
): void {
  execute(
    db,
    `
      INSERT INTO token_market_data (
        token_address, price_ton, price_usd, fdv_usd, ath_fdv_usd,
        lp_value_usd, buy_tax_percent, sell_tax_percent,
        renounced, mintable, total_supply
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token_address) DO UPDATE SET
        price_ton = excluded.price_ton,
        price_usd = excluded.price_usd,
        fdv_usd = excluded.fdv_usd,
        ath_fdv_usd = COALESCE(excluded.ath_fdv_usd, token_market_data.ath_fdv_usd),
        lp_value_usd = excluded.lp_value_usd,
        buy_tax_percent = excluded.buy_tax_percent,
        sell_tax_percent = excluded.sell_tax_percent,
        renounced = excluded.renounced,
        mintable = excluded.mintable,
        total_supply = excluded.total_supply,
        updated_at = CURRENT_TIMESTAMP
    `,
    row.token_address,
    row.price_ton ?? null,
    row.price_usd ?? null,
    row.fdv_usd ?? null,
    row.ath_fdv_usd ?? null,
    row.lp_value_usd ?? null,
    row.buy_tax_percent ?? null,
    row.sell_tax_percent ?? null,
    row.renounced ? 1 : 0,
    row.mintable ? 1 : 0,
    row.total_supply ?? null,
  );
}

export function getTokenMarketData(
  db: DatabaseConnection,
  tokenAddress: string,
): TokenMarketDataRow | undefined {
  return getOne<TokenMarketDataRow>(
    db,
    'SELECT * FROM token_market_data WHERE token_address = ? LIMIT 1',
    tokenAddress,
  );
}
