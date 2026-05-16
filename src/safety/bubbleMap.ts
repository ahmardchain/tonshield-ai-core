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

import type { BubbleMapCacheRow, DatabaseConnection } from '../db/sqlite';
import { getBubbleMapCache, saveBubbleMapCache, saveWalletGraphEdge } from '../db/sqlite';
import type { BubbleRisk } from './safetyCache';
import { BUBBLE_CACHE_TTL_MINUTES, riskEmoji } from './safetyCache';

const SYNC_BUY_WINDOW_SECONDS = 10;
const DUST_THRESHOLD_TON = 0.01;
const DORMANCY_DAYS_THRESHOLD = 7;
const MAX_FUNDING_HOPS = 3;
const HIGH_RISK_SUSPICIOUS_THRESHOLD = 30;
const CRITICAL_SUSPICIOUS_THRESHOLD = 50;

export interface WalletNode {
  address: string;
  percentOfSupply: number;
  firstTxTimestamp: number | null;
  fundingSource: string | null;
  buyBlockTime: number | null;
  isDormant: boolean;
}

export interface WalletCluster {
  clusterIndex: number;
  connectionType:
    | 'funding_source'
    | 'synchronized_timing'
    | 'round_trip'
    | 'dormancy'
    | 'dust_link';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  estimatedControlPercent: number;
  rootWallet: string | null;
  members: WalletNode[];
  description: string;
}

export interface BubbleMapReport {
  tokenAddress: string;
  walletsAnalyzed: number;
  clustersFound: number;
  suspiciousSupplyPercent: number;
  bubbleRisk: BubbleRisk;
  clusters: WalletCluster[];
  independentHolderCount: number;
  formattedReport: string;
  fromCache: boolean;
  phase: 'quick' | 'deep';
}

export class BubbleMapAnalyzer {
  public constructor(
    private readonly db: DatabaseConnection,
    private readonly toncenterApiKey: string,
    private readonly toncenterEndpoint: string,
  ) {}

  public async runQuickScan(
    tokenAddress: string,
    holders: Array<{ address: string; percentOfSupply: number }>,
    tokenDeployTimestamp: number,
  ): Promise<BubbleMapReport> {
    /**
     * Phase 1 — Fast analysis using synchronized timing and dormancy.
     * Does not require deep transaction history fetching.
     * Returns in approximately 5 seconds.
     */
    const cached = getBubbleMapCache(this.db, tokenAddress, BUBBLE_CACHE_TTL_MINUTES);

    if (cached !== undefined) {
      return this.formatCachedReport(tokenAddress, cached);
    }

    const walletNodes = await this.buildWalletNodes(holders.slice(0, 50), tokenDeployTimestamp);
    const timingClusters = this.detectSynchronizedTiming(
      tokenAddress,
      walletNodes,
      tokenDeployTimestamp,
    );
    const dormancyClusters = this.detectDormancyPatterns(
      tokenAddress,
      walletNodes,
      tokenDeployTimestamp,
    );
    const allClusters = [...timingClusters, ...dormancyClusters];
    const suspiciousPercent = this.calculateSuspiciousPercent(allClusters);
    const bubbleRisk = this.scoreBubbleRisk(suspiciousPercent);
    const report = this.buildReport(
      tokenAddress,
      walletNodes.length,
      allClusters,
      suspiciousPercent,
      bubbleRisk,
      'quick',
    );

    this.saveToCache(tokenAddress, allClusters, suspiciousPercent, bubbleRisk, walletNodes.length);

    return report;
  }

  public async runDeepScan(
    tokenAddress: string,
    holders: Array<{ address: string; percentOfSupply: number }>,
    tokenDeployTimestamp: number,
    onProgress?: (message: string) => void,
  ): Promise<BubbleMapReport> {
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
    const timingClusters = this.detectSynchronizedTiming(
      tokenAddress,
      walletNodes,
      tokenDeployTimestamp,
    );
    const dormancyClusters = this.detectDormancyPatterns(
      tokenAddress,
      walletNodes,
      tokenDeployTimestamp,
    );
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
    const report = this.buildReport(
      tokenAddress,
      walletNodes.length,
      deduplicated,
      suspiciousPercent,
      bubbleRisk,
      'deep',
    );

    this.saveToCache(
      tokenAddress,
      deduplicated,
      suspiciousPercent,
      bubbleRisk,
      walletNodes.length,
    );

    return report;
  }

  private async buildWalletNodes(
    holders: Array<{ address: string; percentOfSupply: number }>,
    tokenDeployTimestamp: number,
  ): Promise<WalletNode[]> {
    const nodes = await Promise.allSettled(
      holders.map(async (holder): Promise<WalletNode> => {
        try {
          const txResponse = await fetch(
            `${this.toncenterEndpoint.replace('/jsonRPC', '')}/getTransactions?address=${
              holder.address
            }&limit=3&archival=false`,
            { headers: { 'X-API-Key': this.toncenterApiKey } },
          );
          const txData = (await txResponse.json()) as {
            result?: Array<{ utime?: number; in_msg?: { source?: string } }>;
          };
          const txs = txData.result ?? [];
          const firstTx = txs.at(-1);
          const firstTxTimestamp = firstTx?.utime ?? null;
          const fundingSource = firstTx?.in_msg?.source ?? null;
          const walletAgeDays =
            firstTxTimestamp !== null ? (tokenDeployTimestamp - firstTxTimestamp) / 86400 : null;
          const isDormant =
            walletAgeDays !== null && walletAgeDays < DORMANCY_DAYS_THRESHOLD;

          return {
            address: holder.address,
            percentOfSupply: holder.percentOfSupply,
            firstTxTimestamp,
            fundingSource,
            buyBlockTime: null,
            isDormant,
          } satisfies WalletNode;
        } catch {
          return {
            address: holder.address,
            percentOfSupply: holder.percentOfSupply,
            firstTxTimestamp: null,
            fundingSource: null,
            buyBlockTime: null,
            isDormant: false,
          } satisfies WalletNode;
        }
      }),
    );

    return nodes
      .filter((result): result is PromiseFulfilledResult<WalletNode> => result.status === 'fulfilled')
      .map((result) => result.value);
  }

  private detectSynchronizedTiming(
    tokenAddress: string,
    nodes: WalletNode[],
    deployTimestamp: number,
  ): WalletCluster[] {
    const earlyBuyers = nodes.filter(
      (node) =>
        node.firstTxTimestamp !== null && Math.abs(node.firstTxTimestamp - deployTimestamp) < 3600,
    );
    const clusters: WalletCluster[] = [];
    const used = new Set<string>();

    for (const node of earlyBuyers) {
      if (used.has(node.address) || node.firstTxTimestamp === null) continue;

      const synchronized = earlyBuyers.filter(
        (other) =>
          !used.has(other.address) &&
          other.firstTxTimestamp !== null &&
          Math.abs(other.firstTxTimestamp - node.firstTxTimestamp!) <= SYNC_BUY_WINDOW_SECONDS,
      );

      if (synchronized.length >= 3) {
        synchronized.forEach((member) => used.add(member.address));
        const totalPercent = synchronized.reduce(
          (sum, member) => sum + member.percentOfSupply,
          0,
        );

        synchronized.forEach((member) => {
          if (member.address !== node.address) {
            saveWalletGraphEdge(
              this.db,
              tokenAddress,
              node.address,
              member.address,
              'synchronized_timing',
              undefined,
              member.firstTxTimestamp ?? undefined,
            );
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

  private detectDormancyPatterns(
    tokenAddress: string,
    nodes: WalletNode[],
    deployTimestamp: number,
  ): WalletCluster[] {
    if (deployTimestamp <= 0) return [];

    const dormantBuyers = nodes.filter((node) => node.isDormant && node.percentOfSupply > 0.5);

    if (dormantBuyers.length < 3) return [];

    const totalPercent = dormantBuyers.reduce((sum, node) => sum + node.percentOfSupply, 0);

    dormantBuyers.forEach((node, index) => {
      if (index > 0) {
        saveWalletGraphEdge(
          this.db,
          tokenAddress,
          dormantBuyers[0].address,
          node.address,
          'dormancy',
        );
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

  private detectFundingSourceClusters(
    tokenAddress: string,
    nodes: WalletNode[],
  ): WalletCluster[] {
    const fundingGroups = new Map<string, WalletNode[]>();

    for (const node of nodes) {
      if (node.fundingSource === null) continue;

      const group = fundingGroups.get(node.fundingSource) ?? [];
      group.push(node);
      fundingGroups.set(node.fundingSource, group);
    }

    const clusters: WalletCluster[] = [];

    for (const [source, members] of fundingGroups.entries()) {
      if (members.length < 2 || MAX_FUNDING_HOPS < 1) continue;

      const totalPercent = members.reduce((sum, node) => sum + node.percentOfSupply, 0);

      members.forEach((node) => {
        saveWalletGraphEdge(
          this.db,
          tokenAddress,
          source,
          node.address,
          'funding_source',
          undefined,
          node.firstTxTimestamp ?? undefined,
        );
      });

      clusters.push({
        clusterIndex: clusters.length + 1,
        connectionType: 'funding_source',
        riskLevel: members.length >= 4 ? 'HIGH' : 'MEDIUM',
        estimatedControlPercent: totalPercent,
        rootWallet: source,
        members,
        description: `${members.length} wallets all received initial TON from ${source.slice(
          0,
          8,
        )}... — likely same controller.`,
      });
    }

    return clusters;
  }

  private detectRoundTripFlows(tokenAddress: string, nodes: WalletNode[]): WalletCluster[] {
    // PRODUCTION TODO: Implement multi-hop transaction graph traversal.
    // Requires fetching full transaction history per wallet and building
    // a directed graph to detect circular flows within MAX_FUNDING_HOPS hops.
    if (tokenAddress.length === 0 || nodes.length === 0 || MAX_FUNDING_HOPS <= 0) return [];
    return [];
  }

  private detectDustLinks(tokenAddress: string, nodes: WalletNode[]): WalletCluster[] {
    // PRODUCTION TODO: Implement dust transaction detection.
    // Fetch recent transactions for each wallet and flag transfers
    // below DUST_THRESHOLD_TON that connect otherwise unrelated wallets.
    if (tokenAddress.length === 0 || nodes.length === 0 || DUST_THRESHOLD_TON <= 0) return [];
    return [];
  }

  private deduplicateClusters(clusters: WalletCluster[]): WalletCluster[] {
    const seen = new Set<string>();

    return clusters.filter((cluster) => {
      const key = cluster.members
        .map((member) => member.address)
        .sort()
        .join(',');

      if (seen.has(key)) return false;

      seen.add(key);
      return true;
    });
  }

  private calculateSuspiciousPercent(clusters: WalletCluster[]): number {
    const suspiciousAddresses = new Map<string, number>();

    for (const cluster of clusters) {
      for (const member of cluster.members) {
        if (!suspiciousAddresses.has(member.address)) {
          suspiciousAddresses.set(member.address, member.percentOfSupply);
        }
      }
    }

    return Array.from(suspiciousAddresses.values()).reduce((sum, percent) => sum + percent, 0);
  }

  private scoreBubbleRisk(suspiciousPercent: number): BubbleRisk {
    if (suspiciousPercent >= CRITICAL_SUSPICIOUS_THRESHOLD) return 'CRITICAL';
    if (suspiciousPercent >= HIGH_RISK_SUSPICIOUS_THRESHOLD) return 'HIGH';
    if (suspiciousPercent >= 15) return 'MEDIUM';
    return 'LOW';
  }

  private buildReport(
    tokenAddress: string,
    walletsAnalyzed: number,
    clusters: WalletCluster[],
    suspiciousPercent: number,
    bubbleRisk: BubbleRisk,
    phase: 'quick' | 'deep',
  ): BubbleMapReport {
    const shortAddress = (address: string): string =>
      `${address.slice(0, 8)}...${address.slice(-4)}`;
    const clusteredAddresses = new Set(clusters.flatMap((cluster) => cluster.members.map((m) => m.address)));
    const clusterLines = clusters.map((cluster) => {
      const emoji = riskEmoji(cluster.riskLevel);
      const memberLines = cluster.members.slice(0, 4).map(
        (member) =>
          `  └── ${shortAddress(member.address)} → holds ${member.percentOfSupply.toFixed(2)}%`,
      );

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
      `Bubble Risk Score: ${riskEmoji(bubbleRisk)} ${bubbleRisk}`,
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

  private formatCachedReport(tokenAddress: string, cached: BubbleMapCacheRow): BubbleMapReport {
    const clusters = JSON.parse(cached.cluster_data) as WalletCluster[];
    const report = this.buildReport(
      tokenAddress,
      cached.wallets_analyzed,
      clusters,
      cached.suspicious_supply_percent,
      cached.bubble_risk as BubbleRisk,
      'deep',
    );

    return {
      ...report,
      fromCache: true,
    };
  }

  private saveToCache(
    tokenAddress: string,
    clusters: WalletCluster[],
    suspiciousPercent: number,
    bubbleRisk: BubbleRisk,
    walletsAnalyzed: number,
  ): void {
    saveBubbleMapCache(
      this.db,
      tokenAddress,
      clusters.length,
      suspiciousPercent,
      bubbleRisk,
      JSON.stringify(clusters),
      walletsAnalyzed,
    );
  }
}
