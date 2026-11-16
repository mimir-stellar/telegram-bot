/**
 * `/subpreview`: hidden operator-only dry-run preview of subscription delivery
 * matches for a `market:<id>` or `squad:<id>` event reference.
 *
 * Reports aggregate chat match counts only — never raw chat identifiers — and
 * sends zero notifications to subscribers.
 */

import { escapeMd } from "../notifications/format.js";
import {
  formatRef,
  parseRef,
  type SubscriptionMatchPreview,
} from "../subscriptions/store.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS, commandArgument, replyMarkdown } from "./runtime.js";

/**
 * Parses an operator-supplied event reference (`market:42`, `squad:7`, or
 * whitespace-separated `market 42`). Returns canonical `<kind>:<id>` or `null`.
 */
export function parseSubscriptionPreviewRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = parseRef(trimmed);
  if (direct) return formatRef(direct.kind, direct.id);

  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    const combined = `${parts[0]!.toLowerCase()}:${parts[1]!}`;
    const parsed = parseRef(combined);
    if (parsed) return formatRef(parsed.kind, parsed.id);
  }
  return null;
}

/**
 * Formats a MarkdownV2 summary of subscription match counts without exposing
 * any subscriber chat IDs.
 */
export function subscriptionPreviewMessage(preview: SubscriptionMatchPreview): string {
  const refEsc = escapeMd(preview.ref);
  const matchingEsc = escapeMd(String(preview.matchingChatCount));
  const trackedEsc = escapeMd(String(preview.totalTrackedChats));
  const totalEsc = escapeMd(String(preview.totalFollowEntries));

  return [
    "*Subscription Delivery Match Preview*",
    `Event reference: \`${refEsc}\``,
    `Matching chats: *${matchingEsc}*`,
    `Tracked chats: ${trackedEsc} \\(${totalEsc} total subscriptions\\)`,
    "_Dry\\-run preview only — no notifications were sent\\._",
  ].join("\n");
}

export const subPreviewCommand = defineCommand({
  command: "subpreview",
  hidden: true,
  operatorOnly: true,
  handler: async (ctx, deps) => {
    if (!deps.followStore) {
      await replyMarkdown(
        ctx,
        "*Subscription preview unavailable* — no follow store is configured\\.",
        TELEGRAM_OPTIONS,
      );
      return;
    }

    const arg = commandArgument(ctx);
    const canonicalRef = parseSubscriptionPreviewRef(arg);
    if (canonicalRef === null) {
      await replyMarkdown(
        ctx,
        "*Usage:* `/subpreview <market:id|squad:id>`",
        TELEGRAM_OPTIONS,
      );
      return;
    }

    const preview = deps.followStore.previewMatches(canonicalRef);
    await replyMarkdown(ctx, subscriptionPreviewMessage(preview), TELEGRAM_OPTIONS);
  },
});
