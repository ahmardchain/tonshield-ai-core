"use strict";
/**
 * HolderAnalyzer — Supply distribution and dev wallet identification.
 *
 * Fetches top 50 holders, labels DEX wallets, identifies deployer,
 * calculates concentration metrics, and saves snapshots to DB.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_DEX_ADDRESSES = exports.HolderAnalyzer = void 0;
const core_1 = require("@ton/core");
const sqlite_1 = require("../db/sqlite");
const tokenScanner_1 = require("./tokenScanner");
Object.defineProperty(exports, "KNOWN_DEX_ADDRESSES", { enumerable: true, get: function () { return tokenScanner_1.KNOWN_DEX_ADDRESSES; } });
class HolderAnalyzer {
    db;
    tonClient;
    toncenterApiKey;
    toncenterEndpoint;
    constructor(db, tonClient, toncenterApiKey, toncenterEndpoint) {
        this.db = db;
        this.tonClient = tonClient;
        this.toncenterApiKey = toncenterApiKey;
        this.toncenterEndpoint = toncenterEndpoint;
    }
    async analyzeHolders(tokenAddress, deployerAddress) {
        /**
         * Fetches top 50 token holders from TonCenter API.
         * Identifies dev wallet by matching deployer address.
         * Labels DEX wallets, calculates distribution metrics.
         * Saves snapshot to DB for historical tracking.
         */
        const baseUrl = this.toncenterEndpoint.replace('/jsonRPC', '');
        const [holdersResponse, jettonDataResult] = await Promise.allSettled([
            fetch(`${baseUrl}/getTokenHolders?address=${tokenAddress}&limit=50`, {
                headers: { 'X-API-Key': this.toncenterApiKey },
            }),
            this.tonClient.runMethod(core_1.Address.parse(tokenAddress), 'get_jetton_data', []),
        ]);
        const holdersData = holdersResponse.status === 'fulfilled'
            ? (await holdersResponse.value.json())
            : { result: [] };
        const rawHolders = holdersData.result ?? [];
        const totalSupplyRaw = jettonDataResult.status === 'fulfilled'
            ? jettonDataResult.value.stack.readBigNumber().toString()
            : rawHolders.reduce((sum, holder) => sum + BigInt(holder.balance), 0n).toString();
        const totalSupply = BigInt(totalSupplyRaw);
        const holders = rawHolders.map((holder) => {
            const percent = totalSupply > 0n ? Number((BigInt(holder.balance) * 10000n) / totalSupply) / 100 : 0;
            const isDex = tokenScanner_1.KNOWN_DEX_ADDRESSES.has(holder.address);
            const isDev = deployerAddress !== undefined && holder.address === deployerAddress;
            let label = 'Unknown';
            if (isDex)
                label = 'DEX Liquidity';
            else if (isDev)
                label = 'DEV WALLET';
            return {
                address: holder.address,
                balanceRaw: holder.balance,
                percentOfSupply: percent,
                label,
                isDevWallet: isDev,
                isDexWallet: isDex,
            };
        });
        (0, sqlite_1.saveHolderSnapshots)(this.db, tokenAddress, holders.map((holder) => ({
            wallet_address: holder.address,
            balance_raw: holder.balanceRaw,
            percent_of_supply: holder.percentOfSupply,
            wallet_label: holder.label,
            is_dev_wallet: holder.isDevWallet ? 1 : 0,
            is_dex_wallet: holder.isDexWallet ? 1 : 0,
        })));
        const devHolder = holders.find((holder) => holder.isDevWallet);
        const dexPercent = holders
            .filter((holder) => holder.isDexWallet)
            .reduce((sum, holder) => sum + holder.percentOfSupply, 0);
        const top10Percent = holders
            .slice(0, 10)
            .reduce((sum, holder) => sum + holder.percentOfSupply, 0);
        const formattedReport = this.formatReport(tokenAddress, holders, devHolder?.address ?? null, devHolder?.percentOfSupply ?? 0, dexPercent, top10Percent, totalSupplyRaw);
        return {
            tokenAddress,
            totalSupply: totalSupplyRaw,
            holdersAnalyzed: holders.length,
            devWalletAddress: devHolder?.address ?? null,
            devWalletPercent: devHolder?.percentOfSupply ?? 0,
            top10Percent,
            dexLiquidityPercent: dexPercent,
            circulatingPercent: 100 - dexPercent,
            holders,
            formattedReport,
        };
    }
    formatReport(tokenAddress, holders, devWallet, devPercent, dexPercent, top10Percent, totalSupply) {
        const shortAddress = (address) => `${address.slice(0, 6)}...${address.slice(-4)}`;
        const holderLines = holders.slice(0, 10).map((holder, index) => {
            const emoji = holder.isDevWallet
                ? '🔴'
                : holder.isDexWallet
                    ? '🟢'
                    : holder.percentOfSupply > 10
                        ? '🟡'
                        : '⚪';
            const label = holder.label !== 'Unknown' ? ` [${holder.label}]` : '';
            return `${emoji} ${index + 1}. ${shortAddress(holder.address)}  →  ${holder.percentOfSupply.toFixed(2)}%${label}`;
        });
        const devRisk = devPercent > 30
            ? '🚨 CRITICAL'
            : devPercent > 20
                ? '🔴 HIGH'
                : devPercent > 10
                    ? '🟡 MEDIUM'
                    : '🟢 LOW';
        return [
            `📊 Supply Distribution — ${shortAddress(tokenAddress)}`,
            '',
            `Total Supply: ${Number(BigInt(totalSupply) / 1000000n).toLocaleString()} tokens`,
            `Holders analyzed: ${holders.length}`,
            '',
            'Top Holders:',
            ...holderLines,
            '',
            '━━━━━━━━━━━━━━━━━━',
            `DEX Liquidity:     ${dexPercent.toFixed(2)}%`,
            `Top 10 holders:    ${top10Percent.toFixed(2)}%`,
            `Dev wallet:        ${devWallet !== null ? `${devPercent.toFixed(2)}% — ${shortAddress(devWallet)}` : 'Not identified'}`,
            '',
            `Dev Concentration Risk: ${devRisk}`,
        ].join('\n');
    }
}
exports.HolderAnalyzer = HolderAnalyzer;
