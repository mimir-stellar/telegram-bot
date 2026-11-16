/**
 * `/follow`, `/unfollow`, and `/following`: authenticated per-chat market and
 * squad subscription commands backed by `FollowStore`.
 *
 * Authorization is enforced centrally via `chatAllowlist: true` (`ALLOWED_CHAT_IDS`),
 * and every read/write is strictly scoped to `String(ctx.chat.id)` so one chat
 * can never inspect or mutate another chat's subscriptions.
 */

import { escapeMd } from "../notifications/format.js";
import {
  FollowStoreError,
  formatRef,
  parseRef,
  type RefKind,
} from "../subscriptions/store.js";
import { defineCommand } from "./registry.js";
import { commandArgument, replyMarkdown } from "./runtime.js";

/**
 * Parse a user-supplied subscription target such as `market:42`, `squad:7`,
 * `market 42`, or `squad 7` into its canonical `<kind>:<id>` form, or return
 * `null` when malformed or containing extra tokens.
 */
export function parseFollowCommandArg(rawArg: string): string | null {
  const trimmed = rawArg.trim();
  if (!trimmed) return null;

  const direct = parseRef(trimmed);
  if (direct !== null) {
    return formatRef(direct.kind, direct.id);
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    const kind = parts[0]?.toLowerCase();
    const id = parts[1] ?? "";
    if (kind === "market" || kind === "squad") {
      const candidate = formatRef(kind as RefKind, id);
      if (parseRef(candidate) !== null) {
        return candidate;
      }
    }
  }

  return null;
}

function escapeCodeSpan(text: string): string {
  return text.replace(/[\\`]/g, "\\$&");
}

export function followingMessage(refs: readonly string[]): string {
  if (refs.length === 0) {
    return (
      "*Followed markets & squads \\(0\\)*\n" +
      "No active subscriptions in this chat\\. Use `/follow market:<id>` or `/follow squad:<id>` to subscribe\\."
    );
  }
  const lines = [`*Followed markets & squads \\(${refs.length}\\)*`];
  for (const ref of refs) {
    lines.push(`• \`${escapeCodeSpan(ref)}\``);
  }
  return lines.join("\n");
}

function unavailableMessage(): string {
  return (
    "*Subscriptions unavailable*\n" +
    "Persisted follow storage is not configured on this bot instance\\."
  );
}

function followUsageMessage(command: "follow" | "unfollow"): string {
  return (
    `*Usage:* \`/${command} <market:id|squad:id>\`\n` +
    `Example: \`/${command} market:42\` or \`/${command} squad:7\``
  );
}

function formatQuotaOrStoreError(err: FollowStoreError): string {
  if (/per-chat follow limit reached/i.test(err.message)) {
    return (
      `*Chat follow limit reached*\n` +
      `${escapeMd(err.message)}\\. Use \`/following\` and \`/unfollow <ref>\` in this chat before adding another\\.`
    );
  }
  if (/total follow limit reached/i.test(err.message)) {
    return (
      `*Global follow limit reached*\n` +
      `${escapeMd(err.message)}\\. No new subscriptions can be added until existing follows are removed\\.`
    );
  }
  return `*Subscription error*\n${escapeMd(err.message)}`;
}

export const followCommand = defineCommand({
  command: "follow",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    if (ctx.chat?.id === undefined) return;
    const store = deps.followStore;
    if (!store) {
      await replyMarkdown(ctx, unavailableMessage());
      return;
    }

    const canonicalRef = parseFollowCommandArg(commandArgument(ctx));
    if (canonicalRef === null) {
      await replyMarkdown(ctx, followUsageMessage("follow"));
      return;
    }

    const chatId = String(ctx.chat.id);
    try {
      const created = store.follow(chatId, canonicalRef);
      const count = store.list(chatId).length;
      const headline = created ? "*Subscribed*" : "*Already subscribed*";
      await replyMarkdown(
        ctx,
        `${headline} to \`${escapeCodeSpan(canonicalRef)}\`\nActive follows in this chat: *${count}*`,
      );
    } catch (err) {
      if (err instanceof FollowStoreError) {
        await replyMarkdown(ctx, formatQuotaOrStoreError(err));
        return;
      }
      throw err;
    }
  },
});

export const unfollowCommand = defineCommand({
  command: "unfollow",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    if (ctx.chat?.id === undefined) return;
    const store = deps.followStore;
    if (!store) {
      await replyMarkdown(ctx, unavailableMessage());
      return;
    }

    const canonicalRef = parseFollowCommandArg(commandArgument(ctx));
    if (canonicalRef === null) {
      await replyMarkdown(ctx, followUsageMessage("unfollow"));
      return;
    }

    const chatId = String(ctx.chat.id);
    const removed = store.unfollow(chatId, canonicalRef);
    if (!removed) {
      await replyMarkdown(
        ctx,
        `Not currently following \`${escapeCodeSpan(canonicalRef)}\` in this chat\\.`,
      );
      return;
    }
    const count = store.list(chatId).length;
    await replyMarkdown(
      ctx,
      `*Unsubscribed* from \`${escapeCodeSpan(canonicalRef)}\`\nActive follows in this chat: *${count}*`,
    );
  },
});

export const followingCommand = defineCommand({
  command: "following",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    if (ctx.chat?.id === undefined) return;
    const store = deps.followStore;
    if (!store) {
      await replyMarkdown(ctx, unavailableMessage());
      return;
    }

    if (commandArgument(ctx).length > 0) {
      await replyMarkdown(
        ctx,
        "*Usage:* `/following`\nLists only the subscriptions belonging to this chat\\.",
      );
      return;
    }

    const chatId = String(ctx.chat.id);
    const refs = store.list(chatId);
    await replyMarkdown(ctx, followingMessage(refs));
  },
});
