# TonShield AI Core 🛡️

TonShield AI is the first non-custodial, autonomous risk-mitigation Telegram trading engine built natively for the TON blockchain ecosystem. It empowers retail meme coin traders with machine-speed safety guards, running high-velocity defensive swaps directly through STON.fi liquidity pools during sudden token rugs or sharp liquidity collapses.

## 🛠️ The Technical Problem & Integration Solution

Standard "anti-rug" front-running setups fail on TON because of its asynchronous, dynamic sharding architecture. To combat this limitation, TonShield AI implements an asynchronous shardchain velocity monitor that continuously checks pool tracking logs. 

When a malicious token creator triggers a systemic dump or dynamic fee manipulation, TonShield AI uses a decoupled, budget-capped client wallet schema to bypass human latency—atomically routing a sell transaction via the `@ston-fi/sdk` back into secure stablecoins (USDT/TON) in the immediate subsequent block.

## 🏗️ Repository Architecture

```text
tonshield-ai-core/
├── src/
│   ├── api/
│   │   └── ston_client.ts     # Integrates @ston-fi/api to fetch real-time AMM quotes
│   ├── core/
│   │   ├── velocity_guard.py  # Asynchronous block-by-block pool depth tracker
│   │   └── trade_engine.ts    # STON.fi SDK router payload constructor & signer
│   └── bot/
│       └── tma_interface.py   # Telegram Mini App non-custodial interface handlers
├── config/
│   └── network.config.json    # TON Mainnet/Testnet RPC node endpoints
└── tests/
    └── simulation_rug.ts      # Automated mock test scripts for tracking pool drains
```

## ⚙️ Core Technical Implementation Flow


