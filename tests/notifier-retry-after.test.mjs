import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotifier,
  createRoutePacer,
  DEFAULT_MAX_RETRY_AFTER_MS,
  parseBoundedRetryAfterMs,
} from "../dist/notifications/notifier.js";
import { extractRetryAfterMs } from "../dist/poller.js";

test("parseBoundedRetryAfterMs accepts valid bounded retry_after from parameters and headers", () => {
  assert.deepEqual(
    parseBoundedRetryAfterMs({ error_code: 429, parameters: { retry_after: 5 } }),
    { status: "ok", delayMs: 5_000 },
  );
  assert.deepEqual(
    parseBoundedRetryAfterMs({ response: { headers: { "Retry-After": "12" } } }),
    { status: "ok", delayMs: 12_000 },
  );
  assert.deepEqual(
    parseBoundedRetryAfterMs({ headers: new Headers({ "retry-after": "3" }) }),
    { status: "ok", delayMs: 3_000 },
  );
  assert.deepEqual(parseBoundedRetryAfterMs(new Error("plain error")), { status: "none" });
});

test("parseBoundedRetryAfterMs rejects malformed and extreme server delays", () => {
  for (const raw of ["abc", "10s", "", -5, 0, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
    const res = parseBoundedRetryAfterMs({ parameters: { retry_after: raw } });
    assert.equal(res.status, "rejected", `expected malformed rejection for ${String(raw)}`);
    assert.equal(res.reason, "malformed");
  }

  const extreme = parseBoundedRetryAfterMs(
    { parameters: { retry_after: 120 } },
    DEFAULT_MAX_RETRY_AFTER_MS,
  );
  assert.equal(extreme.status, "rejected");
  assert.equal(extreme.reason, "extreme");

  // poller's extractRetryAfterMs also rejects malformed/extreme values (returns null)
  assert.equal(extractRetryAfterMs({ parameters: { retry_after: "10s" } }), null);
  assert.equal(extractRetryAfterMs({ parameters: { retry_after: 999_999 } }), null);
});

test("per-route pacing honors bounded retry_after without blocking unrelated routes", async () => {
  let clock = 1_000;
  const slept = [];
  const sent = [];

  const bot = {
    api: {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text, at: clock });
        if (chatId === "-100-market" && text === "m1") {
          throw { error_code: 429, parameters: { retry_after: 4 } };
        }
        return {};
      },
    },
  };

  const notify = createNotifier(
    bot,
    {
      botToken: "test-token",
      chatId: "-100-default",
      marketChatId: "-100-market",
      squadChatId: "-100-squad",
    },
    {
      maxRetryAfterMs: 10_000,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    },
  );

  // Market hits 429 with retry_after=4s
  await assert.rejects(notify("m1", "market"));

  // Squad (unrelated route) sends immediately with zero sleep
  await notify("s1", "squad");
  assert.deepEqual(slept, [], "unrelated route must not be blocked by market cooldown");

  // Market next send waits out the remaining 4s cooldown
  await notify("m2", "market");
  assert.deepEqual(slept, [4_000], "flooded route waits for bounded retry_after");
  assert.equal(sent.length, 3);
});

test("malformed or extreme retry_after does not poison route pacing", async () => {
  let clock = 1_000;
  const slept = [];
  const pacer = createRoutePacer({
    maxRetryAfterMs: 10_000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    pacer.recordFloodResponse("-1001", { parameters: { retry_after: "bogus" } });
    pacer.recordFloodResponse("-1001", { parameters: { retry_after: 86_400 } });
  } finally {
    console.warn = origWarn;
  }

  assert.equal(pacer.getRouteCooldownUntil("-1001"), null);
  await pacer.waitForRoute("-1001");
  assert.deepEqual(slept, []);
});
