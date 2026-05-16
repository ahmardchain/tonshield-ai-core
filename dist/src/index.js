"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ton_1 = require("@ton/ton");
const env_1 = require("./config/env");
const bot_1 = require("./bot");
const sqlite_1 = require("./db/sqlite");
const triggerEngine_1 = require("./risk/triggerEngine");
const velocityGuard_1 = require("./risk/velocityGuard");
const bubbleMap_1 = require("./safety/bubbleMap");
const holderAnalyzer_1 = require("./safety/holderAnalyzer");
const priceService_1 = require("./safety/priceService");
const tokenScanner_1 = require("./safety/tokenScanner");
const stonClient_1 = require("./ston/stonClient");
const slippageService_1 = require("./ston/slippageService");
const swapBuilder_1 = require("./ston/swapBuilder");
const agentWallet_1 = require("./wallet/agentWallet");
const budgetPolicy_1 = require("./wallet/budgetPolicy");
const withdrawalEngine_1 = require("./wallet/withdrawalEngine");
const monitorWorker_1 = require("./workers/monitorWorker");
async function main() {
    const db = (0, sqlite_1.initializeDatabase)(env_1.config.databasePath);
    const tonClient = new ton_1.TonClient({
        endpoint: env_1.config.toncenterEndpoint,
        apiKey: env_1.config.toncenterApiKey,
    });
    const stonClient = new stonClient_1.StonClient(env_1.config);
    const budgetPolicy = new budgetPolicy_1.BudgetPolicyService(db);
    const slippageService = new slippageService_1.SlippageService(db, env_1.config);
    const priceService = new priceService_1.PriceService(db, tonClient, stonClient);
    const agentWallet = new agentWallet_1.AgentWalletService({ db, config: env_1.config, tonClient });
    const withdrawalEngine = new withdrawalEngine_1.WithdrawalEngine(db, env_1.config, tonClient, agentWallet);
    const tokenScanner = new tokenScanner_1.TokenSafetyScanner({
        db,
        tonClient,
        stonClient,
        priceService,
        toncenterApiKey: env_1.config.toncenterApiKey,
        toncenterEndpoint: env_1.config.toncenterEndpoint,
    });
    const holderAnalyzer = new holderAnalyzer_1.HolderAnalyzer(db, tonClient, env_1.config.toncenterApiKey, env_1.config.toncenterEndpoint);
    const bubbleMapAnalyzer = new bubbleMap_1.BubbleMapAnalyzer(db, env_1.config.toncenterApiKey, env_1.config.toncenterEndpoint);
    const executor = new swapBuilder_1.StonFiExecutor({
        db,
        config: env_1.config,
        tonClient,
        stonClient,
        budgetPolicy,
        agentWallet,
        slippageService,
    });
    const velocityGuard = new velocityGuard_1.VelocityGuard(db, env_1.config.riskDropThresholdPercent);
    const bot = (0, bot_1.createTonShieldBot)(env_1.config, {
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
    const triggerEngine = new triggerEngine_1.TriggerEngine({
        db,
        config: env_1.config,
        telegram: {
            sendMessage: async (userId, message) => {
                await bot.telegram.sendMessage(userId, message);
            },
        },
        swapExecutor: executor,
    });
    const monitorWorker = new monitorWorker_1.MonitorWorker({
        db,
        stonClient,
        velocityGuard,
        triggerEngine,
        intervalSeconds: env_1.config.monitorIntervalSeconds,
    });
    await bot.launch();
    monitorWorker.startMonitoring();
    const shutdown = (signal) => {
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
