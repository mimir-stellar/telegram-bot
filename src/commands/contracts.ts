/**
 * `/contracts`: which two contracts this bot watches, and where to look each
 * one up independently — deliberately static (config only, no poller state),
 * so it answers the same whether the poller is mid-cycle, between restarts, or
 * wedged on a run of RPC failures. `/status` is for "is it working"; this is
 * for "what is it even watching".
 */

import { escapeMd } from "../notifications/format.js";
import { networkLabel, type BotConfig } from "../config.js";
import { contractExplorerUrl } from "../stellar/client.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

export function contractsMessage(config: BotConfig): string {
  const targets: Array<{ label: string; version: string; contractId: string }> = [
    {
      label: "mimir\\-market",
      version: config.marketContractVersion ?? "v1",
      contractId: config.marketContractId,
    },
    {
      label: "mimir\\-squad",
      version: config.squadContractVersion ?? "v1",
      contractId: config.squadContractId,
    },
  ];

  const lines: string[] = [
    `*Contracts* — Mimir on Stellar ${escapeMd(networkLabel(config))}`,
    "",
    "Read\\-only: this bot holds no signing keys and cannot submit transactions\\.",
  ];

  for (const target of targets) {
    lines.push(
      "",
      `*${target.label}* \\(${escapeMd(target.version ?? "v1")}\\)`,
      `\`${escapeMd(target.contractId)}\``,
      `[View on stellar\\.expert](${contractExplorerUrl(config, target.contractId)})`,
    );
  }

  return lines.join("\n");
}

export const contractsCommand = defineCommand({
  command: "contracts",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    await ctx.reply(contractsMessage(deps.config), TELEGRAM_OPTIONS);
  },
});
