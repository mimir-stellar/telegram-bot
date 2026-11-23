/**
 * Operator maintenance broadcast command.
 *
 * Allows the operator to send an announcement to all configured notification chats
 * from a private chat session. Displays a confirmation preview with Confirm/Cancel
 * inline buttons, bounds the message length, expires pending confirmations, and
 * delivers plain text (no parse mode) to each unique configured chat with an
 * inter-send delay while reporting per-chat success.
 *
 * Confirmation identities are persisted to disk when a `confirmationStorePath`
 * is provided, so that replayed or expired confirmations are rejected after a
 * process restart. Each confirmation is bound to the operator (actor), the chat
 * it was issued in, and the action (confirm/cancel).
 */

import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";
import { Bot, InlineKeyboard, type Context, type CommandContext } from "grammy";
import type { BotConfig } from "../config.js";
import {
  extractCallbackLogIds,
  formatCallbackErrorLog,
  isOperator,
  safeAnswerCallback,
} from "./runtime.js";
import type { CommandDeps as BotDeps } from "./registry.js";
import { safeErrorMessage } from "../notifications/format.js";
import { isNoncanonicalNumericId, handleCallbackQuery } from "../callbacks.js";

/** Telegram Bot API maximum message length limit. */
export const MAX_BROADCAST_LENGTH = 4096;

/** Default expiration timeout for pending broadcast confirmations (5 minutes). */
export const DEFAULT_BROADCAST_EXPIRY_MS = 5 * 60 * 1000;

/** Maximum number of pending confirmations retained per store or listed to an operator. */
export const MAX_PENDING_CONFIRMATIONS = 20;

export const BROADCAST_USAGE_MESSAGE = "Usage: /broadcast <message>";
export const BROADCAST_TOO_LONG_MESSAGE =
  "Broadcast message exceeds the maximum length of 4096 characters.";
export const BROADCAST_NO_CHATS_MESSAGE = "No notification chats configured.";
export const BROADCAST_NO_PENDING_MESSAGE = "No pending confirmations.";

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
  chatId: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  chats: readonly string[];
  confirmed: boolean;
  destinationFingerprint?: string;
}

/**
 * Redacted view of a pending confirmation safe to show in an operator listing.
 * Never includes target chat IDs or raw unredacted destination lists.
 */
export interface PendingConfirmationSummary {
  id: string;
  operatorId: string;
  chatId: string;
  action: "broadcast";
  summary: string;
  targetCount: number;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
}

/** Action bound to a confirmation identity. */
export type BroadcastAction = "confirm" | "cancel";

/** Minimal fs surface used by the persistent confirmation store. */
export interface BroadcastStoreFs {
  readFileSync: (filePath: string, encoding: BufferEncoding) => string;
  writeFileSync: (filePath: string, data: string, encoding: BufferEncoding) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  mkdirSync: (dirPath: string, options: { recursive: boolean }) => unknown;
  existsSync: (filePath: string) => boolean;
}

export interface BroadcastStoreOptions {
  defaultTtlMs?: number;
  /** Maximum number of pending confirmations retained in memory (defaults to 20). */
  capacity?: number;
  /** When set, consumed/issued identities are persisted here across restarts. */
  filePath?: string;
  fs?: Partial<BroadcastStoreFs>;
  now?: () => number;
}

interface PersistedConfirmation {
  /** Hash of the confirmation id; raw ids are never written to disk. */
  idHash: string;
  operatorId: string;
  chatId: string;
  expiresAt: number;
  /** Set once the identity has been consumed (confirm or cancel); replays are rejected. */
  consumedAt?: number;
  consumedAction?: BroadcastAction;
}

interface PersistedFile {
  version: 1;
  entries: PersistedConfirmation[];
}

const PERSIST_VERSION = 1 as const;

function hashId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function summarizeMessage(message: string, maxChars = 60): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  const chars = Array.from(singleLine);
  if (chars.length <= maxChars) return singleLine;
  return chars.slice(0, maxChars - 1).join("") + "…";
}

export interface ConfirmationCheck {
  ok: boolean;
  reason?: "unknown" | "expired" | "replayed" | "actor_mismatch" | "chat_mismatch" | "action_mismatch";
}

export interface ListPendingOptions {
  chatId?: string;
  limit?: number;
  now?: number;
}

export interface CancelForOperatorResult {
  ok: boolean;
  reason?: "unknown" | "expired" | "replayed" | "actor_mismatch" | "chat_mismatch";
}

/**
 * Stores pending broadcast confirmations. Pending message bodies live in memory
 * (they are never persisted); confirmation identities (actor, chat, expiry and
 * consumed state) are persisted to `filePath` when provided so replays and
 * expired confirmations are rejected after a restart.
 */
export class BroadcastStore {
  private readonly items = new Map<string, PendingBroadcast>();
  private readonly cancelledReasons = new Map<string, "route-change" | "user-cancelled">();
  private readonly defaultTtlMs: number;
  private readonly capacity: number;
  private readonly filePath?: string;
  private readonly fsImpl: BroadcastStoreFs;
  private readonly now: () => number;
  private persisted: PersistedConfirmation[] = [];
  private counter = 0;

  constructor(options: BroadcastStoreOptions | number = {}) {
    const opts: BroadcastStoreOptions =
      typeof options === "number" ? { defaultTtlMs: options } : options;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_BROADCAST_EXPIRY_MS;
    this.capacity =
      typeof opts.capacity === "number" && opts.capacity > 0
        ? Math.floor(opts.capacity)
        : MAX_PENDING_CONFIRMATIONS;
    this.filePath = opts.filePath;
    this.now = opts.now ?? Date.now;
    this.fsImpl = {
      readFileSync: opts.fs?.readFileSync ?? ((p, enc) => fs.readFileSync(p, enc)),
      writeFileSync:
        opts.fs?.writeFileSync ?? ((p, data, enc) => fs.writeFileSync(p, data, enc)),
      renameSync: opts.fs?.renameSync ?? ((a, b) => fs.renameSync(a, b)),
      mkdirSync: opts.fs?.mkdirSync ?? ((p, o) => fs.mkdirSync(p, o)),
      existsSync: opts.fs?.existsSync ?? ((p) => fs.existsSync(p)),
    };
    if (this.filePath) {
      this.persisted = this.load();
    }
  }

  private load(): PersistedConfirmation[] {
    if (!this.filePath || !this.fsImpl.existsSync(this.filePath)) return [];
    try {
      const raw = this.fsImpl.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedFile;
      if (parsed?.version !== PERSIST_VERSION || !Array.isArray(parsed.entries)) {
        return [];
      }
      const now = this.now();
      return parsed.entries.filter(
        (e) =>
          e &&
          typeof e.idHash === "string" &&
          typeof e.operatorId === "string" &&
          typeof e.chatId === "string" &&
          typeof e.expiresAt === "number" &&
          e.expiresAt > now,
      );
    } catch {
      return [];
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const now = this.now();
    this.persisted = this.persisted.filter((e) => e.expiresAt > now);
    const dir = path.dirname(this.filePath);
    this.fsImpl.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload: PersistedFile = { version: PERSIST_VERSION, entries: this.persisted };
    this.fsImpl.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    this.fsImpl.renameSync(tmp, this.filePath);
  }

  create(
    operatorId: string,
    message: string,
    chats: readonly string[],
    ttlMs?: number,
    destinationFingerprint?: string,
    chatId: string = operatorId,
  ): PendingBroadcast {
    this.cleanup();
    while (this.items.size >= this.capacity) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    this.counter = (this.counter + 1) % 1_000_000;
    const id = `${Date.now().toString(36)}_${this.counter}_${randomBytes(6).toString("hex")}`;
    const now = this.now();
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs);
    const item: PendingBroadcast = {
      id,
      operatorId,
      chatId,
      message,
      createdAt: now,
      expiresAt,
      chats,
      confirmed: false,
      ...(destinationFingerprint !== undefined ? { destinationFingerprint } : {}),
    };
    this.items.set(id, item);
    this.persisted.push({ idHash: hashId(id), operatorId, chatId, expiresAt });
    this.save();
    return item;
  }

  get(id: string, now: number = this.now()): PendingBroadcast | undefined {
    if (isNoncanonicalNumericId(id)) return undefined;
    this.cleanup(now);
    return this.items.get(id);
  }

  /**
   * Returns a bounded list of active (unexpired, unconfirmed) pending confirmations
   * belonging exclusively to `operatorId` (and optionally scoped to `options.chatId`).
   * Never exposes target chat IDs or actions belonging to other operators.
   */
  listPendingForOperator(
    operatorId: string,
    options: ListPendingOptions | number = {},
  ): PendingConfirmationSummary[] {
    const opts: ListPendingOptions =
      typeof options === "number" ? { limit: options } : options;
    const now = opts.now ?? this.now();
    this.cleanup(now);

    if (!operatorId) return [];

    const maxItems =
      typeof opts.limit === "number" && opts.limit > 0
        ? Math.min(Math.floor(opts.limit), this.capacity)
        : this.capacity;

    const matching: PendingConfirmationSummary[] = [];
    for (const item of this.items.values()) {
      if (item.confirmed) continue;
      if (item.expiresAt <= now) continue;
      if (item.operatorId !== operatorId) continue;
      if (opts.chatId !== undefined && item.chatId !== opts.chatId) continue;

      matching.push({
        id: item.id,
        operatorId: item.operatorId,
        chatId: item.chatId,
        action: "broadcast",
        summary: summarizeMessage(item.message),
        targetCount: item.chats.length,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        remainingMs: Math.max(0, item.expiresAt - now),
      });
    }

    if (matching.length > maxItems) {
      return matching.slice(matching.length - maxItems);
    }
    return matching;
  }

  /**
   * Explicitly cancels a pending confirmation on behalf of `operatorId`.
   * Rejects noncanonical IDs, unknown or expired items, or items belonging to
   * another operator/chat without leaking details about other chats or actors.
   */
  cancelForOperator(
    id: string,
    operatorId: string,
    chatId?: string,
    now: number = this.now(),
  ): CancelForOperatorResult {
    if (!id || !operatorId || isNoncanonicalNumericId(id)) {
      return { ok: false, reason: "unknown" };
    }
    const item = this.items.get(id);
    const entry = this.persisted.find((e) => e.idHash === hashId(id));

    if (!item && !entry) {
      return { ok: false, reason: "unknown" };
    }

    const ownerId = item?.operatorId ?? entry?.operatorId;
    if (ownerId !== operatorId) {
      return { ok: false, reason: "actor_mismatch" };
    }

    const ownerChatId = item?.chatId ?? entry?.chatId;
    if (chatId !== undefined && ownerChatId !== undefined && ownerChatId !== chatId) {
      return { ok: false, reason: "chat_mismatch" };
    }

    if (entry?.consumedAt !== undefined || item?.confirmed) {
      return { ok: false, reason: "replayed" };
    }

    const expiresAt = item?.expiresAt ?? entry?.expiresAt ?? 0;
    if (expiresAt <= now) {
      this.delete(id);
      return { ok: false, reason: "expired" };
    }

    this.cancelledReasons.set(id, "user-cancelled");
    if (entry) {
      this.consume(id, "cancel");
    } else {
      this.items.delete(id);
    }
    return { ok: true };
  }

  /**
   * Cancels all active pending confirmations belonging to `operatorId` (optionally
   * scoped to `chatId`). Other operators' or chats' items remain untouched.
   * Returns the list of cancelled confirmation IDs.
   */
  cancelAllForOperator(
    operatorId: string,
    chatId?: string,
    now: number = this.now(),
  ): string[] {
    this.cleanup(now);
    if (!operatorId) return [];
    const cancelled: string[] = [];
    for (const [id, item] of [...this.items.entries()]) {
      if (item.confirmed) continue;
      if (item.operatorId !== operatorId) continue;
      if (chatId !== undefined && item.chatId !== chatId) continue;
      const res = this.cancelForOperator(id, operatorId, chatId, now);
      if (res.ok) {
        cancelled.push(id);
      }
    }
    return cancelled;
  }

  /**
   * Validates that a confirmation identity is live, unconsumed, and bound to the
   * given actor, chat and action. Does not consume the identity.
   */
  check(
    id: string,
    binding: { operatorId: string; chatId: string; action: BroadcastAction },
    now: number = this.now(),
  ): ConfirmationCheck {
    const entry = this.persisted.find((e) => e.idHash === hashId(id));
    if (!entry) {
      // Fall back to an in-memory pending item with no persisted identity
      // (e.g. one registered directly in the store); bind it the same way.
      const item = this.items.get(id);
      if (!item) return { ok: false, reason: "unknown" };
      if (item.expiresAt <= now) return { ok: false, reason: "expired" };
      if (item.operatorId !== binding.operatorId) return { ok: false, reason: "actor_mismatch" };
      if (item.chatId !== undefined && item.chatId !== binding.chatId) {
        return { ok: false, reason: "chat_mismatch" };
      }
      return { ok: true };
    }
    if (entry.consumedAt !== undefined) return { ok: false, reason: "replayed" };
    if (entry.expiresAt <= now) return { ok: false, reason: "expired" };
    if (entry.operatorId !== binding.operatorId) return { ok: false, reason: "actor_mismatch" };
    if (entry.chatId !== binding.chatId) return { ok: false, reason: "chat_mismatch" };
    return { ok: true };
  }

  /**
   * Marks a confirmation identity consumed for the given action so that any later
   * replay (including after a restart) is rejected. Persists immediately.
   */
  consume(id: string, action: BroadcastAction): void {
    const entry = this.persisted.find((e) => e.idHash === hashId(id));
    if (entry && entry.consumedAt === undefined) {
      entry.consumedAt = this.now();
      entry.consumedAction = action;
      this.save();
    }
    this.items.delete(id);
  }

  delete(id: string): boolean {
    if (isNoncanonicalNumericId(id)) return false;
    const existed = this.items.delete(id);
    const idx = this.persisted.findIndex((e) => e.idHash === hashId(id));
    if (idx >= 0) {
      this.persisted.splice(idx, 1);
      this.save();
    }
    return existed;
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

  cleanup(now: number = this.now()): void {
    for (const [id, item] of this.items.entries()) {
      if (item.expiresAt <= now) {
        this.items.delete(id);
      }
    }
    const before = this.persisted.length;
    this.persisted = this.persisted.filter((e) => e.expiresAt > now);
    if (this.persisted.length !== before) {
      this.save();
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

export function pendingConfirmationsKeyboard(
  items: readonly Pick<PendingConfirmationSummary, "id">[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    if (isNoncanonicalNumericId(item.id)) {
      throw new Error(`Invalid confirmation ID: noncanonical numeric identifier "${item.id}"`);
    }
    kb.text(`❌ Cancel ${item.id}`, `broadcast:cancel:${item.id}`).row();
  }
  if (items.length > 1) {
    kb.text("🗑 Cancel all", "confirmations:cancel_all");
  }
  return kb;
}

function formatRemainingDuration(remainingMs: number): string {
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

/**
 * Formats a bounded operator-only summary of pending confirmations with expiry.
 * Never includes target chat IDs in the rendered output.
 */
export function formatPendingConfirmations(
  items: readonly PendingConfirmationSummary[],
  now?: number,
): string {
  if (items.length === 0) {
    return BROADCAST_NO_PENDING_MESSAGE;
  }
  const bounded = items.slice(0, MAX_PENDING_CONFIRMATIONS);
  const lines: string[] = [
    `⏳ Pending confirmations (${bounded.length}):`,
    "",
  ];
  for (const item of bounded) {
    const remainingMs =
      typeof now === "number" ? Math.max(0, item.expiresAt - now) : item.remainingMs;
    const expiryIso = new Date(item.expiresAt).toISOString();
    const duration = formatRemainingDuration(remainingMs);
    const destLabel = item.targetCount === 1 ? "1 destination" : `${item.targetCount} destinations`;
    lines.push(
      `• [${item.action}] ${item.id} — ${destLabel} — expires in ${duration} (${expiryIso})`,
      `  Message: ${item.summary}`,
    );
  }
  lines.push(
    "",
    "Use /broadcast cancel <id> (or /confirmations cancel <id>) to cancel an action.",
  );
  return lines.join("\n");
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

async function replyPendingConfirmationsList(
  ctx: Context,
  store: BroadcastStore,
  operatorId: string,
  chatId: string,
  limit?: number,
): Promise<void> {
  const items = store.listPendingForOperator(operatorId, { chatId, limit });
  const text = formatPendingConfirmations(items);
  if (items.length === 0) {
    await ctx.reply(text);
    return;
  }
  const keyboard = pendingConfirmationsKeyboard(items);
  await ctx.reply(text, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}

async function replyCancelConfirmation(
  ctx: Context,
  store: BroadcastStore,
  operatorId: string,
  chatId: string,
  targetArg: string,
): Promise<void> {
  const trimmed = targetArg.trim();
  if (!trimmed) {
    await ctx.reply("Usage: /confirmations cancel <id|all>");
    return;
  }

  if (trimmed.toLowerCase() === "all") {
    const cancelled = store.cancelAllForOperator(operatorId, chatId);
    if (cancelled.length === 0) {
      await ctx.reply(BROADCAST_NO_PENDING_MESSAGE);
    } else {
      await ctx.reply(`❌ Cancelled ${cancelled.length} pending confirmation(s).`);
    }
    return;
  }

  const res = store.cancelForOperator(trimmed, operatorId, chatId);
  if (!res.ok) {
    if (res.reason === "expired") {
      await ctx.reply("⚠️ Broadcast confirmation expired.");
    } else {
      await ctx.reply("⚠️ Confirmation not found, expired, or already processed.");
    }
    return;
  }

  await ctx.reply(`❌ Confirmation ${trimmed} cancelled.`);
}

/**
 * Handle /confirmations [list | cancel <id|all>] command.
 * Restricted to operator in private chats only.
 */
export async function handleConfirmationsCommand(
  ctx: CommandContext<Context> | Context,
  deps: Pick<BotDeps, "config"> & {
    broadcastStore?: BroadcastStore;
  },
): Promise<void> {
  const { config } = deps;
  const isPrivate = ctx.chat?.type === "private";

  if (!isOperator(ctx, config) || !isPrivate) {
    console.warn(`[bot] ignored unauthorized /confirmations on update ${ctx.update?.update_id}`);
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const operatorId = String(ctx.from?.id);
  const chatId = String(ctx.chat?.id);

  const rawText = ctx.message?.text ?? "";
  const match = rawText.match(/^\/confirmations(?:@\w+)?(?:\s+([\s\S]*))?$/);
  const arg = (match?.[1] ?? "").trim();

  if (!arg || arg === "list" || arg === "pending") {
    await replyPendingConfirmationsList(ctx, store, operatorId, chatId);
    return;
  }

  const cancelMatch = arg.match(/^cancel(?:\s+([\s\S]*))?$/i);
  if (cancelMatch) {
    await replyCancelConfirmation(ctx, store, operatorId, chatId, cancelMatch[1] ?? "");
    return;
  }

  await ctx.reply("Usage: /confirmations [list | cancel <id|all>]");
}

/**
 * Handle /broadcast <message> (plus `list`, `pending`, and `cancel <id|all>`) command.
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

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const operatorId = String(ctx.from?.id);
  const chatId = String(ctx.chat?.id);

  if (text === "list" || text === "pending") {
    await replyPendingConfirmationsList(ctx, store, operatorId, chatId);
    return;
  }

  const cancelMatch = text.match(/^cancel(?:\s+(\S+))$/);
  if (cancelMatch && cancelMatch[1]) {
    await replyCancelConfirmation(ctx, store, operatorId, chatId, cancelMatch[1]);
    return;
  }
  if (text === "cancel") {
    await ctx.reply("Usage: /broadcast cancel <id|all>");
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
  const pending = store.create(
    operatorId,
    text,
    chats,
    deps.broadcastExpiryMs,
    fingerprint,
    String(ctx.chat?.id),
  );

  const previewText = formatBroadcastPreview(text, chats, fingerprint);
  const keyboard = broadcastKeyboard(pending.id);

  await ctx.reply(previewText, {
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  });
}

/**
 * Handle callback queries for `confirmations:*` actions (listing and explicit cancellation).
 */
export async function handleConfirmationsCallback(
  ctx: Context,
  deps: BotDeps & {
    broadcastStore?: BroadcastStore;
  },
  rawAction: string,
): Promise<void> {
  const { config } = deps;
  const chatType = ctx.chat?.type ?? (ctx.callbackQuery?.message as any)?.chat?.type;
  const isPrivate = chatType === "private";

  if (!isOperator(ctx, config) || !isPrivate) {
    console.warn(
      `[bot] ignored unauthorized confirmations callback on update ${ctx.update?.update_id}`,
    );
    await safeAnswerCallback(ctx, config, {
      text: "Unauthorized: operator in private chat only",
      show_alert: true,
    });
    return;
  }

  const store = deps.broadcastStore ?? defaultBroadcastStore;
  const actor = String(ctx.from?.id);
  const chatId = String(ctx.chat?.id ?? (ctx.callbackQuery?.message as any)?.chat?.id);

  const parts = rawAction.split(":");
  const subAction = parts[1] ?? "list";

  if (subAction === "list" && parts.length <= 2) {
    const items = store.listPendingForOperator(actor, { chatId });
    const text = formatPendingConfirmations(items);
    const keyboard = items.length > 0 ? pendingConfirmationsKeyboard(items) : undefined;
    await safeAnswerCallback(ctx, config, { text: "Pending confirmations" });
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(
          text,
          keyboard ? { reply_markup: keyboard } : undefined,
        );
        return;
      } catch {
        // fallback to reply
      }
    }
    await ctx.reply(text, keyboard ? { reply_markup: keyboard } : undefined);
    return;
  }

  if (subAction === "cancel_all" && parts.length === 2) {
    const cancelled = store.cancelAllForOperator(actor, chatId);
    await safeAnswerCallback(ctx, config, {
      text:
        cancelled.length > 0
          ? `Cancelled ${cancelled.length} confirmation(s)`
          : "No pending confirmations",
    });
    const text =
      cancelled.length > 0
        ? `❌ Cancelled ${cancelled.length} pending confirmation(s).`
        : BROADCAST_NO_PENDING_MESSAGE;
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text);
        return;
      } catch {
        // ignore
      }
    }
    return;
  }

  if (subAction === "cancel" && parts.length === 3 && parts[2]) {
    const targetId = parts[2];
    if (isNoncanonicalNumericId(targetId)) {
      await safeAnswerCallback(ctx, config, { text: "Invalid confirmation action" });
      return;
    }
    const res = store.cancelForOperator(targetId, actor, chatId);
    if (!res.ok) {
      const expired = res.reason === "expired";
      await safeAnswerCallback(ctx, config, {
        text: expired
          ? "Broadcast confirmation expired"
          : "Broadcast expired or already processed",
        show_alert: true,
      });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(
            expired
              ? "⚠️ Broadcast confirmation expired."
              : "⚠️ Broadcast confirmation expired or already processed.",
          );
        } catch {
          // ignore
        }
      }
      return;
    }

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

  await safeAnswerCallback(ctx, config, { text: "Invalid confirmation action" });
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
    const ids = extractCallbackLogIds(ctx, [config.botToken]);
    console.warn(
      `[bot] ignored unauthorized broadcast callback update_id=${ids.updateId} callback_query_id=${ids.callbackQueryId}`,
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

  if (subAction === "list" && parts.length === 2) {
    await handleConfirmationsCallback(ctx, deps, "confirmations:list");
    return;
  }

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
  const actor = String(ctx.from?.id);
  const chatId = String(ctx.chat?.id ?? (ctx.callbackQuery?.message as any)?.chat?.id);
  const action: BroadcastAction = subAction;

  // Identity check against the persisted store: rejects unknown, replayed,
  // expired, or cross-actor/chat/action confirmations, including after restart.
  // If an in-memory item exists without a persisted record (e.g. injected in unit tests),
  // validate ownership and expiry directly against the in-memory item.
  const check = store.check(broadcastId, { operatorId: actor, chatId, action });
  if (!check.ok) {
    const rawPending = store.get(broadcastId);
    const cancelReason = store.getCancelReason?.(broadcastId);
    if (check.reason === "unknown" && cancelReason === "route-change") {
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

    const fallbackAllowed =
      check.reason === "unknown" &&
      rawPending !== undefined &&
      rawPending.operatorId === actor &&
      (rawPending.chatId === undefined || rawPending.chatId === chatId);

    if (!fallbackAllowed) {
      const expired = check.reason === "expired";
      await safeAnswerCallback(ctx, config, {
        text: expired
          ? "Broadcast confirmation expired"
          : "Broadcast expired or already processed",
        show_alert: true,
      });
      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(
            expired
              ? "⚠️ Broadcast confirmation expired."
              : "⚠️ Broadcast confirmation expired or already processed.",
          );
        } catch {
          // ignore edit failure
        }
      }
      if (check.reason === "expired") {
        store.delete(broadcastId);
      }
      return;
    }
  }

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
    return;
  }

  // Cancel pending broadcast confirmation if route configuration has changed since preview
  if (pending.destinationFingerprint !== undefined && subAction === "confirm") {
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
    store.consume(broadcastId, "cancel");
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
  // Each chat receives the message at most once per confirmation. The identity
  // is consumed (and persisted) before any send so a replay after restart fails.
  if (pending.confirmed) {
    await safeAnswerCallback(ctx, config, {
      text: "Broadcast already in progress or sent",
      show_alert: true,
    });
    return;
  }
  pending.confirmed = true;
  store.consume(broadcastId, "confirm");

  await safeAnswerCallback(ctx, config, { text: "Broadcasting message..." });

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(`⏳ Broadcasting to ${pending.chats.length} chat(s)...`);
    } catch {
      // ignore
    }
  }

  try {
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
  } catch (err) {
    console.error(
      formatCallbackErrorLog({
        ctx,
        action: "broadcast",
        broadcastId,
        error: err,
        secrets: [config.botToken],
      }),
    );
    await safeAnswerCallback(ctx, config, { text: "Broadcast failed" });
  }
}

/**
 * Register broadcast and confirmations command handlers on a bot.
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
  bot.command("confirmations", async (ctx: CommandContext<Context>) => {
    await handleConfirmationsCommand(ctx, deps);
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
  createdAt?: number;
  expiresAt?: number;
}

export class PendingBroadcastStore {
  private readonly capacity: number;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;
  private readonly items = new Map<string, PendingBroadcastEntry>();
  private readonly metadata = new Map<string, { createdAt: number; expiresAt: number }>();

  constructor(
    capacity = MAX_PENDING_CONFIRMATIONS,
    options: { defaultTtlMs?: number; now?: () => number } = {},
  ) {
    this.capacity = capacity;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_BROADCAST_EXPIRY_MS;
    this.now = options.now ?? Date.now;
  }

  private prune(now: number = this.now()): void {
    for (const [token, meta] of this.metadata.entries()) {
      if (meta.expiresAt <= now) {
        this.items.delete(token);
        this.metadata.delete(token);
      }
    }
  }

  add(entry: PendingBroadcastEntry, ttlMs?: number): void {
    const now = this.now();
    this.prune(now);
    const createdAt = entry.createdAt ?? now;
    const expiresAt = entry.expiresAt ?? createdAt + (ttlMs ?? this.defaultTtlMs);

    if (this.items.has(entry.token)) {
      this.items.delete(entry.token);
      this.metadata.delete(entry.token);
    } else if (this.items.size >= this.capacity) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) {
        this.items.delete(oldestKey);
        this.metadata.delete(oldestKey);
      }
    }
    this.items.set(entry.token, entry);
    this.metadata.set(entry.token, { createdAt, expiresAt });
  }

  consume(token: string, now: number = this.now()): PendingBroadcastEntry | undefined {
    this.prune(now);
    const entry = this.items.get(token);
    if (entry !== undefined) {
      this.items.delete(token);
      this.metadata.delete(token);
    }
    return entry;
  }

  /**
   * Lists unexpired pending entries belonging strictly to `operatorChatId`.
   * Returned entries omit `chatIds` (replaced with `targetCount`) so other chats
   * are never exposed.
   */
  listForOperator(
    operatorChatId: number | string,
    now: number = this.now(),
  ): PendingConfirmationSummary[] {
    this.prune(now);
    const targetOp = String(operatorChatId);
    const results: PendingConfirmationSummary[] = [];

    for (const entry of this.items.values()) {
      if (String(entry.operatorChatId) !== targetOp) continue;
      const meta = this.metadata.get(entry.token);
      const createdAt = meta?.createdAt ?? entry.createdAt ?? now;
      const expiresAt = meta?.expiresAt ?? entry.expiresAt ?? createdAt + this.defaultTtlMs;
      if (expiresAt <= now) continue;
      results.push({
        id: entry.token,
        operatorId: targetOp,
        chatId: targetOp,
        action: "broadcast",
        summary: summarizeMessage(entry.text),
        targetCount: entry.chatIds.length,
        createdAt,
        expiresAt,
        remainingMs: Math.max(0, expiresAt - now),
      });
    }

    if (results.length > this.capacity) {
      return results.slice(results.length - this.capacity);
    }
    return results;
  }

  /**
   * Explicitly cancels a pending entry only if it belongs to `operatorChatId`.
   */
  cancelForOperator(
    token: string,
    operatorChatId: number | string,
    now: number = this.now(),
  ): boolean {
    if (!token || isNoncanonicalNumericId(token)) return false;
    this.prune(now);
    const entry = this.items.get(token);
    if (!entry) return false;
    if (String(entry.operatorChatId) !== String(operatorChatId)) return false;
    this.items.delete(token);
    this.metadata.delete(token);
    return true;
  }

  size(): number {
    this.prune();
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

    if (text === "list" || text === "pending") {
      const items = store.listForOperator(senderId);
      await ctx.reply(formatPendingConfirmations(items));
      return;
    }

    const cancelMatch = text.match(/^cancel\s+(\S+)$/);
    if (cancelMatch && cancelMatch[1]) {
      const targetToken = cancelMatch[1];
      const ok = store.cancelForOperator(targetToken, senderId);
      await ctx.reply(
        ok
          ? `Broadcast cancelled (${targetToken}).`
          : "Broadcast expired or already processed.",
      );
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

        if (!isConfirm) {
          const cancelled = store.cancelForOperator(token, senderId);
          if (!cancelled) {
            await ctx.answerCallbackQuery({ text: "Broadcast expired or already processed" });
            return;
          }
          await ctx.editMessageText("Broadcast cancelled.");
          await ctx.answerCallbackQuery({ text: "Cancelled" });
          return;
        }

        const entry = store.consume(token);
        if (!entry || String(entry.operatorChatId) !== senderId) {
          await ctx.answerCallbackQuery({ text: "Broadcast expired or already processed" });
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
