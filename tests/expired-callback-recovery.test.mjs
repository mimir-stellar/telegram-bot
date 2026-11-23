/**
 * Focused automated test suite for answering expired callbacks with localized recovery hints.
 *
 * Verifies:
 *   - Callback query is acknowledged exactly once (no duplicate answerCallbackQuery calls).
 *   - Directs the authorized operator to recreate the action with localized recovery hints.
 *   - Localization in default ('en') and configured ('es') locales.
 *   - Edge & boundary cases:
 *       - TTL boundary (exact TTL is valid, TTL + 1ms is expired).
 *       - Edit message failure does not cause double-acknowledgment.
 *       - Non-operator attempts are rejected without exposing recovery hints.
 *       - Replayed or already-processed confirmations are distinguished from expired ones.
 *       - Broadcast cancel callback on expired confirmation answers with recovery hint.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePauseConfirmCallback,
  PAUSE_CONFIRM_TTL_MS,
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_PAUSE_CANCEL,
} from "../src/callbacks.js";
import {
  handleBroadcastCallback,
  handleConfirmationsCallback,
  BroadcastStore,
} from "../src/commands/broadcast.js";
import { messagesFor, CALLBACK_MESSAGES } from "../src/i18n.js";

function fakeConfig(overrides = {}) {
  return {
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    locale: "en",
    ...overrides,
  };
}

function makeCallbackCtx({
  userId = 42,
  data = "",
  messageDate = Math.floor(Date.now() / 1000),
  chatType = "private",
  chatId = 42,
  throwOnEdit = false,
} = {}) {
  const answered = [];
  const edits = [];
  const replies = [];

  const ctx = {
    from: { id: userId },
    chat: { id: chatId, type: chatType },
    update: { update_id: 100 },
    callbackQuery: {
      id: "cq_test_id",
      data,
      message: {
        message_id: 50,
        date: messageDate,
        chat: { id: chatId, type: chatType },
      },
    },
    answerCallbackQuery: async (opts = {}) => {
      answered.push(opts);
    },
    editMessageText: async (text, opts) => {
      if (throwOnEdit) {
        const err = new Error("Bad Request: message to edit not found");
        err.error_code = 400;
        err.description = "Bad Request: message to edit not found";
        throw err;
      }
      edits.push({ text, opts });
    },
    reply: async (text, opts) => {
      replies.push({ text, opts });
    },
  };

  return { ctx, answered, edits, replies };
}

// ── 1. Pause Confirmation Callbacks ──────────────────────────────────────────

test("expired pause confirmation (en): acknowledges callback exactly once with recovery hint", async () => {
  const config = fakeConfig({ locale: "en" });
  let pauseCalled = false;
  const deps = {
    config,
    pause: () => {
      pauseCalled = true;
      return "paused";
    },
  };

  const messageDate = 1_000_000;
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS + 1000; // 1s past TTL

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(pauseCalled, false, "Must not execute pause when confirmation has expired");
  assert.equal(answered.length, 1, "Must acknowledge callback query exactly once");
  assert.equal(answered[0].show_alert, true);
  assert.equal(answered[0].text, "Confirmation expired. Run /pause again.");

  assert.equal(edits.length, 1, "Must edit confirmation message");
  assert.equal(edits[0].text, "⏱ *Pause confirmation expired\\.* Run /pause again\\.");
});

test("expired pause confirmation (es): localized recovery hint in Spanish", async () => {
  const config = fakeConfig({ locale: "es" });
  let pauseCalled = false;
  const deps = {
    config,
    pause: () => {
      pauseCalled = true;
      return "paused";
    },
  };

  const messageDate = 1_000_000;
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS + 5000;

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CANCEL,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(pauseCalled, false);
  assert.equal(answered.length, 1, "Must acknowledge callback query exactly once");
  assert.equal(answered[0].show_alert, true);
  assert.equal(answered[0].text, "Confirmación caducada. Ejecuta /pause de nuevo.");

  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⏱ *Confirmación de pausa caducada\\.* Ejecuta /pause de nuevo\\.");
});

test("expired pause confirmation: edit failure does not trigger duplicate callback acknowledgment", async () => {
  const config = fakeConfig({ locale: "en" });
  const deps = {
    config,
    pause: () => "paused",
  };

  const messageDate = 1_000_000;
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS + 1000;

  const { ctx, answered } = makeCallbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
    throwOnEdit: true, // message was deleted on Telegram
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(answered.length, 1, "Must acknowledge exactly once despite editMessageText failure");
  assert.equal(answered[0].text, "Confirmation expired. Run /pause again.");
});

test("pause confirmation at exact TTL boundary: valid and acknowledged once", async () => {
  const config = fakeConfig({ locale: "en" });
  let pauseCalled = false;
  const deps = {
    config,
    pause: () => {
      pauseCalled = true;
      return "paused";
    },
  };

  const messageDate = 1_000_000;
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS; // Exactly at boundary

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(pauseCalled, true, "Boundary ageMs === PAUSE_CONFIRM_TTL_MS must be treated as valid");
  assert.equal(answered.length, 1);
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Polling paused/i);
});

test("pause confirmation non-operator: rejected with unauthorized alert, no recovery hint", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  let pauseCalled = false;
  const deps = {
    config,
    pause: () => {
      pauseCalled = true;
      return "paused";
    },
  };

  const messageDate = 1_000_000;
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS + 10_000; // Even if expired

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 99, // Unauthorized user
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(pauseCalled, false);
  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /Only the operator/i);
  assert.equal(answered[0].text.includes("/pause"), false, "Must not leak recovery hint to unauthorized user");
  assert.equal(edits.length, 0);
});

// ── 2. Broadcast Confirmation Callbacks ──────────────────────────────────────

test("expired broadcast confirm callback (en): acknowledges callback exactly once with recovery hint", async () => {
  const config = fakeConfig({ locale: "en" });
  const store = new BroadcastStore();
  // Created in past so it is already expired
  const pending = store.create("42", "Important announcement", ["-100111"], -1000, undefined, "42");

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: `broadcast:confirm:${pending.id}`,
    chatType: "private",
    chatId: 42,
  });

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(answered.length, 1, "Must acknowledge callback query exactly once");
  assert.equal(answered[0].show_alert, true);
  assert.equal(answered[0].text, "Broadcast confirmation expired. Run /broadcast again.");

  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚠️ Broadcast confirmation expired. Run /broadcast again.");
});

test("expired broadcast confirm callback (es): localized recovery hint in Spanish", async () => {
  const config = fakeConfig({ locale: "es" });
  const store = new BroadcastStore();
  const pending = store.create("42", "Anuncio importante", ["-100111"], -5000, undefined, "42");

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: `broadcast:confirm:${pending.id}`,
    chatType: "private",
    chatId: 42,
  });

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(answered.length, 1, "Must acknowledge callback query exactly once");
  assert.equal(answered[0].show_alert, true);
  assert.equal(answered[0].text, "Confirmación de difusión caducada. Ejecuta /broadcast de nuevo.");

  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚠️ Confirmación de difusión caducada. Ejecuta /broadcast de nuevo.");
});

test("expired broadcast cancel callback: acknowledges once with recovery hint", async () => {
  const config = fakeConfig({ locale: "en" });
  const store = new BroadcastStore();
  const pending = store.create("42", "To be cancelled", ["-100111"], -1000, undefined, "42");

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: `broadcast:cancel:${pending.id}`,
    chatType: "private",
    chatId: 42,
  });

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:cancel:${pending.id}`,
  );

  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.equal(answered[0].text, "Broadcast confirmation expired. Run /broadcast again.");

  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚠️ Broadcast confirmation expired. Run /broadcast again.");
});

test("confirmations cancel callback for expired confirmation: acknowledges with recovery hint", async () => {
  const config = fakeConfig({ locale: "en" });
  const store = new BroadcastStore();
  const pending = store.create("42", "Pending in list", ["-100111"], -1000, undefined, "42");

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: `confirmations:cancel:${pending.id}`,
    chatType: "private",
    chatId: 42,
  });

  await handleConfirmationsCallback(
    ctx,
    { config, broadcastStore: store },
    `confirmations:cancel:${pending.id}`,
  );

  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.equal(answered[0].text, "Broadcast confirmation expired. Run /broadcast again.");

  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚠️ Broadcast confirmation expired. Run /broadcast again.");
});

test("broadcast callback: replayed confirmation is distinguished from expired confirmation", async () => {
  const config = fakeConfig({ locale: "en" });
  const store = new BroadcastStore();
  const pending = store.create("42", "Replay test", ["-100111"], 60_000, undefined, "42");
  store.consume(pending.id, "confirm");

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 42,
    data: `broadcast:confirm:${pending.id}`,
    chatType: "private",
    chatId: 42,
  });

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, "Broadcast expired or already processed");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].text, "⚠️ Broadcast confirmation expired or already processed.");
});

test("broadcast callback non-operator: rejected without exposing recovery hint", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const store = new BroadcastStore();
  const pending = store.create("42", "Op only", ["-100111"], -1000, undefined, "42");

  const { ctx, answered, edits } = makeCallbackCtx({
    userId: 99, // Unauthorized
    data: `broadcast:confirm:${pending.id}`,
    chatType: "private",
    chatId: 99,
  });

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /Unauthorized/i);
  assert.equal(answered[0].text.includes("/broadcast"), false, "Must not leak recovery hint to unauthorized user");
  assert.equal(edits.length, 0);
});

// ── 3. i18n Catalog Invariants ──────────────────────────────────────────────

test("CALLBACK_MESSAGES interface and exports consistency", () => {
  const en = messagesFor("en").callbackMessages;
  const es = messagesFor("es").callbackMessages;

  assert.ok(en.pauseExpiredAlert.includes("/pause"));
  assert.ok(en.pauseExpiredMessage.includes("/pause"));
  assert.ok(en.broadcastExpiredAlert.includes("/broadcast"));
  assert.ok(en.broadcastExpiredMessage.includes("/broadcast"));

  assert.ok(es.pauseExpiredAlert.includes("/pause"));
  assert.ok(es.pauseExpiredMessage.includes("/pause"));
  assert.ok(es.broadcastExpiredAlert.includes("/broadcast"));
  assert.ok(es.broadcastExpiredMessage.includes("/broadcast"));

  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
  assert.deepEqual(en, CALLBACK_MESSAGES);
});
