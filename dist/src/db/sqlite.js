"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeDatabase = initializeDatabase;
exports.getOne = getOne;
exports.getAll = getAll;
exports.execute = execute;
exports.upsertUser = upsertUser;
exports.addWatchedPool = addWatchedPool;
exports.removeWatchedPool = removeWatchedPool;
exports.addArmedPool = addArmedPool;
exports.removeArmedPool = removeArmedPool;
exports.isPoolArmed = isPoolArmed;
exports.listWatchedPools = listWatchedPools;
exports.listArmedPools = listArmedPools;
exports.insertRiskEvent = insertRiskEvent;
exports.upsertRiskSettings = upsertRiskSettings;
exports.getRiskSettings = getRiskSettings;
exports.openPosition = openPosition;
exports.closePosition = closePosition;
exports.getOpenPositions = getOpenPositions;
exports.getClosedPositions = getClosedPositions;
exports.logWithdrawalAttempt = logWithdrawalAttempt;
exports.updateWithdrawalAttempt = updateWithdrawalAttempt;
exports.logKeyExport = logKeyExport;
exports.getTokenSafetyCache = getTokenSafetyCache;
exports.saveTokenSafetyCache = saveTokenSafetyCache;
exports.saveBubbleMapCache = saveBubbleMapCache;
exports.getBubbleMapCache = getBubbleMapCache;
exports.saveHolderSnapshots = saveHolderSnapshots;
exports.saveWalletGraphEdge = saveWalletGraphEdge;
exports.upsertSlippageSetting = upsertSlippageSetting;
exports.getSlippageSetting = getSlippageSetting;
exports.getAllSlippageSettings = getAllSlippageSettings;
exports.deleteSlippageSetting = deleteSlippageSetting;
exports.getPriceCache = getPriceCache;
exports.setPriceCache = setPriceCache;
exports.upsertTokenMarketData = upsertTokenMarketData;
exports.getTokenMarketData = getTokenMarketData;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function initializeDatabase(databasePath) {
    const db = new better_sqlite3_1.default(databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const localSchemaPath = (0, node_path_1.join)(__dirname, 'schema.sql');
    const sourceSchemaPath = (0, node_path_1.join)(__dirname, '..', '..', 'src', 'db', 'schema.sql');
    const schemaPath = (0, node_fs_1.existsSync)(localSchemaPath) ? localSchemaPath : sourceSchemaPath;
    db.exec((0, node_fs_1.readFileSync)(schemaPath, 'utf8'));
    return db;
}
function getOne(db, sql, ...params) {
    return db.prepare(sql).get(...params);
}
function getAll(db, sql, ...params) {
    return db.prepare(sql).all(...params);
}
function execute(db, sql, ...params) {
    return db.prepare(sql).run(...params);
}
function upsertUser(db, userId, username = null) {
    execute(db, `
      INSERT INTO users (user_id, username)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = COALESCE(excluded.username, users.username)
    `, userId, username);
}
function addWatchedPool(db, userId, poolAddress) {
    upsertUser(db, userId);
    execute(db, 'INSERT OR IGNORE INTO watched_pools (user_id, pool_address) VALUES (?, ?)', userId, poolAddress);
}
function removeWatchedPool(db, userId, poolAddress) {
    execute(db, 'DELETE FROM watched_pools WHERE user_id = ? AND pool_address = ?', userId, poolAddress);
    execute(db, 'DELETE FROM armed_pools WHERE user_id = ? AND pool_address = ?', userId, poolAddress);
}
function addArmedPool(db, userId, poolAddress) {
    upsertUser(db, userId);
    execute(db, 'INSERT OR IGNORE INTO armed_pools (user_id, pool_address) VALUES (?, ?)', userId, poolAddress);
}
function removeArmedPool(db, userId, poolAddress) {
    execute(db, 'DELETE FROM armed_pools WHERE user_id = ? AND pool_address = ?', userId, poolAddress);
}
function isPoolArmed(db, userId, poolAddress) {
    const row = getOne(db, `
      SELECT 1 AS exists_value
      FROM armed_pools
      WHERE user_id = ? AND pool_address = ?
      LIMIT 1
    `, userId, poolAddress);
    return row !== undefined;
}
function listWatchedPools(db, userId) {
    if (userId === undefined) {
        return getAll(db, 'SELECT * FROM watched_pools ORDER BY added_at DESC, id DESC');
    }
    return getAll(db, 'SELECT * FROM watched_pools WHERE user_id = ? ORDER BY added_at DESC, id DESC', userId);
}
function listArmedPools(db, userId) {
    return getAll(db, 'SELECT * FROM armed_pools WHERE user_id = ? ORDER BY armed_at DESC, id DESC', userId);
}
function insertRiskEvent(db, userId, poolAddress, riskLevel, dropPercent) {
    upsertUser(db, userId);
    execute(db, `
      INSERT INTO risk_events (user_id, pool_address, risk_level, drop_percent)
      VALUES (?, ?, ?, ?)
    `, userId, poolAddress, riskLevel, dropPercent);
}
function upsertRiskSettings(db, userId, poolAddress, takeProfitPercent, stopLossPercent, entryPriceTon) {
    execute(db, `
      INSERT INTO risk_settings
        (user_id, pool_address, take_profit_percent, stop_loss_percent, entry_price_ton)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        pool_address = excluded.pool_address,
        take_profit_percent = excluded.take_profit_percent,
        stop_loss_percent = excluded.stop_loss_percent,
        entry_price_ton = COALESCE(excluded.entry_price_ton, risk_settings.entry_price_ton),
        updated_at = CURRENT_TIMESTAMP
    `, userId, poolAddress, takeProfitPercent, stopLossPercent, entryPriceTon ?? null);
}
function getRiskSettings(db, userId, poolAddress) {
    return getOne(db, 'SELECT * FROM risk_settings WHERE user_id = ? AND pool_address = ? LIMIT 1', userId, poolAddress);
}
function openPosition(db, userId, poolAddress, tokenAddress, entryPriceTon, amountTon, txHashOpen) {
    const result = execute(db, `
      INSERT INTO positions
        (user_id, pool_address, token_address, entry_price_ton, amount_ton, tx_hash_open)
      VALUES (?, ?, ?, ?, ?, ?)
    `, userId, poolAddress, tokenAddress, entryPriceTon, amountTon, txHashOpen ?? null);
    return Number(result.lastInsertRowid);
}
function closePosition(db, positionId, exitPriceTon, txHashClose) {
    const position = getOne(db, 'SELECT * FROM positions WHERE id = ? LIMIT 1', positionId);
    if (position === undefined)
        return;
    const pnlPercent = ((exitPriceTon - position.entry_price_ton) / position.entry_price_ton) * 100;
    const pnlTon = (pnlPercent / 100) * position.amount_ton;
    execute(db, `
      UPDATE positions SET
        status = 'closed',
        closed_at = CURRENT_TIMESTAMP,
        exit_price_ton = ?,
        pnl_percent = ?,
        pnl_ton = ?,
        tx_hash_close = COALESCE(?, tx_hash_close)
      WHERE id = ?
    `, exitPriceTon, pnlPercent, pnlTon, txHashClose ?? null, positionId);
}
function getOpenPositions(db, userId) {
    return getAll(db, `SELECT * FROM positions WHERE user_id = ? AND status = 'open' ORDER BY opened_at DESC`, userId);
}
function getClosedPositions(db, userId, limit = 10) {
    return getAll(db, `SELECT * FROM positions WHERE user_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?`, userId, limit);
}
function logWithdrawalAttempt(db, userId, withdrawalType, destinationAddress, amountTon, tokenAddress) {
    const result = execute(db, `
      INSERT INTO withdrawal_attempts
        (user_id, withdrawal_type, destination_address, amount_ton, token_address)
      VALUES (?, ?, ?, ?, ?)
    `, userId, withdrawalType, destinationAddress, amountTon ?? null, tokenAddress ?? null);
    return Number(result.lastInsertRowid);
}
function updateWithdrawalAttempt(db, attemptId, status, txHash, errorMessage) {
    execute(db, `
      UPDATE withdrawal_attempts SET
        status = ?,
        tx_hash = COALESCE(?, tx_hash),
        error_message = COALESCE(?, error_message)
      WHERE id = ?
    `, status, txHash ?? null, errorMessage ?? null, attemptId);
}
function logKeyExport(db, userId, exportType) {
    execute(db, 'INSERT INTO key_export_log (user_id, export_type) VALUES (?, ?)', userId, exportType);
}
function getTokenSafetyCache(db, tokenAddress, maxAgeMinutes = 60) {
    return getOne(db, `
      SELECT * FROM token_safety_cache
      WHERE token_address = ?
        AND datetime(scanned_at, '+' || ? || ' minutes') > datetime('now')
      LIMIT 1
    `, tokenAddress, maxAgeMinutes);
}
function saveTokenSafetyCache(db, row) {
    execute(db, `
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
    `, row.token_address, row.honeypot_result, row.honeypot_round_trip_loss_percent ?? null, row.contract_code_hash ?? null, row.contract_verified ? 1 : 0, row.buy_tax_percent ?? null, row.sell_tax_percent ?? null, row.liquidity_locked ? 1 : 0, row.lock_expiry ?? null, row.locker_address ?? null, row.largest_holder_percent ?? null, row.dev_wallet_address ?? null, row.dev_wallet_percent ?? null, row.overall_risk);
}
function saveBubbleMapCache(db, tokenAddress, clusterCount, suspiciousSupplyPercent, bubbleRisk, clusterData, walletsAnalyzed) {
    execute(db, `
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
    `, tokenAddress, clusterCount, suspiciousSupplyPercent, bubbleRisk, clusterData, walletsAnalyzed);
}
function getBubbleMapCache(db, tokenAddress, maxAgeMinutes = 60) {
    return getOne(db, `
      SELECT * FROM bubble_map_cache
      WHERE token_address = ?
        AND datetime(analyzed_at, '+' || ? || ' minutes') > datetime('now')
      LIMIT 1
    `, tokenAddress, maxAgeMinutes);
}
function saveHolderSnapshots(db, tokenAddress, holders) {
    execute(db, 'DELETE FROM holder_snapshots WHERE token_address = ?', tokenAddress);
    for (const holder of holders) {
        execute(db, `
        INSERT INTO holder_snapshots
          (token_address, wallet_address, balance_raw, percent_of_supply,
           wallet_label, is_dev_wallet, is_dex_wallet)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, tokenAddress, holder.wallet_address, holder.balance_raw, holder.percent_of_supply, holder.wallet_label ?? null, holder.is_dev_wallet ? 1 : 0, holder.is_dex_wallet ? 1 : 0);
    }
}
function saveWalletGraphEdge(db, tokenAddress, fromWallet, toWallet, connectionType, amountTon, blockTime) {
    execute(db, `
      INSERT INTO wallet_graph_edges
        (token_address, from_wallet, to_wallet, connection_type, amount_ton, block_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `, tokenAddress, fromWallet, toWallet, connectionType, amountTon ?? null, blockTime ?? null);
}
function upsertSlippageSetting(db, userId, slippageBps, settingType, tokenAddress = '') {
    execute(db, `
      INSERT INTO slippage_settings
        (user_id, token_address, slippage_bps, setting_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, token_address, setting_type) DO UPDATE SET
        slippage_bps = excluded.slippage_bps,
        updated_at = CURRENT_TIMESTAMP
    `, userId, tokenAddress, slippageBps, settingType);
}
function getSlippageSetting(db, userId, settingType, tokenAddress = '') {
    return getOne(db, `
      SELECT * FROM slippage_settings
      WHERE user_id = ?
        AND setting_type = ?
        AND token_address = ?
      LIMIT 1
    `, userId, settingType, tokenAddress);
}
function getAllSlippageSettings(db, userId) {
    return getAll(db, `
      SELECT * FROM slippage_settings
      WHERE user_id = ?
      ORDER BY setting_type ASC, token_address ASC
    `, userId);
}
function deleteSlippageSetting(db, userId, settingType, tokenAddress = '') {
    execute(db, `
      DELETE FROM slippage_settings
      WHERE user_id = ?
        AND setting_type = ?
        AND token_address = ?
    `, userId, settingType, tokenAddress);
}
function getPriceCache(db, cacheKey, maxAgeSeconds = 30) {
    return getOne(db, `
      SELECT * FROM price_cache
      WHERE cache_key = ?
        AND datetime(cached_at, '+' || ? || ' seconds') > datetime('now')
      LIMIT 1
    `, cacheKey, maxAgeSeconds);
}
function setPriceCache(db, cacheKey, valueJson) {
    execute(db, `
      INSERT INTO price_cache (cache_key, value_json)
      VALUES (?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        value_json = excluded.value_json,
        cached_at = CURRENT_TIMESTAMP
    `, cacheKey, valueJson);
}
function upsertTokenMarketData(db, row) {
    execute(db, `
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
    `, row.token_address, row.price_ton ?? null, row.price_usd ?? null, row.fdv_usd ?? null, row.ath_fdv_usd ?? null, row.lp_value_usd ?? null, row.buy_tax_percent ?? null, row.sell_tax_percent ?? null, row.renounced ? 1 : 0, row.mintable ? 1 : 0, row.total_supply ?? null);
}
function getTokenMarketData(db, tokenAddress) {
    return getOne(db, 'SELECT * FROM token_market_data WHERE token_address = ? LIMIT 1', tokenAddress);
}
