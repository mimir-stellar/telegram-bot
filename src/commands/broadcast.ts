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
import { createHash } from "node:crypto";
import type { BotConfig } from "../config.js";
import { isOperator, safeAnswerCallback } from "./runtime.js";
import type { CommandDeps as BotDeps } from "./registry.js";
import { safeErrorMessage } from "../notifications/format.js";
import { isNoncanonicalNumericId, handleCallbackQuery } from "../callbacks.js";

/** Telegram Bot API maximum message length limit. */
export const MAX_BROADCAST_LENGTH = 4096;

/** Default expiration timeout for pending broadcast confirmations (5 minutes). */
export const DEFAULT_BROADCAST_EXPIRY_MS = 5 * 60 * 1000;

export const BROADCAST_USAGE_MESSAGE = "Usage: /broadcast <message>";
export const BROADCAST_TOO_LONG_MESSAGE =
  "Broadcast message exceeds the maximum length of 4096 characters.";
export const BROADCAST_NO_CHATS_MESSAGE = "No notification chats configured.";

/**
 * Extracts and deduplicates all unique configured notification chats from config.
 * Chats come from TELEGRAM_CHAT_ID (chatId / chatIds), TELEGRAM_MARKET_CHAT_ID,
 * TELEGRAM_SQUAD_CHAT_ID, and per-chat routes.
 */
export function getConfiguredBroadcastChats(
  config: Pick<BotConfig, "chatId"> &
    Partial<Pick<BotConfig, "chatIds" | "marketChatId" | "squadChatId" | "routes">>,
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
  if (Array.isArray(config.routes)) {
    for (const r of config.routes) {
      if (r && typeof r.chatId === "string") {
        candidates.push(r.chatId);
      }
    }
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

/**
 * Computes a deterministic, order-independent SHA-256 fingerprint for a destination set.
 * - Trims each chat identifier.
 * - Filters empty or blank values.
 * - Deduplicates unique destinations.
 * - Lexicographically sorts destination identifiers for canonical representation.
 * - Hashes the canonical newline-delimited sequence with SHA-256.
 */
export function fingerprintDestinationSet(chats: readonly string[]): string {
  const unique = Array.from(
    new Set(
      chats
        .map((c) => (typeof c === "string" ? c.trim() : String(c ?? "").trim()))
        .filter((c) => c.length > 0),
    ),
  ).sort();
  return createHash("sha256").update(unique.join("\n")).digest("hex");
}

export interface PendingBroadcast {
  id: string;
  operatorId: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  chats: readonly string[];
  confirmed: boolean;
  destinationFingerprint?: string;
}

export class BroadcastStore {
  private readonly items = new Map<string, PendingBroadcast>();
  private readonly cancelledReasons = new Map<string, "route-change" | "user-cancelled">();
  private readonly defaultTtlMs: number;
  private counter = 0;

  constructor(defaultTtlMs: number = DEFAULT_BROADCAST_EXPIRY_MS) {
    this.defaultTtlMs = defaultTtlMs;
  }

  create(
    operatorId: string,
    message: string,
    chats: readonly string[],
    ttlMs?: number,
    destinationFingerprint?: string,
  ): PendingBroadcast {
    this.cleanup();
    this.counter = (this.counter + 1) % 1_000_000;
    const id = `${Date.now().toString(36)}_${this.counter}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const item: PendingBroadcast = {
      id,
      operatorId,
      message,
      createdAt: now,
      expiresAt: now + (ttlMs ?? this.defaultTtlMs),
      chats,
      confirmed: false,
      ...(destinationFingerprint !== undefined ? { destinationFingerprint } : {}),
    };
    this.items.set(id, item);
    return item;
  }

  get(id: string, now: number = Date.now()): PendingBroadcast | undefined {
    if (isNoncanonicalNumericId(id)) return undefined;
    this.cleanup(now);
    return this.items.get(id);
  }

  delete(id: string): boolean {
    if (isNoncanonicalNumericId(id)) return false;
    return this.items.delete(id);
  }

  /**
   * Cancels and removes all pending broadcast confirmations whose reviewed destination
   * fingerprint does not match the provided current destination set (or fingerprint).
   * Returns the list of cancelled broadcast IDs.
   */
  cancelOnRouteChange(currentChatsOrFingerprint: readonly string[] | string): string[] {
    const targetFingerprint =
      typeof currentChatsOrFingerprint === "string"
        ? currentChatsOrFingerprint
        : fingerprintDestinationSet(currentChatsOrFingerprint);
    const cancelled: string[] = [];
    for (const [id, item] of this.items.entries()) {
      if (item.destinationFingerprint && item.destinationFingerprint !== targetFingerprint) {
        this.items.delete(id);
        this.cancelledReasons.set(id, "route-change");
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  getCancelReason(id: string): "route-change" | "user-cancelled" | undefined {
    return this.cancelledReasons.get(id);
  }

  cleanup(now: number = Date.now()): void {
    for (const [id, item] of this.items.entries()) {
      if (item.expiresAt <= now) {
        this.items.delete(id);
      }
    }
    if (this.cancelledReasons.size > 1000) {
      this.cancelledReasons.clear();
    }
  }

  clear(): void {
    this.items.clear();
    this.cancelledReasons.clear();
  }

  size(): number {
    return this.items.size;
  }
}

export const defaultBroadcastStore = new BroadcastStore();

export function broadcastKeyboard(id: string): InlineKeyboard {
  if (isNoncanonicalNumericId(id)) {
    throw new Error(`Invalid broadcast ID: noncanonical numeric identifier "${id}"`);
  }
  return new InlineKeyboard()
    .text("✅ Confirm", `broadcast:confirm:${id}`)
    .text("❌ Cancel", `broadcast:cancel:${id}`);
}

export function formatBroadcastPreview(
  message: string,
  chats: readonly string[],
  destinationFingerprint?: string,
): string {
  const chatList = chats.map((c) => `• ${c}`).join("\n");
  const fp = destinationFingerprint ?? fingerprintDestinationSet(chats);
  return (
    `📢 Broadcast Preview\n\n` +
    `Target chats (${chats.length}):\n${chatList}\n\n` +
    `Route fingerprint: \`${fp.slice(0, 12)}\`\n\n` +
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

/**
 * Handle /broadcast <message> command.
 * Restricted to operator in private chats only.
 */
export async function handleBroadcastCommand(
  ctx: CommandContext<Context>,
  deps: Pick<BotDeps, "config"> & {
    broadcastStore?: BroadcastStore;
    broadcastExpiryMs?: number;
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

  if (text.length > MAX_BROADCAST_LENGTH) {
    await ctx.reply(BROADCAST_TOO_LONG_MESSAGE);
    return;
  }

  const chats = getConfiguredBroadcastChats(config);
  if (chats.length === 0) {
    await ctx.reply(BROADCAST_NO_CHATS_MESSAGE);
    return;
  }

  const fingerprint = fingerprintDestinationSet(chats);
  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const pending = store.create(
    String(ctx.from?.id),
    text,
    chats,
    deps.broadcastExpiryMs,
    fingerprint,
  );

  const previewText = formatBroadcastPreview(text, chats, fingerprint);
  const keyboard = broadcastKeyboard(pending.id);

  await ctx.reply(previewText, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Handle confirmation or cancellation callback queries for broadcast.
 */
export async function handleBroadcastCallback(
  ctx: Context,
  deps: BotDeps & {
    broadcastStore?: BroadcastStore;
    sleep?: (ms: number) => Promise<void>;
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

  const parts = rawAction.split(":");
  const subAction = parts[1];
  const broadcastId = parts[2];

  if (
    parts.length !== 3 ||
    !broadcastId ||
    (subAction !== "confirm" && subAction !== "cancel") ||
    isNoncanonicalNumericId(broadcastId)
  ) {
    await safeAnswerCallback(ctx, config, { text: "Invalid broadcast action" });
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const pending = store.get(broadcastId);

  if (!pending) {
    const cancelReason = store.getCancelReason?.(broadcastId);
    if (cancelReason === "route-change") {
      await safeAnswerCallback(ctx, config, {
        text: "Route configuration changed. New preview required.",
        show_alert: true,
      });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(
            "⚠️ Route configuration changed since preview. Broadcast confirmation cancelled. Run /broadcast again for an updated preview.",
          );
        } catch {
          // ignore edit failure
        }
      }
      return;
    }

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

  if (Date.now() > pending.expiresAt) {
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

  // Cancel pending broadcast confirmation if route configuration has changed since preview
  if (pending.destinationFingerprint !== undefined) {
    const currentChats = getConfiguredBroadcastChats(config);
    const currentFingerprint = fingerprintDestinationSet(currentChats);

    if (pending.destinationFingerprint !== currentFingerprint) {
      store.delete(broadcastId);
      await safeAnswerCallback(ctx, config, {
        text: "Route configuration changed. New preview required.",
        show_alert: true,
      });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(
            "⚠️ Route configuration changed since preview. Broadcast confirmation cancelled. Run /broadcast again for an updated preview.",
          );
        } catch {
          // ignore edit failure
        }
      }
      return;
    }
  }

  if (subAction === "cancel") {
    store.delete(broadcastId);
    await safeAnswerCallback(ctx, config, { text: "Broadcast cancelled" });
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText("❌ Broadcast cancelled.");
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
 * Register broadcast command handlers on a bot.
 */
export function registerBroadcastHandlers(
  bot: Bot | {
    command: (name: string, handler: (ctx: CommandContext<Context>) => Promise<void>) => void;
  },
  deps: BotDeps & { broadcastStore?: BroadcastStore },
): void {
  bot.command("broadcast", async (ctx: CommandContext<Context>) => {
    await handleBroadcastCommand(ctx, deps);
  });
}

/**
 * Returns an ordered, deduplicated list of target chat IDs configured
 * for broadcast delivery (chatId / chatIds, marketChatId, squadChatId).
 */
export function targetChatIds(config: {
  chatId?: string;
  chatIds?: string[];
  marketChatId?: string;
  squadChatId?: string;
}): string[] {
  const candidates: string[] = [];
  if (Array.isArray(config.chatIds)) {
    candidates.push(...config.chatIds);
  } else if (config.chatId) {
    candidates.push(config.chatId);
  }
  if (config.marketChatId) candidates.push(config.marketChatId);
  if (config.squadChatId) candidates.push(config.squadChatId);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of candidates) {
    const str = typeof id === "string" ? id.trim() : String(id ?? "").trim();
    if (str.length > 0 && !seen.has(str)) {
      seen.add(str);
      result.push(str);
    }
  }
  return result;
}

export interface PendingBroadcastEntry {
  token: string;
  text: string;
  chatIds: string[];
  operatorChatId: number;
}

export class PendingBroadcastStore {
  private readonly capacity: number;
  private readonly items = new Map<string, PendingBroadcastEntry>();

  constructor(capacity = 20) {
    this.capacity = capacity;
  }

  add(entry: PendingBroadcastEntry): void {
    if (this.items.has(entry.token)) {
      this.items.delete(entry.token);
    } else if (this.items.size >= this.capacity) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) {
        this.items.delete(oldestKey);
      }
    }
    this.items.set(entry.token, entry);
  }

  consume(token: string): PendingBroadcastEntry | undefined {
    const entry = this.items.get(token);
    if (entry !== undefined) {
      this.items.delete(token);
    }
    return entry;
  }

  size(): number {
    return this.items.size;
  }
}

export interface RegisterBroadcastCommandDeps {
  config: any;
  store?: PendingBroadcastStore;
  targetChatIds?: string[];
  sendMessage?: (chatId: string, text: string) => Promise<any>;
}

export function registerBroadcastCommand(
  bot: {
    command: (name: string, fn: (ctx: any) => Promise<void>) => void;
    on: (event: string, fn: (ctx: any) => Promise<void>) => void;
  },
  deps: RegisterBroadcastCommandDeps,
): void {
  const store = deps.store ?? new PendingBroadcastStore();
  let tokenSeq = 0;

  bot.command("broadcast", async (ctx: any) => {
    const operatorId = String(deps.config?.operatorTelegramUserId ?? "");
    const senderId = String(ctx.from?.id ?? "");
    if (!operatorId || senderId !== operatorId) {
      console.warn(`[broadcast] unauthorized access from user ${senderId}`);
      return;
    }

    const raw = ctx.message?.text ?? "";
    const text = raw.replace(/^\/broadcast(?:@\w+)?\s*/, "").trim();
    if (!text) {
      await ctx.reply("Usage: /broadcast <message>");
      return;
    }

    const chats = Array.isArray(deps.targetChatIds)
      ? deps.targetChatIds
      : targetChatIds(deps.config);

    if (chats.length === 0) {
      await ctx.reply("No target chats configured.");
      return;
    }

    tokenSeq += 1;
    const token = `bc_${Date.now().toString(36)}_${tokenSeq}_${Math.random().toString(36).slice(2, 6)}`;
    store.add({
      token,
      text,
      chatIds: chats,
      operatorChatId: ctx.from?.id ?? 0,
    });

    await ctx.reply(`Broadcast preview:\n${text}`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Confirm", callback_data: `broadcast:confirm:${token}` },
            { text: "Cancel", callback_data: `broadcast:cancel:${token}` },
          ],
        ],
      },
    });
  });

  bot.on("callback_query:data", async (ctx: any) => {
    const data = ctx.callbackQuery?.data;
    if (typeof data !== "string") return;
    if (!data.startsWith("broadcast:confirm:") && !data.startsWith("broadcast:cancel:")) {
      return;
    }

    await handleCallbackQuery(
      ctx,
      async () => {
        const operatorId = String(deps.config?.operatorTelegramUserId ?? "");
        const senderId = String(ctx.from?.id ?? "");
        if (!operatorId || senderId !== operatorId) {
          console.warn(`[broadcast] unauthorized callback from user ${senderId}`);
          await ctx.answerCallbackQuery({ text: "Unauthorized: operator only", show_alert: true });
          return;
        }

        const isConfirm = data.startsWith("broadcast:confirm:");
        const token = data.slice(isConfirm ? "broadcast:confirm:".length : "broadcast:cancel:".length);

        const entry = store.consume(token);
        if (!entry) {
          await ctx.answerCallbackQuery({ text: "Broadcast expired or already processed" });
          return;
        }

        if (!isConfirm) {
          await ctx.editMessageText("Broadcast cancelled.");
          await ctx.answerCallbackQuery({ text: "Cancelled" });
          return;
        }

        const sendFn = deps.sendMessage ?? (async (chatId: string, msg: string) => {
          await ctx.api?.sendMessage(chatId, msg);
        });

        for (const chatId of entry.chatIds) {
          await sendFn(chatId, entry.text);
        }

        await ctx.editMessageText(`Broadcast sent to ${entry.chatIds.length} chat(s).`);
        await ctx.answerCallbackQuery({ text: "Broadcast sent." });
      },
      {
        deletedToast: "The original message was deleted.",
        deletedFallbackReply: "The confirmation message was deleted. Please retry with /broadcast.",
      },
    );
  });
}
