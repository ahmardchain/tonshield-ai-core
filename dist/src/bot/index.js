"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTonShieldBot = createTonShieldBot;
const telegraf_1 = require("telegraf");
const commands_1 = require("./commands");
function createTonShieldBot(config, services) {
    const bot = new telegraf_1.Telegraf(config.telegramBotToken);
    (0, commands_1.registerCommands)(bot, { ...services, config });
    return bot;
}
