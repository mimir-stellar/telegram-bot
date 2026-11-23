/**
 * `/follow <ref>`: subscribe this chat to on-chain notifications for a market
 * or squad reference (e.g. `market:abc` or `squad:xyz`).
 *
 * Quota exhaustion is reported with actionable guidance:
 *   - Per-chat limit: the user is told how many follows the chat already holds
 *     and that they must /unfollow something before adding another.
 *   - Global limit: the installation-wide cap is reached; the user is told to
 *     contact the operator rather than being given an opaque error.
 *
 * The persisted store is never mutated on a rejected request (the FollowStore
 * enforces this internally — both quota checks run before any write).
 */

import { escapeMd } from "../notifications/format.js";
import { FollowStoreError, parseRef } from "../subscriptions/store.js";
import { defineCommand } from "./registry.js";
import { commandArgument, TELEGRAM_OPTIONS } from "./runtime.js";

/** Identify whether a FollowStoreError is per-chat or global quota exhaustion. */
function quotaKind(err: FollowStoreError): "per-chat" | "global" | null {
  if (err.message.includes("per-chat follow limit reached")) return "per-chat";
  if (err.message.includes("total follow limit reached")) return "global";
  return null;
}

/** Extract the numeric limit from a quota error message like "… reached (N)". */
function extractLimit(message: string): number | null {
  const match = /\((\d+)\)/.exec(message);
  return match ? Number(match[1]) : null;
}

export function followQuotaMessage(err: FollowStoreError, _chatId: string): string {
  const kind = quotaKind(err);
  const limit = extractLimit(err.message);
  const limitText = limit !== null ? ` \\(${escapeMd(String(limit))}\\)` : "";

  if (kind === "per-chat") {
    return (
      `⚠️ *Follow limit reached for this chat*${limitText}\n` +
      `This chat has used all of its follow slots\\.\n` +
      `Use /unfollow to remove a subscription, then try again\\.`
    );
  }

  if (kind === "global") {
    return (
      `⚠️ *Global follow limit reached*${limitText}\n` +
      `This installation cannot accept more follows right now\\.\n` +
      `Contact the operator to increase the limit or free up space\\.`
    );
  }

  // Unexpected FollowStoreError (e.g. corrupt file) — do not expose internals.
  return `⚠️ *Could not add follow* — please try again later\\.`;
}

export const followCommand = defineCommand({
  command: "follow",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "");
    const arg = commandArgument(ctx);

    if (!arg) {
      await ctx.reply(
        `*Usage:* /follow \\<ref\\>\n` +
          `Example: /follow market:abc\n\n` +
          `Supported ref kinds: market, squad\\.`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    if (parseRef(arg) === null) {
      await ctx.reply(
        `⚠️ *Invalid ref:* ${escapeMd(arg)}\n\n` +
          `A ref must be in the form \`kind:id\`, where kind is \`market\` or \`squad\`\n` +
          `and id contains no spaces or special characters\\.\n\n` +
          `Example: /follow market:abc`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    if (!deps.followStore) {
      await ctx.reply(
        `⚠️ *Follow is not available* — the follow store is not configured\\.`,
        TELEGRAM_OPTIONS,
      );
      return;
    }

    try {
      const added = deps.followStore.follow(chatId, arg);
      if (added) {
        await ctx.reply(
          `✅ *Following* \`${escapeMd(arg)}\`\nThis chat will receive notifications for this ref\\.`,
          TELEGRAM_OPTIONS,
        );
      } else {
        await ctx.reply(
          `ℹ️ Already following \`${escapeMd(arg)}\`\\.`,
          TELEGRAM_OPTIONS,
        );
      }
    } catch (err) {
      if (err instanceof FollowStoreError) {
        await ctx.reply(followQuotaMessage(err, chatId), TELEGRAM_OPTIONS);
        console.warn(`[bot] /follow quota rejected for chat ${chatId}: ${err.message}`);
      } else {
        await ctx.reply(
          `⚠️ *Could not add follow* — please try again later\\.`,
          TELEGRAM_OPTIONS,
        );
        console.error(`[bot] /follow unexpected error for chat ${chatId}:`, err);
      }
    }
  },
});
