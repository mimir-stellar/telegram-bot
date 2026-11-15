import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotifier,
  createTelegramSendLimiter,
  TelegramSendLimiterCancelledError,
} from "../dist/bot.js";
import { ConfigError, loadConfig } from "../dist/config.js";
import { createSendJournal } from "../dist/notifications/send-journal.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const BOT_CREDENTIAL = ["555666777", `AA${"FakeTestValue".repeat(3)}`].join(":");
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("shared Telegram send limiter enforces bounded concurrency across market, squad, default, and operator routes", async () => {
  const limiter = createTelegramSendLimiter({ maxConcurrent: 2 });
  const gates = [];
  const startedRoutes = [];
  let inFlight = 0;
  let observedMaxInFlight = 0;

  const fakeBot = {
    api: {
      sendMessage: async (chatId, text) => {
        inFlight += 1;
        if (inFlight > observedMaxInFlight) observedMaxInFlight = inFlight;
        startedRoutes.push(`${chatId}:${text}`);
        const gate = createDeferred();
        gates.push(gate);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      },
    },
  };

  const notify = createNotifier(
    fakeBot,
    {
      chatId: "-1001111111111",
      marketChatId: "-1002222222222",
      squadChatId: "-1003333333333",
      botToken: BOT_CREDENTIAL,
    },
    { limiter },
  );

  // Launch 5 concurrent sends across 4 distinct destinations sharing one limiter (maxConcurrent=2).
  const p1 = notify("m1", "market");
  const p2 = notify("s1", "squad");
  const p3 = notify("d1");
  const p4 = limiter.run(() => fakeBot.api.sendMessage("9990001", "op1"), { route: "operator" });
  const p5 = notify("m2", "market");

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(limiter.stats().active, 2);
  assert.equal(limiter.stats().queued, 3);
  assert.equal(startedRoutes.length, 2);

  // Release slots in waves and verify FIFO progression without ever exceeding 2 active sends.
  let resolvedCount = 0;
  while (resolvedCount < 5) {
    const currentBatch = gates.splice(0, gates.length);
    for (const g of currentBatch) {
      g.resolve({ message_id: 1 });
      resolvedCount += 1;
    }
    if (resolvedCount < 5) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  await Promise.all([p1, p2, p3, p4, p5]);

  assert.equal(observedMaxInFlight, 2);
  assert.equal(limiter.stats().peakActive, 2);
  assert.equal(limiter.stats().active, 0);
  assert.equal(limiter.stats().queued, 0);
  assert.equal(limiter.stats().completed, 5);
  assert.deepEqual(startedRoutes, [
    "-1002222222222:m1",
    "-1003333333333:s1",
    "-1001111111111:d1",
    "9990001:op1",
    "-1002222222222:m2",
  ]);
});

test("shutdown drain completes queued work while rejecting new arrivals, and cancelPending deterministically aborts queued sends", async () => {
  await withTempDataDir(async (dir) => {
    // Part A: deterministic drain()
    const drainLimiter = createTelegramSendLimiter({ maxConcurrent: 1 });
    const drainGates = [];
    const fakeDrainBot = {
      api: {
        sendMessage: async () => {
          const g = createDeferred();
          drainGates.push(g);
          return g.promise;
        },
      },
    };
    const drainNotify = createNotifier(
      fakeDrainBot,
      { chatId: "-1001", marketChatId: "-1002", squadChatId: "-1003", botToken: BOT_CREDENTIAL },
      { limiter: drainLimiter },
    );

    const activeSend = drainNotify("first", "market");
    const queuedSend = drainNotify("second", "squad");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(drainLimiter.stats().active, 1);
    assert.equal(drainLimiter.stats().queued, 1);

    const drainPromise = drainNotify.drain({ timeoutMs: 2_000 });

    // New send submitted after drain begins is rejected deterministically.
    await assert.rejects(
      drainNotify("late", "market"),
      (err) =>
        err instanceof TelegramSendLimiterCancelledError &&
        err.code === "TELEGRAM_SEND_DRAINING",
    );

    drainGates[0].resolve({ message_id: 10 });
    await new Promise((r) => setTimeout(r, 10));
    drainGates[1].resolve({ message_id: 11 });

    const drainResult = await drainPromise;
    await Promise.all([activeSend, queuedSend]);
    assert.deepEqual(drainResult, {
      drained: true,
      cancelledQueued: 0,
      remainingActive: 0,
    });

    // Part B: deterministic cancelPending() + sendJournal pre-send cancellation cleanup
    const journal = createSendJournal({ filePath: dir.file("cancel-journal.jsonl") });
    await journal.recordIntent({
      id: "evt-active",
      source: "market",
      ledger: 8001,
      eventName: "claim_created",
      at: 1_700_000_000_000,
    });
    await journal.recordIntent({
      id: "evt-queued",
      source: "squad",
      ledger: 8002,
      eventName: "squad_joined",
      at: 1_700_000_001_000,
    });

    const cancelLimiter = createTelegramSendLimiter({ maxConcurrent: 1 });
    const activeGate = createDeferred();
    let sendCalls = 0;
    const fakeCancelBot = {
      api: {
        sendMessage: async () => {
          sendCalls += 1;
          return activeGate.promise;
        },
      },
    };
    const cancelNotify = createNotifier(
      fakeCancelBot,
      { chatId: "-1001", marketChatId: "-1002", squadChatId: "-1003", botToken: BOT_CREDENTIAL },
      { limiter: cancelLimiter, sendJournal: journal },
    );

    const pActive = cancelNotify("active msg", "market", {
      eventRef: { eventId: "evt-active", ledger: 8001, source: "market" },
    });
    const pQueued = cancelNotify("queued msg", "squad", {
      eventRef: { eventId: "evt-queued", ledger: 8002, source: "squad" },
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sendCalls, 1);

    const cancelRes = cancelNotify.cancelPending("sigterm_immediate");
    assert.deepEqual(cancelRes, { cancelled: 1, active: 1 });

    await assert.rejects(
      pQueued,
      (err) =>
        err instanceof TelegramSendLimiterCancelledError &&
        err.code === "TELEGRAM_SEND_CANCELLED" &&
        err.reason === "sigterm_immediate",
    );

    // Finish the single already-in-flight request; queued request never hit sendMessage.
    activeGate.resolve({ message_id: 99 });
    await pActive;
    assert.equal(sendCalls, 1);

    // Queued item cancelled before sendMessage was settled as cancelled, while active stays pending until done.
    const pending = await journal.loadPending();
    assert.deepEqual(pending.map((p) => p.id), ["evt-active"]);
  }, "concurrency-limit-");
});

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const prev = new Map(keys.map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("TELEGRAM_MAX_CONCURRENT_SENDS validates integer bounds 1..32 in loadConfig and createTelegramSendLimiter", () => {
  assert.throws(() => createTelegramSendLimiter({ maxConcurrent: 0 }), RangeError);
  assert.throws(() => createTelegramSendLimiter({ maxConcurrent: 33 }), RangeError);
  assert.throws(() => createTelegramSendLimiter({ maxConcurrent: 1.5 }), RangeError);

  const baseEnv = {
    BOT_TOKEN: BOT_CREDENTIAL,
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: MARKET_ID,
    SQUAD_CONTRACT_ID: SQUAD_ID,
  };

  const valid = withEnv({ ...baseEnv, TELEGRAM_MAX_CONCURRENT_SENDS: "8" }, () => loadConfig());
  assert.equal(valid.telegramMaxConcurrentSends, 8);

  assert.throws(
    () => withEnv({ ...baseEnv, TELEGRAM_MAX_CONCURRENT_SENDS: "0" }, () => loadConfig()),
    (err) =>
      err instanceof ConfigError &&
      err.problems.some((p) => p.includes("TELEGRAM_MAX_CONCURRENT_SENDS must be >= 1")),
  );
  assert.throws(
    () => withEnv({ ...baseEnv, TELEGRAM_MAX_CONCURRENT_SENDS: "64" }, () => loadConfig()),
    (err) =>
      err instanceof ConfigError &&
      err.problems.some((p) => p.includes("TELEGRAM_MAX_CONCURRENT_SENDS must be <= 32")),
  );
});
