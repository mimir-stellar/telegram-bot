/**
 * `/preview [market|squad]`: render a sample notification with the current
 * formatting and link-preview settings, so an operator can check a channel's
 * look without waiting for a live event.
 */

import { COMMAND_DESCRIPTIONS } from "../i18n.js";
import { previewMessage } from "../notifications/format.js";
import { createCommandModule } from "./registry.js";
import { TELEGRAM_OPTIONS, commandArgument } from "./runtime.js";

export const previewCommand = createCommandModule({
  command: "preview",
  description: COMMAND_DESCRIPTIONS.preview,
  operatorOnly: false,
  // Reveals channel formatting settings: only answered in ALLOWED_CHAT_IDS.
  allowlisted: true,
  handle: async (ctx, deps) => {
    const target = commandArgument(ctx) || "market";
    await ctx.reply(previewMessage(deps.config, target), TELEGRAM_OPTIONS);
  },
});
