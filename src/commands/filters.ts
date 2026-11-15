/**
 * Active notification filters message builder and `/filters` command.
 *
 * Formats the active notification filters for the bot from effective config:
 * - Global settings: feature flags, enabled/disabled event types, category
 *   allowlists, silent-delivery events, and preview/link-preview defaults.
 * - Route-specific settings: default destination, fan-out destinations,
 *   per-contract overrides, and per-route preview overrides (redacted).
 *
 * Sensitive values (tokens, secrets, raw chat IDs) are redacted and all
 * dynamic values are escaped for MarkdownV2.
 */

import { escapeMd } from "../notifications/format.js";
import { redactText } from "../redact.js";
import { redactChatId } from "../status.js";
import type { BotConfig } from "../config.js";
import type { NotificationFeatureFlags } from "../notifications/featureFlags.js";
import { DEFAULT_FEATURE_FLAGS } from "../notifications/featureFlags.js";
import { defineCommand } from "./registry.js";
import { replyMarkdown } from "./runtime.js";

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

const MAX_DISPLAYED_CATEGORIES = 20;
const MAX_DISPLAYED_EVENTS = 20;
const MAX_DISPLAYED_ROUTES = 10;

/** Minimal configuration shape required by filtersMessage. */
export type FiltersConfig = Partial<
  Pick<
    BotConfig,
    | "featureFlags"
    | "notificationCategories"
    | "silentEvents"
    | "channelPreviewMode"
    | "linkPreviewMarket"
    | "linkPreviewSquad"
    | "chatId"
    | "chatIds"
    | "marketChatId"
    | "squadChatId"
    | "routes"
    | "botToken"
    | "healthAuthToken"
  >
>;

/**
 * Builds a MarkdownV2 formatted message describing the active notification filters.
 *
 * Under default configuration, renders an "all notifications enabled" line.
 * Explains global settings (applied across all routes before delivery) versus
 * route-specific settings (destination chats and per-route overrides), while
 * redacting sensitive values such as tokens and chat identifiers.
 */
export function filtersMessage(config: FiltersConfig = {}): string {
  const flags: NotificationFeatureFlags =
    config.featureFlags ?? DEFAULT_FEATURE_FLAGS;
  const categories = config.notificationCategories ?? [];
  const knownSecrets = [config.botToken, config.healthAuthToken].filter(
    (s): s is string => typeof s === "string" && s.length >= 4,
  );

  const sanitizeToken = (value: string, maxLen = 64): string => {
    const redacted = redactText(value, { secrets: knownSecrets, maxLen });
    return redacted.replace(/[\r\n`\\]+/g, " ").trim();
  };

  const isDefault =
    flags.enabled &&
    flags.market &&
    flags.squad &&
    categories.length === 0;

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

  lines.push(
    "_Global settings apply across every destination before routing; route\\-specific settings control target chats and per\\-route preview overrides\\._",
    "",
  );

  // Global Settings
  lines.push("*Global Settings*");
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
    const cappedCategories = categories.slice(0, MAX_DISPLAYED_CATEGORIES);
    const hiddenCategories = categories.length - cappedCategories.length;
    const formattedCategories = cappedCategories
      .map((c) => `\`${escapeMd(sanitizeToken(String(c)))}\``)
      .join(", ");
    const moreSuffix =
      hiddenCategories > 0 ? ` _\\(\\+${hiddenCategories} more\\)_` : "";
    lines.push(`· Categories: ${formattedCategories}${moreSuffix}`);
    lines.push("· Note: category filter applies only to `claim\\_created` events");
  } else {
    lines.push("· Categories: all allowed \\(no filter\\)");
  }

  if (config.silentEvents !== undefined) {
    if (config.silentEvents.length > 0) {
      const cappedSilent = config.silentEvents.slice(0, MAX_DISPLAYED_EVENTS);
      lines.push(
        `· Silent events \\(no sound\\): ${cappedSilent.map((e) => `\`${escapeMd(sanitizeToken(String(e)))}\``).join(", ")}`,
      );
    } else {
      lines.push("· Silent events \\(no sound\\): none");
    }
  }

  const globalPreview = config.channelPreviewMode === true ? "enabled" : "disabled";
  lines.push(`· Global channel preview mode: ${globalPreview}`);
  if (config.linkPreviewMarket !== undefined || config.linkPreviewSquad !== undefined) {
    const marketLink = config.linkPreviewMarket === true ? "enabled" : "disabled";
    const squadLink = config.linkPreviewSquad === true ? "enabled" : "disabled";
    lines.push(
      `· Link previews: mimir\\-market ${marketLink}, mimir\\-squad ${squadLink}`,
    );
  }
  lines.push("");

  // Route-Specific Settings (Chat Routing)
  lines.push("*Route\\-Specific Settings \\(Chat Routing\\)*");
  lines.push(`· Default chat: \`${escapeMd(redactChatId(defaultChat))}\``);

  const extraDefaultChats = (config.chatIds ?? []).filter(
    (id) => typeof id === "string" && id.trim() !== "" && id !== defaultChat,
  );
  if (extraDefaultChats.length > 0) {
    const cappedChats = extraDefaultChats.slice(0, MAX_DISPLAYED_ROUTES);
    const hiddenChats = extraDefaultChats.length - cappedChats.length;
    const renderedChats = cappedChats
      .map((id) => `\`${escapeMd(redactChatId(id))}\``)
      .join(", ");
    const chatMore = hiddenChats > 0 ? ` _\\(\\+${hiddenChats} more\\)_` : "";
    lines.push(`· Additional default chats: ${renderedChats}${chatMore}`);
  }

  if (config.marketChatId && config.marketChatId !== defaultChat) {
    lines.push(
      `· mimir\\-market chat: \`${escapeMd(redactChatId(marketChat))}\` \\(route override\\)`,
    );
  } else {
    lines.push("· mimir\\-market chat: inherits default route");
  }

  if (config.squadChatId && config.squadChatId !== defaultChat) {
    lines.push(
      `· mimir\\-squad chat: \`${escapeMd(redactChatId(squadChat))}\` \\(route override\\)`,
    );
  } else {
    lines.push("· mimir\\-squad chat: inherits default route");
  }

  const routes = Array.isArray(config.routes) ? config.routes : [];
  if (routes.length > 0) {
    const cappedRoutes = routes.slice(0, MAX_DISPLAYED_ROUTES);
    const hiddenRoutes = routes.length - cappedRoutes.length;
    for (const [idx, route] of cappedRoutes.entries()) {
      const routeChat = escapeMd(redactChatId(route?.chatId));
      const routePreview = route?.channelPreviewMode === true ? "enabled" : "disabled";
      lines.push(
        `· Route \\#${idx + 1}: \`${routeChat}\` — channel preview ${routePreview}`,
      );
    }
    if (hiddenRoutes > 0) {
      lines.push(`· _…and ${hiddenRoutes} additional route\\(s\\)_`);
    }
  } else {
    lines.push("· Per\\-route overrides: none \\(uses global preview mode\\)");
  }

  return lines.join("\n");
}

export const filtersCommand = defineCommand({
  command: "filters",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    await replyMarkdown(ctx, filtersMessage(deps.config));
  },
});
