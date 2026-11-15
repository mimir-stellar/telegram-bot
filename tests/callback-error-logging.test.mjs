/**
 * Tests for bounded callback error logging (#856).
 *
 * Verifies that callback handlers, broadcast confirmation callbacks, pause
 * confirmation callbacks, `safeAnswerCallback`, and `bot.catch` log only
 * stable scalar IDs (`update_id`, `callback_id`), closed action tokens, and
 * redacted error categories — never serializing full Telegram `Update`
 * objects, chat IDs, usernames, broadcast text, secrets, or deeply nested /
 * circular hostile payloads.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_PAUSE_CONFIRM,
  MAX_CALLBACK_ID_LOG_CHARS,
  MAX_CALLBACK_LOG_LINE_CHARS,
  BroadcastStore,
  classifyCallbackError,
  createBot,
  extractCallbackLogIds,
  formatCallbackErrorLog,
  formatCallbackRejectionLog,
  handleBroadcastCallback,
  handleCallbackQuery,
  handlePauseConfirmCallback,
} from "../dist/bot.js";

const FAKE_CRED = ["987654321:", "A".repeat(35)].join("");
const FAKE_SEED = ["S", "A".repeat(55)].join("");
const PRIVATE_CHAT_MARKER = "-1009876543210";
const HOSTILE_USERNAME = "sensitive_operator_handle_xyz";
const HOSTILE_MESSAGE_BODY = "SENSITIVE_ANNOUNCEMENT_TEXT_DO_NOT_SERIALIZE";
const HOSTILE_CALLBACK_PAYLOAD = "broadcast:confirm:internal_cb_payload";

function makeConfig(overrides = {}) {
  return {
    botToken: FAKE_CRED,
    chatId: PRIVATE_CHAT_MARKER,
    chatIds: [PRIVATE_CHAT_MARKER],
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    interSendDelayMs: 0,
    ...overrides,
  };
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function buildHostileNestedUpdate({ updateId = 777, callbackId = "cb_safe_777", data = "status" } = {}) {
  // Build a 150-level nested structure + circular link + 512 KB string + poison getter.
  const deepRoot = {};
  let cursor = deepRoot;
  for (let i = 0; i < 150; i += 1) {
    cursor.child = {
      depth: i,
      secretCred: FAKE_CRED,
      seed: FAKE_SEED,
      blob: i === 0 ? "X".repeat(512 * 1024) : "nested_payload",
    };
    cursor = cursor.child;
  }
  cursor.self = deepRoot; // circular reference

  const message = {
    message_id: 9001,
    date: Math.floor(Date.now() / 1000),
    chat: {
      id: Number(PRIVATE_CHAT_MARKER),
      type: "private",
      username: HOSTILE_USERNAME,
      title: "Private Ops Room",
    },
    text: `${HOSTILE_MESSAGE_BODY}\n${"M".repeat(64 * 1024)}`,
    entities: [{ type: "bold", offset: 0, length: 5 }],
    reply_to_message: deepRoot,
  };

  Object.defineProperty(message, "poisonedGetter", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("poisoned message property should never be read during error logging");
    },
  });

  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: {
        id: 42,
        is_bot: false,
        first_name: "Op",
        username: HOSTILE_USERNAME,
      },
      message,
      chat_instance: "chat_inst_secret_999",
      data,
    },
  };
}

function captureConsole(fn) {
  const errors = [];
  const warnings = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  console.warn = (...args) => warnings.push(args.map(String).join(" "));

  const restore = () => {
    console.error = origError;
    console.warn = origWarn;
  };

  return Promise.resolve()
    .then(fn)
    .then(
      (value) => {
        restore();
        return { value, errors, warnings };
      },
      (err) => {
        restore();
        throw err;
      },
    );
}

function assertBoundedCleanLog(line) {
  assert.equal(typeof line, "string");
  assert.ok(line.length > 0 && line.length <= MAX_CALLBACK_LOG_LINE_CHARS);
  assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\r\n\u2028\u2029]/);
  assert.equal(line.includes(FAKE_CRED), false, "must not leak bot credential");
  assert.equal(line.includes(FAKE_SEED), false, "must not leak seed strkey");
  assert.equal(line.includes(PRIVATE_CHAT_MARKER), false, "must not leak chat id");
  assert.equal(line.includes(HOSTILE_USERNAME), false, "must not leak username");
  assert.equal(line.includes(HOSTILE_MESSAGE_BODY), false, "must not leak message body");
  assert.equal(line.includes(HOSTILE_CALLBACK_PAYLOAD), false, "must not leak raw callback data");
  assert.equal(line.includes("nested_payload"), false, "must not serialize nested update fields");
}

test("classifyCallbackError maps Telegram, HTTP, timeout, network, and unknown errors to closed categories", () => {
  assert.equal(
    classifyCallbackError({ error_code: 429, description: "Too Many Requests: retry after 30" }),
    "rate_limited",
  );
  assert.equal(
    classifyCallbackError({ error_code: 401, description: `Unauthorized ${FAKE_CRED}` }),
    "unauthorized",
  );
  assert.equal(
    classifyCallbackError({ error_code: 403, description: "Forbidden: bot was kicked" }),
    "unauthorized",
  );
  assert.equal(
    classifyCallbackError({ error_code: 400, description: "Bad Request: message to edit not found" }),
    "message_not_found",
  );
  assert.equal(
    classifyCallbackError({
      error_code: 400,
      description: "Bad Request: query is too old and response timeout expired",
    }),
    "query_expired",
  );
  assert.equal(
    classifyCallbackError({ error_code: 400, description: "Bad Request: can't parse entities" }),
    "bad_request",
  );
  assert.equal(
    classifyCallbackError({ error_code: 502, description: "Bad Gateway" }),
    "upstream_5xx",
  );

  const timeoutErr = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
  assert.equal(classifyCallbackError(timeoutErr), "timeout");

  const netErr = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  assert.equal(classifyCallbackError(netErr), "network");

  // Grammy BotError-like wrapper carrying nested error + hostile circular update
  const hostileUpdate = buildHostileNestedUpdate();
  const botErrorWrapper = {
    ctx: { update: hostileUpdate },
    error: { error_code: 429, description: "Too Many Requests" },
  };
  assert.equal(classifyCallbackError(botErrorWrapper), "rate_limited");

  // Plain object without message containing circular update must NOT be JSON.stringified
  assert.equal(classifyCallbackError({ update: hostileUpdate }), "internal");
  assert.equal(classifyCallbackError(null), "internal");
  assert.equal(classifyCallbackError(undefined), "internal");
});

test("extractCallbackLogIds keeps valid scalar IDs and sanitizes hostile, oversized, or secret IDs", () => {
  const normal = extractCallbackLogIds({
    update: { update_id: 404 },
    callbackQuery: { id: "query_404" },
  });
  assert.deepEqual(normal, { updateId: "404", callbackId: "query_404" });

  // Hostile update_id with throwing toString() and oversized callback_id
  const hostileIdObj = {
    toString() {
      throw new Error("must never invoke toString on update_id");
    },
  };
  const oversized = extractCallbackLogIds({
    update: { update_id: hostileIdObj },
    callbackQuery: { id: "q".repeat(MAX_CALLBACK_ID_LOG_CHARS + 1000) },
  });
  assert.deepEqual(oversized, { updateId: "unknown", callbackId: "oversized" });

  // Secret-shaped callback_id is redacted
  const secretId = extractCallbackLogIds(
    {
      update: { update_id: 12 },
      callbackQuery: { id: FAKE_CRED },
    },
    [FAKE_CRED],
  );
  assert.equal(secretId.updateId, "12");
  assert.equal(secretId.callbackId, "[REDACTED]");

  // JSON-like or newline-injected callback_id is rejected as "invalid"
  const injected = extractCallbackLogIds({
    update: { update_id: -5 },
    callbackQuery: { id: `{"chat":"${PRIVATE_CHAT_MARKER}"}\ninjected` },
  });
  assert.deepEqual(injected, { updateId: "unknown", callbackId: "invalid" });
});

test("formatCallbackErrorLog and formatCallbackRejectionLog never serialize hostile nested updates", () => {
  const hostileUpdate = buildHostileNestedUpdate({
    updateId: 856,
    callbackId: "cb_856",
    data: HOSTILE_CALLBACK_PAYLOAD,
  });
  const ctx = {
    update: hostileUpdate,
    callbackQuery: hostileUpdate.callback_query,
  };
  // Error carrying full hostile update, credentials, chat IDs, and message body
  const thrown = Object.assign(
    new Error(
      `Telegram failure for chat ${PRIVATE_CHAT_MARKER} user ${HOSTILE_USERNAME} ` +
        `body=${HOSTILE_MESSAGE_BODY} cred=${FAKE_CRED} Bad Request: message to edit not found`,
    ),
    {
      error_code: 400,
      payload: hostileUpdate,
      ctx,
    },
  );

  const errLine = formatCallbackErrorLog(ctx, thrown, {
    action: "status",
    secrets: [FAKE_CRED],
  });
  assertBoundedCleanLog(errLine);
  assert.equal(
    errLine,
    "[bot] callback error: update_id=856 callback_id=cb_856 action=status category=message_not_found",
  );

  const rejectLine = formatCallbackRejectionLog(ctx, {
    action: "broadcast",
    reason: "unauthorized",
    secrets: [FAKE_CRED],
  });
  assertBoundedCleanLog(rejectLine);
  assert.equal(
    rejectLine,
    "[bot] callback rejected: update_id=856 callback_id=cb_856 action=broadcast category=unauthorized",
  );
});

test("handleCallbackQuery logs only stable IDs and category when status/action throws an update-carrying object", async () => {
  const config = makeConfig();
  const hostileUpdate = buildHostileNestedUpdate({
    updateId: 901,
    callbackId: "cb_status_901",
    data: "status",
  });

  // Throw a plain non-Error object embedding the circular hostile update (which previously hit JSON.stringify!)
  const { errors, warnings } = await captureConsole(async () => {
    await handleCallbackQuery(
      {
        from: { id: 42 },
        chat: { id: Number(PRIVATE_CHAT_MARKER), type: "private" },
        update: hostileUpdate,
        callbackQuery: hostileUpdate.callback_query,
        answerCallbackQuery: async () => {
          throw { error_code: 400, description: "Bad Request: query is too old", update: hostileUpdate };
        },
        editMessageText: async () => true,
        reply: async () => ({}),
      },
      {
        config,
        status: () => {
          throw { update: hostileUpdate, secret: FAKE_CRED, chat: PRIVATE_CHAT_MARKER };
        },
        pause: () => "paused",
        resume: () => "resumed",
      },
    );
  });

  assert.equal(errors.length, 1);
  assertBoundedCleanLog(errors[0]);
  assert.equal(
    errors[0],
    "[bot] callback error: update_id=901 callback_id=cb_status_901 action=status category=internal",
  );

  // safeAnswerCallback failure also logs stable IDs + query_expired category only
  assert.equal(warnings.length, 1);
  assertBoundedCleanLog(warnings[0]);
  assert.equal(
    warnings[0],
    "[bot] callback error: update_id=901 callback_id=cb_status_901 action=answer_callback category=query_expired",
  );
});

test("handleBroadcastCallback logs only stable IDs and category on unauthorized or delivery reply failure", async () => {
  const config = makeConfig();
  const store = new BroadcastStore();
  const pending = store.create("42", HOSTILE_MESSAGE_BODY, [PRIVATE_CHAT_MARKER]);

  const hostileUpdate = buildHostileNestedUpdate({
    updateId: 902,
    callbackId: "cb_bcast_902",
    data: `broadcast:confirm:${pending.id}`,
  });

  // 1. Unauthorized tap logs bounded rejection without chat/message/payload details
  const unauthRes = await captureConsole(async () => {
    await handleBroadcastCallback(
      {
        from: { id: 999 },
        chat: { id: 999, type: "private" },
        update: hostileUpdate,
        callbackQuery: hostileUpdate.callback_query,
        answerCallbackQuery: async () => true,
      },
      {
        config,
        broadcastStore: store,
        status: () => ({}),
        pause: () => "paused",
        resume: () => "resumed",
      },
      `broadcast:confirm:${pending.id}`,
    );
  });
  assert.equal(unauthRes.warnings.length, 1);
  assertBoundedCleanLog(unauthRes.warnings[0]);
  assert.equal(
    unauthRes.warnings[0],
    "[bot] callback rejected: update_id=902 callback_id=cb_bcast_902 action=broadcast category=unauthorized",
  );

  // 2. Authorized confirm where editMessageText and fallback reply both fail with 429 carrying hostile update
  const failRes = await captureConsole(async () => {
    await handleBroadcastCallback(
      {
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        update: hostileUpdate,
        callbackQuery: hostileUpdate.callback_query,
        api: {
          sendMessage: async () => ({ message_id: 1 }),
        },
        editMessageText: async () => {
          throw { error_code: 400, description: "Bad Request: message to edit not found", update: hostileUpdate };
        },
        reply: async () => {
          throw {
            error_code: 429,
            description: `Too Many Requests: retry after 15 (chat=${PRIVATE_CHAT_MARKER}, body=${HOSTILE_MESSAGE_BODY})`,
            update: hostileUpdate,
          };
        },
        answerCallbackQuery: async () => true,
      },
      {
        config,
        broadcastStore: store,
        sleep: async () => {},
        status: () => ({}),
        pause: () => "paused",
        resume: () => "resumed",
      },
      `broadcast:confirm:${pending.id}`,
    );
  });

  assert.equal(failRes.errors.length, 1);
  assertBoundedCleanLog(failRes.errors[0]);
  assert.equal(
    failRes.errors[0],
    "[bot] callback error: update_id=902 callback_id=cb_bcast_902 action=broadcast category=rate_limited",
  );
});

test("handlePauseConfirmCallback and createBot catch log bounded IDs + category without serializing updates", async () => {
  const config = makeConfig();
  const nowSec = Math.floor(Date.now() / 1000);
  const hostileUpdate = buildHostileNestedUpdate({
    updateId: 903,
    callbackId: "cb_pause_903",
    data: CALLBACK_PAUSE_CONFIRM,
  });
  hostileUpdate.callback_query.message.date = nowSec;
  // Remove poison getter for grammy's own update cloning if any, keep deep circular payload + secrets
  delete hostileUpdate.callback_query.message.poisonedGetter;

  const pauseRes = await captureConsole(async () => {
    await handlePauseConfirmCallback(
      {
        from: { id: 42 },
        update: hostileUpdate,
        callbackQuery: hostileUpdate.callback_query,
        answerCallbackQuery: async () => true,
        editMessageText: async () => {
          throw {
            error_code: 503,
            description: `Service Unavailable for ${PRIVATE_CHAT_MARKER} ${FAKE_CRED}`,
            update: hostileUpdate,
          };
        },
      },
      { config, pause: () => "paused" },
      nowSec * 1000 + 100,
    );
  });

  assert.equal(pauseRes.errors.length, 1);
  assertBoundedCleanLog(pauseRes.errors[0]);
  assert.equal(
    pauseRes.errors[0],
    "[bot] callback error: update_id=903 callback_id=cb_pause_903 action=pause-confirm category=upstream_5xx",
  );

  // Verify createBot's bot.catch path when an unhandled error bubbles up on a callback update
  const catchConfig = makeConfig();
  let triggerMiddlewareThrow = false;
  Object.defineProperty(catchConfig, "operatorTelegramUserId", {
    configurable: true,
    enumerable: true,
    get() {
      if (triggerMiddlewareThrow) {
        throw Object.assign(new Error(`boom ${HOSTILE_MESSAGE_BODY} ${FAKE_CRED}`), {
          code: "ECONNRESET",
          update: hostileUpdate,
        });
      }
      return "42";
    },
  });

  const bot = createBot({
    config: catchConfig,
    botInfo: BOT_INFO,
    status: () => ({
      running: true,
      paused: false,
      startedAt: 1,
      cycles: 1,
      lastPollAt: 1,
      lastSuccessAt: 1,
      latestLedger: 1,
      oldestLedger: 1,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 0,
      lastError: null,
      targets: [],
    }),
    pause: () => "paused",
    resume: () => "resumed",
  });
  bot.api.config.use(async () => ({ ok: true, result: true }));

  const catchUpdate = buildHostileNestedUpdate({
    updateId: 904,
    callbackId: "cb_catch_904",
    data: "pause",
  });
  delete catchUpdate.callback_query.message.poisonedGetter;

  triggerMiddlewareThrow = true;
  const botCatchRes = await captureConsole(async () => {
    await bot.handleUpdate(catchUpdate);
    await bot.errorHandler({
      ctx: { update: catchUpdate, callbackQuery: catchUpdate.callback_query },
      error: Object.assign(new Error(`boom ${HOSTILE_MESSAGE_BODY} ${FAKE_CRED}`), {
        code: "ETIMEDOUT",
        update: hostileUpdate,
      }),
    });
  });

  const catchErrors = botCatchRes.errors;
  assert.equal(catchErrors.length, 2);
  for (const line of catchErrors) {
    assertBoundedCleanLog(line);
  }
  assert.equal(
    catchErrors[0],
    "[bot] callback error: update_id=904 callback_id=cb_catch_904 action=pause category=network",
  );
  assert.equal(
    catchErrors[1],
    "[bot] callback error: update_id=904 callback_id=cb_catch_904 action=unknown category=timeout",
  );
});
