"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatSafetyReport = formatSafetyReport;
exports.registerCommands = registerCommands;
const node_crypto_1 = require("node:crypto");
const core_1 = require("@ton/core");
const crypto_1 = require("@ton/crypto");
const telegraf_1 = require("telegraf");
const sqlite_1 = require("../db/sqlite");
const riskScore_1 = require("../risk/riskScore");
const priceService_1 = require("../safety/priceService");
const safetyCache_1 = require("../safety/safetyCache");
const tokenScanner_1 = require("../safety/tokenScanner");
const slippageService_1 = require("../ston/slippageService");
const swapBuilder_1 = require("../ston/swapBuilder");
const agentWallet_1 = require("../wallet/agentWallet");
const walletStore_1 = require("../wallet/walletStore");
const pendingEmergencySells = new Map();
const pendingSellNow = new Map();
const pendingBuys = new Map();
const pendingKeyExports = new Map();
const EMERGENCY_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const KEY_EXPORT_TTL_MS = 60 * 1000;
const WITHDRAWAL_GAS_RESERVE_TON = 0.15;
function messageText(ctx) {
    const message = ctx.message;
    return message !== undefined && 'text' in message && typeof message.text === 'string'
        ? message.text
        : '';
}
function commandArgs(ctx) {
    return messageText(ctx).trim().split(/\s+/).slice(1);
}
function parsePositiveAmount(value, fallback) {
    if (value === undefined && fallback !== undefined) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('Amount must be a positive number.');
    }
    return parsed;
}
async function ensureTelegramUser(ctx, db) {
    const from = ctx.from;
    if (from === undefined) {
        await ctx.reply('Unable to identify your Telegram user.');
        return null;
    }
    (0, sqlite_1.upsertUser)(db, from.id, from.username ?? null);
    return from.id;
}
function formatNetwork(config) {
    return config.network === 'mainnet'
        ? `mainnet (execution ${config.enableMainnetExecution ? 'enabled' : 'disabled'})`
        : 'testnet';
}
function firstTokenAddress(tokenAddresses) {
    return tokenAddresses[0] ?? 'unknown';
}
function parsePercent(value, label, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
        throw new Error(`${label} must be greater than 0 and less than or equal to ${max}.`);
    }
    return parsed;
}
function formatSigned(value) {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}
function pnlIndicator(value) {
    if (value > 0) {
        return '🟢';
    }
    if (value < 0) {
        return '🔴';
    }
    return '⚪';
}
function formatExecutionResult(amountTon, status, txHash, config) {
    if (status === 'success' && txHash !== undefined) {
        return [
            '✅ Emergency swap executed.',
            `Amount: ${amountTon} TON`,
            'Status: success',
            `🔗 Verify on TONscan: ${(0, swapBuilder_1.buildTonscanLink)(txHash, config.network)}`,
        ].join('\n');
    }
    if (status === 'success') {
        return '⏳ Transaction submitted. Hash will be available shortly.';
    }
    return `Emergency swap did not execute.\nStatus: ${status}`;
}
function buildTonscanAddressLink(address, network) {
    const base = network === 'testnet' ? 'https://testnet.tonscan.org/address' : 'https://tonscan.org/address';
    return `${base}/${address}`;
}
function assertNonEmpty(value, usage) {
    if (value === undefined || value.trim().length === 0) {
        throw new Error(usage);
    }
    return value;
}
function parseTonAddress(address, label) {
    try {
        core_1.Address.parse(address);
    }
    catch {
        throw new Error(`${label} must be a valid TON address.`);
    }
}
async function deriveAgentPublicKey(encryptedMnemonic, config) {
    const mnemonic = agentWallet_1.agentWalletCrypto.decryptMnemonic(encryptedMnemonic, config.agentWalletEncryptionKey);
    const keyPair = await (0, crypto_1.mnemonicToPrivateKey)(mnemonic.split(' '));
    return Buffer.from(keyPair.publicKey).toString('hex');
}
function formatMnemonicForExport(mnemonic) {
    const words = mnemonic.split(' ');
    const lines = [];
    for (let index = 0; index < words.length; index += 6) {
        lines.push(words.slice(index, index + 6).join(' '));
    }
    return lines.join('\n');
}
function shortAddress(address) {
    return `${address.slice(0, 8)}...${address.slice(-4)}`;
}
function formatSafetyReport(report, poolAddress = '') {
    if (poolAddress !== '__legacy_text__') {
        return (0, tokenScanner_1.formatScanCard)(report, poolAddress);
    }
    const honeypotIcon = report.honeypot.result === 'PASS'
        ? '✅'
        : report.honeypot.result === 'FAIL'
            ? '🔴'
            : '⚠️';
    const contractIcon = report.contract.verified ? '✅' : '⚠️';
    const liquidityIcon = report.liquidityLock.locked ? '✅' : '⚠️';
    const concentrationIcon = report.concentration.devWalletPercent > 20
        ? '🔴'
        : report.concentration.devWalletPercent > 10
            ? '⚠️'
            : '✅';
    const lines = [
        `🔍 Token Safety Scan — ${shortAddress(report.tokenAddress)}`,
        '',
        `Honeypot Risk:        ${honeypotIcon} ${report.honeypot.result} — Round-trip loss: ${(0, safetyCache_1.formatPercent)(report.honeypot.roundTripLossPercent)}`,
        `Contract Code:        ${contractIcon} ${report.contract.verified ? 'VERIFIED' : 'UNVERIFIED'} — ${report.contract.message}`,
        `Liquidity Lock:       ${liquidityIcon} ${report.liquidityLock.locked ? 'PASS' : 'WARN'} — ${report.liquidityLock.message}`,
        `Supply Concentration: ${concentrationIcon} ${report.concentration.devWalletPercent > 20 ? 'FAIL' : 'PASS'} — Dev holds ${(0, safetyCache_1.formatPercent)(report.concentration.devWalletPercent)}`,
        '',
        `Overall Risk: ${(0, safetyCache_1.riskEmoji)(report.overallRisk)} ${report.overallRisk}`,
        `Recommendation: ${report.recommendation}`,
        '',
        '⏱️ Cached for 60 minutes. Use /scan_token force to refresh.',
    ];
    if (report.overallRisk === 'CRITICAL') {
        lines.push('', '🚨 CRITICAL RISK DETECTED', 'This token has been flagged as extremely dangerous.', 'Buying is strongly discouraged.');
    }
    return lines.join('\n');
}
function formatCondensedSafetySummary(report) {
    const market = report.marketData;
    const taxLine = market !== null
        ? (0, priceService_1.formatTaxBadge)(market.buyTaxPercent, market.sellTaxPercent).replace(/^[^\s]+ /, '')
        : 'TAX   Buy: N/A | Sell: N/A';
    const priceLine = `💲 Price: ${market !== null ? `${(0, priceService_1.formatSmallPrice)(market.priceTon)} TON` : 'N/A'}`;
    const lpLock = report.liquidityLock.locked ? '✅' : '❌';
    const renounced = market !== null && market.renounced ? '✅' : '❌';
    const riskEmojis = {
        LOW: '🟢',
        MEDIUM: '🟡',
        HIGH: '🔴',
        CRITICAL: '🚨',
        UNKNOWN: '⚪',
    };
    return [
        taxLine,
        priceLine,
        `🔒 LP Lock: ${lpLock}  🔑 Renounced: ${renounced}`,
        `Overall Risk: ${riskEmojis[report.overallRisk] ?? '⚪'} ${report.overallRisk}`,
    ].join('\n');
}
function formatSlippageWarning(sandwichWarning) {
    return sandwichWarning
        ? '\n⚠️ High slippage — sandwich attack risk. Consider using a lower value.'
        : '';
}
function slippageUsage() {
    return [
        'Usage examples:',
        '/slippage',
        '/slippage 5',
        '/slippage <token_address> 15',
        '/slippage reset',
        '/slippage reset <token_address>',
    ].join('\n');
}
async function calculateWithdrawableTon(services, agentAddress) {
    const balance = await services.tonClient.getBalance(core_1.Address.parse(agentAddress));
    const balanceTon = Number(balance) / 1e9;
    return Math.max(0, balanceTon - WITHDRAWAL_GAS_RESERVE_TON);
}
function quoteAskAmount(quote) {
    const view = quote;
    return view.askAmount ?? view.estimatedOutput ?? '0';
}
function quoteMinAskAmount(quote) {
    const view = quote;
    return view.minAskAmount ?? view.minimumReceived ?? '0';
}
function quoteEntryPrice(amountTon, quote) {
    const view = quote;
    const tokenOut = Number(view.askAmount ?? view.estimatedOutput ?? view.offerAmount ?? '0');
    return tokenOut > 0 ? amountTon / tokenOut : 0;
}
async function safeReply(ctx, message) {
    await ctx.reply(message);
}
function registerCommands(bot, services) {
    bot.start(async (ctx) => {
        await ensureTelegramUser(ctx, services.db);
        await safeReply(ctx, [
            'Welcome to TonShield AI.',
            '',
            'This experimental MVP creates a separate non-custodial agent wallet for defensive testnet execution. It never asks for your primary wallet seed phrase or private key.',
            '',
            `Current network: ${formatNetwork(services.config)}`,
            `Mode: ${services.config.paperTrade ? 'paper trading' : 'live testnet execution'}`,
            '',
            'Commands:',
            '/create_agent_wallet',
            '/budget <max_ton> [per_trade_ton]',
            '/scan <pool_address>',
            '/watch <pool_address>',
            '/unwatch <pool_address>',
            '/watchlist',
            '/settings <pool_address> <take_profit_percent> <stop_loss_percent>',
            '/positions',
            '/history',
            '/simulate <pool_address> [amount_ton]',
            '/preview_buy <pool_address> <token_address> <amount_ton>',
            '/buy <pool_address> <token_address> <amount_ton>',
            '/arm <pool_address>',
            '/disarm <pool_address>',
            '/agent_status',
            '/emergency_sell <pool_address> [amount_ton]',
            '',
            'Trading Settings:',
            '/slippage',
            '/emergency_slippage <percent>',
            '/slippage_info',
            '',
            'Token Intelligence:',
            '/scan_token <token_address> <pool_address>',
            '/holders <token_address>',
            '/bubbles <token_address> <pool_address>',
            '',
            'Wallet Management:',
            '/withdraw_ton <destination_address> <amount_ton>',
            '/withdraw_all <destination_address>',
            '/withdraw_token <token_address> <destination_address>',
            '/export_address',
            '/export_keys',
        ].join('\n'));
    });
    bot.command('create_agent_wallet', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const existing = (0, walletStore_1.getAgentWallet)(services.db, userId);
        if (existing !== undefined) {
            await safeReply(ctx, `Agent wallet already exists:\n${existing.address}`);
            return;
        }
        const address = await services.agentWallet.generateAgentWallet(userId);
        await safeReply(ctx, [
            'Agent wallet created.',
            `Address: ${address}`,
            '',
            'Experimental warning: fund this wallet only with small TON testnet amounts. The mnemonic is encrypted in SQLite and printed once to the server console for operator backup. It is never sent in Telegram.',
            '',
            'Fund it with the TON testnet faucet before arming any pool.',
        ].join('\n'));
    });
    bot.command('budget', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const [maxBudget, perTrade] = commandArgs(ctx);
            const maxBudgetTon = parsePositiveAmount(maxBudget);
            const perTradeLimitTon = parsePositiveAmount(perTrade, Math.min(maxBudgetTon, 1));
            const policy = services.budgetPolicy.setBudget(userId, maxBudgetTon, perTradeLimitTon);
            await safeReply(ctx, [
                'Budget policy saved.',
                `Max budget: ${policy.maxBudgetTon} TON`,
                `Per-trade limit: ${policy.perTradeLimitTon} TON`,
                `Current spent: ${policy.currentSpentTon} TON`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Budget rejected: ${error instanceof Error ? error.message : 'Invalid input.'}`);
        }
    });
    bot.command('scan', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /scan <pool_address>');
            return;
        }
        try {
            const pool = await services.stonClient.getPoolData(poolAddress);
            services.velocityGuard.recordSnapshot(poolAddress, pool.depthTon);
            const velocity = services.velocityGuard.calculateVelocityDrop(poolAddress);
            const risk = velocity === null ? null : (0, riskScore_1.scorePool)(velocity);
            await safeReply(ctx, [
                `Pool: ${poolAddress}`,
                `Current depth: ${pool.depthTon.toFixed(4)} TON`,
                `Tokens: ${pool.tokenAddresses.length === 0 ? 'unknown' : pool.tokenAddresses.join(', ')}`,
                `Fee tier: ${pool.feeTier ?? 'unknown'}`,
                velocity === null
                    ? 'Risk: insufficient snapshot history. Scan or monitor at least 3 samples.'
                    : `Risk: ${risk?.level} (${velocity.rollingDropPercent.toFixed(2)}% rolling drop, ${risk?.confidence} confidence)`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Scan failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
        }
    });
    bot.command('scan_token', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const [token, pool, maybeForce] = commandArgs(ctx);
            const tokenAddress = assertNonEmpty(token, 'Usage: /scan_token <token_address> <pool_address> [force]');
            const poolAddress = assertNonEmpty(pool, 'Usage: /scan_token <token_address> <pool_address> [force]');
            const forceRefresh = maybeForce === 'force';
            await safeReply(ctx, `🔍 Running token safety scan for ${shortAddress(tokenAddress)}...`);
            const report = await services.tokenScanner.scanToken(tokenAddress, poolAddress, forceRefresh);
            await safeReply(ctx, (0, tokenScanner_1.formatScanCard)(report, poolAddress));
        }
        catch (error) {
            await safeReply(ctx, `Token scan failed: ${error instanceof Error ? error.message : 'Unknown token scan error.'}`);
        }
    });
    bot.command('holders', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const [token] = commandArgs(ctx);
            const tokenAddress = assertNonEmpty(token, 'Usage: /holders <token_address>');
            await safeReply(ctx, `📊 Analyzing holders for ${shortAddress(tokenAddress)}...`);
            const report = await services.holderAnalyzer.analyzeHolders(tokenAddress);
            await safeReply(ctx, report.formattedReport);
        }
        catch (error) {
            await safeReply(ctx, `Holder analysis failed: ${error instanceof Error ? error.message : 'Unknown holder analysis error.'}`);
        }
    });
    bot.command('bubbles', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const [token, pool] = commandArgs(ctx);
            const tokenAddress = assertNonEmpty(token, 'Usage: /bubbles <token_address> <pool_address>');
            const poolAddress = assertNonEmpty(pool, 'Usage: /bubbles <token_address> <pool_address>');
            await safeReply(ctx, `🫧 Building wallet connection map for ${shortAddress(tokenAddress)} via ${shortAddress(poolAddress)}...`);
            const holderAnalysis = await services.holderAnalyzer.analyzeHolders(tokenAddress);
            const holders = holderAnalysis.holders.map((holder) => ({
                address: holder.address,
                percentOfSupply: holder.percentOfSupply,
            }));
            const tokenDeployTimestamp = Math.floor(Date.now() / 1000);
            const quickReport = await services.bubbleMapAnalyzer.runQuickScan(tokenAddress, holders, tokenDeployTimestamp);
            await safeReply(ctx, quickReport.formattedReport);
            await safeReply(ctx, '🔬 Deep wallet connection scan is running...');
            const deepReport = await services.bubbleMapAnalyzer.runDeepScan(tokenAddress, holders, tokenDeployTimestamp, (message) => {
                void ctx.reply(message);
            });
            await safeReply(ctx, deepReport.formattedReport);
        }
        catch (error) {
            await safeReply(ctx, `Bubble map analysis failed: ${error instanceof Error ? error.message : 'Unknown bubble map error.'}`);
        }
    });
    bot.command('watch', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /watch <pool_address>');
            return;
        }
        (0, sqlite_1.addWatchedPool)(services.db, userId, poolAddress);
        const count = (0, sqlite_1.listWatchedPools)(services.db, userId).length;
        await safeReply(ctx, `Monitoring started for ${poolAddress}.\nWatchlist count: ${count}`);
    });
    bot.command('unwatch', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /unwatch <pool_address>');
            return;
        }
        (0, sqlite_1.removeWatchedPool)(services.db, userId, poolAddress);
        await safeReply(ctx, `Stopped monitoring and disarmed ${poolAddress}.`);
    });
    bot.command('watchlist', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const watched = (0, sqlite_1.listWatchedPools)(services.db, userId);
        const armed = new Set((0, sqlite_1.listArmedPools)(services.db, userId).map((pool) => pool.pool_address));
        if (watched.length === 0) {
            await safeReply(ctx, 'Your watchlist is empty.');
            return;
        }
        const lines = watched.map((pool) => {
            const velocity = services.velocityGuard.calculateVelocityDrop(pool.pool_address);
            const risk = velocity === null ? 'insufficient data' : (0, riskScore_1.scorePool)(velocity).level;
            return `- ${pool.pool_address} | ${armed.has(pool.pool_address) ? 'armed' : 'watching'} | ${risk}`;
        });
        await safeReply(ctx, ['Watched pools:', ...lines].join('\n'));
    });
    bot.command('settings', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const [poolAddress, takeProfit, stopLoss] = commandArgs(ctx);
            if (poolAddress === undefined || poolAddress.trim().length === 0) {
                throw new Error('Usage: /settings <pool_address> <take_profit_percent> <stop_loss_percent>');
            }
            const takeProfitPercent = parsePercent(takeProfit, 'take_profit_percent', 1000);
            const stopLossPercent = parsePercent(stopLoss, 'stop_loss_percent', 100);
            let entryPriceTon;
            try {
                const pool = await services.stonClient.getPoolData(poolAddress);
                const tokenAddress = firstTokenAddress(pool.tokenAddresses);
                const currentPriceTon = await services.stonClient.getTokenPrice(tokenAddress);
                entryPriceTon = currentPriceTon > 0 ? currentPriceTon : undefined;
            }
            catch {
                entryPriceTon = undefined;
            }
            (0, sqlite_1.upsertRiskSettings)(services.db, userId, poolAddress, takeProfitPercent, stopLossPercent, entryPriceTon);
            await safeReply(ctx, [
                `⚙️ Risk settings saved for pool ${poolAddress}`,
                '',
                `Take Profit: +${takeProfitPercent}%`,
                `Stop Loss: -${stopLossPercent}%`,
                '',
                'The bot will automatically exit this position when either target is reached.',
                `Use /arm ${poolAddress} to activate auto-defense.`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Settings rejected: ${error instanceof Error ? error.message : 'Usage: /settings <pool_address> <take_profit_percent> <stop_loss_percent>'}`);
        }
    });
    bot.command('slippage', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const args = commandArgs(ctx);
            if (args.length === 0) {
                await safeReply(ctx, services.slippageService.getUserSlippageSummary(userId));
                return;
            }
            if (args[0] === 'reset') {
                const tokenAddress = args[1];
                if (tokenAddress === undefined) {
                    services.slippageService.resetSlippage(userId, 'global');
                    await safeReply(ctx, [
                        '✅ Global slippage reset.',
                        `Falling back to system default: ${services.config.defaultSlippageBps / 100}%`,
                    ].join('\n'));
                    return;
                }
                parseTonAddress(tokenAddress, 'token_address');
                services.slippageService.resetSlippage(userId, 'token', tokenAddress);
                await safeReply(ctx, [
                    `✅ Token slippage setting removed for ${shortAddress(tokenAddress)}.`,
                    'Falling back to your global setting or system default.',
                ].join('\n'));
                return;
            }
            if (args.length === 1) {
                const validation = slippageService_1.SlippageService.validateSlippageInput(args[0] ?? '');
                if (!validation.valid) {
                    await safeReply(ctx, `${validation.errorMessage ?? 'Invalid slippage.'}\n\n${slippageUsage()}`);
                    return;
                }
                services.slippageService.setGlobalSlippage(userId, validation.slippageBps);
                await safeReply(ctx, [
                    `✅ Global slippage set to ${validation.slippageBps / 100}%`,
                    '',
                    `All your trades will use ${validation.slippageBps / 100}% tolerance`,
                    'unless overridden by a token-specific setting',
                    'or inline --slippage flag.',
                    formatSlippageWarning(validation.sandwichWarning),
                ].join('\n'));
                return;
            }
            const [tokenAddress, percent] = args;
            if (tokenAddress === undefined || percent === undefined) {
                await safeReply(ctx, slippageUsage());
                return;
            }
            parseTonAddress(tokenAddress, 'token_address');
            const validation = slippageService_1.SlippageService.validateSlippageInput(percent);
            if (!validation.valid) {
                await safeReply(ctx, `${validation.errorMessage ?? 'Invalid slippage.'}\n\n${slippageUsage()}`);
                return;
            }
            services.slippageService.setTokenSlippage(userId, tokenAddress, validation.slippageBps);
            await safeReply(ctx, [
                `✅ Token slippage set to ${validation.slippageBps / 100}% for`,
                shortAddress(tokenAddress),
                '',
                `All trades on this token will use ${validation.slippageBps / 100}%`,
                'tolerance overriding your global setting.',
                formatSlippageWarning(validation.sandwichWarning),
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Slippage update failed: ${error instanceof Error ? error.message : 'Invalid input.'}\n\n${slippageUsage()}`);
        }
    });
    bot.command('emergency_slippage', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const [percent] = commandArgs(ctx);
            if (percent === undefined) {
                await safeReply(ctx, 'Usage: /emergency_slippage <percent>');
                return;
            }
            const validation = slippageService_1.SlippageService.validateSlippageInput(percent);
            if (!validation.valid) {
                await safeReply(ctx, validation.errorMessage ?? 'Invalid emergency slippage value.');
                return;
            }
            services.slippageService.setEmergencySlippage(userId, validation.slippageBps);
            await safeReply(ctx, [
                `✅ Emergency exit slippage set to ${validation.slippageBps / 100}%`,
                '',
                'This tolerance will be used when TonShield',
                'automatically exits a position during a',
                'detected rug or velocity breach.',
                '',
                'Higher values guarantee execution but increase',
                'sandwich attack exposure.',
                'Recommended range: 25% — 49%.',
                formatSlippageWarning(validation.sandwichWarning),
                validation.slippageBps < 2500
                    ? [
                        '',
                        '⚠️ Warning: Emergency slippage below 25% may',
                        'cause exit transactions to fail during fast',
                        'liquidity drains. Consider setting at least 25%.',
                    ].join('\n')
                    : '',
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Emergency slippage update failed: ${error instanceof Error ? error.message : 'Invalid input.'}`);
        }
    });
    bot.command('slippage_info', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        await safeReply(ctx, [
            '📖 How Slippage Works on TonShield',
            '',
            'Slippage tolerance is the maximum price difference',
            'you accept between quote and execution.',
            '',
            'Priority order for your trades:',
            '1. --slippage flag in command (highest)',
            '2. Token-specific setting (/slippage <token> <%)',
            '3. Your global setting (/slippage <percent>)',
            `4. System default (${services.config.defaultSlippageBps / 100}%)`,
            '',
            'For emergency auto-exits:',
            '1. Your emergency setting (/emergency_slippage)',
            '2. Your normal slippage × 2 (min 25%, max 49%)',
            '',
            'Tips:',
            '• New meme coins with low liquidity: use 10-20%',
            '• Deep liquidity tokens: use 1-3%',
            '• Emergency exits: set 25-49% for guarantee',
            '• Above 49% risks sandwich attacks',
            '',
            'Commands:',
            '/slippage              — view your settings',
            '/slippage 5            — set 5% global default',
            '/slippage EQToken 15   — set 15% for one token',
            '/emergency_slippage 30 — set 30% for auto-exits',
            '/buy ... --slippage 20 — one-time 20% override',
        ].join('\n'));
    });
    bot.command('positions', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const positions = (0, sqlite_1.getOpenPositions)(services.db, userId);
        if (positions.length === 0) {
            await safeReply(ctx, 'No open positions.');
            return;
        }
        for (const position of positions) {
            const currentPriceTon = await services.stonClient.getTokenPrice(position.token_address);
            const pnlPercent = ((currentPriceTon - position.entry_price_ton) / position.entry_price_ton) * 100;
            const pnlTon = (pnlPercent / 100) * position.amount_ton;
            await ctx.reply([
                '📊 Live Position',
                '',
                `Token: ${position.token_address}`,
                `Pool: ${position.pool_address}`,
                `Entry: ${position.entry_price_ton} TON`,
                `Current: ${currentPriceTon} TON`,
                `Amount: ${position.amount_ton} TON`,
                '',
                `P&L: ${pnlIndicator(pnlPercent)} ${formatSigned(pnlPercent)}% (${formatSigned(pnlTon)} TON)`,
                `Opened: ${position.opened_at}`,
            ].join('\n'), telegraf_1.Markup.inlineKeyboard([
                [telegraf_1.Markup.button.callback('Sell Now', `sell_now:${position.pool_address}`)],
            ]));
        }
    });
    bot.command('history', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const positions = (0, sqlite_1.getClosedPositions)(services.db, userId, 10);
        if (positions.length === 0) {
            await safeReply(ctx, 'No closed positions.');
            return;
        }
        for (const position of positions) {
            const pnlTon = position.pnl_ton ?? 0;
            const pnlPercent = position.pnl_percent ?? 0;
            const receivedTon = position.amount_ton + pnlTon;
            const tonscanLink = position.tx_hash_close === null
                ? 'unavailable'
                : (0, swapBuilder_1.buildTonscanLink)(position.tx_hash_close, services.config.network);
            await safeReply(ctx, [
                `📋 Closed Position — ${position.token_address}`,
                '',
                `Spent: ${position.amount_ton} TON`,
                `Received: ${receivedTon} TON`,
                `P&L: ${formatSigned(pnlPercent)}%`,
                `Closed: ${position.closed_at ?? 'unknown'}`,
                `🔗 TONscan: ${tonscanLink}`,
            ].join('\n'));
        }
    });
    bot.command('preview_buy', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        try {
            const args = commandArgs(ctx);
            const [poolAddress, tokenAddress, amount] = args;
            if (poolAddress === undefined ||
                poolAddress.trim().length === 0 ||
                tokenAddress === undefined ||
                tokenAddress.trim().length === 0) {
                throw new Error('Usage: /preview_buy <pool_address> <token_address> <amount_ton>');
            }
            const amountTon = parsePositiveAmount(amount);
            const quote = await services.stonClient.getSwapQuote(tokenAddress, amountTon, services.config.defaultSlippageBps);
            const estimatedTokenOut = quoteAskAmount(quote);
            const minTokenOut = quoteMinAskAmount(quote);
            const entryPriceTon = quoteEntryPrice(amountTon, quote);
            await safeReply(ctx, [
                '🔍 Buy Preview (No transaction sent)',
                '',
                `Token: ${tokenAddress}`,
                `Pool: ${poolAddress}`,
                `You spend: ${amountTon} TON`,
                `Estimated received: ${estimatedTokenOut} tokens`,
                `Minimum received: ${minTokenOut} tokens`,
                `Slippage tolerance: ${services.config.defaultSlippageBps / 100}%`,
                `Entry price: ${entryPriceTon} TON per token`,
                '',
                `To execute: /buy ${poolAddress} ${tokenAddress} ${amountTon}`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Preview failed: ${error instanceof Error ? error.message : 'Usage: /preview_buy <pool_address> <token_address> <amount_ton>'}`);
        }
    });
    bot.command('buy', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        if (!(0, walletStore_1.hasAgentWallet)(services.db, userId)) {
            await safeReply(ctx, '❌ No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        if (services.budgetPolicy.getPolicy(userId) === undefined) {
            await safeReply(ctx, '❌ No budget set. Run /budget <max_ton> first.');
            return;
        }
        try {
            const args = commandArgs(ctx);
            const [poolAddress, tokenAddress, amount] = args;
            if (poolAddress === undefined ||
                poolAddress.trim().length === 0 ||
                tokenAddress === undefined ||
                tokenAddress.trim().length === 0) {
                throw new Error('Usage: /buy <pool_address> <token_address> <amount_ton>');
            }
            const amountTon = parsePositiveAmount(amount);
            const inlineSlippageBps = (0, slippageService_1.parseInlineSlippage)(args);
            const slippageResolution = services.slippageService.resolveSlippage(userId, tokenAddress, inlineSlippageBps);
            const quote = await services.stonClient.getSwapQuote(tokenAddress, amountTon, slippageResolution.slippageBps);
            const minTokenOut = quoteMinAskAmount(quote);
            const safetyReport = await services.tokenScanner.scanToken(tokenAddress, poolAddress);
            if (safetyReport.overallRisk === 'CRITICAL' || safetyReport.honeypot.result === 'FAIL') {
                await safeReply(ctx, [formatSafetyReport(safetyReport), '', '🚨 Buy blocked due to critical risk.'].join('\n'));
                return;
            }
            const confirmationId = (0, node_crypto_1.randomUUID)();
            pendingBuys.set(confirmationId, {
                userId,
                poolAddress,
                tokenAddress,
                amountTon,
                inlineSlippageBps,
                createdAt: Date.now(),
            });
            await ctx.reply([
                formatCondensedSafetySummary(safetyReport),
                safetyReport.overallRisk === 'HIGH'
                    ? '⚠️ HIGH RISK TOKEN — Proceed at your own risk.'
                    : '',
                '',
                '🛒 Confirm Buy Order',
                '',
                `Pool: ${poolAddress}`,
                `Token: ${tokenAddress}`,
                `Amount: ${amountTon} TON`,
                `Slippage: ${(0, slippageService_1.formatSlippageResolution)(slippageResolution)}`,
                `Min received: ${minTokenOut} tokens`,
                `Network: ${services.config.network}`,
                '',
                '⚠️ This will execute a real testnet transaction from your agent wallet.',
            ].join('\n'), telegraf_1.Markup.inlineKeyboard([
                [
                    telegraf_1.Markup.button.callback('✅ Confirm Buy', `confirm_buy:${confirmationId}`),
                    telegraf_1.Markup.button.callback('❌ Cancel', `cancel_buy:${confirmationId}`),
                ],
            ]));
        }
        catch (error) {
            await safeReply(ctx, `Buy rejected: ${error instanceof Error ? error.message : 'Usage: /buy <pool_address> <token_address> <amount_ton>'}`);
        }
    });
    bot.command('simulate', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress, amount] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /simulate <pool_address> [amount_ton]');
            return;
        }
        try {
            const amountTon = parsePositiveAmount(amount, 1);
            const result = await services.executor.simulateDefensiveSwap(userId, poolAddress, amountTon);
            await safeReply(ctx, [
                'Paper trade simulated.',
                `Attempt ID: ${result.attemptId}`,
                `Pool: ${poolAddress}`,
                `Amount: ${amountTon} TON`,
                `Status: ${result.status}`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Simulation failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
        }
    });
    bot.command('arm', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /arm <pool_address>');
            return;
        }
        if (!(0, walletStore_1.hasAgentWallet)(services.db, userId)) {
            await safeReply(ctx, 'Create an agent wallet first with /create_agent_wallet.');
            return;
        }
        if (services.budgetPolicy.getPolicy(userId) === undefined) {
            await safeReply(ctx, 'Set a budget first with /budget <max_ton> [per_trade_ton].');
            return;
        }
        (0, sqlite_1.addWatchedPool)(services.db, userId, poolAddress);
        (0, sqlite_1.addArmedPool)(services.db, userId, poolAddress);
        await safeReply(ctx, [
            `Pool armed: ${poolAddress}`,
            'Warning: when PAPER_TRADE=false and NETWORK=testnet, real testnet transactions may execute automatically after a breach.',
        ].join('\n'));
    });
    bot.command('disarm', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /disarm <pool_address>');
            return;
        }
        (0, sqlite_1.removeArmedPool)(services.db, userId, poolAddress);
        await safeReply(ctx, `Pool disarmed: ${poolAddress}`);
    });
    bot.command('agent_status', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
        const budget = services.budgetPolicy.getPolicy(userId);
        const armed = (0, sqlite_1.listArmedPools)(services.db, userId);
        const remaining = budget === undefined ? null : Math.max(0, budget.maxBudgetTon - budget.currentSpentTon);
        await safeReply(ctx, [
            'Agent status',
            `Address: ${wallet?.address ?? 'not created'}`,
            `Network: ${formatNetwork(services.config)}`,
            `Budget remaining: ${remaining === null ? 'not set' : `${remaining} TON`}`,
            `Spend so far: ${budget === undefined ? 'not set' : `${budget.currentSpentTon} TON`}`,
            `Monitoring mode: ${services.config.paperTrade ? 'paper trading' : 'live testnet execution'}`,
            `Armed pools: ${armed.length === 0 ? 'none' : armed.map((pool) => pool.pool_address).join(', ')}`,
        ].join('\n'));
    });
    bot.command('withdraw_ton', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
        if (wallet === undefined) {
            await safeReply(ctx, 'No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        try {
            const [destination, amount] = commandArgs(ctx);
            const destinationAddress = assertNonEmpty(destination, 'Usage: /withdraw_ton <destination_address> <amount_ton>');
            parseTonAddress(destinationAddress, 'destination_address');
            const amountTon = parsePositiveAmount(amount);
            await ctx.reply([
                '💸 Confirm TON Withdrawal',
                '',
                `From: Agent Wallet (${wallet.address})`,
                `To: ${destinationAddress}`,
                `Amount: ${amountTon} TON`,
                '',
                '⚠️ Double check the destination address.',
                'Blockchain transactions cannot be reversed.',
            ].join('\n'), telegraf_1.Markup.inlineKeyboard([
                [
                    telegraf_1.Markup.button.callback('✅ Confirm Withdrawal', `confirm_withdraw_ton:${destinationAddress}:${amountTon}`),
                    telegraf_1.Markup.button.callback('❌ Cancel', 'cancel_withdrawal'),
                ],
            ]));
        }
        catch (error) {
            await safeReply(ctx, `Withdrawal rejected: ${error instanceof Error ? error.message : 'Usage: /withdraw_ton <destination_address> <amount_ton>'}`);
        }
    });
    bot.command('withdraw_all', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
        if (wallet === undefined) {
            await safeReply(ctx, 'No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        try {
            const [destination] = commandArgs(ctx);
            const destinationAddress = assertNonEmpty(destination, 'Usage: /withdraw_all <destination_address>');
            parseTonAddress(destinationAddress, 'destination_address');
            const withdrawableAmount = await calculateWithdrawableTon(services, wallet.address);
            await ctx.reply([
                '💸 Confirm Full Withdrawal',
                '',
                `From: Agent Wallet (${wallet.address})`,
                `To: ${destinationAddress}`,
                `Amount: ${withdrawableAmount.toFixed(4)} TON`,
                `Reserved for gas: ${WITHDRAWAL_GAS_RESERVE_TON} TON`,
            ].join('\n'), telegraf_1.Markup.inlineKeyboard([
                [
                    telegraf_1.Markup.button.callback('✅ Confirm', `confirm_withdraw_all:${destinationAddress}`),
                    telegraf_1.Markup.button.callback('❌ Cancel', 'cancel_withdrawal'),
                ],
            ]));
        }
        catch (error) {
            await safeReply(ctx, `Full withdrawal rejected: ${error instanceof Error ? error.message : 'Usage: /withdraw_all <destination_address>'}`);
        }
    });
    bot.command('withdraw_token', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
        if (wallet === undefined) {
            await safeReply(ctx, 'No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        try {
            const [token, destination] = commandArgs(ctx);
            const tokenAddress = assertNonEmpty(token, 'Usage: /withdraw_token <token_address> <destination_address>');
            const destinationAddress = assertNonEmpty(destination, 'Usage: /withdraw_token <token_address> <destination_address>');
            parseTonAddress(tokenAddress, 'token_address');
            parseTonAddress(destinationAddress, 'destination_address');
            await ctx.reply([
                '🪙 Confirm Token Withdrawal',
                '',
                `Token: ${tokenAddress}`,
                `From: Agent Wallet (${wallet.address})`,
                `To: ${destinationAddress}`,
                'Amount: All held tokens',
            ].join('\n'), telegraf_1.Markup.inlineKeyboard([
                [
                    telegraf_1.Markup.button.callback('✅ Confirm', `confirm_withdraw_token:${tokenAddress}:${destinationAddress}`),
                    telegraf_1.Markup.button.callback('❌ Cancel', 'cancel_withdrawal'),
                ],
            ]));
        }
        catch (error) {
            await safeReply(ctx, `Token withdrawal rejected: ${error instanceof Error ? error.message : 'Usage: /withdraw_token <token_address> <destination_address>'}`);
        }
    });
    bot.command('export_address', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
        if (wallet === undefined) {
            await safeReply(ctx, 'No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        try {
            const publicKey = await deriveAgentPublicKey(wallet.encryptedMnemonic, services.config);
            await safeReply(ctx, [
                '📋 Agent Wallet Address',
                '',
                `Address: ${wallet.address}`,
                `Network: ${services.config.network}`,
                `Public Key: ${publicKey}`,
                '',
                'This is safe to share. It contains no private information.',
                'Use this to receive funds or verify your wallet on TONscan.',
                `🔗 ${buildTonscanAddressLink(wallet.address, services.config.network)}`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Address export failed: ${error instanceof Error ? error.message : 'Unknown export error.'}`);
        }
    });
    bot.command('export_keys', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        const chatId = ctx.chat?.id;
        if (userId === null) {
            return;
        }
        if (chatId === undefined) {
            await safeReply(ctx, 'Unable to identify this chat.');
            return;
        }
        if (!(0, walletStore_1.hasAgentWallet)(services.db, userId)) {
            await safeReply(ctx, 'No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        const existing = pendingKeyExports.get(userId);
        if (existing !== undefined) {
            clearTimeout(existing.timeout);
            pendingKeyExports.delete(userId);
        }
        const timeout = setTimeout(() => {
            const pending = pendingKeyExports.get(userId);
            if (pending?.timeout === timeout) {
                pendingKeyExports.delete(userId);
                void bot.telegram.sendMessage(chatId, '⏱️ Export request expired. Run /export_keys again if needed.');
            }
        }, KEY_EXPORT_TTL_MS);
        pendingKeyExports.set(userId, { chatId, timeout });
        await safeReply(ctx, [
            '🔐 Seed Phrase Export Request',
            '',
            '⚠️ WARNING: Your seed phrase gives COMPLETE access to your agent wallet and all funds inside it.',
            '',
            'Before proceeding you must understand:',
            '• Anyone who sees this phrase can steal your funds instantly',
            '• Telegram stores message history — delete this message immediately after saving',
            '• Never share this with anyone including TonShield support',
            '• Import into Tonkeeper or MyTonWallet immediately after export',
            '',
            'To confirm you understand, reply with exactly:',
            'EXPORT MY KEYS',
            '',
            'You have 60 seconds to reply or this request expires.',
        ].join('\n'));
    });
    bot.action(/^cancel_withdrawal$/, async (ctx) => {
        await ctx.answerCbQuery('Withdrawal cancelled.');
        await ctx.editMessageText('❌ Withdrawal cancelled.');
    });
    bot.action(/^confirm_withdraw_ton:(.+):([^:]+)$/, async (ctx) => {
        const [, destinationAddress, amount] = ctx.match;
        const userId = ctx.from?.id;
        if (userId === undefined) {
            await ctx.answerCbQuery('Unable to identify your Telegram user.');
            return;
        }
        try {
            const amountTon = parsePositiveAmount(amount);
            await ctx.answerCbQuery('Sending withdrawal...');
            const result = await services.withdrawalEngine.withdrawTon(userId, destinationAddress, amountTon);
            if (result.status !== 'success' || result.txHash === undefined) {
                await safeReply(ctx, `Withdrawal failed: ${result.errorMessage ?? result.status}`);
                return;
            }
            await safeReply(ctx, [
                '✅ Withdrawal successful.',
                '',
                `Sent: ${amountTon} TON`,
                `To: ${destinationAddress}`,
                `🔗 Verify: ${(0, swapBuilder_1.buildTonscanLink)(result.txHash, services.config.network)}`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Withdrawal failed: ${error instanceof Error ? error.message : 'Unknown withdrawal error.'}`);
        }
    });
    bot.action(/^confirm_withdraw_all:(.+)$/, async (ctx) => {
        const destinationAddress = ctx.match[1];
        const userId = ctx.from?.id;
        if (userId === undefined) {
            await ctx.answerCbQuery('Unable to identify your Telegram user.');
            return;
        }
        try {
            const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
            const amountTon = wallet === undefined ? 0 : await calculateWithdrawableTon(services, wallet.address);
            await ctx.answerCbQuery('Sending full withdrawal...');
            const result = await services.withdrawalEngine.withdrawAllTon(userId, destinationAddress);
            if (result.status !== 'success' || result.txHash === undefined) {
                await safeReply(ctx, `Withdrawal failed: ${result.errorMessage ?? result.status}`);
                return;
            }
            await safeReply(ctx, [
                '✅ Withdrawal successful.',
                '',
                `Sent: ${amountTon.toFixed(4)} TON`,
                `To: ${destinationAddress}`,
                `🔗 Verify: ${(0, swapBuilder_1.buildTonscanLink)(result.txHash, services.config.network)}`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Withdrawal failed: ${error instanceof Error ? error.message : 'Unknown withdrawal error.'}`);
        }
    });
    bot.action(/^confirm_withdraw_token:([^:]+):(.+)$/, async (ctx) => {
        const [, tokenAddress, destinationAddress] = ctx.match;
        const userId = ctx.from?.id;
        if (userId === undefined) {
            await ctx.answerCbQuery('Unable to identify your Telegram user.');
            return;
        }
        try {
            await ctx.answerCbQuery('Sending token withdrawal...');
            const result = await services.withdrawalEngine.withdrawToken(userId, tokenAddress, destinationAddress);
            if (result.status !== 'success' || result.txHash === undefined) {
                await safeReply(ctx, `Token withdrawal failed: ${result.errorMessage ?? result.status}`);
                return;
            }
            await safeReply(ctx, [
                '✅ Token withdrawal successful.',
                '',
                `Token: ${tokenAddress}`,
                `To: ${destinationAddress}`,
                `🔗 Verify: ${(0, swapBuilder_1.buildTonscanLink)(result.txHash, services.config.network)}`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, `Token withdrawal failed: ${error instanceof Error ? error.message : 'Unknown token withdrawal error.'}`);
        }
    });
    bot.command('emergency_sell', async (ctx) => {
        const userId = await ensureTelegramUser(ctx, services.db);
        if (userId === null) {
            return;
        }
        const [poolAddress, amount] = commandArgs(ctx);
        if (poolAddress === undefined) {
            await safeReply(ctx, 'Usage: /emergency_sell <pool_address> [amount_ton]');
            return;
        }
        if (!(0, walletStore_1.hasAgentWallet)(services.db, userId)) {
            await safeReply(ctx, 'Create an agent wallet first with /create_agent_wallet.');
            return;
        }
        try {
            const amountTon = parsePositiveAmount(amount, 1);
            const pool = await services.stonClient.getPoolData(poolAddress);
            const tokenAddress = firstTokenAddress(pool.tokenAddresses);
            const emergencyResolution = services.slippageService.resolveEmergencySlippage(userId, tokenAddress);
            const confirmationId = (0, node_crypto_1.randomUUID)();
            pendingEmergencySells.set(confirmationId, {
                userId,
                poolAddress,
                tokenAddress,
                amountTon,
                createdAt: Date.now(),
            });
            await ctx.reply([
                '⚠️ Manual Emergency Sell',
                '',
                `Pool: ${poolAddress}`,
                `Slippage: ${(0, slippageService_1.formatSlippageResolution)(emergencyResolution)}`,
                `Mode: ${services.config.network}`,
            ].join('\n'), telegraf_1.Markup.inlineKeyboard([
                [
                    telegraf_1.Markup.button.callback('✅ Confirm Emergency Sell', `emergency_sell_confirm:${confirmationId}`),
                    telegraf_1.Markup.button.callback('❌ Cancel', `emergency_sell_cancel:${confirmationId}`),
                ],
            ]));
        }
        catch (error) {
            await safeReply(ctx, `Emergency sell preparation failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
        }
    });
    bot.action(/^emergency_sell_cancel:(.+)$/, async (ctx) => {
        const confirmationId = ctx.match[1];
        pendingEmergencySells.delete(confirmationId);
        await ctx.answerCbQuery('Emergency sell cancelled.');
        await ctx.editMessageReplyMarkup(undefined);
    });
    bot.action(/^emergency_sell_confirm:(.+)$/, async (ctx) => {
        const confirmationId = ctx.match[1];
        const pending = pendingEmergencySells.get(confirmationId);
        if (pending === undefined) {
            await ctx.answerCbQuery('Confirmation expired or not found.');
            return;
        }
        if (Date.now() - pending.createdAt > EMERGENCY_CONFIRMATION_TTL_MS) {
            pendingEmergencySells.delete(confirmationId);
            await ctx.answerCbQuery('Confirmation expired.');
            return;
        }
        if (ctx.from?.id !== pending.userId) {
            await ctx.answerCbQuery('This confirmation belongs to another user.');
            return;
        }
        pendingEmergencySells.delete(confirmationId);
        await ctx.answerCbQuery('Executing emergency sell...');
        const result = await services.executor.executeDefensiveSwap(pending.userId, pending.poolAddress, pending.tokenAddress, pending.amountTon);
        await safeReply(ctx, result.status === 'success'
            ? formatExecutionResult(pending.amountTon, result.status, result.txHash, services.config)
            : `Emergency sell did not execute.\nAttempt ID: ${result.attemptId}\nStatus: ${result.status}`);
    });
    bot.action(/^cancel_buy:(.+)$/, async (ctx) => {
        const confirmationId = ctx.match[1];
        pendingBuys.delete(confirmationId);
        await ctx.answerCbQuery('Buy cancelled.');
        await ctx.editMessageText('❌ Buy cancelled. No transaction sent.');
    });
    bot.action(/^confirm_buy:(.+)$/, async (ctx) => {
        const confirmationId = ctx.match[1];
        const pending = pendingBuys.get(confirmationId);
        const userId = ctx.from?.id;
        if (userId === undefined) {
            await ctx.answerCbQuery('Unable to identify your Telegram user.');
            return;
        }
        if (pending === undefined) {
            await ctx.answerCbQuery('Confirmation expired or not found.');
            return;
        }
        if (Date.now() - pending.createdAt > EMERGENCY_CONFIRMATION_TTL_MS) {
            pendingBuys.delete(confirmationId);
            await ctx.answerCbQuery('Confirmation expired.');
            return;
        }
        if (pending.userId !== userId) {
            await ctx.answerCbQuery('This confirmation belongs to another user.');
            return;
        }
        try {
            pendingBuys.delete(confirmationId);
            await ctx.answerCbQuery(services.config.paperTrade ? 'Simulating buy...' : 'Executing buy...');
            if (services.config.paperTrade) {
                const result = await services.executor.simulateBuySwap(pending.userId, pending.poolAddress, pending.tokenAddress, pending.amountTon, { inlineSlippageBps: pending.inlineSlippageBps });
                await safeReply(ctx, [
                    '🔍 Buy simulated. No transaction sent.',
                    '',
                    `Token: ${pending.tokenAddress}`,
                    `Pool: ${pending.poolAddress}`,
                    `Amount: ${pending.amountTon} TON`,
                    `Estimated received: ${result.estimatedTokenOut} tokens`,
                    `Entry price: ${result.entryPriceTon} TON`,
                ].join('\n'));
                return;
            }
            const result = await services.executor.executeBuySwap(pending.userId, pending.poolAddress, pending.tokenAddress, pending.amountTon, { inlineSlippageBps: pending.inlineSlippageBps });
            if (result.status !== 'success') {
                await safeReply(ctx, [
                    `❌ Buy failed: ${result.status}`,
                    '',
                    'Your budget has not been deducted.',
                    `Try /preview_buy ${pending.poolAddress} ${pending.tokenAddress} ${pending.amountTon} to check the quote first.`,
                ].join('\n'));
                return;
            }
            (0, sqlite_1.openPosition)(services.db, pending.userId, pending.poolAddress, pending.tokenAddress, result.entryPriceTon, pending.amountTon, result.txHash);
            const alreadyWatched = (0, sqlite_1.listWatchedPools)(services.db, pending.userId).some((pool) => pool.pool_address === pending.poolAddress);
            if (!alreadyWatched) {
                (0, sqlite_1.addWatchedPool)(services.db, pending.userId, pending.poolAddress);
            }
            await safeReply(ctx, [
                '✅ Buy executed successfully.',
                '',
                `Token: ${pending.tokenAddress}`,
                `Pool: ${pending.poolAddress}`,
                `Amount spent: ${pending.amountTon} TON`,
                `Estimated received: ${result.estimatedTokenOut} tokens`,
                `Entry price: ${result.entryPriceTon} TON`,
                '',
                alreadyWatched
                    ? 'Position opened and monitoring already active.'
                    : 'Position opened and monitoring started.',
                result.txHash === undefined
                    ? '⏳ Transaction submitted. Hash will be available shortly.'
                    : `🔗 Verify: ${(0, swapBuilder_1.buildTonscanLink)(result.txHash, services.config.network)}`,
                '',
                `Use /arm ${pending.poolAddress} to activate auto-defense.`,
            ].join('\n'));
        }
        catch (error) {
            await safeReply(ctx, [
                `❌ Buy failed: ${error instanceof Error ? error.message : 'Unknown buy failure.'}`,
                '',
                'Your budget has not been deducted.',
                `Try /preview_buy ${pending.poolAddress} ${pending.tokenAddress} ${pending.amountTon} to check the quote first.`,
            ].join('\n'));
        }
    });
    bot.action(/^sell_now:(.+)$/, async (ctx) => {
        const userId = ctx.from?.id;
        const poolAddress = ctx.match[1];
        if (userId === undefined) {
            await ctx.answerCbQuery('Unable to identify your Telegram user.');
            return;
        }
        const position = (0, sqlite_1.getOpenPositions)(services.db, userId).find((openPosition) => openPosition.pool_address === poolAddress);
        if (position === undefined) {
            await ctx.answerCbQuery('No open position found for this pool.');
            return;
        }
        const confirmationId = (0, node_crypto_1.randomUUID)();
        pendingSellNow.set(confirmationId, {
            userId,
            poolAddress,
            tokenAddress: position.token_address,
            amountTon: position.amount_ton,
            createdAt: Date.now(),
        });
        await ctx.reply(`Confirm sell for ${poolAddress}.`, telegraf_1.Markup.inlineKeyboard([
            [
                telegraf_1.Markup.button.callback('Confirm Sell', `sell_now_confirm:${confirmationId}`),
                telegraf_1.Markup.button.callback('Cancel', `sell_now_cancel:${confirmationId}`),
            ],
        ]));
    });
    bot.action(/^sell_now_cancel:(.+)$/, async (ctx) => {
        const confirmationId = ctx.match[1];
        pendingSellNow.delete(confirmationId);
        await ctx.answerCbQuery('Sell cancelled.');
        await ctx.editMessageText('❌ Sell cancelled.');
    });
    bot.action(/^sell_now_confirm:(.+)$/, async (ctx) => {
        const confirmationId = ctx.match[1];
        const pending = pendingSellNow.get(confirmationId);
        if (pending === undefined) {
            await ctx.answerCbQuery('Confirmation expired or not found.');
            return;
        }
        if (ctx.from?.id !== pending.userId) {
            await ctx.answerCbQuery('This confirmation belongs to another user.');
            return;
        }
        pendingSellNow.delete(confirmationId);
        await ctx.answerCbQuery('Executing sell...');
        const result = await services.executor.executeDefensiveSwap(pending.userId, pending.poolAddress, pending.tokenAddress, pending.amountTon);
        await safeReply(ctx, result.status === 'success'
            ? formatExecutionResult(pending.amountTon, result.status, result.txHash, services.config)
            : `Sell did not execute.\nStatus: ${result.status}`);
    });
    bot.on('text', async (ctx, next) => {
        const userId = ctx.from?.id;
        if (userId === undefined) {
            return next();
        }
        const pending = pendingKeyExports.get(userId);
        if (pending === undefined) {
            return next();
        }
        clearTimeout(pending.timeout);
        pendingKeyExports.delete(userId);
        if (messageText(ctx).trim() !== 'EXPORT MY KEYS') {
            await safeReply(ctx, '❌ Export cancelled. Confirmation phrase did not match.');
            return;
        }
        const wallet = (0, walletStore_1.getAgentWallet)(services.db, userId);
        if (wallet === undefined) {
            await safeReply(ctx, 'No agent wallet found. Run /create_agent_wallet first.');
            return;
        }
        try {
            (0, sqlite_1.logKeyExport)(services.db, userId, 'seed_phrase');
            await services.agentWallet.decryptAndLoadWallet(userId);
            const mnemonic = agentWallet_1.agentWalletCrypto.decryptMnemonic(wallet.encryptedMnemonic, services.config.agentWalletEncryptionKey);
            const sent = await ctx.reply([
                '🔑 Your Agent Wallet Seed Phrase',
                '',
                formatMnemonicForExport(mnemonic),
                '',
                '⚠️ This message will be deleted in 60 seconds.',
                'Import into Tonkeeper now. Then delete this message manually as well.',
                '',
                'Steps to import:',
                '1. Open Tonkeeper or MyTonWallet',
                '2. Tap Import Wallet',
                '3. Enter these 24 words in exact order',
                '4. Your agent wallet and all its funds will appear',
            ].join('\n'));
            setTimeout(() => {
                void (async () => {
                    try {
                        await ctx.deleteMessage(sent.message_id);
                        await ctx.reply([
                            '✅ Seed phrase message deleted from Telegram.',
                            'Your keys are now only in your wallet app.',
                            'Your agent wallet on TonShield remains active.',
                        ].join('\n'));
                    }
                    catch {
                        await ctx.reply('⚠️ Automatic deletion failed. Delete the seed phrase message manually now.');
                    }
                })();
            }, KEY_EXPORT_TTL_MS);
        }
        catch (error) {
            await safeReply(ctx, `Key export failed: ${error instanceof Error ? error.message : 'Unknown key export error.'}`);
        }
    });
}
