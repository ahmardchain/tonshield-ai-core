import { Markup } from 'telegraf';

export function buildEmergencySellKeyboard(confirmationId: string) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Confirm emergency sell', `emergency_sell_confirm:${confirmationId}`),
      Markup.button.callback('Cancel', `emergency_sell_cancel:${confirmationId}`),
    ],
  ]);
}
