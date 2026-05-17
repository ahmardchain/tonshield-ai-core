# TonShield AI Core

TonShield AI is an experimental non-custodial agentic risk mitigation bot for the TON blockchain, built for the STON.fi Grant Program. It combines Telegram control, an encrypted agent wallet, STON.fi swap execution, risk monitoring, token safety intelligence, wallet distribution analysis, paper trading, and testnet-only automated exits.

This repository is an MVP intended for testnet validation, reviewer inspection, and future audit preparation. Mainnet execution is disabled by default and intentionally guarded.

## Current Status

- Default network: testnet
- Runtime: Node.js 20+ and TypeScript strict mode
- Telegram framework: Telegraf v4
- TON SDK: @ton/ton and @ton/crypto
- STON.fi integrations: @ston-fi/sdk and @ston-fi/api
- Database: better-sqlite3
- Tests: Vitest
- Coverage: 10 test files, 125 tests, 90.35% overall coverage from the latest local run

## What TonShield Does

TonShield is designed around a separate agent wallet. The user never gives TonShield their primary wallet seed phrase or private key. The agent wallet can be funded with a limited testnet budget, monitored by the bot, and used for controlled testnet swaps.

Implemented capabilities include:

- Agent wallet creation with AES-256-GCM encrypted mnemonic storage
- Budget policies with per-trade and total spend caps
- Mainnet double guard for all live execution paths
- Buy-side TON to Jetton swaps with automatic position opening
- Defensive Jetton to TON exits for emergency sell flows
- Paper trading and quote previews
- Live position and closed-history P&L cards
- TONscan transaction links for execution verification
- Token safety scanner with honeypot, tax, contract, liquidity, and concentration checks
- Holder distribution analysis
- Bubble map wallet connection analysis
- User-controlled slippage settings with global, token-specific, emergency, and inline overrides
- Take-profit and stop-loss risk settings
- Watched pool monitoring with alert cooldowns
- TON and Jetton withdrawals from the agent wallet
- Secure public address export and high-risk seed phrase export flow

Limit orders and trailing stops are planned roadmap items. They are not advertised as implemented in this README because the current codebase does not contain the order service or command handlers yet.

## Architecture

```text
src/
  bot/
    index.ts          Telegram bot initialization
    commands.ts       Command handlers and callback flows
    keyboards.ts      Inline keyboard builders
  config/
    env.ts            Strict environment validation
  db/
    sqlite.ts         Database initialization and typed query helpers
    schema.sql        SQLite schema
  risk/
    velocityGuard.ts  Rolling liquidity-depth breach detection
    riskScore.ts      LOW/MEDIUM/HIGH/CRITICAL scoring
    triggerEngine.ts  Armed pool breach orchestration
  safety/
    tokenScanner.ts   Honeypot, contract, liquidity, concentration scan
    holderAnalyzer.ts Holder distribution and dev wallet analysis
    bubbleMap.ts      Wallet connection graph analysis
    safetyCache.ts    TTL cache and risk utilities
    priceService.ts   TON/USD, FDV, LP value, tax and renounce checks
  ston/
    stonClient.ts     STON.fi API client and token price helpers
    swapBuilder.ts    Buy, sell, simulation, TONscan link helpers
    routerResolver.ts Router resolution
    slippageService.ts User-controlled slippage resolution
  wallet/
    agentWallet.ts    Agent wallet creation, encryption, signing access
    walletStore.ts    Agent wallet persistence helpers
    budgetPolicy.ts   Spend limits and reservation logic
    withdrawalEngine.ts TON and Jetton withdrawals
  workers/
    monitorWorker.ts  Watched pool polling and automated checks
tests/
  budgetPolicy.test.ts
  buySwap.test.ts
  networkGuard.test.ts
  priceService.test.ts
  riskScore.test.ts
  safetyScanner.test.ts
  slippageService.test.ts
  triggerEngine.test.ts
  velocityGuard.test.ts
  withdrawal.test.ts
```

## Security Model

TonShield never requests, accepts, or stores a user's primary wallet seed phrase or private key.

Instead, TonShield creates a separate agent wallet. That wallet is intended to hold only limited funds that the user explicitly transfers to it. The agent wallet mnemonic is encrypted before it is written to SQLite.

The encryption model is:

- Algorithm: AES-256-GCM
- Key source: AGENT_WALLET_ENCRYPTION_KEY
- Required key format: 32-byte hex string
- Stored value: encrypted mnemonic payload, not plaintext mnemonic
- Decryption scope: only when signing an agent-wallet transaction or exporting keys

Important security reality: because the encryption key lives on the server, the user is trusting the server operator's security. This is safer than asking for a primary wallet seed, but it is not equivalent to audited smart-contract custody or hardware-wallet signing.

## Mainnet Guard

All live transaction paths are blocked unless both conditions are explicitly true:

```text
NETWORK=mainnet
ENABLE_MAINNET_EXECUTION=true
```

The default is testnet. Mainnet execution remains unsuitable for production use until an independent security audit, stronger wallet delegation standards, and a hardened key management layer are complete.

## Setup

```bash
git clone https://github.com/ahmardchain/tonshield-ai-core.git
cd tonshield-ai-core
npm install
cp .env.example .env
```

Edit `.env` and configure at minimum:

```text
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TONCENTER_API_KEY=your_toncenter_api_key_here
TONCENTER_ENDPOINT=https://testnet.toncenter.com/api/v2/jsonRPC
NETWORK=testnet
ENABLE_MAINNET_EXECUTION=false
AGENT_WALLET_ENCRYPTION_KEY=replace_with_64_hex_characters
DATABASE_PATH=./tonshield.db
MONITOR_INTERVAL_SECONDS=30
RISK_DROP_THRESHOLD_PERCENT=25
DEFAULT_SLIPPAGE_BPS=500
PAPER_TRADE=true
```

Generate a local encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run the bot:

```bash
npm run dev
```

Build and verify:

```bash
npm run build
npm run lint
npm test
npm run test:coverage
```

## Command Reference

### Getting Started

| Command | Purpose |
| --- | --- |
| /start | Show overview, network mode, and available commands |
| /create_agent_wallet | Create or show the user's encrypted agent wallet address |
| /agent_status | Show wallet, budget, armed pools, and monitoring status |
| /export_address | Show the public agent wallet address and TONscan address link |
| /export_keys | High-risk seed phrase export flow with typed confirmation and deletion timer |

### Budget And Risk Controls

| Command | Purpose |
| --- | --- |
| /budget <max_ton> [per_trade_ton] | Set total and per-trade budget limits |
| /settings <pool> <take_profit_percent> <stop_loss_percent> | Save take-profit and stop-loss settings for a pool |
| /arm <pool> | Arm a watched pool for automated testnet defense |
| /disarm <pool> | Disable automated defense for a pool |

### Pool Monitoring

| Command | Purpose |
| --- | --- |
| /scan <pool> | Scan pool liquidity and velocity risk |
| /watch <pool> | Add a pool to monitoring |
| /unwatch <pool> | Remove a pool from monitoring and armed state |
| /watchlist | Show watched pools, armed status, and last known risk |
| /simulate <pool> | Run a paper defensive swap simulation |
| /emergency_sell <pool> | Confirm and execute a defensive exit from the agent wallet |

### Trading

| Command | Purpose |
| --- | --- |
| /preview_buy <pool> <token> <amount_ton> | Preview a TON to Jetton buy without sending a transaction |
| /buy <pool> <token> <amount_ton> | Confirm and execute or simulate a buy, then open a position |
| /buy <pool> <token> <amount_ton> --slippage <percent> | Execute a buy with one-time slippage override |
| /positions | Show live open positions with current P&L |
| /history | Show recently closed positions and TONscan links |

### Slippage Management

| Command | Purpose |
| --- | --- |
| /slippage | Show current slippage settings |
| /slippage <percent> | Set global default slippage |
| /slippage <token> <percent> | Set token-specific slippage |
| /slippage reset | Reset global slippage to system default |
| /slippage reset <token> | Remove token-specific slippage |
| /emergency_slippage <percent> | Set emergency auto-exit slippage |
| /slippage_info | Explain slippage priority and recommended ranges |

### Token Intelligence

| Command | Purpose |
| --- | --- |
| /scan_token <token> <pool> | Run token safety scan and display professional scan card |
| /holders <token> | Analyze supply distribution and top holders |
| /bubbles <token> <pool> | Run quick and deep wallet connection analysis |

### Withdrawals

| Command | Purpose |
| --- | --- |
| /withdraw_ton <destination> <amount_ton> | Withdraw TON from the agent wallet with confirmation |
| /withdraw_all <destination> | Withdraw all available TON minus gas reserve |
| /withdraw_token <token> <destination> | Withdraw all held Jettons of a token |

## Token Scan Card Example

```text
Token Scan - EQToken...abcd
-------------------------
TAX   Buy: 10.0% | Sell: 10.0%

Price: 0.000282 TON ($0.00054)
FDV:   $40.46K
LP:    $21.87K
LP Lock:   PASS
Renounced: PASS
ATH FDV:   $670.84K

Honeypot:      PASS
Contract:      UNVERIFIED
Concentration: Dev holds 34.0% of supply

Overall Risk: HIGH
Recommendation: Proceed with extreme caution.
-------------------------
```

## Testnet Agent Wallet Flow

1. Start the bot with `/start`.
2. Create an agent wallet with `/create_agent_wallet`.
3. Copy the public agent wallet address.
4. Fund it from a TON testnet faucet.
5. Set a budget with `/budget 5 1`.
6. Preview a buy with `/preview_buy <pool> <token> 1`.
7. Execute a testnet buy with `/buy <pool> <token> 1`.
8. Watch the position with `/positions`.
9. Configure protection with `/settings <pool> 10 5` and `/arm <pool>`.
10. Trigger a manual exit with `/emergency_sell <pool>` or let monitoring react to risk conditions.

## Withdrawal And Key Export

TonShield supports withdrawal commands so users can recover funds from the agent wallet.

TON withdrawals reserve 0.15 TON for gas by default. Jetton withdrawals transfer all detected holdings for the requested token. Every withdrawal attempt is logged before execution.

Seed phrase export is intentionally high friction. The bot requires an exact typed confirmation phrase, logs the export event, sends the seed phrase, schedules message deletion, and warns the user that Telegram message history is sensitive. This is the riskiest operation in the system and should only be used when the user needs to migrate or recover the agent wallet.

## Testing Status

Latest local verification before this README update:

```text
npm run build          PASS
npm run lint           PASS
npm test               PASS - 10 test files, 125 tests
npm run test:coverage  PASS - 90.35% overall coverage
```

Coverage focuses on core modules: budget policy, velocity guard, risk score, trigger engine, network guard, buy swaps, withdrawals, slippage service, safety scanner, and price service.

## Honest Limitations

This MVP is not safe for unaudited mainnet operation.

Known limitations:

- Agent wallet keys are encrypted at rest, but the server can decrypt them for signing.
- Telegram is not a secure channel for seed phrase delivery.
- STON.fi transaction construction requires continued integration hardening.
- Some token intelligence checks depend on third-party or indexer data availability.
- Honeypot and tax checks are quote-based heuristics, not formal proofs.
- Bubble map clustering is probabilistic and may produce false positives or false negatives.
- Mainnet execution should remain disabled until independent audit approval.

## Roadmap

- Phase 1: Integrate TON Agentic Wallet Standard when available
- Phase 2: Add MCP-based wallet execution layer
- Phase 3: Replace server-decrypted agent wallet with audited smart-contract budget wallet
- Phase 4: Add limit orders and trailing stops as first-class order services
- Phase 5: Independent security audit
- Phase 6: Mainnet beta only after audit and controlled rollout

## Grant Context

TonShield AI is submitted as an experimental STON.fi ecosystem project exploring agentic risk mitigation for TON traders. The goal is to demonstrate how automated monitoring, safety intelligence, user-defined execution limits, and transparent testnet transactions can reduce risk without ever requesting a user's primary wallet keys.
