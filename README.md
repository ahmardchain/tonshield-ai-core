# TonShield AI Core

TonShield AI is an experimental non-custodial agentic risk mitigation bot for the TON blockchain. It was built as a grant submission deliverable for the STON.fi Grant Program and demonstrates how an off-chain monitoring agent can watch STON.fi liquidity pools, score risk, alert a Telegram user, and optionally execute defensive testnet swaps through a dedicated agent wallet.

This is an MVP. It defaults to testnet and paper trading. Mainnet execution is blocked unless both `NETWORK=mainnet` and `ENABLE_MAINNET_EXECUTION=true` are explicitly set, and even then this repository should not be treated as mainnet-safe until the roadmap items are completed.

## Security Model

TonShield AI never requests, accepts, or stores a user's primary wallet seed phrase or private key. The bot creates a separate agent wallet for the user. That wallet is intended to hold only small, isolated funds for experimental defensive execution.

The generated agent wallet mnemonic is encrypted before it is written to SQLite:

- Encryption: AES-256-GCM
- Key source: `AGENT_WALLET_ENCRYPTION_KEY`
- Required key format: 32 bytes encoded as 64 hex characters
- Stored payload: base64 IV, base64 auth tag, and base64 ciphertext

The mnemonic is printed once to the server console for operator backup during MVP testing. It is never sent to Telegram chat and is never returned by the wallet loading path.

## Setup

```bash
git clone <your-repo-url>
cd tonshield-ai-core
npm install
cp .env.example .env
```

Generate a local encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value into `AGENT_WALLET_ENCRYPTION_KEY` in `.env`, then fill in:

- `TELEGRAM_BOT_TOKEN`
- `TONCENTER_API_KEY`
- `TONCENTER_ENDPOINT`

Run locally:

```bash
npm run dev
```

Production-style build:

```bash
npm run build
npm start
```

Quality checks:

```bash
npm run lint
npm test
npm run test:coverage
```

## Command Reference

| Command | Purpose |
| --- | --- |
| `/start` | Show project summary, current network, and available commands. |
| `/create_agent_wallet` | Create an encrypted agent wallet and return only its address. |
| `/budget <max_ton> [per_trade_ton]` | Set the user's maximum TON budget and per-trade cap. |
| `/scan <pool_address>` | Fetch pool data, record a snapshot, and return a risk report. |
| `/watch <pool_address>` | Add a pool to the monitor loop. |
| `/unwatch <pool_address>` | Remove a pool from watched and armed lists. |
| `/watchlist` | List watched pools, armed status, and last available risk score. |
| `/simulate <pool_address> [amount_ton]` | Run a paper defensive swap quote and log it. |
| `/arm <pool_address>` | Arm a watched pool after wallet and budget checks. |
| `/disarm <pool_address>` | Remove a pool from armed status. |
| `/agent_status` | Show wallet, network, budget, spend, armed pools, and mode. |
| `/emergency_sell <pool_address> [amount_ton]` | Request an inline confirmation before executing a defensive swap. |

## Testnet Wallet Funding

1. Start the bot with `NETWORK=testnet` and `PAPER_TRADE=true`.
2. Send `/create_agent_wallet` in Telegram.
3. Copy the returned testnet address.
4. Fund that address using a TON testnet faucet.
5. Set a small budget, for example:

```text
/budget 2 0.25
```

Only fund the agent wallet with small testnet amounts. Never fund it with assets you cannot afford to lose.

## Emergency Testnet Sell Flow

For paper observation:

```text
/watch <pool_address>
/scan <pool_address>
/simulate <pool_address> 0.25
```

For live testnet execution:

1. Set `NETWORK=testnet`.
2. Set `PAPER_TRADE=false`.
3. Fund the agent wallet with testnet TON.
4. Configure budget:

```text
/budget 2 0.25
```

5. Arm the pool:

```text
/arm <pool_address>
```

6. Trigger a manual sell with confirmation:

```text
/emergency_sell <pool_address> 0.25
```

The bot logs the swap attempt before budget validation or signing. If the budget would be exceeded, the transaction is rejected before signing.

## Honest Mainnet Limitations

- No audited smart contract budget wallet is included yet.
- The current agent wallet is a standard Wallet V4 controlled by an encrypted mnemonic.
- Testnet STON.fi execution uses documented hardcoded testnet router constants because the public STON.fi API is mainnet-first.
- Mainnet execution is doubly guarded but should remain disabled until independent security review.
- Swap output protection currently depends on STON.fi SDK/API simulation and MVP defaults; production needs stronger asset-decimal handling and route verification.
- Telegram command confirmation is not a substitute for audited wallet execution rights.
- SQLite is suitable for MVP testing, but production deployments need hardened backup, access control, and key management.

## Roadmap

- Phase 1: TON Agentic Wallet Standard integration
- Phase 2: MCP-based wallet execution layer
- Phase 3: Audited smart contract budget wallet
- Phase 4: Mainnet beta after independent security audit

## References

- STON.fi SDK documentation: https://docs.ston.fi/developer-section/dex/sdk
- STON.fi REST API reference: https://docs.ston.fi/developer-section/dex/api/reference
- STON.fi v2 swap guidance: https://docs.ston.fi/developer-section/dex/sdk/v2/swap
