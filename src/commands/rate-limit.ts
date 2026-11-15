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

import { formatSuppressedRepeats, LogSampler } from "../log-sampler.js";

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

// ── Per-actor confirmation action rate limiter ───────────────────────────────

export interface ConfirmationRateLimiterOptions {
  /** Maximum burst of confirmation actions an actor bucket can hold. Defaults to 5. */
  capacity?: number;
  /** Milliseconds required to refill 1 confirmation action token. Defaults to 10,000ms. */
  refillMs?: number;
  /** Injected clock returning epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
  /** Inactivity duration in milliseconds before an idle actor bucket is evicted. Defaults to 300,000ms. */
  idleTtlMs?: number;
  /** Maximum distinct actors tracked before evicting the least recently active entry. Defaults to 1,000. */
  maxActors?: number;
}

export const DEFAULT_CONFIRMATION_CAPACITY = 5;
export const DEFAULT_CONFIRMATION_REFILL_MS = 10_000;
export const DEFAULT_CONFIRMATION_IDLE_TTL_MS = 300_000;
export const DEFAULT_CONFIRMATION_MAX_ACTORS = 1_000;

/**
 * Bounded per-actor token bucket dedicated to state-changing confirmation and
 * operator callbacks (`pause`, `resume`, `pause-confirm`, `pause-cancel`, and
 * `broadcast` confirm/cancel), independent of read-only navigation callbacks
 * (`status`, `contracts`, `help`).
 */
export class ConfirmationRateLimiter {
  readonly capacity: number;
  readonly refillMs: number;
  readonly idleTtlMs: number;
  readonly maxActors: number;
  private readonly inner: CommandRateLimiter;

  constructor(options: ConfirmationRateLimiterOptions = {}) {
    const capacity = Math.max(1, Math.trunc(options.capacity ?? DEFAULT_CONFIRMATION_CAPACITY));
    const refillMs = Math.max(1, Math.trunc(options.refillMs ?? DEFAULT_CONFIRMATION_REFILL_MS));
    const idleTtlMs = Math.max(1, Math.trunc(options.idleTtlMs ?? DEFAULT_CONFIRMATION_IDLE_TTL_MS));
    const maxActors = Math.max(1, Math.trunc(options.maxActors ?? DEFAULT_CONFIRMATION_MAX_ACTORS));

    this.inner = new CommandRateLimiter({
      capacity,
      refillMs,
      idleTtlMs,
      maxChats: maxActors,
      ...(options.now ? { now: options.now } : {}),
    });
    this.capacity = this.inner.capacity;
    this.refillMs = this.inner.refillMs;
    this.idleTtlMs = this.inner.idleTtlMs;
    this.maxActors = this.inner.maxChats;
  }

  get now(): () => number {
    return this.inner.now;
  }

  consume(actorId: string | number, cost: number = 1): boolean {
    return this.inner.consume(actorId, cost);
  }

  take(actorId: string | number, cost: number = 1): boolean {
    return this.inner.take(actorId, cost);
  }

  getTokens(actorId: string | number): number {
    return this.inner.getTokens(actorId);
  }

  /** Milliseconds until `cost` tokens are available for `actorId` (`0` if ready now). */
  retryAfterMs(actorId: string | number, cost: number = 1): number {
    if (cost > this.capacity) return Infinity;
    const deficit = cost - this.getTokens(actorId);
    if (deficit <= 0) return 0;
    return Math.ceil(deficit * this.refillMs);
  }

  evictIdle(now?: number): number {
    return this.inner.evictIdle(now);
  }

  reset(actorId?: string | number): void {
    this.inner.reset(actorId);
  }

  size(): number {
    return this.inner.size();
  }
}

const defaultConfirmationLimiters = new WeakMap<object, ConfirmationRateLimiter>();
const defaultConfirmationSamplers = new WeakMap<object, LogSampler>();
const fallbackConfirmationLimiter = new ConfirmationRateLimiter();

export interface ConfirmationLimiterDeps {
  config?: object;
  confirmationRateLimiter?: ConfirmationRateLimiter | undefined;
  confirmationRateLimitSampler?: LogSampler | undefined;
  now?: (() => number) | undefined;
}

export function resolveConfirmationRateLimiter(
  deps: ConfirmationLimiterDeps,
): ConfirmationRateLimiter {
  if (deps.confirmationRateLimiter !== undefined) {
    return deps.confirmationRateLimiter;
  }
  const cacheKey =
    deps.config !== undefined && deps.config !== null && typeof deps.config === "object"
      ? deps.config
      : deps;
  if (cacheKey && typeof cacheKey === "object") {
    let cached = defaultConfirmationLimiters.get(cacheKey);
    if (!cached) {
      cached = new ConfirmationRateLimiter(deps.now ? { now: deps.now } : {});
      defaultConfirmationLimiters.set(cacheKey, cached);
    }
    return cached;
  }
  return fallbackConfirmationLimiter;
}

export function resolveConfirmationRateLimitSampler(
  deps: ConfirmationLimiterDeps,
  limiter: ConfirmationRateLimiter,
): LogSampler {
  if (deps.confirmationRateLimitSampler !== undefined) {
    return deps.confirmationRateLimitSampler;
  }
  let cached = defaultConfirmationSamplers.get(limiter);
  if (!cached) {
    cached = new LogSampler({
      maxPerWindow: 1,
      windowMs: 60_000,
      now: deps.now ?? limiter.now,
    });
    defaultConfirmationSamplers.set(limiter, cached);
  }
  return cached;
}

/**
 * Consume one confirmation action token for `actorId`, emitting a sampled
 * warning when throttled. Returns `true` when allowed, `false` when throttled.
 */
export function tryConsumeConfirmationAction(
  actorId: string | number | undefined,
  actionLabel: string,
  deps: ConfirmationLimiterDeps,
): boolean {
  const key = actorId !== undefined ? String(actorId) : "unknown";
  const limiter = resolveConfirmationRateLimiter(deps);
  if (limiter.consume(key)) {
    return true;
  }
  const sampler = resolveConfirmationRateLimitSampler(deps, limiter);
  const sample = sampler.record(`${key}:${actionLabel}`);
  if (sample.log) {
    const repeats = formatSuppressedRepeats(sample.suppressed, sampler.windowMs);
    console.warn(
      `[bot] confirmation rate limit exceeded for actor ${key}, throttling ${actionLabel}${repeats}`,
    );
  }
  return false;
}

// `registerCommandHandlers` in src/bot.ts reads the limiter, the sampler for
// its "rate limit exceeded" warning and the injected clock from the command
// deps, so tests and embedders can supply their own.
declare module "./registry.js" {
  interface CommandDeps {
    /** Per-chat command rate limiter. Defaults to a fresh limiter per bot. */
    rateLimiter?: CommandRateLimiter | undefined;
    /** Sampler for the "rate limit exceeded" warning. */
    rateLimitSampler?: LogSampler | undefined;
    /** Per-actor confirmation/operator callback rate limiter. */
    confirmationRateLimiter?: ConfirmationRateLimiter | undefined;
    /** Sampler for the confirmation rate-limit warning. */
    confirmationRateLimitSampler?: LogSampler | undefined;
    /** Injected clock (epoch ms) for the default rate limiter and sampler. */
    now?: (() => number) | undefined;
  }
}
