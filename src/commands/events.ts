/**
 * `/events` command: list recent notifications the bot delivered.
 *
 * Renders the last N (default 10, max 30) delivered events as one-line
 * summaries with explorer links, newest first. Supports `/events market` or
 * `/events squad` filtering. Output is split with `splitTelegramMessage`
 * when it exceeds Telegram's message ceiling. Memory use is bounded by the
 * backing ring buffer (see src/notifications/recent.ts).
 */

import { type CommandContext, type Context } from "grammy";
import { escapeMd, splitTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "../notifications/format.js";
import { txExplorerUrl } from "../stellar/client.js";
import { isUsableTxHash } from "../stellar/decode.js";
import type { BotConfig } from "../config.js";
import type { ContractSource } from "../stellar/decode.js";
import { RecentEvents, recentEvents, type RecentEvent } from "../notifications/recent.js";

export const DEFAULT_EVENTS_LIMIT = 10;
export const MAX_EVENTS_LIMIT = 30;

export interface EventsCommandOptions {
  /** "market" | "squad" filter; undefined shows both. */
  source?: ContractSource;
  limit?: number;
}

function normalizeLimit(limit: unknown): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? limit : DEFAULT_EVENTS_LIMIT;
  return Math.min(Math.max(n, 1), MAX_EVENTS_LIMIT);
}

function clipEventName(name: string): string {
  const MAX = 80;
  return name.length > MAX ? name.slice(0, MAX) : name;
}

function renderEventLine(event: RecentEvent, config: BotConfig): string {
  const name = escapeMd(clipEventName(event.eventName));
  const source = escapeMd(event.source);
  let line = `mimir-${source}`;
  if (event.marketId !== undefined) line += ` #${event.marketId}`;
  line += ` ${name} at ledger ${event.ledger}`;
  const url = event.txHash && isUsableTxHash(event.txHash) ? txExplorerUrl(config, event.txHash) : null;
  if (url) line += ` · [tx](${url})`;
  return line;
}

/**
 * Renders the recent-events message text. Callers split the result with
 * `splitTelegramMessage` before sending.
 */
export function eventsMessage(
  recent: RecentEvents,
  config: BotConfig,
  options: EventsCommandOptions = {},
): string {
  const limit = normalizeLimit(options.limit);
  const events = recent.list({ source: options.source, limit });
  const lines: string[] = [];
  lines.push(options.source ? `*Recent ${options.source} events*` : "*Recent events*");
  lines.push("");
  if (events.length === 0) {
    lines.push("No recent events\\.");
    return lines.join("\n");
  }
  for (const event of events) {
    lines.push(`• ${renderEventLine(event, config)}`);
  }
  return lines.join("\n");
}

/** Builds the `/events` command handler bound to a buffer and config. */
export function createEventsHandler(
  recent: RecentEvents,
  config: BotConfig,
): (ctx: CommandContext<Context>) => Promise<void> {
  return async (ctx) => {
    const allowed = config.allowedChatIds.length === 0 || config.allowedChatIds.includes(String(ctx.chat.id));
    if (!allowed) return;
    const text = ctx.message?.text ?? "";
    const spaceIndex = text.indexOf(" ");
    const arg = spaceIndex !== -1 ? text.slice(spaceIndex + 1).trim() : "";
    let source: ContractSource | undefined;
    if (arg === "market" || arg === "squad") source = arg;

    const body = eventsMessage(recent, config, { source });
    const parts = splitTelegramMessage(body, TELEGRAM_MAX_MESSAGE_LENGTH);
    for (const part of parts) {
      await ctx.reply(part, { link_preview_options: { is_disabled: true } });
    }
  };
}

/** Default handler bound to the process-wide buffer and a resolved config. */
export function createDefaultEventsHandler(config: BotConfig): (ctx: CommandContext<Context>) => Promise<void> {
  return createEventsHandler(recentEvents, config);
}
