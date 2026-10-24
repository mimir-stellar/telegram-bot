import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandRateLimiter,
  DEFAULT_CAPACITY,
  DEFAULT_REFILL_MS,
  DEFAULT_IDLE_TTL_MS,
} from "../dist/commands/rate-limit.js";
import { registerCommandHandlers } from "../dist/bot.js";
import { LogSampler } from "../dist/log-sampler.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    webhookUrl: null,
    telegramWebhookUrl: null,
    allowedChatIds: [],
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: 100,
    oldestLedger: 1,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

function createFakeClock(initialTime = 1_000_000) {
  let currentTime = initialTime;
  return {
    now: () => currentTime,
    advance: (ms) => {
      currentTime += ms;
      return currentTime;
    },
    set: (t) => {
      currentTime = t;
      return currentTime;
    },
  };
}

function mockedBot(deps) {
  const handlers = new Map();
  const bot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerCommandHandlers(bot, deps);
  return { bot, handlers };
}

function createMockCommandContext(chatId, userId = 100, updateId = 1) {
  const replies = [];
  const ctx = {
    chat: { id: chatId },
    from: { id: userId },
    update: { update_id: updateId },
    reply: async (...args) => {
      replies.push(args);
    },
  };
  return { ctx, replies };
}

// ── Unit Tests: Token Bucket Rate Limiter ────────────────────────────────────

test("token bucket starts at full capacity and consumes tokens", () => {
  const clock = createFakeClock(10_000);
  const limiter = new CommandRateLimiter({
    capacity: 3,
    refillMs: 1_000,
    now: clock.now,
  });

  assert.equal(limiter.consume(123), true);
  assert.equal(limiter.consume(123), true);
  assert.equal(limiter.consume(123), true);
  // 4th request exceeds capacity
  assert.equal(limiter.consume(123), false);
  assert.equal(limiter.consume(123), false);
});

test("token bucket refills at refillMs rate up to capacity", () => {
  const clock = createFakeClock(10_000);
  const limiter = new CommandRateLimiter({
    capacity: 2,
    refillMs: 1_000,
    now: clock.now,
  });

  // Consume 2 tokens
  assert.equal(limiter.consume("chat-a"), true);
  assert.equal(limiter.consume("chat-a"), true);
  assert.equal(limiter.consume("chat-a"), false);

  // Advance by 500ms (not yet 1 full token)
  clock.advance(500);
  assert.equal(limiter.consume("chat-a"), false);

  // Advance another 500ms (1000ms total -> 1 token refilled)
  clock.advance(500);
  assert.equal(limiter.consume("chat-a"), true);
  assert.equal(limiter.consume("chat-a"), false);

  // Advance 5,000ms -> should cap at capacity (2 tokens)
  clock.advance(5_000);
  assert.equal(limiter.consume("chat-a"), true);
  assert.equal(limiter.consume("chat-a"), true);
  assert.equal(limiter.consume("chat-a"), false);
});

test("token bucket isolates limits per chat", () => {
  const clock = createFakeClock(10_000);
  const limiter = new CommandRateLimiter({
    capacity: 1,
    refillMs: 2_000,
    now: clock.now,
  });

  assert.equal(limiter.consume("chat-1"), true);
  assert.equal(limiter.consume("chat-1"), false);

  // chat-2 is completely unaffected by chat-1's exhaustion
  assert.equal(limiter.consume("chat-2"), true);
  assert.equal(limiter.consume("chat-2"), false);
});

test("token bucket evicts idle chats to bound memory state", () => {
  const clock = createFakeClock(10_000);
  const limiter = new CommandRateLimiter({
    capacity: 2,
    refillMs: 1_000,
    idleTtlMs: 5_000,
    now: clock.now,
  });

  limiter.consume("active-chat");
  limiter.consume("idle-chat");
  assert.equal(limiter.size(), 2);

  // Advance past idle TTL for idle-chat, but keep active-chat refreshed
  clock.advance(4_000);
  limiter.consume("active-chat"); // refreshes active-chat lastSeen to 14_000

  clock.advance(2_000); // clock is 16_000; idle-chat was last seen at 10_000 (diff 6_000 >= 5_000)
  const evicted = limiter.evictIdle();
  assert.equal(evicted, 1);
  assert.equal(limiter.size(), 1);

  // After eviction, idle-chat gets a fresh full bucket if it speaks again
  assert.equal(limiter.consume("idle-chat"), true);
  assert.equal(limiter.size(), 2);
});

test("token bucket strictly caps maxChats tracking", () => {
  const clock = createFakeClock(10_000);
  const limiter = new CommandRateLimiter({
    capacity: 2,
    refillMs: 1_000,
    maxChats: 3,
    now: clock.now,
  });

  limiter.consume("chat-1");
  limiter.consume("chat-2");
  limiter.consume("chat-3");
  assert.equal(limiter.size(), 3);

  // Adding a 4th chat evicts the oldest (chat-1)
  limiter.consume("chat-4");
  assert.equal(limiter.size(), 3);

  // chat-1 starts fresh with full tokens if accessed again
  assert.equal(limiter.getTokens("chat-1"), 2);
});

test("token bucket supports positional constructor arguments and defaults", () => {
  const limiter = new CommandRateLimiter(10, 2000);
  assert.equal(limiter.capacity, 10);
  assert.equal(limiter.refillMs, 2000);
  assert.equal(limiter.idleTtlMs, DEFAULT_IDLE_TTL_MS);

  const defaultLimiter = new CommandRateLimiter();
  assert.equal(defaultLimiter.capacity, DEFAULT_CAPACITY);
  assert.equal(defaultLimiter.refillMs, DEFAULT_REFILL_MS);
});

// ── Integration Tests: Bot Command Rate Limiting ─────────────────────────────

test("bot command rate limiting rejects over-limit requests with no reply", async () => {
  const clock = createFakeClock(100_000);
  const rateLimiter = new CommandRateLimiter({
    capacity: 2,
    refillMs: 5_000,
    now: clock.now,
  });

  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    rateLimiter,
  });

  const { ctx: ctx1, replies: replies1 } = createMockCommandContext(999, 100, 1);
  const { ctx: ctx2, replies: replies2 } = createMockCommandContext(999, 100, 2);
  const { ctx: ctx3, replies: replies3 } = createMockCommandContext(999, 100, 3);

  // Request 1: allowed, replies with status
  await handlers.get("status")(ctx1);
  assert.equal(replies1.length, 1);

  // Request 2: allowed, replies with help
  await handlers.get("help")(ctx2);
  assert.equal(replies2.length, 1);

  // Request 3: rate limit exceeded! Must produce NO reply
  await handlers.get("status")(ctx3);
  assert.equal(replies3.length, 0);
});

test("operator bypasses rate limiting completely", async () => {
  const clock = createFakeClock(100_000);
  const rateLimiter = new CommandRateLimiter({
    capacity: 1,
    refillMs: 10_000,
    now: clock.now,
  });

  const { handlers } = mockedBot({
    config: baseConfig({ operatorTelegramUserId: "42" }),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    rateLimiter,
  });

  // Regular user uses up their 1 token
  const { ctx: regCtx1, replies: regRep1 } = createMockCommandContext(111, 888, 1);
  const { ctx: regCtx2, replies: regRep2 } = createMockCommandContext(111, 888, 2);

  await handlers.get("help")(regCtx1);
  assert.equal(regRep1.length, 1);

  await handlers.get("help")(regCtx2);
  assert.equal(regRep2.length, 0, "regular user must be rate limited on 2nd command");

  // Operator in the exact same chat (or private chat) is never rate-limited
  const { ctx: opCtx1, replies: opRep1 } = createMockCommandContext(111, 42, 3);
  const { ctx: opCtx2, replies: opRep2 } = createMockCommandContext(111, 42, 4);
  const { ctx: opCtx3, replies: opRep3 } = createMockCommandContext(111, 42, 5);

  await handlers.get("status")(opCtx1);
  await handlers.get("status")(opCtx2);
  await handlers.get("status")(opCtx3);

  assert.equal(opRep1.length, 1);
  assert.equal(opRep2.length, 1);
  assert.equal(opRep3.length, 1);
});

test("rate limit logs once per window via LogSampler", async () => {
  const clock = createFakeClock(100_000);
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const rateLimiter = new CommandRateLimiter({
      capacity: 1,
      refillMs: 60_000,
      now: clock.now,
    });
    const rateLimitSampler = new LogSampler({
      maxPerWindow: 1,
      windowMs: 10_000,
      now: clock.now,
    });

    const { handlers } = mockedBot({
      config: baseConfig(),
      status: () => baseStatus(),
      pause: () => "paused",
      resume: () => "resumed",
      rateLimiter,
      rateLimitSampler,
    });

    const chatA = 555;
    // 1st command: allowed
    const { ctx: c1 } = createMockCommandContext(chatA, 10, 1);
    await handlers.get("status")(c1);
    assert.equal(warnings.length, 0);

    // 2nd command: rejected, logs once
    const { ctx: c2 } = createMockCommandContext(chatA, 10, 2);
    await handlers.get("status")(c2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[bot\] rate limit exceeded for chat 555, ignoring \/status/);

    // 3rd & 4th commands in same window: rejected, but suppressed by LogSampler (no new logs)
    const { ctx: c3 } = createMockCommandContext(chatA, 10, 3);
    const { ctx: c4 } = createMockCommandContext(chatA, 10, 4);
    await handlers.get("health")(c3);
    await handlers.get("contracts")(c4);
    assert.equal(warnings.length, 1, "repeats within window are suppressed");

    // Advance clock past the sampler window (10s)
    clock.advance(10_001);

    // 5th command: rejected, now logs with suppressed count summary
    const { ctx: c5 } = createMockCommandContext(chatA, 10, 5);
    await handlers.get("status")(c5);
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /suppressed 2 identical repeats/);
  } finally {
    console.warn = origWarn;
  }
});

test("commands work again after token refill with fake clock", async () => {
  const clock = createFakeClock(200_000);
  const rateLimiter = new CommandRateLimiter({
    capacity: 1,
    refillMs: 2_000,
    now: clock.now,
  });

  const { handlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    rateLimiter,
  });

  const { ctx: c1, replies: r1 } = createMockCommandContext(777, 20, 1);
  await handlers.get("help")(c1);
  assert.equal(r1.length, 1);

  // Immediate 2nd command: blocked
  const { ctx: c2, replies: r2 } = createMockCommandContext(777, 20, 2);
  await handlers.get("help")(c2);
  assert.equal(r2.length, 0);

  // Advance clock by 2,000ms: refilled 1 token
  clock.advance(2_000);

  const { ctx: c3, replies: r3 } = createMockCommandContext(777, 20, 3);
  await handlers.get("help")(c3);
  assert.equal(r3.length, 1);
});
