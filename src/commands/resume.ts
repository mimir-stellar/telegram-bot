/**
 * `/resume`: start polling again now. Resuming is reversible and safe (it never
 * edits cursors), so it acts immediately instead of asking for confirmation.
 */

import { messagesFor, type Locale } from "../i18n.js";
import type { PollerResumeResult } from "../poller.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

export function resumeMessage(result: PollerResumeResult, locale?: Locale): string {
  const messages = messagesFor(locale).resumeMessages;
  switch (result) {
    case "resumed":
      return messages.resumed;
    case "already-running":
      return messages.alreadyRunning;
    case "stopped":
      return messages.stopped;
  }
}

export const resumeCommand = defineCommand({
  command: "resume",
  operatorOnly: true,
  handler: async (ctx, deps) => {
    const resume = deps.resume ?? (() => "stopped" as const);
    await ctx.reply(resumeMessage(resume(), deps.config.locale), TELEGRAM_OPTIONS);
  },
});
