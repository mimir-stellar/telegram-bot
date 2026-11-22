/**
 * `/digestpreview [grouped|flat]`: operator-only preview of the current
 * pending digest window.
 *
 * Renders pending events through the live `formatDigest` builder without
 * consuming or mutating the pending buffer. Protected by the central
 * `operatorOnly` authorization gate in `src/bot.ts` and hidden from the public
 * command menu.
 */

import { previewPendingDigest } from "../notifications/digest-preview.js";
import { defineCommand } from "./registry.js";
import { commandArgument, replyMarkdown } from "./runtime.js";

/** MarkdownV2 response when no pending digest window is configured on deps. */
export const DIGEST_PREVIEW_UNAVAILABLE =
  "🧪 *Digest Preview*\n\n_No pending digest window is configured\\._";

export const digestPreviewCommand = defineCommand({
  command: "digestpreview",
  hidden: true,
  operatorOnly: true,
  handler: async (ctx, deps) => {
    const window = deps.digestWindow;
    if (!window) {
      await replyMarkdown(ctx, DIGEST_PREVIEW_UNAVAILABLE);
      return;
    }

    const arg = commandArgument(ctx).trim().toLowerCase();
    const grouped = arg === "grouped" ? true : arg === "flat" ? false : undefined;
    const preview = previewPendingDigest(
      window,
      grouped !== undefined ? { grouped } : {},
    );
    await replyMarkdown(ctx, preview.message);
  },
});
