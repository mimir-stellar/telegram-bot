/**
 * Inline keyboards attached to command and callback messages.
 *
 * Callback data is untrusted user input, so every payload here is one of the
 * small tokens `validateCallbackData` accepts (plus the pause-confirmation
 * tokens, which `handlePauseConfirmCallback` validates against its own set).
 */

import { InlineKeyboard } from "grammy";

import type { BotConfig } from "../config.js";

/** Callback data for the /pause confirmation buttons. */
export const CALLBACK_PAUSE_CONFIRM = "pause-confirm" as const;
export const CALLBACK_PAUSE_CANCEL = "pause-cancel" as const;

/** Status message keyboard: refresh, plus operator controls when configured. */
export function statusKeyboard(config?: BotConfig): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("🔄 Refresh", "status")
    .text("📋 Contracts", "contracts");
  if (config?.operatorTelegramUserId) {
    keyboard.row().text("⏸ Pause", "pause").text("▶ Resume", "resume");
  }
  return keyboard;
}

/** Contracts message keyboard: navigation back to status and help. */
export function contractsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Status", "status")
    .text("❓ Help", "help");
}

/** Operator controls keyboard attached to operator messages. */
export function operatorKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏸ Pause", "pause")
    .text("▶ Resume", "resume")
    .row()
    .text("📊 Status", "status");
}

/**
 * Confirmation keyboard for `/pause`. Pausing is disruptive enough to ask
 * twice: the prompt is a separate message whose buttons expire
 * (`PAUSE_CONFIRM_TTL_MS`), so a stale tap cannot stop polling later.
 */
export function pauseConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm pause", CALLBACK_PAUSE_CONFIRM)
    .text("❌ Cancel", CALLBACK_PAUSE_CANCEL);
}
