"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildEmergencySellKeyboard = buildEmergencySellKeyboard;
const telegraf_1 = require("telegraf");
function buildEmergencySellKeyboard(confirmationId) {
    return telegraf_1.Markup.inlineKeyboard([
        [
            telegraf_1.Markup.button.callback('Confirm emergency sell', `emergency_sell_confirm:${confirmationId}`),
            telegraf_1.Markup.button.callback('Cancel', `emergency_sell_cancel:${confirmationId}`),
        ],
    ]);
}
