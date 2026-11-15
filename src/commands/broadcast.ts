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

/** Upper bound for fallback chat replies when a confirmation message was deleted or cannot be edited. */
export const MAX_CONFIRMATION_FALLBACK_CHARS = 1024;

/** Default expiration timeout for pending broadcast confirmations (5 minutes). */
export const DEFAULT_BROADCAST_EXPIRY_MS = 5 * 60 * 1000;

export const BROADCAST_USAGE_MESSAGE = "Usage: /broadcast <message>";
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

export interface PendingBroadcast {
  id: string;
  operatorId: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  chats: readonly string[];
  confirmed: boolean;
}

export class BroadcastStore {
  private readonly items = new Map<string, PendingBroadcast>();
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
    };
    this.items.set(id, item);
    return item;
  }

  get(id: string, now: number = Date.now()): PendingBroadcast | undefined {
    this.cleanup(now);
    return this.items.get(id);
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
  }

  clear(): void {
    this.items.clear();
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

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const pending = store.create(
    String(ctx.from?.id),
    text,
    chats,
    deps.broadcastExpiryMs,
  );

  const previewText = formatBroadcastPreview(text, chats);
  const keyboard = broadcastKeyboard(pending.id);

  await ctx.reply(previewText, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}

export function clampConfirmationFallbackText(
  text: string,
  maxChars: number = MAX_CONFIRMATION_FALLBACK_CHARS,
): string {
  const limit = Math.max(16, Math.trunc(maxChars));
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function isBroadcastMessageNotModified(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /message is not modified/i.test(msg);
}

/**
 * True when Telegram rejected `editMessageText` because the target message was
 * deleted, expired from the edit window, or has an invalid message identifier.
 */
export function isDeletedOrUneditableMessageError(err: unknown): boolean {
  if (!err || isBroadcastMessageNotModified(err)) return false;
  const record = typeof err === "object" ? (err as { description?: unknown; message?: unknown }) : null;
  const raw =
    typeof record?.description === "string"
      ? record.description
      : err instanceof Error
        ? err.message
        : typeof record?.message === "string"
          ? record.message
          : String(err);
  return /message to edit not found|message can't be edited|message_id_invalid|message identifier is not specified|message to delete not found/i.test(
    raw,
  );
}

async function sendBoundedBroadcastFallback(ctx: Context, text: string): Promise<void> {
  const bounded = clampConfirmationFallbackText(text, MAX_CONFIRMATION_FALLBACK_CHARS);
  const options = { link_preview_options: { is_disabled: true } };

  try {
    if (typeof ctx.reply === "function") {
      await ctx.reply(bounded, options);
      return;
    }
    const targetChatId =
      ctx.chat?.id ?? (ctx.callbackQuery?.message as { chat?: { id?: number | string } } | undefined)?.chat?.id;
    if (targetChatId !== undefined && typeof ctx.api?.sendMessage === "function") {
      await ctx.api.sendMessage(targetChatId, bounded, options);
    }
  } catch (err) {
    console.warn(`[bot] broadcast fallback reply failed: ${safeErrorMessage(err)}`);
  }
}

async function editBroadcastMessageOrFallback(ctx: Context, text: string): Promise<void> {
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text);
      return;
    } catch (err) {
      if (isBroadcastMessageNotModified(err)) {
        return;
      }
      // Message was deleted or can no longer be edited — fall through to bounded reply.
    }
  }
  await sendBoundedBroadcastFallback(ctx, text);
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

  if (!broadcastId || (subAction !== "confirm" && subAction !== "cancel")) {
    await safeAnswerCallback(ctx, config, { text: "Invalid broadcast action" });
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const pending = store.get(broadcastId);

  if (!pending) {
    await safeAnswerCallback(ctx, config, {
      text: "Broadcast expired or already processed",
      show_alert: true,
    });
    await editBroadcastMessageOrFallback(
      ctx,
      "⚠️ Broadcast confirmation expired or already processed.",
    );
    return;
  }

  if (Date.now() > pending.expiresAt) {
    store.delete(broadcastId);
    await safeAnswerCallback(ctx, config, {
      text: "Broadcast confirmation expired",
      show_alert: true,
    });
    await editBroadcastMessageOrFallback(ctx, "⚠️ Broadcast confirmation expired.");
    return;
  }

  if (subAction === "cancel") {
    store.delete(broadcastId);
    await safeAnswerCallback(ctx, config, { text: "Broadcast cancelled" });
    await editBroadcastMessageOrFallback(ctx, "❌ Broadcast cancelled.");
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
      // If the preview message was deleted, skip the transient progress edit and
      // emit a single bounded fallback reply once delivery completes below.
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
  await editBroadcastMessageOrFallback(ctx, report);
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
