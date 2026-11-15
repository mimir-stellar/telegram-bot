/**
 * Operator maintenance broadcast command.
 *
 * Allows the operator to send an announcement to all configured notification chats
 * from a private chat session. Displays a confirmation preview with Confirm/Cancel
 * inline buttons, bounds the message length, expires pending confirmations, and
 * delivers plain text (no parse mode) to each unique configured chat with an
 * inter-send delay while reporting per-chat success.
 */

import { Bot, InlineKeyboard, type Context, type CommandContext } from "grammy";
import type { BotConfig } from "../config.js";
import { isOperator, safeAnswerCallback } from "./runtime.js";
import type { CommandDeps as BotDeps } from "./registry.js";
import { safeErrorMessage } from "../notifications/format.js";

/** Telegram Bot API maximum message length limit. */
export const MAX_BROADCAST_LENGTH = 4096;

/** Default expiration timeout for pending broadcast confirmations (5 minutes). */
export const DEFAULT_BROADCAST_EXPIRY_MS = 5 * 60 * 1000;

/** Default expiration timeout for pending pause confirmations (1 minute). */
export const DEFAULT_PAUSE_CONFIRM_EXPIRY_MS = 60_000;

/** Hard capacity limit for in-memory pending confirmations across operators. */
export const MAX_PENDING_CONFIRMATIONS = 25;

/** Maximum number of pending confirmations rendered in a single operator list view. */
export const MAX_PENDING_CONFIRMATION_LIST = 10;

/** Maximum single-line preview snippet length in pending confirmation listings. */
export const MAX_PENDING_SNIPPET_CHARS = 60;

/** Hard upper bound on rendered pending-confirmation list message size. */
export const MAX_PENDING_LIST_MESSAGE_LENGTH = 2048;

export const BROADCAST_USAGE_MESSAGE = "Usage: /broadcast <message>";
export const CONFIRMATIONS_USAGE_MESSAGE =
  "Usage: /confirmations [list | cancel <id|all>]";
export const BROADCAST_TOO_LONG_MESSAGE =
  "Broadcast message exceeds the maximum length of 4096 characters.";
export const BROADCAST_NO_CHATS_MESSAGE = "No notification chats configured.";

/**
 * Extracts and deduplicates all unique configured notification chats from config.
 * Chats come from TELEGRAM_CHAT_ID (chatId / chatIds), TELEGRAM_MARKET_CHAT_ID,
 * and TELEGRAM_SQUAD_CHAT_ID.
 */
export function getConfiguredBroadcastChats(
  config: Pick<BotConfig, "chatId"> &
    Partial<Pick<BotConfig, "chatIds" | "marketChatId" | "squadChatId">>,
): string[] {
  const candidates: string[] = [];
  if (Array.isArray(config.chatIds) && config.chatIds.length > 0) {
    candidates.push(...config.chatIds);
  } else if (config.chatId) {
    candidates.push(config.chatId);
  }
  if (config.marketChatId) {
    candidates.push(config.marketChatId);
  }
  if (config.squadChatId) {
    candidates.push(config.squadChatId);
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const raw of candidates) {
    const trimmed = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      unique.push(trimmed);
    }
  }

  // Fallback to process.env if config yielded no chats
  if (unique.length === 0 && typeof process !== "undefined" && process.env) {
    const envSources = [
      process.env.TELEGRAM_CHAT_ID,
      process.env.TELEGRAM_MARKET_CHAT_ID,
      process.env.TELEGRAM_SQUAD_CHAT_ID,
    ];
    for (const raw of envSources) {
      if (raw) {
        for (const part of raw.split(",")) {
          const trimmed = part.trim();
          if (trimmed.length > 0 && !seen.has(trimmed)) {
            seen.add(trimmed);
            unique.push(trimmed);
          }
        }
      }
    }
  }

  return unique;
}

export type PendingConfirmationKind = "broadcast" | "pause";

export interface PendingBroadcast {
  id: string;
  kind?: PendingConfirmationKind;
  operatorId: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  chats: readonly string[];
  confirmed: boolean;
}

/**
 * Redacted, chat-ID-free view of a single operator's pending confirmation.
 * Destination chat IDs are never included in summaries or cancellation output.
 */
export interface PendingConfirmationSummary {
  id: string;
  kind: PendingConfirmationKind;
  operatorId: string;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
  targetChatCount: number;
  snippet: string;
}

export interface PendingConfirmationListResult {
  items: PendingConfirmationSummary[];
  total: number;
  truncated: number;
}

export type CancelConfirmationResult = "cancelled" | "expired" | "not_found";

/**
 * Normalize and bound an operator message snippet for single-line display.
 * Control characters and line breaks are collapsed so multi-line prompts remain compact.
 */
export function sanitizeConfirmationSnippet(
  raw: string,
  maxChars: number = MAX_PENDING_SNIPPET_CHARS,
): string {
  const collapsed = raw.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  const limit = Math.max(1, Math.trunc(maxChars));
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= limit) {
    return collapsed;
  }
  return `${codePoints.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

export class BroadcastStore {
  private readonly items = new Map<string, PendingBroadcast>();
  private readonly pauseCancelledUntil = new Map<string, number>();
  private readonly defaultTtlMs: number;
  private readonly maxItems: number;
  private counter = 0;

  constructor(
    defaultTtlMs: number = DEFAULT_BROADCAST_EXPIRY_MS,
    maxItems: number = MAX_PENDING_CONFIRMATIONS,
  ) {
    this.defaultTtlMs = defaultTtlMs;
    this.maxItems = Math.max(1, Math.trunc(maxItems));
  }

  private nextId(now: number): string {
    this.counter = (this.counter + 1) % 1_000_000;
    return `${now.toString(36)}_${this.counter}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private enforceCapacity(): void {
    while (this.items.size >= this.maxItems) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) break;
      this.items.delete(oldestKey);
    }
  }

  private recordPauseCancelled(operatorId: string, cancelledAt: number): void {
    this.pauseCancelledUntil.delete(operatorId);
    this.pauseCancelledUntil.set(operatorId, cancelledAt);
    while (this.pauseCancelledUntil.size > this.maxItems) {
      const oldestKey = this.pauseCancelledUntil.keys().next().value;
      if (oldestKey === undefined) break;
      this.pauseCancelledUntil.delete(oldestKey);
    }
  }

  create(
    operatorId: string,
    message: string,
    chats: readonly string[],
    ttlMs?: number,
    now: number = Date.now(),
  ): PendingBroadcast {
    this.cleanup(now);
    this.enforceCapacity();
    const id = this.nextId(now);
    const item: PendingBroadcast = {
      id,
      kind: "broadcast",
      operatorId: String(operatorId),
      message,
      createdAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
      chats: [...chats],
      confirmed: false,
    };
    this.items.set(id, item);
    return item;
  }

  /**
   * Record a pending `/pause` confirmation for `operatorId` without storing any chat ID.
   * Replaces any earlier unconfirmed `/pause` entry for the same operator.
   */
  createPause(
    operatorId: string,
    ttlMs: number = DEFAULT_PAUSE_CONFIRM_EXPIRY_MS,
    now: number = Date.now(),
  ): PendingBroadcast {
    const owner = String(operatorId);
    this.cleanup(now);
    this.clearOperatorKind(owner, "pause");
    this.pauseCancelledUntil.delete(owner);
    this.enforceCapacity();
    const id = this.nextId(now);
    const item: PendingBroadcast = {
      id,
      kind: "pause",
      operatorId: owner,
      message: "Pause polling",
      createdAt: now,
      expiresAt: now + ttlMs,
      chats: [],
      confirmed: false,
    };
    this.items.set(id, item);
    return item;
  }

  get(id: string, now: number = Date.now()): PendingBroadcast | undefined {
    this.cleanup(now);
    return this.items.get(id);
  }

  /**
   * Return a bounded, expiry-annotated list of pending confirmations owned strictly
   * by `operatorId`. Never exposes other operators' actions or any target chat IDs.
   */
  listForOperator(
    operatorId: string,
    now: number = Date.now(),
    limit: number = MAX_PENDING_CONFIRMATION_LIST,
  ): PendingConfirmationListResult {
    const owner = String(operatorId);
    this.cleanup(now);

    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_PENDING_CONFIRMATION_LIST));
    const matching: PendingBroadcast[] = [];
    for (const item of this.items.values()) {
      if (!item.confirmed && item.operatorId === owner && item.expiresAt > now) {
        matching.push(item);
      }
    }

    matching.sort((a, b) => {
      if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id.localeCompare(b.id);
    });

    const items: PendingConfirmationSummary[] = matching.slice(0, safeLimit).map((item) => ({
      id: item.id,
      kind: item.kind ?? "broadcast",
      operatorId: item.operatorId,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      remainingMs: Math.max(0, item.expiresAt - now),
      targetChatCount: item.chats.length,
      snippet: sanitizeConfirmationSnippet(item.message),
    }));

    return {
      items,
      total: matching.length,
      truncated: Math.max(0, matching.length - items.length),
    };
  }

  /**
   * Explicitly cancel a pending confirmation owned by `operatorId`.
   * Confirmations belonging to any other operator return `"not_found"` untouched.
   */
  cancelForOperator(
    id: string,
    operatorId: string,
    now: number = Date.now(),
  ): CancelConfirmationResult {
    const owner = String(operatorId);
    const existing = this.items.get(id);
    if (!existing || existing.confirmed || existing.operatorId !== owner) {
      this.cleanup(now);
      return "not_found";
    }

    this.items.delete(id);
    if (existing.expiresAt <= now) {
      this.cleanup(now);
      return "expired";
    }

    if ((existing.kind ?? "broadcast") === "pause") {
      this.recordPauseCancelled(owner, now);
    }
    this.cleanup(now);
    return "cancelled";
  }

  /**
   * Cancel all unexpired pending confirmations owned by `operatorId`.
   * Leaves all other operators' entries untouched.
   */
  cancelAllForOperator(operatorId: string, now: number = Date.now()): number {
    const owner = String(operatorId);
    this.cleanup(now);
    let cancelled = 0;
    let cancelledPause = false;
    for (const [id, item] of this.items.entries()) {
      if (!item.confirmed && item.operatorId === owner) {
        if ((item.kind ?? "broadcast") === "pause") {
          cancelledPause = true;
        }
        this.items.delete(id);
        cancelled += 1;
      }
    }
    if (cancelledPause) {
      this.recordPauseCancelled(owner, now);
    }
    return cancelled;
  }

  /** Remove unconfirmed entries of `kind` for `operatorId` (e.g. after `/pause` resolves). */
  clearOperatorKind(operatorId: string, kind: PendingConfirmationKind): number {
    const owner = String(operatorId);
    let removed = 0;
    for (const [id, item] of this.items.entries()) {
      if (!item.confirmed && item.operatorId === owner && (item.kind ?? "broadcast") === kind) {
        this.items.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * True when `operatorId` explicitly cancelled a pending `/pause` confirmation at or
   * after `messageTimestampMs` within the active pause-confirmation TTL window.
   */
  isPauseCancelled(
    operatorId: string,
    messageTimestampMs: number,
    now: number = Date.now(),
    pauseTtlMs: number = DEFAULT_PAUSE_CONFIRM_EXPIRY_MS,
  ): boolean {
    const owner = String(operatorId);
    for (const [key, cancelledAt] of this.pauseCancelledUntil.entries()) {
      if (now - cancelledAt > pauseTtlMs) {
        this.pauseCancelledUntil.delete(key);
      }
    }
    const cancelledAt = this.pauseCancelledUntil.get(owner);
    return cancelledAt !== undefined && messageTimestampMs <= cancelledAt;
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  cleanup(now: number = Date.now()): void {
    for (const [id, item] of this.items.entries()) {
      if (item.expiresAt <= now) {
        this.items.delete(id);
      }
    }
    for (const [key, cancelledAt] of this.pauseCancelledUntil.entries()) {
      if (now - cancelledAt > DEFAULT_PAUSE_CONFIRM_EXPIRY_MS) {
        this.pauseCancelledUntil.delete(key);
      }
    }
  }

  clear(): void {
    this.items.clear();
    this.pauseCancelledUntil.clear();
  }

  size(): number {
    return this.items.size;
  }
}

export const defaultBroadcastStore = new BroadcastStore();

export function broadcastKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", `broadcast:confirm:${id}`)
    .text("❌ Cancel", `broadcast:cancel:${id}`);
}

export function pendingConfirmationsKeyboard(
  items: readonly PendingConfirmationSummary[],
): InlineKeyboard | undefined {
  const bounded = items
    .slice(0, MAX_PENDING_CONFIRMATION_LIST)
    .filter((item) => Buffer.byteLength(`broadcast:cancel:${item.id}`, "utf8") <= 64);
  if (bounded.length === 0) return undefined;

  const keyboard = new InlineKeyboard();
  bounded.forEach((item, index) => {
    if (index > 0) {
      keyboard.row();
    }
    keyboard.text(`❌ Cancel ${item.id}`, `broadcast:cancel:${item.id}`);
  });
  return keyboard;
}

function formatExpiryLabel(remainingMs: number, expiresAt: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const countdown = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  const isoUtc = new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `expires in ${countdown} (${isoUtc})`;
}

/**
 * Format a bounded plain-text list of the current operator's pending confirmations.
 * Never includes destination or other chat identifiers.
 */
export function formatPendingConfirmationsList(
  result: PendingConfirmationListResult,
): string {
  if (result.total === 0 || result.items.length === 0) {
    return "No pending confirmations.";
  }

  const lines: string[] = [
    `⏳ Pending confirmations (${result.items.length}/${result.total}):`,
  ];

  for (const item of result.items) {
    const expiry = formatExpiryLabel(item.remainingMs, item.expiresAt);
    const scope =
      item.kind === "broadcast"
        ? `broadcast (${item.targetChatCount} target chat(s))`
        : "pause";
    lines.push(`• [${item.id}] ${scope} — ${expiry} — "${item.snippet}"`);
  }

  if (result.truncated > 0) {
    lines.push(`…and ${result.truncated} more pending confirmation(s).`);
  }

  lines.push("Cancel with /confirmations cancel <id> or tap a button below.");

  const joined = lines.join("\n");
  if (joined.length <= MAX_PENDING_LIST_MESSAGE_LENGTH) {
    return joined;
  }
  return `${joined.slice(0, MAX_PENDING_LIST_MESSAGE_LENGTH - 1)}…`;
}

export function formatBroadcastPreview(message: string, chats: readonly string[]): string {
  const chatList = chats.map((c) => `• ${c}`).join("\n");
  return (
    `📢 Broadcast Preview\n\n` +
    `Target chats (${chats.length}):\n${chatList}\n\n` +
    `Message:\n${message}\n\n` +
    `Click Confirm to send or Cancel to abort.`
  );
}

export interface BroadcastResult {
  chatId: string;
  ok: boolean;
  error?: string;
}

export async function sendBroadcast(params: {
  api: { sendMessage: (chatId: string | number, text: string, options?: any) => Promise<any> };
  chats: readonly string[];
  message: string;
  interSendDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BroadcastResult[]> {
  const { api, chats, message, interSendDelayMs = 0 } = params;
  const sleepFn = params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const results: BroadcastResult[] = [];

  for (let i = 0; i < chats.length; i++) {
    const chatId = chats[i]!;
    if (i > 0 && interSendDelayMs > 0) {
      await sleepFn(interSendDelayMs);
    }
    try {
      // Plain text send: no parse_mode option specified
      await api.sendMessage(chatId, message, {
        link_preview_options: { is_disabled: true },
      });
      results.push({ chatId, ok: true });
    } catch (err) {
      const errMsg = safeErrorMessage(err);
      results.push({ chatId, ok: false, error: errMsg });
    }
  }

  return results;
}

export function formatBroadcastReport(results: readonly BroadcastResult[]): string {
  const succeeded = results.filter((r) => r.ok).length;
  const total = results.length;
  const lines: string[] = [
    `📢 Broadcast Results: ${succeeded}/${total} succeeded`,
    "",
  ];
  for (const r of results) {
    if (r.ok) {
      lines.push(`• ${r.chatId}: sent`);
    } else {
      lines.push(`• ${r.chatId}: failed (${r.error ?? "unknown error"})`);
    }
  }
  return lines.join("\n");
}

export interface BroadcastDeps {
  config: BotConfig;
  broadcastStore?: BroadcastStore;
  broadcastExpiryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const CONFIRMATION_ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

async function replyPendingList(
  ctx: Pick<Context, "reply">,
  store: BroadcastStore,
  operatorId: string,
  now: number,
): Promise<void> {
  const listing = store.listForOperator(operatorId, now);
  const keyboard = pendingConfirmationsKeyboard(listing.items);
  await ctx.reply(formatPendingConfirmationsList(listing), {
    ...(keyboard ? { reply_markup: keyboard } : {}),
    link_preview_options: { is_disabled: true },
  });
}

async function replyExplicitCancel(
  ctx: Pick<Context, "reply">,
  store: BroadcastStore,
  operatorId: string,
  targetToken: string,
  now: number,
): Promise<void> {
  if (targetToken.toLowerCase() === "all") {
    const cancelledCount = store.cancelAllForOperator(operatorId, now);
    if (cancelledCount === 0) {
      await ctx.reply("No pending confirmations to cancel.");
    } else {
      await ctx.reply(`❌ Cancelled ${cancelledCount} pending confirmation(s).`);
    }
    return;
  }

  if (!CONFIRMATION_ID_TOKEN.test(targetToken)) {
    await ctx.reply("⚠️ Invalid confirmation identifier.");
    return;
  }

  const outcome = store.cancelForOperator(targetToken, operatorId, now);
  if (outcome === "cancelled") {
    await ctx.reply(`❌ Cancelled pending confirmation ${targetToken}.`);
    return;
  }
  if (outcome === "expired") {
    await ctx.reply(`⚠️ Pending confirmation ${targetToken} has already expired.`);
    return;
  }
  await ctx.reply("⚠️ Pending confirmation not found or already processed.");
}

/**
 * Handle `/confirmations [list | cancel <id|all>]` command.
 * Restricted to the configured operator in private chats only.
 */
export async function handleConfirmationsCommand(
  ctx: CommandContext<Context>,
  deps: Pick<BotDeps, "config"> & {
    broadcastStore?: BroadcastStore | undefined;
    now?: (() => number) | undefined;
  },
): Promise<void> {
  const { config } = deps;
  const isPrivate = ctx.chat?.type === "private";

  if (!isOperator(ctx, config) || !isPrivate) {
    console.warn(`[bot] ignored unauthorized /confirmations on update ${ctx.update?.update_id}`);
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const now = deps.now ? deps.now() : Date.now();
  const operatorId = String(ctx.from?.id ?? "");

  const rawText = ctx.message?.text ?? "";
  const match = rawText.match(/^\/confirmations(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const argText = (match?.[1] ?? (typeof ctx.match === "string" ? ctx.match : "")).trim();

  if (!argText || argText.toLowerCase() === "list" || argText.toLowerCase() === "pending") {
    await replyPendingList(ctx, store, operatorId, now);
    return;
  }

  const cancelMatch = argText.match(/^cancel\s+(\S+)$/i);
  if (cancelMatch?.[1]) {
    await replyExplicitCancel(ctx, store, operatorId, cancelMatch[1], now);
    return;
  }

  await ctx.reply(CONFIRMATIONS_USAGE_MESSAGE);
}

/**
 * Handle /broadcast <message> command (plus bounded pending list/cancel subcommands).
 * Restricted to operator in private chats only.
 */
export async function handleBroadcastCommand(
  ctx: CommandContext<Context>,
  deps: Pick<BotDeps, "config"> & {
    broadcastStore?: BroadcastStore | undefined;
    broadcastExpiryMs?: number | undefined;
    now?: (() => number) | undefined;
  },
): Promise<void> {
  const { config } = deps;
  const isPrivate = ctx.chat?.type === "private";

  if (!isOperator(ctx, config) || !isPrivate) {
    console.warn(`[bot] ignored unauthorized /broadcast on update ${ctx.update?.update_id}`);
    return;
  }

  const rawText = ctx.message?.text ?? "";
  const match = rawText.match(/^\/broadcast(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const text = (match?.[1] ?? "").trim();

  if (!text) {
    await ctx.reply(BROADCAST_USAGE_MESSAGE);
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const now = deps.now ? deps.now() : Date.now();
  const operatorId = String(ctx.from?.id ?? "");

  const lower = text.toLowerCase();
  if (lower === "list" || lower === "pending" || lower === "--list" || lower === "--pending") {
    await replyPendingList(ctx, store, operatorId, now);
    return;
  }

  const cancelSub = text.match(/^(?:cancel|--cancel)\s+([A-Za-z0-9_-]{1,64})$/i);
  if (cancelSub?.[1]) {
    await replyExplicitCancel(ctx, store, operatorId, cancelSub[1], now);
    return;
  }

  if (text.length > MAX_BROADCAST_LENGTH) {
    await ctx.reply(BROADCAST_TOO_LONG_MESSAGE);
    return;
  }

  const chats = getConfiguredBroadcastChats(config);
  if (chats.length === 0) {
    await ctx.reply(BROADCAST_NO_CHATS_MESSAGE);
    return;
  }

  const pending = store.create(
    operatorId,
    text,
    chats,
    deps.broadcastExpiryMs,
    now,
  );

  const previewText = formatBroadcastPreview(text, chats);
  const keyboard = broadcastKeyboard(pending.id);

  await ctx.reply(previewText, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Handle confirmation, cancellation, or pending-list callback queries for broadcast.
 */
export async function handleBroadcastCallback(
  ctx: Context,
  deps: BotDeps & {
    broadcastStore?: BroadcastStore | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  },
  rawAction: string,
): Promise<void> {
  const { config } = deps;
  const chatType = ctx.chat?.type ?? (ctx.callbackQuery?.message as any)?.chat?.type;
  const isPrivate = chatType === "private";

  if (!isOperator(ctx, config) || !isPrivate) {
    console.warn(
      `[bot] ignored unauthorized broadcast callback on update ${ctx.update?.update_id}`,
    );
    await safeAnswerCallback(ctx, config, {
      text: "Unauthorized: operator in private chat only",
      show_alert: true,
    });
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const now = deps.now ? deps.now() : Date.now();
  const actorId = String(ctx.from?.id ?? "");

  const parts = rawAction.split(":");
  const subAction = parts[1];

  if (subAction === "list" && parts.length === 2) {
    const listing = store.listForOperator(actorId, now);
    const listText = formatPendingConfirmationsList(listing);
    const keyboard = pendingConfirmationsKeyboard(listing.items);
    await safeAnswerCallback(ctx, config, { text: "Pending confirmations" });
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(listText, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
          link_preview_options: { is_disabled: true },
        });
        return;
      } catch {
        // fall through to reply
      }
    }
    await ctx.reply(listText, {
      ...(keyboard ? { reply_markup: keyboard } : {}),
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  const broadcastId = parts[2];

  if (!broadcastId || (subAction !== "confirm" && subAction !== "cancel")) {
    await safeAnswerCallback(ctx, config, { text: "Invalid broadcast action" });
    return;
  }

  if (subAction === "cancel") {
    const targetKind = store.get(broadcastId, now)?.kind ?? "broadcast";
    const cancelOutcome = store.cancelForOperator(broadcastId, actorId, now);
    if (cancelOutcome === "not_found") {
      await safeAnswerCallback(ctx, config, {
        text: "Broadcast expired or already processed",
        show_alert: true,
      });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText("⚠️ Broadcast confirmation expired or already processed.");
        } catch {
          // ignore edit failure
        }
      }
      return;
    }
    if (cancelOutcome === "expired") {
      await safeAnswerCallback(ctx, config, {
        text: "Broadcast confirmation expired",
        show_alert: true,
      });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText("⚠️ Broadcast confirmation expired.");
        } catch {
          // ignore
        }
      }
      return;
    }

    const cancelledLabel =
      targetKind === "pause" ? "Confirmation cancelled" : "Broadcast cancelled";
    const cancelledBody =
      targetKind === "pause" ? "❌ Confirmation cancelled." : "❌ Broadcast cancelled.";
    await safeAnswerCallback(ctx, config, { text: cancelledLabel });
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(cancelledBody);
      } catch {
        // ignore
      }
    }
    return;
  }

  const pending = store.get(broadcastId, now);

  if (!pending || pending.operatorId !== actorId || (pending.kind ?? "broadcast") !== "broadcast") {
    await safeAnswerCallback(ctx, config, {
      text: "Broadcast expired or already processed",
      show_alert: true,
    });
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText("⚠️ Broadcast confirmation expired or already processed.");
      } catch {
        // ignore edit failure
      }
    }
    return;
  }

  if (now > pending.expiresAt) {
    store.delete(broadcastId);
    await safeAnswerCallback(ctx, config, {
      text: "Broadcast confirmation expired",
      show_alert: true,
    });
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText("⚠️ Broadcast confirmation expired.");
      } catch {
        // ignore
      }
    }
    return;
  }

  // subAction === "confirm"
  // Each chat receives the message at most once per confirmation.
  if (pending.confirmed) {
    await safeAnswerCallback(ctx, config, {
      text: "Broadcast already in progress or sent",
      show_alert: true,
    });
    return;
  }
  pending.confirmed = true;
  store.delete(broadcastId);

  await safeAnswerCallback(ctx, config, { text: "Broadcasting message..." });

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(`⏳ Broadcasting to ${pending.chats.length} chat(s)...`);
    } catch {
      // ignore
    }
  }

  const interSendDelayMs = config.interSendDelayMs ?? 1500;
  const results = await sendBroadcast({
    api: ctx.api,
    chats: pending.chats,
    message: pending.message,
    interSendDelayMs,
    sleep: deps.sleep,
  });

  const report = formatBroadcastReport(results);
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(report);
      return;
    } catch {
      // fallback to reply
    }
  }
  await ctx.reply(report);
}

/**
 * Register broadcast and pending-confirmation command handlers on a bot.
 */
export function registerBroadcastHandlers(
  bot: Bot | {
    command: (name: string, handler: (ctx: CommandContext<Context>) => Promise<void>) => void;
  },
  deps: BotDeps & { broadcastStore?: BroadcastStore | undefined },
): void {
  bot.command("broadcast", async (ctx: CommandContext<Context>) => {
    await handleBroadcastCommand(ctx, deps);
  });
  bot.command("confirmations", async (ctx: CommandContext<Context>) => {
    await handleConfirmationsCommand(ctx, deps);
  });
}
