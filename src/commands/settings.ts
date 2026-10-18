/**
 * Operator settings panel with inline toggles.
 *
 * Lets the operator view and toggle notification feature flags at runtime
 * without restarting the bot or modifying environment configuration.
 * Gated to operator-only in private chat.
 */

import { InlineKeyboard, type Context } from "grammy";
import type { BotConfig } from "../config.js";
import {
  getEffectiveFeatureFlags,
  getFlagOverrides,
  type NotificationFeatureFlags,
} from "../notifications/featureFlags.js";

export function canAccessSettings(
  ctx: Pick<Context, "from" | "chat">,
  config: BotConfig,
): boolean {
  const operatorId = config.operatorTelegramUserId;
  const isOp = operatorId !== null && ctx.from?.id.toString() === operatorId;
  const isPrivate = ctx.chat?.type === "private";
  return isOp && isPrivate;
}

export function settingsKeyboard(
  flags?: NotificationFeatureFlags,
): InlineKeyboard {
  const current = flags ?? getEffectiveFeatureFlags(undefined);
  const kb = new InlineKeyboard();

  const enabledLabel = current.enabled ? "🔔 Notifications: ON" : "🔕 Notifications: OFF";
  const enabledNext = current.enabled ? 0 : 1;
  kb.text(enabledLabel, `set:enabled:${enabledNext}`).row();

  const marketLabel = current.market ? "📈 Market: ON" : "📉 Market: OFF";
  const marketNext = current.market ? 0 : 1;
  kb.text(marketLabel, `set:market:${marketNext}`);

  const squadLabel = current.squad ? "👥 Squad: ON" : "👤 Squad: OFF";
  const squadNext = current.squad ? 0 : 1;
  kb.text(squadLabel, `set:squad:${squadNext}`);

  return kb;
}

export function settingsMessage(config: BotConfig): string {
  const flags = getEffectiveFeatureFlags(config.featureFlags);
  const overrides = getFlagOverrides();
  const overrideCount = Object.keys(overrides).length;

  const lines = [
    "*Operator Settings — Notification Flags*",
    "",
    "Toggle notification types at runtime\\. Overrides take effect immediately without process restart\\.",
    "",
    `• *Master Switch*: ${flags.enabled ? "✅ Enabled" : "❌ Disabled"}`,
    `• *Market Events*: ${flags.market ? "✅ Enabled" : "❌ Disabled"}`,
    `• *Squad Events*: ${flags.squad ? "✅ Enabled" : "❌ Disabled"}`,
  ];

  if (overrideCount > 0) {
    const summary = Object.entries(overrides)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    lines.push("", `Active overrides \\(${overrideCount}\\): \`${summary}\``);
  } else {
    lines.push("", "_No active overrides \\(using env defaults\\)_");
  }

  return lines.join("\n");
}
