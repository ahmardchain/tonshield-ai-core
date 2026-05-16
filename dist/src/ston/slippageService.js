"use strict";
/**
 * SlippageService — User-controlled slippage resolution with priority cascade.
 *
 * Priority order for normal trades:
 * 1. Inline override from command (--slippage flag)
 * 2. Token-specific setting
 * 3. User global setting
 * 4. System default from Config
 *
 * Priority order for emergency auto-exits:
 * 1. User emergency_slippage setting
 * 2. Token-specific setting × EMERGENCY_MULTIPLIER
 * 3. User global setting × EMERGENCY_MULTIPLIER
 * 4. System default × EMERGENCY_MULTIPLIER (floor: EMERGENCY_FLOOR_BPS)
 *
 * All slippage values stored and resolved in basis points (BPS).
 * 1% = 100 BPS, 5% = 500 BPS, 25% = 2500 BPS.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlippageService = void 0;
exports.parseInlineSlippage = parseInlineSlippage;
exports.formatSlippageResolution = formatSlippageResolution;
const sqlite_1 = require("../db/sqlite");
// Hard limits
const MIN_SLIPPAGE_BPS = 10; // 0.1% minimum
const MAX_SLIPPAGE_BPS = 4900; // 49% maximum — above this warn sandwich risk
const SANDWICH_WARNING_BPS = 4900; // Warn at 49%
const EMERGENCY_MULTIPLIER = 2; // Double slippage for emergency exits
const EMERGENCY_FLOOR_BPS = 2500; // 25% minimum for emergency exits
const EMERGENCY_CEILING_BPS = 4900; // 49% maximum even for emergency exits
class SlippageService {
    db;
    config;
    constructor(db, config) {
        this.db = db;
        this.config = config;
    }
    resolveSlippage(userId, tokenAddress, inlineOverrideBps) {
        /**
         * Resolves the correct slippage for a normal trade
         * using the priority cascade.
         * Returns full resolution metadata for display in confirmation messages.
         */
        // Priority 1 — inline override from command
        if (inlineOverrideBps !== undefined) {
            return {
                slippageBps: inlineOverrideBps,
                slippagePercent: inlineOverrideBps / 100,
                source: 'inline',
                isEmergencyDoubled: false,
                sandwichWarning: inlineOverrideBps >= SANDWICH_WARNING_BPS,
            };
        }
        // Priority 2 — token-specific setting
        if (tokenAddress !== undefined && tokenAddress !== '') {
            const tokenSetting = (0, sqlite_1.getSlippageSetting)(this.db, userId, 'token', tokenAddress);
            if (tokenSetting !== undefined) {
                return {
                    slippageBps: tokenSetting.slippage_bps,
                    slippagePercent: tokenSetting.slippage_bps / 100,
                    source: 'token',
                    isEmergencyDoubled: false,
                    sandwichWarning: tokenSetting.slippage_bps >= SANDWICH_WARNING_BPS,
                };
            }
        }
        // Priority 3 — user global setting
        const globalSetting = (0, sqlite_1.getSlippageSetting)(this.db, userId, 'global');
        if (globalSetting !== undefined) {
            return {
                slippageBps: globalSetting.slippage_bps,
                slippagePercent: globalSetting.slippage_bps / 100,
                source: 'global',
                isEmergencyDoubled: false,
                sandwichWarning: globalSetting.slippage_bps >= SANDWICH_WARNING_BPS,
            };
        }
        // Priority 4 — system default from Config
        return {
            slippageBps: this.config.defaultSlippageBps,
            slippagePercent: this.config.defaultSlippageBps / 100,
            source: 'system_default',
            isEmergencyDoubled: false,
            sandwichWarning: this.config.defaultSlippageBps >= SANDWICH_WARNING_BPS,
        };
    }
    resolveEmergencySlippage(userId, tokenAddress) {
        /**
         * Resolves slippage for auto-triggered defensive exits.
         * Uses emergency setting if set, otherwise doubles normal slippage
         * with a floor of EMERGENCY_FLOOR_BPS and ceiling of EMERGENCY_CEILING_BPS.
         * This ensures emergency exits go through even during volatile pool conditions.
         */
        // Priority 1 — user emergency setting
        const emergencySetting = (0, sqlite_1.getSlippageSetting)(this.db, userId, 'emergency');
        if (emergencySetting !== undefined) {
            return {
                slippageBps: emergencySetting.slippage_bps,
                slippagePercent: emergencySetting.slippage_bps / 100,
                source: 'emergency',
                isEmergencyDoubled: false,
                sandwichWarning: emergencySetting.slippage_bps >= SANDWICH_WARNING_BPS,
            };
        }
        // Priority 2-4 — resolve normal slippage then double it
        const normal = this.resolveSlippage(userId, tokenAddress);
        const doubled = normal.slippageBps * EMERGENCY_MULTIPLIER;
        const clamped = Math.min(Math.max(doubled, EMERGENCY_FLOOR_BPS), EMERGENCY_CEILING_BPS);
        return {
            slippageBps: clamped,
            slippagePercent: clamped / 100,
            source: normal.source,
            isEmergencyDoubled: true,
            sandwichWarning: clamped >= SANDWICH_WARNING_BPS,
        };
    }
    setGlobalSlippage(userId, slippageBps) {
        /**
         * Sets the user's global slippage default.
         * Applies to all trades unless overridden by token-specific or inline setting.
         */
        (0, sqlite_1.upsertSlippageSetting)(this.db, userId, slippageBps, 'global');
    }
    setTokenSlippage(userId, tokenAddress, slippageBps) {
        /**
         * Sets token-specific slippage for a single token address.
         * Overrides global setting for all trades on this token.
         */
        (0, sqlite_1.upsertSlippageSetting)(this.db, userId, slippageBps, 'token', tokenAddress);
    }
    setEmergencySlippage(userId, slippageBps) {
        /**
         * Sets slippage used exclusively for auto-triggered defensive exits.
         * Recommended range: 2500-4900 BPS (25%-49%).
         * Lower values risk failed exits during fast rugs.
         */
        (0, sqlite_1.upsertSlippageSetting)(this.db, userId, slippageBps, 'emergency');
    }
    resetSlippage(userId, settingType, tokenAddress = '') {
        /**
         * Removes a slippage setting, falling back to the next priority level.
         */
        (0, sqlite_1.deleteSlippageSetting)(this.db, userId, settingType, tokenAddress);
    }
    getUserSlippageSummary(userId) {
        /**
         * Returns a formatted summary of all current slippage settings for a user.
         */
        const settings = (0, sqlite_1.getAllSlippageSettings)(this.db, userId);
        if (settings.length === 0) {
            return [
                '⚙️ Your Slippage Settings',
                '',
                'No custom settings configured.',
                `System default: ${this.config.defaultSlippageBps / 100}%`,
                '',
                'Use /slippage to configure.',
            ].join('\n');
        }
        const globalSetting = settings.find((setting) => setting.setting_type === 'global');
        const emergencySetting = settings.find((setting) => setting.setting_type === 'emergency');
        const tokenSettings = settings.filter((setting) => setting.setting_type === 'token');
        const lines = [
            '⚙️ Your Slippage Settings',
            '',
            `Global default:    ${globalSetting !== undefined
                ? `${globalSetting.slippage_bps / 100}%`
                : `${this.config.defaultSlippageBps / 100}% (system default)`}`,
            `Emergency exits:   ${emergencySetting !== undefined
                ? `${emergencySetting.slippage_bps / 100}%`
                : 'Auto (2× normal, min 25%)'}`,
        ];
        if (tokenSettings.length > 0) {
            lines.push('', 'Token-specific:');
            for (const setting of tokenSettings) {
                const short = `${setting.token_address.slice(0, 8)}...${setting.token_address.slice(-4)}`;
                lines.push(`  ${short}  →  ${setting.slippage_bps / 100}%`);
            }
        }
        lines.push('', 'Commands:', '/slippage <percent>            — set global default', '/slippage <token> <percent>    — set token-specific', '/emergency_slippage <percent>  — set emergency exit tolerance', '/slippage reset                — reset to system default');
        return lines.join('\n');
    }
    static validateSlippageInput(input) {
        /**
         * Parses and validates a slippage percentage string from user input.
         * Accepts formats: "5", "5%", "0.5", "15.5"
         * Rejects: negative values, above 49%, non-numeric input.
         */
        const cleaned = input.trim().replace('%', '');
        const parsed = parseFloat(cleaned);
        if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
            return {
                valid: false,
                slippageBps: 0,
                errorMessage: `Invalid slippage value "${input}". Please enter a number like 5 or 15.5`,
                sandwichWarning: false,
            };
        }
        if (parsed < MIN_SLIPPAGE_BPS / 100) {
            return {
                valid: false,
                slippageBps: 0,
                errorMessage: `Slippage too low. Minimum is ${MIN_SLIPPAGE_BPS / 100}% (${MIN_SLIPPAGE_BPS} BPS).`,
                sandwichWarning: false,
            };
        }
        if (parsed > MAX_SLIPPAGE_BPS / 100) {
            return {
                valid: false,
                slippageBps: 0,
                errorMessage: `Slippage too high. Maximum allowed is ${MAX_SLIPPAGE_BPS / 100}% to protect against sandwich attacks.`,
                sandwichWarning: false,
            };
        }
        const bps = Math.round(parsed * 100);
        return {
            valid: true,
            slippageBps: bps,
            sandwichWarning: bps >= SANDWICH_WARNING_BPS,
        };
    }
}
exports.SlippageService = SlippageService;
function parseInlineSlippage(args) {
    /**
     * Parses --slippage flag from command arguments.
     * Example: ["EQPool...", "EQToken...", "2", "--slippage", "15"]
     * Returns slippage in BPS if flag found and valid, undefined otherwise.
     */
    const flagIndex = args.findIndex((arg) => arg === '--slippage' || arg === '-s');
    if (flagIndex === -1 || flagIndex >= args.length - 1)
        return undefined;
    const value = args[flagIndex + 1];
    if (value === undefined)
        return undefined;
    const validation = SlippageService.validateSlippageInput(value);
    return validation.valid ? validation.slippageBps : undefined;
}
function formatSlippageResolution(resolution) {
    /**
     * Formats a slippage resolution for display in confirmation messages.
     * Shows the source so users know which setting is being applied.
     */
    const sourceLabel = {
        inline: 'one-time override',
        token: 'token setting',
        global: 'your global setting',
        emergency: 'your emergency setting',
        system_default: 'system default',
    };
    const doubled = resolution.isEmergencyDoubled ? ' (2× for emergency exit)' : '';
    const warning = resolution.sandwichWarning
        ? '\n⚠️ High slippage — sandwich attack risk. Consider using a lower value.'
        : '';
    return `${resolution.slippagePercent}% (${sourceLabel[resolution.source]}${doubled})${warning}`;
}
