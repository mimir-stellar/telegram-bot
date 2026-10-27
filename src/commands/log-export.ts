/**
 * `/export`: the recent redacted log ring, for the operator.
 *
 * Hidden from the command menu on purpose — it is a recovery tool, not part of
 * the bot's surface — but registered like any other command so it no longer
 * needs its own `bot.command("export", …)` in `createBot`.
 */

import { renderLogExport } from "../logger.js";
import { defineCommand } from "./registry.js";

export const logExportCommand = defineCommand({
  command: "export",
  hidden: true,
  operatorOnly: true,
  handler: async (ctx, deps) => {
    const { config, logs } = deps;
    if (!logs || logs.capacity() === 0) {
      await ctx.reply("Log export is disabled (LOG_BUFFER_LINES=0).");
      return;
    }
    // Plain text, no parse mode: the content is redacted but untrusted, and
    // MarkdownV2 would make any escaping slip a parsing error instead of a
    // cosmetic wart.
    await ctx.reply(renderLogExport(config, deps.status(), logs), {
      link_preview_options: { is_disabled: true },
    });
  },
});
