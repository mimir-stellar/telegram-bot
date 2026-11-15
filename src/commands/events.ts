/**
 * `/events [page]`: bounded, paginated lookup over retained in-memory canonical
 * contract event summaries.
 *
 * Never reads or resolves filesystem paths; arguments are strictly validated as
 * 1-based positive page integers.
 */

import type { InlineKeyboard } from "grammy";

import { networkLabel, type BotConfig } from "../config.js";
import { clip, escapeMd } from "../notifications/format.js";
import { pageKeyboard, paginate } from "../notifications/pagination.js";
import {
  isCanonicalEventSummary,
  toCanonicalEventSummary,
  type CanonicalEventSummary,
} from "../recent-events.js";
import { defineCommand, type CommandDeps } from "./registry.js";
import { TELEGRAM_OPTIONS, commandArgument, replyMarkdown } from "./runtime.js";

/** Number of canonical event summaries rendered per page. */
export const EVENTS_PAGE_SIZE = 5;

/** Maximum accepted 1-based page number to bound numeric parsing. */
export const MAX_EVENTS_PAGE_NUMBER = 1_000;

export const EVENTS_USAGE_MESSAGE =
  "*Usage:* `/events [page]`\nProvide a positive page number \\(for example `/events` or `/events 2`\\)\\.";

export const EVENTS_PATH_REJECTED_MESSAGE =
  "*Invalid argument*\n`/events` queries retained in\\-memory event summaries only; file paths and external URIs are not accepted\\. Use `/events` or `/events <page>`\\.";

export type EventsPageArgResult =
  | { readonly ok: true; readonly page: number }
  | { readonly ok: false; readonly reason: "path-rejected" | "invalid-page" };

const PATH_LIKE_INPUT_RE =
  /[\\/]|^\.\.?(?:$|\s)|^~|^file:|^[A-Za-z]:|\.jsonl?\b|%2f|%5c|\0/i;

/**
 * Parse and validate an optional 1-based page number argument for `/events`.
 * Rejects path-like strings and any non-integer input without touching disk.
 */
export function parseEventsPageArg(raw?: string | null): EventsPageArgResult {
  if (typeof raw !== "string") {
    return { ok: true, page: 1 };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, page: 1 };
  }
  if (PATH_LIKE_INPUT_RE.test(trimmed)) {
    return { ok: false, reason: "path-rejected" };
  }
  if (!/^[1-9]\d{0,3}$/.test(trimmed)) {
    return { ok: false, reason: "invalid-page" };
  }
  const page = Number(trimmed);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_EVENTS_PAGE_NUMBER) {
    return { ok: false, reason: "invalid-page" };
  }
  return { ok: true, page };
}

/**
 * Resolve retained canonical event summaries from `deps.recentEvents()` with
 * fallback to `deps.status().targets[].lastEvent` when no dedicated ring was
 * injected.
 */
export function resolveRetainedEventSummaries(
  deps: Pick<CommandDeps, "config" | "status" | "recentEvents">,
): CanonicalEventSummary[] {
  if (typeof deps.recentEvents === "function") {
    const rawItems = deps.recentEvents() ?? [];
    const normalized: CanonicalEventSummary[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      normalized.push(
        isCanonicalEventSummary(item)
          ? item
          : toCanonicalEventSummary(item, deps.config),
      );
    }
    return normalized;
  }

  const status = deps.status();
  const fallback: CanonicalEventSummary[] = [];
  for (const target of status.targets ?? []) {
    if (target.lastEvent) {
      fallback.push(toCanonicalEventSummary(target.lastEvent, deps.config));
    }
  }
  fallback.sort((a, b) => b.ledger - a.ledger);
  return fallback;
}

function safeCodeSpan(text: string, maxChars: number = 64): string {
  const sanitized = clip(text.replace(/[`\\\r\n]+/g, " ").trim() || "unknown", maxChars);
  return `\`${sanitized}\``;
}

function escapeMarkdownLinkUrl(url: string): string {
  return url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
}

export interface RenderedEventsPage {
  readonly text: string;
  readonly page: number;
  readonly totalPages: number;
  readonly keyboard?: InlineKeyboard | undefined;
}

/**
 * Render a bounded MarkdownV2 page of canonical event summaries.
 */
export function eventsMessage(
  summaries: readonly CanonicalEventSummary[],
  config: BotConfig,
  requestedPage: number = 1,
): RenderedEventsPage {
  const net = escapeMd(networkLabel(config));

  if (summaries.length === 0) {
    return {
      text: `*Recent Events* — Stellar ${net}\n\nNo recent contract events retained in memory yet\\.`,
      page: 1,
      totalPages: 1,
    };
  }

  const pages = paginate(summaries, EVENTS_PAGE_SIZE);
  const totalPages = Math.max(1, pages.length);

  if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > totalPages) {
    const keyboard = totalPages > 1 ? pageKeyboard("events", totalPages - 1, totalPages) : undefined;
    return {
      text:
        `*Recent Events* — Stellar ${net}\n\n` +
        `Page ${escapeMd(String(requestedPage))} is out of range ` +
        `\\(available pages: 1–${escapeMd(String(totalPages))}, ` +
        `${escapeMd(String(summaries.length))} retained\\)\\.`,
      page: totalPages,
      totalPages,
      keyboard,
    };
  }

  const pageSlice = pages[requestedPage - 1] ?? [];
  const lines: string[] = [
    `*Recent Events* — Stellar ${net} ` +
      `\\(page ${escapeMd(String(requestedPage))}/${escapeMd(String(totalPages))}, ` +
      `${escapeMd(String(summaries.length))} retained\\)`,
    "",
  ];

  for (const item of pageSlice) {
    const linkPart = item.explorerUrl
      ? ` · [tx](${escapeMarkdownLinkUrl(item.explorerUrl)})`
      : "";
    lines.push(
      `• *mimir\\-${escapeMd(item.source)}* ${safeCodeSpan(item.eventName, 64)} · ` +
        `ledger ${escapeMd(String(item.ledger))}${linkPart}`,
      `  ${escapeMd(clip(item.summary, 140))}`,
    );
  }

  const keyboard =
    totalPages > 1 ? pageKeyboard("events", requestedPage - 1, totalPages) : undefined;

  return {
    text: lines.join("\n"),
    page: requestedPage,
    totalPages,
    keyboard,
  };
}

export const eventsCommand = defineCommand({
  command: "events",
  chatAllowlist: true,
  handler: async (ctx, deps) => {
    const rawArg = commandArgument(ctx);
    const parsed = parseEventsPageArg(rawArg);
    if (!parsed.ok) {
      const errorReply =
        parsed.reason === "path-rejected"
          ? EVENTS_PATH_REJECTED_MESSAGE
          : EVENTS_USAGE_MESSAGE;
      await replyMarkdown(ctx, errorReply);
      return;
    }

    const summaries = resolveRetainedEventSummaries(deps);
    const rendered = eventsMessage(summaries, deps.config, parsed.page);
    if (rendered.keyboard) {
      await ctx.reply(rendered.text, {
        ...TELEGRAM_OPTIONS,
        reply_markup: rendered.keyboard,
      });
      return;
    }
    await replyMarkdown(ctx, rendered.text);
  },
});

export {
  createRecentEventRing,
  DEFAULT_RECENT_EVENTS_CAPACITY,
  isCanonicalEventSummary,
  MAX_EVENT_SUMMARY_CHARS,
  toCanonicalEventSummary,
  type CanonicalEventSummary,
  type RecentEventRing,
} from "../recent-events.js";
