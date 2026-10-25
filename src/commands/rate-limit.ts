/**
 * Per-chat token bucket rate limiter for bot commands.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Public commands (/status, /health, /contracts, /preview) build reports and
 * serialize state each time they are invoked. Telegram imposes global API limits,
 * but without in-process throttling, a single chat can flood the bot with
 * rapid commands, monopolizing event loop cycles and generating excessive
 * replies.
 *
 * This limiter maintains a per-chat token bucket:
 *  - Each chat starts with `capacity` tokens.
 *  - Each command consumes 1 token.
 *  - Tokens refill continuously at a rate of 1 token per `refillMs`.
 *  - When the bucket is empty, requests are rejected (rate-limited).
 *  - Idle chat buckets are evicted after `idleTtlMs` to keep memory strictly bounded.
 *
 * Clock injection is supported for deterministic time-travel testing.
 */

import type { LogSampler } from "../log-sampler.js";

export interface RateLimiterOptions {
  /** Maximum number of tokens a bucket can hold. Defaults to 5. */
  capacity?: number;
  /** Milliseconds required to refill 1 token. Defaults to 1,000ms. */
  refillMs?: number;
  /** Injected clock returning epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  /**
   * Inactivity duration in milliseconds before an idle chat bucket is evicted.
   * Defaults to 60,000ms (1 minute).
   */
  idleTtlMs?: number;
  /**
   * Maximum number of distinct chats to track before evicting the least
   * recently active entry. Defaults to 10,000.
   */
  maxChats?: number;
}

export type CommandRateLimiterOptions = RateLimiterOptions;

interface BucketEntry {
  tokens: number;
  lastUpdate: number;
  lastSeen: number;
}

export const DEFAULT_CAPACITY = 5;
export const DEFAULT_REFILL_MS = 1_000;
export const DEFAULT_IDLE_TTL_MS = 60_000;
export const DEFAULT_MAX_CHATS = 10_000;

export class CommandRateLimiter {
  readonly capacity: number;
  readonly refillMs: number;
  readonly idleTtlMs: number;
  readonly maxChats: number;
  readonly now: () => number;

  private readonly buckets = new Map<string, BucketEntry>();

  constructor(
    optionsOrCapacity: RateLimiterOptions | number = {},
    refillMs?: number,
    now?: () => number,
  ) {
    if (typeof optionsOrCapacity === "number") {
      this.capacity = Math.max(1, Math.trunc(optionsOrCapacity));
      this.refillMs = Math.max(1, Math.trunc(refillMs ?? DEFAULT_REFILL_MS));
      this.now = now ?? Date.now;
      this.idleTtlMs = DEFAULT_IDLE_TTL_MS;
      this.maxChats = DEFAULT_MAX_CHATS;
    } else {
      this.capacity = Math.max(1, Math.trunc(optionsOrCapacity.capacity ?? DEFAULT_CAPACITY));
      this.refillMs = Math.max(1, Math.trunc(optionsOrCapacity.refillMs ?? DEFAULT_REFILL_MS));
      this.now = optionsOrCapacity.now ?? Date.now;
      this.idleTtlMs = Math.max(1, Math.trunc(optionsOrCapacity.idleTtlMs ?? DEFAULT_IDLE_TTL_MS));
      this.maxChats = Math.max(1, Math.trunc(optionsOrCapacity.maxChats ?? DEFAULT_MAX_CHATS));
    }
  }

  /**
   * Attempt to consume `cost` token(s) for the specified chat.
   * Returns true if allowed, false if rate limited.
   */
  consume(chatId: string | number, cost: number = 1): boolean {
    const key = String(chatId);
    const at = this.now();

    this.evictIdle(at);

    let entry = this.buckets.get(key);

    if (entry === undefined) {
      entry = {
        tokens: this.capacity,
        lastUpdate: at,
        lastSeen: at,
      };
    } else {
      // Remove and re-insert to maintain LRU order (most recently accessed at the end)
      this.buckets.delete(key);
      const elapsed = Math.max(0, at - entry.lastUpdate);
      if (elapsed > 0) {
        const refilled = elapsed / this.refillMs;
        entry.tokens = Math.min(this.capacity, entry.tokens + refilled);
        entry.lastUpdate = at;
      }
      entry.lastSeen = at;
    }

    if (entry.tokens >= cost) {
      entry.tokens -= cost;
      this.buckets.set(key, entry);
      this.boundCapacity();
      return true;
    }

    // Over limit: keep the updated entry so future refills compute correctly
    this.buckets.set(key, entry);
    this.boundCapacity();
    return false;
  }

  /** Alias for consume(). */
  take(chatId: string | number, cost: number = 1): boolean {
    return this.consume(chatId, cost);
  }

  /**
   * Current token count for `chatId` after calculating any elapsed refills.
   * Does not consume tokens.
   */
  getTokens(chatId: string | number): number {
    const key = String(chatId);
    const entry = this.buckets.get(key);
    if (!entry) return this.capacity;

    const at = this.now();
    const elapsed = Math.max(0, at - entry.lastUpdate);
    const refilled = elapsed / this.refillMs;
    return Math.min(this.capacity, entry.tokens + refilled);
  }

  /**
   * Evicts entries that have had no command activity for at least `idleTtlMs`.
   * Returns the count of evicted chat entries.
   */
  evictIdle(now: number = this.now()): number {
    let evicted = 0;
    // Map iterates in insertion/update order (oldest lastSeen first)
    for (const [key, entry] of this.buckets) {
      if (now - entry.lastSeen >= this.idleTtlMs) {
        this.buckets.delete(key);
        evicted += 1;
      } else {
        // Since buckets are kept in LRU order, the first non-idle entry
        // implies all subsequent entries are also non-idle.
        break;
      }
    }
    return evicted;
  }

  /** Reset or clear one or all buckets. */
  reset(chatId?: string | number): void {
    if (chatId !== undefined) {
      this.buckets.delete(String(chatId));
    } else {
      this.buckets.clear();
    }
  }

  /** Number of currently tracked chat buckets. */
  size(): number {
    return this.buckets.size;
  }

  private boundCapacity(): void {
    while (this.buckets.size > this.maxChats) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey !== undefined) {
        this.buckets.delete(oldestKey);
      } else {
        break;
      }
    }
  }
}

export { CommandRateLimiter as TokenBucket, CommandRateLimiter as ChatRateLimiter };

// `registerCommandHandlers` in src/bot.ts reads the limiter, the sampler for
// its "rate limit exceeded" warning and the injected clock from the command
// deps, so tests and embedders can supply their own.
declare module "./registry.js" {
  interface CommandDeps {
    /** Per-chat command rate limiter. Defaults to a fresh limiter per bot. */
    rateLimiter?: CommandRateLimiter | undefined;
    /** Sampler for the "rate limit exceeded" warning. */
    rateLimitSampler?: LogSampler | undefined;
    /** Injected clock (epoch ms) for the default rate limiter and sampler. */
    now?: (() => number) | undefined;
  }
}
