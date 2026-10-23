/**
 * Tests for the /pause confirmation flow and the callback-query
 * infrastructure in bot.ts.
 *
 * Covers:
 *   - CALLBACK_PAUSE_CONFIRM/CANCEL byte-length contract
 *   - validateCallbackData: known actions, unknown actions, edge cases
 *   - operatorKeyboard: button shape and byte limits
 *   - handleCallbackQuery: pause, resume, non-operator, invalid data
 *   - validatePauseConfirmData / pauseConfirmKeyboard
 *   - handlePauseConfirmCallback: operator confirm and cancel, expiry, TTL
 *     boundary, non-operator and no-operator rejection
 *   - /pause command: operator gets a confirmation prompt (pause() is not
 *     called), non-operator gets nothing
 *
 * #694 (pause confirmation) and #709 (callback infrastructure) each shipped a
 * version of this file; the #700 merge interleaved them into invalid syntax.
 * This is the union of both. #709's "/pause by operator calls pause()" case
 * is superseded by #694's confirmation prompt, which is what /pause does.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePauseConfirmCallback,
  validateCallbackData,
  validatePauseConfirmData,
  pauseConfirmKeyboard,
  handleCallbackQuery,
  operatorKeyboard,
  CALLBACK_PAUSE_CONFIRM,
  CALLBACK_PAUSE_CANCEL,
  PAUSE_CONFIRM_TTL_MS,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  CALLBACK_FALLBACK_FEEDBACK,
  registerCommandHandlers,
} from "../dist/bot.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true, paused: false, startedAt: 1, cycles: 0,
    lastPollAt: null, lastSuccessAt: null, latestLedger: null,
    oldestLedger: null, notificationsSent: 0, notificationsFailed: 0,
    eventsSkipped: 0, eventsDeduplicated: 0, consecutiveFailures: 0,
    lastError: null, targets: [], stopping: false,
    pagesScanned: 0, emptyPages: 0, lastCyclePages: 0,
    lastCycleEmptyPages: 0, restartGaps: 0, cursorRewinds: 0,
    ...overrides,
  };
}


/**
 * Builds a fake grammy callback-query context.
 *
 * @param {object} opts
 * @param {number}  opts.userId      - Telegram user id for ctx.from.id
 * @param {string}  opts.data        - callback_query.data
 * @param {number}  opts.messageDate - Unix seconds for the originating message
 */
function callbackCtx({ userId, data, messageDate = Math.floor(Date.now() / 1000) } = {}) {
  const answered = [];
  const edits = [];
  const replies = [];
  const ctx = {
    from: { id: userId },
    update: { update_id: 1 },
    callbackQuery: { data, id: "cq-id", message: { date: messageDate, chat: { id: -1001234567890 } } },
    chat: { id: -1001234567890 },
    api: { sendMessage: async (...a) => { replies.push(a); return {}; } },
    answerCallbackQuery: async (opts = {}) => { answered.push(opts); },
    editMessageText: async (text, opts) => { edits.push({ text, opts }); },
    reply: async (...a) => { replies.push(a); },
  };
  return { ctx, answered, edits, replies };
}

/** Current Unix seconds; expiry tests pass an explicit nowMs derived from it. */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function mockedBot(deps) {
  const commandHandlers = new Map();
  const callbackHandlers = [];
  const bot = {
    command(name, handler) {
      commandHandlers.set(name, handler);
    },
    callbackQuery(_filter, handler) {
      callbackHandlers.push(handler);
    },
  };
  registerCommandHandlers(bot, deps);
  return { commandHandlers, callbackHandlers };
}

function baseDeps(overrides = {}) {
  return {
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    ...overrides,
  };
}

// ── #709: constants, validateCallbackData, operatorKeyboard, handleCallbackQuery ──

test("PAUSE_CONFIRM_TTL_MS is exported and positive", () => {
  assert.ok(typeof PAUSE_CONFIRM_TTL_MS === "number" && PAUSE_CONFIRM_TTL_MS > 0);
});

test("CALLBACK_PAUSE_CONFIRM fits within Telegram's 64-byte limit", () => {
  assert.ok(Buffer.byteLength(CALLBACK_PAUSE_CONFIRM, "utf8") <= 64);
});

test("CALLBACK_PAUSE_CANCEL fits within Telegram's 64-byte limit", () => {
  assert.ok(Buffer.byteLength(CALLBACK_PAUSE_CANCEL, "utf8") <= 64);
});

test("TELEGRAM_CALLBACK_DATA_MAX_BYTES is 64", () => {
  assert.equal(TELEGRAM_CALLBACK_DATA_MAX_BYTES, 64);
});

test("validateCallbackData: direct 'pause' token is accepted", () => {
  const result = validateCallbackData("pause");
  assert.equal(result.ok, true);
  assert.equal(result.action.type, "pause");
});

test("validateCallbackData: direct 'resume' token is accepted", () => {
  const result = validateCallbackData("resume");
  assert.equal(result.ok, true);
  assert.equal(result.action.type, "resume");
});

test("validateCallbackData: 'status', 'contracts', 'help' tokens are accepted", () => {
  for (const token of ["status", "contracts", "help"]) {
    const result = validateCallbackData(token);
    assert.equal(result.ok, true, `${token} should be accepted`);
    assert.equal(result.action.type, token);
  }
});

test("validateCallbackData: unknown string returns ok=false with reason", () => {
  const result = validateCallbackData("bad-action");
  assert.equal(result.ok, false);
  assert.ok(typeof result.reason === "string");
  assert.ok(typeof result.fallbackText === "string");
});

test("validateCallbackData: undefined returns ok=false", () => {
  const result = validateCallbackData(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
});

test("validateCallbackData: empty string returns ok=false", () => {
  const result = validateCallbackData("");
  assert.equal(result.ok, false);
});

test("validateCallbackData: oversized string (>64 bytes) returns ok=false", () => {
  const big = "x".repeat(65);
  const result = validateCallbackData(big);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "exceeds-max-length");
});

test("validateCallbackData: JSON payload {action:'pause'} is accepted", () => {
  const result = validateCallbackData(JSON.stringify({ action: "pause" }));
  assert.equal(result.ok, true);
  assert.equal(result.action.type, "pause");
});

test("validateCallbackData: mimir-prefixed colon format is accepted", () => {
  const result = validateCallbackData("mimir:status");
  assert.equal(result.ok, true);
  assert.equal(result.action.type, "status");
});

test("operatorKeyboard returns an InlineKeyboard with pause and resume buttons", () => {
  const kb = operatorKeyboard();
  const buttons = kb.inline_keyboard.flat();
  const datas = buttons.map((b) => b.callback_data);
  assert.ok(datas.includes("pause"), "should include pause button");
  assert.ok(datas.includes("resume"), "should include resume button");
});

test("operatorKeyboard button data strings are within Telegram's 64-byte limit", () => {
  const kb = operatorKeyboard();
  for (const button of kb.inline_keyboard.flat()) {
    assert.ok(
      Buffer.byteLength(button.callback_data, "utf8") <= 64,
      `Button "${button.callback_data}" exceeds 64 bytes`,
    );
  }
});

test("non-operator callback: no pause() call", async () => {
  let pauseCalls = 0;
  const deps = baseDeps({ pause: () => { pauseCalls++; return "paused"; } });
  const { ctx } = callbackCtx({ userId: 99, data: "pause" });
  await handleCallbackQuery(ctx, deps);
  assert.equal(pauseCalls, 0);
});

test("non-operator resume callback: no pause() call", async () => {
  let pauseCalls = 0;
  const deps = baseDeps({ pause: () => { pauseCalls++; return "paused"; } });
  const { ctx } = callbackCtx({ userId: 99, data: "resume" });
  await handleCallbackQuery(ctx, deps);
  assert.equal(pauseCalls, 0);
});

test("operator pause callback: pause() is called", async () => {
  let pauseCalls = 0;
  const deps = baseDeps({ pause: () => { pauseCalls++; return "paused"; } });
  const { ctx } = callbackCtx({ userId: 42, data: "pause" });
  await handleCallbackQuery(ctx, deps);
  assert.equal(pauseCalls, 1);
});

test("operator resume callback: resume() is called", async () => {
  let resumeCalls = 0;
  const deps = baseDeps({ resume: () => { resumeCalls++; return "resumed"; } });
  const { ctx } = callbackCtx({ userId: 42, data: "resume" });
  await handleCallbackQuery(ctx, deps);
  assert.equal(resumeCalls, 1);
});

test("invalid callback data: no pause/resume mutation", async () => {
  let pauseCalls = 0, resumeCalls = 0;
  const deps = baseDeps({
    pause: () => { pauseCalls++; return "paused"; },
    resume: () => { resumeCalls++; return "resumed"; },
  });
  const { ctx } = callbackCtx({ userId: 42, data: "totally-unknown-action" });
  await handleCallbackQuery(ctx, deps);
  assert.equal(pauseCalls, 0);
  assert.equal(resumeCalls, 0);
});

// ── #694: pause confirmation ─────────────────────────────────────────────────

test("validatePauseConfirmData accepts pause-confirm", () => {
  assert.equal(validatePauseConfirmData(CALLBACK_PAUSE_CONFIRM), CALLBACK_PAUSE_CONFIRM);
});

test("validatePauseConfirmData accepts pause-cancel", () => {
  assert.equal(validatePauseConfirmData(CALLBACK_PAUSE_CANCEL), CALLBACK_PAUSE_CANCEL);
});

test("validatePauseConfirmData rejects unknown data", () => {
  assert.equal(validatePauseConfirmData("bad-action"), null);
});

test("validatePauseConfirmData rejects undefined", () => {
  assert.equal(validatePauseConfirmData(undefined), null);
});

test("validatePauseConfirmData rejects empty string", () => {
  assert.equal(validatePauseConfirmData(""), null);
});

test("validateCallbackData keeps pause-confirm payloads out of the action set", () => {
  assert.equal(validateCallbackData(CALLBACK_PAUSE_CONFIRM).ok, false);
  assert.equal(validateCallbackData(CALLBACK_PAUSE_CANCEL).ok, false);
});

test("pauseConfirmKeyboard button callback_data strings are within Telegram's 64-byte limit", () => {
  assert.ok(
    Buffer.byteLength(CALLBACK_PAUSE_CONFIRM, "utf8") <= 64,
    `pause-confirm exceeds 64 bytes`,
  );
  assert.ok(
    Buffer.byteLength(CALLBACK_PAUSE_CANCEL, "utf8") <= 64,
    `pause-cancel exceeds 64 bytes`,
  );
});

test("pauseConfirmKeyboard returns an object with inline_keyboard rows", () => {
  const kb = pauseConfirmKeyboard();
  // grammy InlineKeyboard serialises to { inline_keyboard: Button[][] }
  const serialised = kb.inline_keyboard;
  assert.ok(Array.isArray(serialised), "inline_keyboard is an array");
  const allButtons = serialised.flat();
  const callbackDatas = allButtons.map((b) => b.callback_data);
  assert.ok(callbackDatas.includes(CALLBACK_PAUSE_CONFIRM));
  assert.ok(callbackDatas.includes(CALLBACK_PAUSE_CANCEL));
});

test("operator confirm: calls pause(), answers query, edits message with pauseMessage result", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds(); // fresh message
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, messageDate * 1000 + 500); // 0.5 s after send

  assert.equal(pauseCalls, 1);
  // answerCallbackQuery was called (no show_alert)
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, undefined);
  // message was edited to the pause result
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /\*Polling paused\*/);
});

test("operator confirm already-paused: edits message with already-paused text", async () => {
  const deps = {
    config: baseConfig(),
    pause: () => "already-paused",
  };

  const messageDate = nowSeconds();
  const { ctx, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, messageDate * 1000 + 100);

  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /already paused/i);
});

test("operator cancel: does NOT call pause(), answers with text, edits message", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CANCEL,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, messageDate * 1000 + 500);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].text, "Cancelled.");
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Pause cancelled/);
});

test("expired confirmation: answers with alert, edits expiry message, does NOT call pause()", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds() - 120; // 2 minutes old — well past TTL
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS + 1000; // 1 s past expiry
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.match(answered[0].text, /expired/i);
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /expired/i);
});

test("confirmation exactly at TTL boundary is still valid", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  // nowMs is exactly at the TTL — ageMs === PAUSE_CONFIRM_TTL_MS, not > it
  const nowMs = messageDate * 1000 + PAUSE_CONFIRM_TTL_MS;
  const { ctx } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, nowMs);

  assert.equal(pauseCalls, 1);
});

test("non-operator confirm: answers with alert, does NOT call pause() or edit message", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig(), // operatorTelegramUserId: "42"
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 99, // not the operator
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, messageDate * 1000 + 500);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.match(answered[0].text, /operator/i);
  assert.equal(edits.length, 0);
});

test("non-operator cancel: answers with alert, does NOT edit message", async () => {
  const deps = {
    config: baseConfig(),
    pause: () => "paused",
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 99,
    data: CALLBACK_PAUSE_CANCEL,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, messageDate * 1000 + 500);

  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.equal(edits.length, 0);
});

test("no operator configured: non-operator confirm is rejected", async () => {
  let pauseCalls = 0;
  const deps = {
    config: baseConfig({ operatorTelegramUserId: null }),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  const messageDate = nowSeconds();
  const { ctx, answered, edits } = callbackCtx({
    userId: 42,
    data: CALLBACK_PAUSE_CONFIRM,
    messageDate,
  });

  await handlePauseConfirmCallback(ctx, deps, messageDate * 1000 + 500);

  assert.equal(pauseCalls, 0);
  assert.equal(answered.length, 1);
  assert.equal(answered[0].show_alert, true);
  assert.equal(edits.length, 0);
});

test("/pause by operator sends confirmation prompt with inline keyboard, does NOT call pause()", async () => {
  let pauseCalls = 0;
  const { commandHandlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
  });

  const replies = [];
  const ctx = {
    from: { id: 42 },
    update: { update_id: 200 },
    reply: async (...args) => {
      replies.push(args);
    },
  };

  await commandHandlers.get("pause")(ctx);

  assert.equal(pauseCalls, 0, "pause() must not be called before confirmation");
  assert.equal(replies.length, 1);
  const [text, opts] = replies[0];
  assert.match(text, /Pause polling/);
  // reply_markup must carry the keyboard
  assert.ok(opts.reply_markup, "reply should include reply_markup");
  assert.ok(opts.reply_markup.inline_keyboard, "reply_markup should have inline_keyboard");
});

test("/pause by non-operator sends no reply and does not call pause()", async () => {
  let pauseCalls = 0;
  const { commandHandlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
  });

  const replies = [];
  const ctx = {
    from: { id: 99 },
    update: { update_id: 201 },
    reply: async (...args) => {
      replies.push(args);
    },
  };

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await commandHandlers.get("pause")(ctx);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(pauseCalls, 0);
  assert.deepEqual(replies, []);
});

test("registerCommandHandlers registers a callbackQuery handler for pause actions", () => {
  const { callbackHandlers } = mockedBot({
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  assert.equal(callbackHandlers.length, 1, "exactly one callbackQuery handler should be registered");
});
