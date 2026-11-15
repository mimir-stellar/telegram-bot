/**
 * `/pause`: stop new polling cycles — but only after the operator confirms.
 *
 * Pausing is disruptive and the command is one keystroke away from `/help`, so
 * the command answers with a confirmation prompt instead of acting. The prompt
 * expires (`PAUSE_CONFIRM_TTL_MS`) and its callbacks are handled by
 * `handlePauseConfirmCallback`, so a stale message cannot stop the poller later.
 * Cursors are never touched; the current scan may still finish.
 */

import { PAUSE_CONFIRM_TTL_MS, pauseConfirmationId } from "../confirmation-store.js";
import { messagesFor, type Locale } from "../i18n.js";
import type { PollerPauseResult } from "../poller.js";
import { pauseConfirmKeyboard } from "./keyboards.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

/** Operator-facing text for the pause confirmation prompt. */
export const PAUSE_PROMPT =
  "⏸ *Pause polling?*\nThis will stop new scans from starting\\. The current scan may finish\\.";

/** Exact operator replies, exported for deterministic Telegram payload tests. */
export function pauseMessage(result: PollerPauseResult, locale?: Locale): string {
  const messages = messagesFor(locale).pauseMessages;
  switch (result) {
    case "paused":
      return messages.paused;
    case "already-paused":
      return messages.alreadyPaused;
    case "stopped":
      return messages.stopped;
  }
}

export const pauseCommand = defineCommand({
  command: "pause",
  operatorOnly: true,
  handler: async (ctx, deps) => {
    const sent = await ctx.reply(PAUSE_PROMPT, {
      ...TELEGRAM_OPTIONS,
      reply_markup: pauseConfirmKeyboard(),
    });
    if (ctx.from?.id !== undefined && ctx.chat?.id !== undefined && deps.confirmationStore) {
      const sentMsg = sent as { message_id?: number; date?: number } | undefined;
      if (typeof sentMsg?.message_id === "number" || typeof sentMsg?.date === "number") {
        const now = deps.now ? deps.now() : Date.now();
        deps.confirmationStore.issue({
          id: pauseConfirmationId(sentMsg),
          actorId: String(ctx.from.id),
          chatId: String(ctx.chat.id),
          action: "pause",
          ttlMs: PAUSE_CONFIRM_TTL_MS,
          now,
        });
      }
    }
  },
});
