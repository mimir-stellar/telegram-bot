/**
 * `/unfollow <ref>`: remove a follow subscription from this chat.
 */

import { escapeMd } from "../notifications/format.js";
import { FollowStoreError, parseRef } from "../subscriptions/store.js";
import { defineCommand } from "./registry.js";
import { commandArgument, TELEGRAM_OPTIONS } from "./runtime.js";

export const unfollowCommand = defineCommand({
  command: "unfollow",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "");
    const arg = commandArgument(ctx);

    if (!arg) {
      await ctx.reply(
        `*Usage:* /unfollow \\<ref\\>\n` +
          `Example: /unfollow market:abc\n\n` +
          `Use /follows to list active subscriptions\\.`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    if (parseRef(arg) === null) {
      await ctx.reply(
        `⚠️ *Invalid ref:* ${escapeMd(arg)}\n\n` +
          `A ref must be in the form \`kind:id\`, where kind is \`market\` or \`squad\`\\.`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    if (!deps.followStore) {
      await ctx.reply(
        `⚠️ *Unfollow is not available* — the follow store is not configured\\.`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    try {
      const removed = deps.followStore.unfollow(chatId, arg);
      if (removed) {
        await ctx.reply(
          `✅ *Unfollowed* \`${escapeMd(arg)}\`\\.`,
          TELEGRAM_OPTIONS,
        );
      } else {
        await ctx.reply(
          `ℹ️ This chat was not following \`${escapeMd(arg)}\`\\.`,
          TELEGRAM_OPTIONS,
        );
      }
    } catch (err) {
      if (err instanceof FollowStoreError) {
        await ctx.reply(
          `⚠️ *Could not remove follow* — please try again later\\.`,
          TELEGRAM_OPTIONS,
        );
        console.warn(`[bot] /unfollow store error for chat ${chatId}: ${err.message}`);
      } else {
        await ctx.reply(
          `⚠️ *Could not remove follow* — please try again later\\.`,
          TELEGRAM_OPTIONS,
        );
        console.error(`[bot] /unfollow unexpected error for chat ${chatId}:`, err);
      }
    }
  },
});
