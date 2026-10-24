/**
 * Group administrator authorization and caching for operator commands.
 *
 * `isOperator` in `src/bot.ts` checks `OPERATOR_TELEGRAM_USER_ID` only. In
 * group and supergroup chats shared with other administrators, state-changing
 * commands (`/pause`, `/resume`, etc.) also honour Telegram chat administrator
 * rights via `getChatMember` — including anonymous admins, whose messages have
 * no `from.id` and instead set `sender_chat.id === chat.id`.
 *
 * Private-chat authorization is unchanged: only `OPERATOR_TELEGRAM_USER_ID`
 * grants access there.
 */

import type { Api, Context } from "grammy";
import type { BotConfig } from "../config.js";
import { safeErrorMessage } from "../notifications/format.js";

/** Default cache TTL for `getChatMember` results (60 seconds). */
export const DEFAULT_ADMIN_CACHE_TTL_MS = 60_000;

/** Default maximum number of cached `(chatId, userId)` entries. */
export const DEFAULT_ADMIN_CACHE_MAX_SIZE = 256;

export interface ChatMemberApi {
  getChatMember(
    chatId: number | string,
    userId: number,
  ): Promise<{ status?: string | undefined } | null | undefined>;
}

export interface AdminCheckOptions {
  /** Cache entry TTL in milliseconds. Defaults to {@link DEFAULT_ADMIN_CACHE_TTL_MS}. */
  ttlMs?: number | undefined;
  /** Maximum number of entries in the cache. Defaults to {@link DEFAULT_ADMIN_CACHE_MAX_SIZE}. */
  maxSize?: number | undefined;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /** Secrets to redact if `getChatMember` fails. */
  secrets?: readonly string[] | undefined;
  /** Custom cache instance (defaults to the module-level bounded cache). */
  cache?: AdminCache | undefined;
}

interface CacheEntry {
  isAdmin: boolean;
  expiresAt: number;
}

/**
 * Bounded TTL cache for `(chatId, userId)` admin status lookups.
 * Evicts expired entries first, then oldest-inserted (LRU order) when full.
 */
export class AdminCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  readonly ttlMs: number;
  readonly maxSize: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number | undefined; maxSize?: number | undefined; now?: (() => number) | undefined } = {}) {
    this.ttlMs = Math.max(0, options.ttlMs ?? DEFAULT_ADMIN_CACHE_TTL_MS);
    this.maxSize = Math.max(1, Math.floor(options.maxSize ?? DEFAULT_ADMIN_CACHE_MAX_SIZE));
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get(
    key: string,
    ttlMs: number = this.ttlMs,
    maxSize: number = this.maxSize,
    now: () => number = this.now,
  ): boolean | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order for LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    void ttlMs;
    void maxSize;
    return entry.isAdmin;
  }

  set(
    key: string,
    isAdmin: boolean,
    ttlMs: number = this.ttlMs,
    maxSize: number = this.maxSize,
    now: () => number = this.now,
  ): void {
    if (ttlMs <= 0) return;
    const currentNow = now();
    this.entries.delete(key);

    if (this.entries.size >= maxSize) {
      // First sweep expired entries.
      for (const [k, v] of this.entries) {
        if (currentNow >= v.expiresAt) {
          this.entries.delete(k);
        }
      }
      // Evict oldest entries if still at capacity.
      while (this.entries.size >= maxSize) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey === undefined) break;
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, {
      isAdmin,
      expiresAt: currentNow + ttlMs,
    });
  }

  getInflight(key: string): Promise<boolean> | undefined {
    return this.inflight.get(key);
  }

  setInflight(key: string, promise: Promise<boolean>): void {
    this.inflight.set(key, promise);
  }

  deleteInflight(key: string): void {
    this.inflight.delete(key);
  }
}

const defaultCache = new AdminCache();

/** Clear the module-level admin check cache (useful in tests). */
export function clearAdminCache(): void {
  defaultCache.clear();
}

function isAdminStatus(status: unknown): boolean {
  return status === "administrator" || status === "creator";
}

/**
 * Check whether `userId` is an administrator or creator of `chatId` via
 * `api.getChatMember`, cached with a short TTL and bounded size.
 *
 * API errors fail closed (`false`) and are logged with secret redaction.
 */
export async function isChatAdmin(
  api: ChatMemberApi | Pick<Api, "getChatMember"> | null | undefined,
  chatId: number | string,
  userId: number | null | undefined,
  options: AdminCheckOptions = {},
): Promise<boolean> {
  if (
    !api ||
    typeof api.getChatMember !== "function" ||
    typeof userId !== "number" ||
    !Number.isFinite(userId) ||
    chatId === null ||
    chatId === undefined ||
    chatId === ""
  ) {
    return false;
  }

  const cache = options.cache ?? defaultCache;
  const ttlMs = options.ttlMs ?? cache.ttlMs;
  const maxSize = options.maxSize ?? cache.maxSize;
  const now = options.now ?? Date.now;
  const key = `${String(chatId)}:${String(userId)}`;

  const cached = cache.get(key, ttlMs, maxSize, now);
  if (cached !== undefined) {
    return cached;
  }

  const existing = cache.getInflight(key);
  if (existing !== undefined) {
    return existing;
  }

  const request = (async (): Promise<boolean> => {
    try {
      const member = await api.getChatMember(chatId, userId);
      const result = isAdminStatus(member?.status);
      cache.set(key, result, ttlMs, maxSize, now);
      return result;
    } catch (err) {
      console.warn(
        `[bot] getChatMember failed for chat ${String(chatId)}: ${safeErrorMessage(
          err,
          options.secrets ? [...options.secrets] : [],
        )}`,
      );
      return false;
    } finally {
      cache.deleteInflight(key);
    }
  })();

  cache.setInflight(key, request);
  return request;
}

function isGroupChat(chat: { id?: number | undefined; type?: string | undefined } | undefined): boolean {
  if (!chat) return false;
  if (chat.type === "group" || chat.type === "supergroup") return true;
  if (chat.type === "private" || chat.type === "channel") return false;
  // When chat.type is omitted in minimal test contexts, negative chat IDs
  // identify Telegram groups/supergroups while positive IDs are private chats.
  return typeof chat.id === "number" && chat.id < 0;
}

/**
 * Combined authorization helper for state-changing commands and callbacks.
 *
 * Rules:
 * 1. The configured `OPERATOR_TELEGRAM_USER_ID` is always authorised.
 * 2. Private-chat authorization is unchanged (only `OPERATOR_TELEGRAM_USER_ID`).
 * 3. In group/supergroup chats:
 *    - An anonymous admin (`sender_chat.id === chat.id`) is treated as admin.
 *    - Otherwise `isChatAdmin(api, chat.id, from.id)` checks Telegram admin rights.
 */
export async function canControl(
  ctx: Partial<Pick<Context, "from" | "chat" | "senderChat" | "message" | "callbackQuery" | "api">>,
  config: Pick<BotConfig, "operatorTelegramUserId"> & Partial<Pick<BotConfig, "botToken">>,
  api?: ChatMemberApi | Pick<Api, "getChatMember"> | null | undefined,
  options: AdminCheckOptions = {},
): Promise<boolean> {
  const operatorId = config?.operatorTelegramUserId ?? null;
  if (operatorId !== null && ctx?.from?.id !== undefined && String(ctx.from.id) === operatorId) {
    return true;
  }

  const chat =
    ctx?.chat ??
    ctx?.message?.chat ??
    (ctx?.callbackQuery?.message as { chat?: { id: number; type?: string } } | undefined)?.chat;

  if (!chat || typeof chat.id !== "number" || !isGroupChat(chat)) {
    return false;
  }

  const senderChat =
    ctx?.senderChat ??
    (ctx as { sender_chat?: { id?: number } } | undefined)?.sender_chat ??
    ctx?.message?.sender_chat;

  if (senderChat && typeof senderChat.id === "number" && senderChat.id === chat.id) {
    return true;
  }

  const userId = ctx?.from?.id ?? ctx?.message?.from?.id ?? ctx?.callbackQuery?.from?.id;
  if (typeof userId !== "number") {
    return false;
  }

  const effectiveApi = api ?? ctx?.api;
  const secrets =
    options.secrets ?? (typeof config?.botToken === "string" && config.botToken ? [config.botToken] : []);

  return isChatAdmin(effectiveApi, chat.id, userId, {
    ...options,
    secrets,
  });
}
