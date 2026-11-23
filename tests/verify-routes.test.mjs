/**
 * verify-routes.test.mjs
 *
 * Covers `verifyRoutes` from src/notifications/verify-routes.ts and the
 * end-to-end integration between verified routes and `createNotifier`.
 *
 * All Telegram interaction goes through fake in-process bots — no real API
 * calls, no credentials.
 *
 * Before/after: previously, a route with a `topicId` that pointed at a
 * deleted or inaccessible forum topic would either raise an uncaught error
 * during the first poll cycle, or silently land the message in the wrong
 * place. After this change, `verifyRoutes` probes each route at startup;
 * invalid routes are dropped (the warning is logged) and all remaining routes
 * continue to work normally.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { verifyRoutes } from "../dist/notifications/verify-routes.js";
import { createNotifier } from "../dist/bot.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds a fake bot whose `sendMessage` succeeds by default and can be
 * scripted per call number. `deleteMessage` succeeds silently.
 *
 * @param {(callIndex: number, args: unknown[]) => unknown} [sendBehavior]
 */
function fakeBotWith(sendBehavior) {
  const sends = [];
  const deletes = [];
  let sendCall = 0;

  const bot = {
    api: {
      sendMessage: async (...args) => {
        const idx = sendCall++;
        sends.push(args);
        if (sendBehavior) return sendBehavior(idx, args);
        return { message_id: 42 + idx };
      },
      deleteMessage: async (...args) => {
        deletes.push(args);
        return true;
      },
    },
  };

  return { bot, sends, deletes };
}

/** A route without a topic (plain chat). */
function plainRoute(chatId = "-1001234567890") {
  return { chatId };
}

/** A route with a forum topic id. */
function topicRoute(chatId = "-1001234567890", topicId = 7) {
  return { chatId, topicId };
}

// ── verifyRoutes: core behaviour ─────────────────────────────────────────────

test("plain routes (no topicId) are accepted without a probe", async () => {
  const { bot, sends } = fakeBotWith();

  const result = await verifyRoutes(bot, [plainRoute()]);

  assert.equal(result.length, 1, "plain route must be returned");
  assert.equal(result[0].chatId, "-1001234567890");
  assert.equal(sends.length, 0, "no probe must be sent for a plain route");
});

test("a route whose topic probe succeeds is preserved", async () => {
  const { bot, sends, deletes } = fakeBotWith();

  const result = await verifyRoutes(bot, [topicRoute("-100111", 5)]);

  assert.equal(result.length, 1, "valid topic route must be returned");
  assert.equal(result[0].chatId, "-100111");
  assert.equal(result[0].topicId, 5);
  assert.equal(sends.length, 1, "one probe must be sent");
  // The probe must include the thread id.
  const [chatId, _text, options] = sends[0];
  assert.equal(chatId, "-100111");
  assert.equal(options.message_thread_id, 5);
  // Probe message must be deleted after success.
  assert.equal(deletes.length, 1);
});

test("a route whose topic probe throws is disabled and a warning is logged", async () => {
  const { bot, sends } = fakeBotWith(() => {
    throw { error_code: 400, description: "Bad Request: message thread not found" };
  });

  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(msg);
  let result;
  try {
    result = await verifyRoutes(bot, [topicRoute("-100222", 9)]);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(result.length, 0, "invalid route must be dropped");
  assert.equal(sends.length, 1, "one probe attempt must be made");
  assert.equal(warns.length, 1, "one warning must be emitted");
  assert.ok(warns[0].includes("[verify-routes]"), warns[0]);
  assert.ok(warns[0].includes("9"), warns[0]);         // topic id present
  assert.ok(warns[0].includes("-100222"), warns[0]);    // chat id present
});

test("invalid routes are dropped while valid routes are preserved", async () => {
  const routes = [
    topicRoute("-100good", 1),   // succeeds
    topicRoute("-100bad", 2),    // fails
    plainRoute("-100plain"),     // no probe
  ];

  let callIdx = 0;
  const { bot } = fakeBotWith((idx) => {
    // First topic call → chat -100good topic 1 → succeeds
    // Second topic call → chat -100bad topic 2 → fails
    if (callIdx++ === 1) {
      throw { error_code: 400, description: "Bad Request: message thread not found" };
    }
    return { message_id: 100 };
  });

  const warns = [];
  const origWarn = console.warn;
  console.warn = (msg) => warns.push(msg);
  let result;
  try {
    result = await verifyRoutes(bot, routes);
  } finally {
    console.warn = origWarn;
  }

  assert.equal(result.length, 2, "one valid topic route + plain route must survive");
  const chatIds = result.map((r) => r.chatId);
  assert.ok(chatIds.includes("-100good"), "good topic route must be kept");
  assert.ok(chatIds.includes("-100plain"), "plain route must be kept");
  assert.ok(!chatIds.includes("-100bad"), "bad topic route must be dropped");
  assert.equal(warns.length, 1, "exactly one warning for the dropped route");
});

test("delete failure after a successful probe does not invalidate the route", async () => {
  const { bot } = fakeBotWith(() => ({ message_id: 55 }));
  // Override deleteMessage to throw.
  bot.api.deleteMessage = async () => {
    throw new Error("forbidden");
  };

  const result = await verifyRoutes(bot, [topicRoute("-100ok", 3)]);

  assert.equal(result.length, 1, "route must still be accepted even if delete fails");
});

test("empty route list returns empty", async () => {
  const { bot, sends } = fakeBotWith();
  const result = await verifyRoutes(bot, []);
  assert.equal(result.length, 0);
  assert.equal(sends.length, 0);
});

// ── Integration: createNotifier uses topicId from verified routes ─────────────

test("createNotifier threads messages through topicId when route has one", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const config = {
    chatId: "-1001234567890",
    marketChatId: "-1001234567890",
    squadChatId: "-1001234567890",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    routes: [{ chatId: "-1001234567890", topicId: 42 }],
  };

  const notifier = createNotifier(fakeBot, config);
  await notifier("hello topic", "market");

  assert.equal(sent.length, 1, "must send exactly once");
  const [chatId, text, options] = sent[0];
  assert.equal(chatId, "-1001234567890");
  assert.equal(text, "hello topic");
  assert.equal(options.message_thread_id, 42, "must include the topic id");
});

test("createNotifier without routes sends normally (no message_thread_id)", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const config = {
    chatId: "-1001234567890",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
  };

  const notifier = createNotifier(fakeBot, config);
  await notifier("hello plain");

  assert.equal(sent.length, 1);
  const [, , options] = sent[0];
  assert.equal(options.message_thread_id, undefined, "must not add a thread id");
});

test("createNotifier: route whose topicId is undefined does not add message_thread_id", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  const config = {
    chatId: "-1001234567890",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    routes: [{ chatId: "-1001234567890", topicId: undefined }],
  };

  const notifier = createNotifier(fakeBot, config);
  await notifier("no topic");

  const [, , options] = sent[0];
  assert.equal(options.message_thread_id, undefined);
});
