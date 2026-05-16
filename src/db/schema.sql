CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY,
  username TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(user_id),
  address TEXT NOT NULL,
  encrypted_mnemonic TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'testnet',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS budget_policies (
  user_id INTEGER PRIMARY KEY REFERENCES users(user_id),
  max_budget_ton REAL NOT NULL,
  current_spent_ton REAL NOT NULL DEFAULT 0,
  per_trade_limit_ton REAL NOT NULL DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS watched_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  pool_address TEXT NOT NULL,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS armed_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  pool_address TEXT NOT NULL,
  armed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT NOT NULL,
  depth_ton REAL NOT NULL,
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  pool_address TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  drop_percent REAL NOT NULL,
  triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS swap_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  amount_ton REAL NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  error_message TEXT,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS risk_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(user_id),
  pool_address TEXT NOT NULL,
  take_profit_percent REAL NOT NULL DEFAULT 10,
  stop_loss_percent REAL NOT NULL DEFAULT 5,
  entry_price_ton REAL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  entry_price_ton REAL NOT NULL,
  amount_ton REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME,
  exit_price_ton REAL,
  pnl_percent REAL,
  pnl_ton REAL,
  tx_hash_open TEXT,
  tx_hash_close TEXT
);

CREATE TABLE IF NOT EXISTS withdrawal_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(user_id),
  withdrawal_type TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  amount_ton REAL,
  token_address TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  error_message TEXT,
  attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS key_export_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  export_type TEXT NOT NULL,
  exported_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_safety_cache (
  token_address TEXT PRIMARY KEY,
  honeypot_result TEXT NOT NULL,
  honeypot_round_trip_loss_percent REAL,
  contract_code_hash TEXT,
  contract_verified INTEGER NOT NULL DEFAULT 0,
  buy_tax_percent REAL,
  sell_tax_percent REAL,
  liquidity_locked INTEGER NOT NULL DEFAULT 0,
  lock_expiry TEXT,
  locker_address TEXT,
  largest_holder_percent REAL,
  dev_wallet_address TEXT,
  dev_wallet_percent REAL,
  overall_risk TEXT NOT NULL,
  scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  balance_raw TEXT NOT NULL,
  percent_of_supply REAL NOT NULL,
  wallet_label TEXT,
  is_dev_wallet INTEGER NOT NULL DEFAULT 0,
  is_dex_wallet INTEGER NOT NULL DEFAULT 0,
  captured_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bubble_map_cache (
  token_address TEXT PRIMARY KEY,
  cluster_count INTEGER NOT NULL DEFAULT 0,
  suspicious_supply_percent REAL NOT NULL DEFAULT 0,
  bubble_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  cluster_data TEXT NOT NULL,
  wallets_analyzed INTEGER NOT NULL DEFAULT 0,
  analyzed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  from_wallet TEXT NOT NULL,
  to_wallet TEXT NOT NULL,
  connection_type TEXT NOT NULL,
  amount_ton REAL,
  block_time INTEGER,
  discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slippage_settings (
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  token_address TEXT NOT NULL DEFAULT '',
  slippage_bps INTEGER NOT NULL,
  setting_type TEXT NOT NULL CHECK(setting_type IN ('global', 'token', 'emergency')),
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, token_address, setting_type)
);

CREATE TABLE IF NOT EXISTS price_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  value_json TEXT NOT NULL,
  cached_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_market_data (
  token_address TEXT PRIMARY KEY,
  price_ton REAL,
  price_usd REAL,
  fdv_usd REAL,
  ath_fdv_usd REAL,
  lp_value_usd REAL,
  buy_tax_percent REAL,
  sell_tax_percent REAL,
  renounced INTEGER NOT NULL DEFAULT 0,
  mintable INTEGER NOT NULL DEFAULT 1,
  total_supply TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_pools_unique
  ON watched_pools(user_id, pool_address);

CREATE UNIQUE INDEX IF NOT EXISTS idx_armed_pools_unique
  ON armed_pools(user_id, pool_address);

CREATE INDEX IF NOT EXISTS idx_pool_snapshots_pool_time
  ON pool_snapshots(pool_address, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_swap_attempts_user_time
  ON swap_attempts(user_id, attempted_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_holder_snapshots_token
  ON holder_snapshots(token_address, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_graph_token
  ON wallet_graph_edges(token_address, connection_type);

CREATE INDEX IF NOT EXISTS idx_token_safety_scanned
  ON token_safety_cache(scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_slippage_settings_user
  ON slippage_settings(user_id, setting_type);

CREATE INDEX IF NOT EXISTS idx_price_cache_key
  ON price_cache(cache_key, cached_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_market_updated
  ON token_market_data(updated_at DESC);
