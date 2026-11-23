/**
 * `/matchpreview <ref>`: show how many chats currently follow a given event
 * reference, so an operator can preview subscription delivery coverage without
 * triggering any notification or exposing chat identifiers.
 *
 * Usage: /matchpreview market:123
 *        /matchpreview squad:m1
 *
 * The reply reports only the count. Chat ids are never included in the
 * response so the command is safe to run in any operator context.
 *
 * Hidden from the command menu (operator recovery/diagnostic tool).
 */

import { escapeMd } from "../notifications/format.js";
import { parseRef } from "../subscriptions/store.js";
import { defineCommand } from "./registry.js";
import { commandArgument } from "./runtime.js";

/** MarkdownV2 response for a successful match count. */
export function matchPreviewMessage(ref: string, count: number): string {
  const escaped = escapeMd(ref);
  const chatWord = count === 1 ? "chat" : "chats";
  return `*Match preview* for \`${escaped}\`: *${count}* ${chatWord} subscribed\\.`;
}

/** MarkdownV2 response when the ref is not a valid market/squad reference. */
export function matchPreviewInvalidMessage(input: string): string {
  // Truncate and escape the input so a long or hostile string cannot blow up
  // the message. 64 chars is enough to identify any real ref.
  const safe = escapeMd(input.slice(0, 64));
  return (
    `*Match preview*: invalid ref \`${safe}\`\\.\n` +
    `Expected \`market:<id>\` or \`squad:<id>\`\\.`
  );
}

/** MarkdownV2 response when no ref argument was provided. */
export const MATCH_PREVIEW_USAGE =
  "*Match preview*: missing ref\\.\n" +
  "Usage: `/matchpreview market:<id>` or `/matchpreview squad:<id>`\\.";

export const matchPreviewCommand = defineCommand({
  command: "matchpreview",
  hidden: true,
  operatorOnly: true,
  handler: async (ctx, deps) => {
    const arg = commandArgument(ctx);

    if (!arg) {
      await ctx.reply(MATCH_PREVIEW_USAGE, {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    if (parseRef(arg) === null) {
      await ctx.reply(matchPreviewInvalidMessage(arg), {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    const count = deps.followStore ? deps.followStore.followersOf(arg).length : 0;

    await ctx.reply(matchPreviewMessage(arg, count), {
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  },
});
