/**
 * `/follows`: list all active follow subscriptions for this chat.
 */

import { escapeMd } from "../notifications/format.js";
import { FollowStoreError } from "../subscriptions/store.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

export const followsCommand = defineCommand({
  command: "follows",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "");

    if (!deps.followStore) {
      await ctx.reply(
        `⚠️ *Follows is not available* — the follow store is not configured\\.`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    try {
      const refs = deps.followStore.list(chatId);
      if (refs.length === 0) {
        await ctx.reply(
          `ℹ️ *No active follows* for this chat\\.\n\nUse /follow \\<ref\\> to subscribe\\.`,
          TELEGRAM_OPTIONS,
        );
      } else {
        const lines = refs.map((ref) => `• \`${escapeMd(ref)}\``).join("\n");
        await ctx.reply(
          `*Active follows* \\(${escapeMd(String(refs.length))}\\):\n\n${lines}\n\nUse /unfollow \\<ref\\> to remove one\\.`,
          TELEGRAM_OPTIONS,
        );
      }
    } catch (err) {
      if (err instanceof FollowStoreError) {
        await ctx.reply(
          `⚠️ *Could not read follows* — please try again later\\.`,
          TELEGRAM_OPTIONS,
        );
        console.warn(`[bot] /follows store error for chat ${chatId}: ${err.message}`);
      } else {
        await ctx.reply(
          `⚠️ *Could not read follows* — please try again later\\.`,
          TELEGRAM_OPTIONS,
        );
        console.error(`[bot] /follows unexpected error for chat ${chatId}:`, err);
      }
    }
  },
});
