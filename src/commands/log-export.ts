/**
 * `/export`: the recent redacted log ring, for the operator.
 *
 * Hidden from the command menu on purpose — it is a recovery tool, not part of
 * the bot's surface — but registered like any other command so it no longer
 * needs its own `bot.command("export", …)` in `createBot`.
 */

import { InputFile } from "grammy";

import {
  TELEGRAM_MESSAGE_MAX_CHARS,
  formatLogExportCaption,
  renderLogExportWithMeta,
} from "../logger.js";
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
    const now = Date.now();
    const { text, meta } = renderLogExportWithMeta(config, deps.status(), logs, { now });

    // Inline replies are rejected by Telegram above 4,096 characters; send
    // larger exports as a plain-text document attachment within Telegram's
    // document size limit while keeping lightweight test stubs compatible.
    if (text.length > TELEGRAM_MESSAGE_MAX_CHARS && typeof ctx.replyWithDocument === "function") {
      const payload = Buffer.from(text, "utf8");
      const caption = formatLogExportCaption(config, meta, now);
      await ctx.replyWithDocument(new InputFile(payload, "mimir-log-export.txt"), {
        caption,
      });
      return;
    }

    // Plain text, no parse mode: the content is redacted but untrusted, and
    // MarkdownV2 would make any escaping slip a parsing error instead of a
    // cosmetic wart.
    await ctx.reply(text, {
      link_preview_options: { is_disabled: true },
    });
  },
});
