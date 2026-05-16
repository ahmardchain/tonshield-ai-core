import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import type { Config } from '../config/env';
import type { BotCommandServices } from './commands';
import { registerCommands } from './commands';

export function createTonShieldBot(
  config: Config,
  services: Omit<BotCommandServices, 'config'>,
): Telegraf<Context> {
  const bot = new Telegraf<Context>(config.telegramBotToken);
  registerCommands(bot, { ...services, config });
  return bot;
}
