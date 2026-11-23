/**
 * Active notification filters message builder.
 *
 * Formats the active notification filters for the bot:
 * - Enabled / disabled event types (derived from feature flags and contract sources)
 * - Claim category allowlists (from config.notificationCategories)
 * - Chat routing destinations (safely redacted with redactChatId)
 * - Per-chat digest scheduling preferences (when configured)
 *
 * All dynamic values are escaped with escapeMd.
 */

import { escapeMd } from "../notifications/format.js";
import { redactChatId } from "../status.js";
import type { BotConfig } from "../config.js";
import type { NotificationFeatureFlags } from "../notifications/featureFlags.js";
import { DEFAULT_FEATURE_FLAGS } from "../notifications/featureFlags.js";
import { defineCommand } from "./registry.js";
import { TELEGRAM_OPTIONS } from "./runtime.js";

/** Event types supported by mimir-market. */
export const MARKET_EVENT_TYPES = [
  "claim_created",
  "claim_challenged",
  "claim_resolved",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
] as const;

/** Event types supported by mimir-squad. */
export const SQUAD_EVENT_TYPES = [
  "market_created",
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
] as const;

/** Bounds for digest intervals, in minutes. */
export const DIGEST_INTERVAL_MIN_MINUTES = 5;
export const DIGEST_INTERVAL_MAX_MINUTES = 24 * 60;

/** Per-chat digest scheduling preference. */
export interface DigestPreference {
  /** Digest interval in minutes; must be within the bounded range. */
  intervalMinutes: number;
}

/** Minimal configuration shape required by filtersMessage. */
export type FiltersConfig = Partial<
  Pick<
    BotConfig,
    | "featureFlags"
    | "notificationCategories"
    | "chatId"
    | "chatIds"
    | "marketChatId"
    | "squadChatId"
    | "channelPreviewMode"
    | "routes"
  >
> & {
  /** Optional per-chat digest scheduling preferences, keyed by chat id. */
  digestPreferences?: Record<string, DigestPreference>;
};

/**
 * Validates a digest interval for a destination. Returns an error message
 * when invalid, or null when the interval is acceptable.
 */
export function validateDigestInterval(intervalMinutes: number): string | null {
  if (!Number.isFinite(intervalMinutes) || !Number.isInteger(intervalMinutes)) {
    return "digest interval must be an integer number of minutes";
  }
  if (intervalMinutes < DIGEST_INTERVAL_MIN_MINUTES) {
    return `digest interval must be at least ${DIGEST_INTERVAL_MIN_MINUTES} minutes`;
  }
  if (intervalMinutes > DIGEST_INTERVAL_MAX_MINUTES) {
    return `digest interval must be at most ${DIGEST_INTERVAL_MAX_MINUTES} minutes`;
  }
  return null;
}

/**
 * Builds a MarkdownV2 formatted message describing the active notification filters.
 *
 * Under default configuration, renders an "all notifications enabled" line.
 * When filters or gates are active, lists:
 * - Enabled/disabled event types
 * - Category allowlists
 * - Chat routing destinations (redacted)
 * - Digest scheduling preferences per chat (when present). Critical
 *   notifications are always delivered immediately and are not affected.
 */
export function filtersMessage(config: FiltersConfig = {}): string {
  const flags: NotificationFeatureFlags =
    config.featureFlags ?? DEFAULT_FEATURE_FLAGS;
  const categories = config.notificationCategories ?? [];
  const digestPreferences = config.digestPreferences ?? {};

  const isDefault =
    flags.enabled &&
    flags.market &&
    flags.squad &&
    categories.length === 0 &&
    Object.keys(digestPreferences).length === 0;

  const defaultChat = config.chatId ?? config.chatIds?.[0];
  const marketChat = config.marketChatId || defaultChat;
  const squadChat = config.squadChatId || defaultChat;

  const lines: string[] = [
    "*Active Notification Filters*",
    "",
  ];

  if (isDefault) {
    lines.push("All notifications are enabled\\.");
    lines.push("");
  }

  // Feature Flags / Status
  lines.push("*Feature Flags*");
  lines.push(`· Master switch: ${flags.enabled ? "enabled" : "disabled"}`);
  lines.push(`· mimir\\-market: ${flags.market ? "enabled" : "disabled"}`);
  lines.push(`· mimir\\-squad: ${flags.squad ? "enabled" : "disabled"}`);
  lines.push("");

  // Event Types
  const enabledEvents: string[] = [];
  const disabledEvents: string[] = [];

  for (const name of MARKET_EVENT_TYPES) {
    if (flags.enabled && flags.market) {
      enabledEvents.push(name);
    } else {
      disabledEvents.push(name);
    }
  }

  for (const name of SQUAD_EVENT_TYPES) {
    if (flags.enabled && flags.squad) {
      enabledEvents.push(name);
    } else {
      disabledEvents.push(name);
    }
  }

  lines.push("*Event Types*");
  if (enabledEvents.length > 0) {
    lines.push(
      `· Enabled \\(${enabledEvents.length}\\): ${enabledEvents.map((e) => `\`${escapeMd(e)}\``).join(", ")}`,
    );
  } else {
    lines.push("· Enabled: none");
  }

  if (disabledEvents.length > 0) {
    lines.push(
      `· Disabled \\(${disabledEvents.length}\\): ${disabledEvents.map((e) => `\`${escapeMd(e)}\``).join(", ")}`,
    );
  } else {
    lines.push("· Disabled: none");
  }
  lines.push("");

  // Category Allowlists
  lines.push("*Category Allowlist*");
  if (categories.length > 0) {
    lines.push(
      `· Categories: ${categories.map((c) => `\`${escapeMd(c)}\``).join(", ")}`,
    );
    lines.push("· Note: category filter applies only to `claim\\_created` events");
  } else {
    lines.push("· Categories: all allowed \\(no filter\\)");
  }
  lines.push("");

  // Chat Routing (global default vs route-specific overrides)
  lines.push("*Chat Routing*");
  lines.push("· Scope: feature flags and categories apply globally; chat destinations and preview mode can be route\\-specific\\.");
  lines.push(`· Default chat: \`${escapeMd(redactChatId(defaultChat))}\``);
  if (config.marketChatId && config.marketChatId !== defaultChat) {
    lines.push(`· mimir\\-market chat \\(route\\-specific\\): \`${escapeMd(redactChatId(marketChat))}\``);
  }
  if (config.squadChatId && config.squadChatId !== defaultChat) {
    lines.push(`· mimir\\-squad chat \\(route\\-specific\\): \`${escapeMd(redactChatId(squadChat))}\``);
  }

  const routes = config.routes ?? [];
  if (routes.length > 0) {
    lines.push(`· Per\\-chat routes \\(${routes.length}\\):`);
    for (const route of routes) {
      const previewLabel = route.channelPreviewMode ? "preview on" : "preview off";
      lines.push(`  \\- \`${escapeMd(redactChatId(route.chatId))}\`: ${previewLabel}`);
    }
  } else {
    const globalPreview = config.channelPreviewMode ? "preview on" : "preview off";
    lines.push(`· Per\\-chat routes: none \\(using global default, ${globalPreview}\\)`);
  }

  // Digest Scheduling (per chat)
  const digestChatIds = Object.keys(digestPreferences);
  if (digestChatIds.length > 0) {
    lines.push("");
    lines.push("*Digest Schedule*");
    for (const chatId of digestChatIds) {
      const pref = digestPreferences[chatId];
      const error = validateDigestInterval(pref.intervalMinutes);
      const label = error
        ? `invalid \\(${escapeMd(error)}\\)`
        : `every ${pref.intervalMinutes} min`;
      lines.push(`· \`${escapeMd(redactChatId(chatId))}\`: ${label}`);
    }
    lines.push("· Critical notifications are delivered immediately and are not batched");
  }

  return lines.join("\n");
}

export const filtersCommand = defineCommand({
  command: "filters",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    await ctx.reply(filtersMessage(deps.config), TELEGRAM_OPTIONS);
  },
});
