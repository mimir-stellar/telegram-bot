import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotifier,
  createSendLimiter,
  DEFAULT_MAX_CONCURRENT_SENDS,
  SendLimiterClosedError,
} from "../dist/notifications/notifier.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("send limiter shares global concurrency cap across all destination routes", async () => {
  let inFlight = 0;
  let maxObserved = 0;
  const gates = [];

  const bot = {
    api: {
      sendMessage: async (chatId) => {
        inFlight += 1;
        maxObserved = Math.max(maxObserved, inFlight);
        const gate = deferred();
        gates.push({ chatId, gate });
        try {
          await gate.promise;
          return {};
        } finally {
          inFlight -= 1;
        }
      },
    },
  };

  const notify = createNotifier(
    bot,
    {
      botToken: "test-token",
      chatId: "-1001",
      marketChatId: "-1002",
      squadChatId: "-1003",
    },
    { maxConcurrentSends: 2 },
  );

  const sends = [
    notify("m1", "market"),
    notify("s1", "squad"),
    notify("d1"),
    notify("m2", "market"),
    notify("s2", "squad"),
  ];

  // Allow microtasks to schedule initial 2 sends.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(inFlight, 2, "only 2 sends should be active concurrently across all routes");
  assert.equal(notify.limiter.stats().queued, 3, "remaining 3 sends should be queued");

  let resolvedCount = 0;
  while (resolvedCount < 5) {
    const next = gates.shift();
    if (next) {
      next.gate.resolve();
      resolvedCount += 1;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  await Promise.all(sends);

  assert.equal(maxObserved, 2, "global concurrency never exceeded limit of 2");
  assert.equal(notify.limiter.stats().active, 0);
  assert.equal(notify.limiter.stats().queued, 0);
});

test("send limiter shutdown('drain') lets queued and in-flight sends complete and rejects new ones", async () => {
  const gates = [];
  const bot = {
    api: {
      sendMessage: async () => {
        const g = deferred();
        gates.push(g);
        await g.promise;
        return {};
      },
    },
  };

  const notify = createNotifier(
    bot,
    { botToken: "test-token", chatId: "-1001" },
    { maxConcurrentSends: 1 },
  );

  const p1 = notify("first");
  const p2 = notify("second");
  await new Promise((r) => setTimeout(r, 10));

  let drained = false;
  const shutdownPromise = notify.shutdown("drain").then(() => {
    drained = true;
  });

  // New sends after shutdown are rejected deterministically.
  await assert.rejects(
    notify("third"),
    (err) => err instanceof SendLimiterClosedError && err.mode === "drain",
  );

  assert.equal(drained, false, "drain must wait for active and queued sends");
  gates[0].resolve();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(drained, false, "drain must still wait for queued second send");
  gates[1].resolve();

  await Promise.all([p1, p2, shutdownPromise]);
  assert.equal(drained, true);
});

test("send limiter shutdown('cancel') rejects queued sends deterministically and waits for in-flight", async () => {
  const gates = [];
  const bot = {
    api: {
      sendMessage: async () => {
        const g = deferred();
        gates.push(g);
        await g.promise;
        return {};
      },
    },
  };

  const notify = createNotifier(
    bot,
    { botToken: "test-token", chatId: "-1001" },
    { maxConcurrentSends: 1 },
  );

  const p1 = notify("in-flight");
  const p2 = notify("queued-1");
  const p3 = notify("queued-2");
  await new Promise((r) => setTimeout(r, 10));

  let settled = false;
  const shutdownPromise = notify.shutdown("cancel").then(() => {
    settled = true;
  });

  await assert.rejects(
    p2,
    (err) => err instanceof SendLimiterClosedError && err.mode === "cancel",
  );
  await assert.rejects(
    p3,
    (err) => err instanceof SendLimiterClosedError && err.mode === "cancel",
  );
  assert.equal(settled, false, "shutdown('cancel') waits for in-flight send to settle");

  gates[0].resolve();
  await Promise.all([p1, shutdownPromise]);
  assert.equal(settled, true);
  assert.equal(gates.length, 1, "cancelled queued sends never called bot.api.sendMessage");
});

test("createSendLimiter validates maxConcurrent boundary values", () => {
  assert.ok(DEFAULT_MAX_CONCURRENT_SENDS >= 1);
  assert.throws(() => createSendLimiter({ maxConcurrent: 0 }), RangeError);
  assert.throws(() => createSendLimiter({ maxConcurrent: -2 }), RangeError);
  assert.throws(() => createSendLimiter({ maxConcurrent: Number.NaN }), RangeError);
  assert.throws(() => createSendLimiter({ maxConcurrent: 1.5 }), RangeError);
});
