/**
 * `/preview [market|squad]`: render a sample notification with the current
 * formatting and link-preview settings, so an operator can check a channel's
 * look without waiting for a live event.
 *
 * `/preview routes [market|squad]` (or `/preview routing ...`) reports the
 * routing decision for a sample event without calling Telegram sendMessage.
 * It goes through the same decision path as live delivery.
 */

import { previewMessage } from "../notifications/format.js";
import { previewRouting } from "../config.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS, commandArgument } from "./runtime.js";

export const previewCommand = defineCommand({
  command: "preview",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const argument = commandArgument(ctx);
    const [first, ...rest] = argument.split(/\s+/).filter(Boolean);
    if (first === "routes" || first === "routing") {
      const target = rest[0] === "squad" ? "squad" : "market";
      const report = previewRouting(deps.config, target);
      const lines = [
        `Routing preview (${report.contract}), nothing sent:`,
        `matched: ${report.matched.join(", ") || "none"}`,
        `filtered: ${report.filtered.join(", ") || "none"}`,
        `unavailable: ${report.unavailable.length}`,
      ];
      await ctx.reply(lines.join("\n"), TELEGRAM_OPTIONS);
      return;
    }
    const target = argument || "market";
    await ctx.reply(previewMessage(deps.config, target), TELEGRAM_OPTIONS);
  },
});
