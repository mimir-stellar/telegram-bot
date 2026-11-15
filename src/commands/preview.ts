/**
 * `/preview [market|squad]`: render a sample notification with the current
 * formatting and link-preview settings, so an operator can check a channel's
 * look without waiting for a live event.
 */

import { previewMessage } from "../notifications/format.js";
import { renderPendingDigestForCommand } from "./digest-preview.js";
import { defineCommand } from "./registry.js";
import {
  TELEGRAM_OPTIONS,
  commandArgument,
  operatorAllowed,
  replyMarkdown,
} from "./runtime.js";

export const previewCommand = defineCommand({
  command: "preview",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const target = commandArgument(ctx) || "market";
    if (target.trim().toLowerCase() === "digest") {
      if (!operatorAllowed(ctx, deps.config, "preview")) return;
      await replyMarkdown(ctx, renderPendingDigestForCommand(deps));
      return;
    }
    await ctx.reply(previewMessage(deps.config, target), TELEGRAM_OPTIONS);
  },
});
