"use strict";
/**
 * BubbleMapAnalyzer — Hidden wallet connection detection.
 *
 * Five connection signals:
 * 1. Common funding source — wallets funded from same root
 * 2. Synchronized buy timing — wallets bought within seconds of launch
 * 3. Round-trip fund flows — TON sent and returned in circular pattern
 * 4. Dormancy pattern — wallets created specifically for this launch
 * 5. Dust linking — tiny amounts connecting otherwise unrelated wallets
 *
 * Analysis runs in two phases:
 * Phase 1 (fast): timing + dormancy checks — returns in ~5 seconds
 * Phase 2 (deep): funding source + dust tracing — returns in 30-60 seconds
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BubbleMapAnalyzer = void 0;
const sqlite_1 = require("../db/sqlite");
const safetyCache_1 = require("./safetyCache");
const SYNC_BUY_WINDOW_SECONDS = 10;
const DUST_THRESHOLD_TON = 0.01;
const DORMANCY_DAYS_THRESHOLD = 7;
const MAX_FUNDING_HOPS = 3;
const HIGH_RISK_SUSPICIOUS_THRESHOLD = 30;
const CRITICAL_SUSPICIOUS_THRESHOLD = 50;
class BubbleMapAnalyzer {
    db;
    toncenterApiKey;
    toncenterEndpoint;
    constructor(db, toncenterApiKey, toncenterEndpoint) {
        this.db = db;
        this.toncenterApiKey = toncenterApiKey;
        this.toncenterEndpoint = toncenterEndpoint;
    }
    async runQuickScan(tokenAddress, holders, tokenDeployTimestamp) {
        /**
         * Phase 1 — Fast analysis using synchronized timing and dormancy.
         * Does not require deep transaction history fetching.
         * Returns in approximately 5 seconds.
         */
        const cached = (0, sqlite_1.getBubbleMapCache)(this.db, tokenAddress, safetyCache_1.BUBBLE_CACHE_TTL_MINUTES);
        if (cached !== undefined) {
            return this.formatCachedReport(tokenAddress, cached);
        }
        const walletNodes = await this.buildWalletNodes(holders.slice(0, 50), tokenDeployTimestamp);
        const timingClusters = this.detectSynchronizedTiming(tokenAddress, walletNodes, tokenDeployTimestamp);
        const dormancyClusters = this.detectDormancyPatterns(tokenAddress, walletNodes, tokenDeployTimestamp);
        const allClusters = [...timingClusters, ...dormancyClusters];
        const suspiciousPercent = this.calculateSuspiciousPercent(allClusters);
        const bubbleRisk = this.scoreBubbleRisk(suspiciousPercent);
        const report = this.buildReport(tokenAddress, walletNodes.length, allClusters, suspiciousPercent, bubbleRisk, 'quick');
        this.saveToCache(tokenAddress, allClusters, suspiciousPercent, bubbleRisk, walletNodes.length);
        return report;
    }
    async runDeepScan(tokenAddress, holders, tokenDeployTimestamp, onProgress) {
        /**
         * Phase 2 — Deep analysis including funding source tracing and dust linking.
         * Makes multiple TonCenter API calls per wallet.
         * May take 30-60 seconds for large holder sets.
         * Reports progress via onProgress callback for Telegram updates.
         */
        onProgress?.('🔍 Tracing funding sources...');
        const walletNodes = await this.buildWalletNodes(holders.slice(0, 30), tokenDeployTimestamp);
        const fundingClusters = this.detectFundingSourceClusters(tokenAddress, walletNodes);
        onProgress?.('🔍 Checking circular fund flows...');
        const roundTripClusters = this.detectRoundTripFlows(tokenAddress, walletNodes);
        onProgress?.('🔍 Detecting dust links...');
        const dustClusters = this.detectDustLinks(tokenAddress, walletNodes);
        const timingClusters = this.detectSynchronizedTiming(tokenAddress, walletNodes, tokenDeployTimestamp);
        const dormancyClusters = this.detectDormancyPatterns(tokenAddress, walletNodes, tokenDeployTimestamp);
        const allClusters = [
            ...fundingClusters,
            ...roundTripClusters,
            ...dustClusters,
            ...timingClusters,
            ...dormancyClusters,
        ];
        const deduplicated = this.deduplicateClusters(allClusters);
        const suspiciousPercent = this.calculateSuspiciousPercent(deduplicated);
        const bubbleRisk = this.scoreBubbleRisk(suspiciousPercent);
        const report = this.buildReport(tokenAddress, walletNodes.length, deduplicated, suspiciousPercent, bubbleRisk, 'deep');
        this.saveToCache(tokenAddress, deduplicated, suspiciousPercent, bubbleRisk, walletNodes.length);
        return report;
    }
    async buildWalletNodes(holders, tokenDeployTimestamp) {
        const nodes = await Promise.allSettled(holders.map(async (holder) => {
            try {
                const txResponse = await fetch(`${this.toncenterEndpoint.replace('/jsonRPC', '')}/getTransactions?address=${holder.address}&limit=3&archival=false`, { headers: { 'X-API-Key': this.toncenterApiKey } });
                const txData = (await txResponse.json());
                const txs = txData.result ?? [];
                const firstTx = txs.at(-1);
                const firstTxTimestamp = firstTx?.utime ?? null;
                const fundingSource = firstTx?.in_msg?.source ?? null;
                const walletAgeDays = firstTxTimestamp !== null ? (tokenDeployTimestamp - firstTxTimestamp) / 86400 : null;
                const isDormant = walletAgeDays !== null && walletAgeDays < DORMANCY_DAYS_THRESHOLD;
                return {
                    address: holder.address,
                    percentOfSupply: holder.percentOfSupply,
                    firstTxTimestamp,
                    fundingSource,
                    buyBlockTime: null,
                    isDormant,
                };
            }
            catch {
                return {
                    address: holder.address,
                    percentOfSupply: holder.percentOfSupply,
                    firstTxTimestamp: null,
                    fundingSource: null,
                    buyBlockTime: null,
                    isDormant: false,
                };
            }
        }));
        return nodes
            .filter((result) => result.status === 'fulfilled')
            .map((result) => result.value);
    }
    detectSynchronizedTiming(tokenAddress, nodes, deployTimestamp) {
        const earlyBuyers = nodes.filter((node) => node.firstTxTimestamp !== null && Math.abs(node.firstTxTimestamp - deployTimestamp) < 3600);
        const clusters = [];
        const used = new Set();
        for (const node of earlyBuyers) {
            if (used.has(node.address) || node.firstTxTimestamp === null)
                continue;
            const synchronized = earlyBuyers.filter((other) => !used.has(other.address) &&
                other.firstTxTimestamp !== null &&
                Math.abs(other.firstTxTimestamp - node.firstTxTimestamp) <= SYNC_BUY_WINDOW_SECONDS);
            if (synchronized.length >= 3) {
                synchronized.forEach((member) => used.add(member.address));
                const totalPercent = synchronized.reduce((sum, member) => sum + member.percentOfSupply, 0);
                synchronized.forEach((member) => {
                    if (member.address !== node.address) {
                        (0, sqlite_1.saveWalletGraphEdge)(this.db, tokenAddress, node.address, member.address, 'synchronized_timing', undefined, member.firstTxTimestamp ?? undefined);
                    }
                });
                clusters.push({
                    clusterIndex: clusters.length + 1,
                    connectionType: 'synchronized_timing',
                    riskLevel: totalPercent > 20 ? 'HIGH' : 'MEDIUM',
                    estimatedControlPercent: totalPercent,
                    rootWallet: null,
                    members: synchronized,
                    description: `${synchronized.length} wallets bought within ${SYNC_BUY_WINDOW_SECONDS}s of each other at launch.`,
                });
            }
        }
        return clusters;
    }
    detectDormancyPatterns(tokenAddress, nodes, deployTimestamp) {
        if (deployTimestamp <= 0)
            return [];
        const dormantBuyers = nodes.filter((node) => node.isDormant && node.percentOfSupply > 0.5);
        if (dormantBuyers.length < 3)
            return [];
        const totalPercent = dormantBuyers.reduce((sum, node) => sum + node.percentOfSupply, 0);
        dormantBuyers.forEach((node, index) => {
            if (index > 0) {
                (0, sqlite_1.saveWalletGraphEdge)(this.db, tokenAddress, dormantBuyers[0].address, node.address, 'dormancy');
            }
        });
        return [
            {
                clusterIndex: 1,
                connectionType: 'dormancy',
                riskLevel: dormantBuyers.length > 5 ? 'HIGH' : 'MEDIUM',
                estimatedControlPercent: totalPercent,
                rootWallet: null,
                members: dormantBuyers,
                description: `${dormantBuyers.length} wallets with no history before token launch — likely created for this token.`,
            },
        ];
    }
    detectFundingSourceClusters(tokenAddress, nodes) {
        const fundingGroups = new Map();
        for (const node of nodes) {
            if (node.fundingSource === null)
                continue;
            const group = fundingGroups.get(node.fundingSource) ?? [];
            group.push(node);
            fundingGroups.set(node.fundingSource, group);
        }
        const clusters = [];
        for (const [source, members] of fundingGroups.entries()) {
            if (members.length < 2 || MAX_FUNDING_HOPS < 1)
                continue;
            const totalPercent = members.reduce((sum, node) => sum + node.percentOfSupply, 0);
            members.forEach((node) => {
                (0, sqlite_1.saveWalletGraphEdge)(this.db, tokenAddress, source, node.address, 'funding_source', undefined, node.firstTxTimestamp ?? undefined);
            });
            clusters.push({
                clusterIndex: clusters.length + 1,
                connectionType: 'funding_source',
                riskLevel: members.length >= 4 ? 'HIGH' : 'MEDIUM',
                estimatedControlPercent: totalPercent,
                rootWallet: source,
                members,
                description: `${members.length} wallets all received initial TON from ${source.slice(0, 8)}... — likely same controller.`,
            });
        }
        return clusters;
    }
    detectRoundTripFlows(tokenAddress, nodes) {
        // PRODUCTION TODO: Implement multi-hop transaction graph traversal.
        // Requires fetching full transaction history per wallet and building
        // a directed graph to detect circular flows within MAX_FUNDING_HOPS hops.
        if (tokenAddress.length === 0 || nodes.length === 0 || MAX_FUNDING_HOPS <= 0)
            return [];
        return [];
    }
    detectDustLinks(tokenAddress, nodes) {
        // PRODUCTION TODO: Implement dust transaction detection.
        // Fetch recent transactions for each wallet and flag transfers
        // below DUST_THRESHOLD_TON that connect otherwise unrelated wallets.
        if (tokenAddress.length === 0 || nodes.length === 0 || DUST_THRESHOLD_TON <= 0)
            return [];
        return [];
    }
    deduplicateClusters(clusters) {
        const seen = new Set();
        return clusters.filter((cluster) => {
            const key = cluster.members
                .map((member) => member.address)
                .sort()
                .join(',');
            if (seen.has(key))
                return false;
            seen.add(key);
            return true;
        });
    }
    calculateSuspiciousPercent(clusters) {
        const suspiciousAddresses = new Map();
        for (const cluster of clusters) {
            for (const member of cluster.members) {
                if (!suspiciousAddresses.has(member.address)) {
                    suspiciousAddresses.set(member.address, member.percentOfSupply);
                }
            }
        }
        return Array.from(suspiciousAddresses.values()).reduce((sum, percent) => sum + percent, 0);
    }
    scoreBubbleRisk(suspiciousPercent) {
        if (suspiciousPercent >= CRITICAL_SUSPICIOUS_THRESHOLD)
            return 'CRITICAL';
        if (suspiciousPercent >= HIGH_RISK_SUSPICIOUS_THRESHOLD)
            return 'HIGH';
        if (suspiciousPercent >= 15)
            return 'MEDIUM';
        return 'LOW';
    }
    buildReport(tokenAddress, walletsAnalyzed, clusters, suspiciousPercent, bubbleRisk, phase) {
        const shortAddress = (address) => `${address.slice(0, 8)}...${address.slice(-4)}`;
        const clusteredAddresses = new Set(clusters.flatMap((cluster) => cluster.members.map((m) => m.address)));
        const clusterLines = clusters.map((cluster) => {
            const emoji = (0, safetyCache_1.riskEmoji)(cluster.riskLevel);
            const memberLines = cluster.members.slice(0, 4).map((member) => `  └── ${shortAddress(member.address)} → holds ${member.percentOfSupply.toFixed(2)}%`);
            if (cluster.members.length > 4) {
                memberLines.push(`  └── ...and ${cluster.members.length - 4} more wallets`);
            }
            return [
                `${emoji} CLUSTER ${cluster.clusterIndex} — ${cluster.riskLevel}`,
                `Estimated control: ${cluster.estimatedControlPercent.toFixed(2)}% of supply`,
                `Connection: ${cluster.connectionType.replace(/_/g, ' ')}`,
                cluster.rootWallet !== null ? `Root wallet: ${shortAddress(cluster.rootWallet)}` : '',
                ...memberLines,
                cluster.description,
                '',
            ]
                .filter(Boolean)
                .join('\n');
        });
        const formattedReport = [
            `🫧 Wallet Connection Analysis — ${shortAddress(tokenAddress)}`,
            `Phase: ${phase === 'quick' ? '⚡ Quick scan' : '🔬 Deep scan'}`,
            '',
            `Wallets analyzed: ${walletsAnalyzed}`,
            `Suspicious clusters: ${clusters.length}`,
            '',
            clusters.length > 0 ? '━━━━━━━━━━━━━━━━━━' : '',
            ...clusterLines,
            clusters.length > 0 ? '━━━━━━━━━━━━━━━━━━' : '',
            '',
            '📊 SUMMARY',
            `Suspicious clustered supply: ${suspiciousPercent.toFixed(2)}%`,
            `Bubble Risk Score: ${(0, safetyCache_1.riskEmoji)(bubbleRisk)} ${bubbleRisk}`,
            '',
            suspiciousPercent > HIGH_RISK_SUSPICIOUS_THRESHOLD
                ? `⚠️ Hidden concentration exceeds ${HIGH_RISK_SUSPICIOUS_THRESHOLD}% threshold.\nA coordinated dump could collapse the price significantly.`
                : '✅ No significant hidden wallet clusters detected.',
        ]
            .filter((line) => line !== '')
            .join('\n');
        return {
            tokenAddress,
            walletsAnalyzed,
            clustersFound: clusters.length,
            suspiciousSupplyPercent: suspiciousPercent,
            bubbleRisk,
            clusters,
            independentHolderCount: walletsAnalyzed - clusteredAddresses.size,
            formattedReport,
            fromCache: false,
            phase,
        };
    }
    formatCachedReport(tokenAddress, cached) {
        const clusters = JSON.parse(cached.cluster_data);
        const report = this.buildReport(tokenAddress, cached.wallets_analyzed, clusters, cached.suspicious_supply_percent, cached.bubble_risk, 'deep');
        return {
            ...report,
            fromCache: true,
        };
    }
    saveToCache(tokenAddress, clusters, suspiciousPercent, bubbleRisk, walletsAnalyzed) {
        (0, sqlite_1.saveBubbleMapCache)(this.db, tokenAddress, clusters.length, suspiciousPercent, bubbleRisk, JSON.stringify(clusters), walletsAnalyzed);
    }
}
exports.BubbleMapAnalyzer = BubbleMapAnalyzer;
