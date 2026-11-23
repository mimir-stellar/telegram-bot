/**
 * `/about`: what this process is, which network it watches, and what version
 * it runs. Config-only, so it never depends on poller or RPC state.
 */

import { escapeMd } from "../notifications/format.js";
import { networkLabel, type BotConfig } from "../config.js";
import { defineCommand } from "./registry.js";
import { replyMarkdown } from "./runtime.js";

const REPOSITORY_URL = "https://github.com/example/stellar-bot";

export function aboutMessage(config: BotConfig, version: string): string {
  const network = networkLabel(config);
  return [
    `*Stellar Bot*`,
    ``,
    `Version: ${escapeMd(version)}`,
    `Network: ${escapeMd(network)}`,
    `Repository: ${escapeMd(REPOSITORY_URL)}`,
  ].join("\n");
}

export const aboutCommand = defineCommand({
  command: "about",
  handler: async (ctx, deps) => {
    await replyMarkdown(ctx, aboutMessage(deps.config, deps.version ?? "unknown"));
  },
});
