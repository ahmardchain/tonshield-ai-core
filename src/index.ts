import { TonClient } from '@ton/ton';
import { config } from './config/env';
import { createTonShieldBot } from './bot';
import { initializeDatabase } from './db/sqlite';
import { TriggerEngine } from './risk/triggerEngine';
import { VelocityGuard } from './risk/velocityGuard';
import { BubbleMapAnalyzer } from './safety/bubbleMap';
import { HolderAnalyzer } from './safety/holderAnalyzer';
import { PriceService } from './safety/priceService';
import { TokenSafetyScanner } from './safety/tokenScanner';
import { StonClient } from './ston/stonClient';
import { SlippageService } from './ston/slippageService';
import { StonFiExecutor } from './ston/swapBuilder';
import { AgentWalletService } from './wallet/agentWallet';
import { BudgetPolicyService } from './wallet/budgetPolicy';
import { WithdrawalEngine } from './wallet/withdrawalEngine';
import { MonitorWorker } from './workers/monitorWorker';

async function main(): Promise<void> {
  const db = initializeDatabase(config.databasePath);
  const tonClient = new TonClient({
    endpoint: config.toncenterEndpoint,
    apiKey: config.toncenterApiKey,
  });
  const stonClient = new StonClient(config);
  const budgetPolicy = new BudgetPolicyService(db);
  const slippageService = new SlippageService(db, config);
  const priceService = new PriceService(db, tonClient, stonClient);
  const agentWallet = new AgentWalletService({ db, config, tonClient });
  const withdrawalEngine = new WithdrawalEngine(db, config, tonClient, agentWallet);
  const tokenScanner = new TokenSafetyScanner({
    db,
    tonClient,
    stonClient,
    priceService,
    toncenterApiKey: config.toncenterApiKey,
    toncenterEndpoint: config.toncenterEndpoint,
  });
  const holderAnalyzer = new HolderAnalyzer(
    db,
    tonClient,
    config.toncenterApiKey,
    config.toncenterEndpoint,
  );
  const bubbleMapAnalyzer = new BubbleMapAnalyzer(
    db,
    config.toncenterApiKey,
    config.toncenterEndpoint,
  );
  const executor = new StonFiExecutor({
    db,
    config,
    tonClient,
    stonClient,
    budgetPolicy,
    agentWallet,
    slippageService,
  });
  const velocityGuard = new VelocityGuard(db, config.riskDropThresholdPercent);
  const bot = createTonShieldBot(config, {
    db,
    agentWallet,
    budgetPolicy,
    velocityGuard,
    stonClient,
    executor,
    tonClient,
    withdrawalEngine,
    tokenScanner,
    holderAnalyzer,
    bubbleMapAnalyzer,
    slippageService,
  });
  const triggerEngine = new TriggerEngine({
    db,
    config,
    telegram: {
      sendMessage: async (userId, message) => {
        await bot.telegram.sendMessage(userId, message);
      },
    },
    swapExecutor: executor,
  });
  const monitorWorker = new MonitorWorker({
    db,
    stonClient,
    velocityGuard,
    triggerEngine,
    intervalSeconds: config.monitorIntervalSeconds,
  });

  await bot.launch();
  monitorWorker.startMonitoring();

  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}; shutting down TonShield AI.`);
    monitorWorker.stopMonitoring();
    bot.stop(signal);
    db.close();
  };

  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown startup failure.';
  console.error(`TonShield AI failed to start: ${message}`);
  process.exitCode = 1;
});
