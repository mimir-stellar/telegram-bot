import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_PAUSE_CONFIRM,
  classifyCallbackError,
  createBot,
  extractCallbackLogIds,
  formatCallbackErrorLog,
  handleCallbackQuery,
  handlePauseConfirmCallback,
} from "../dist/bot.js";
import { BroadcastStore, handleBroadcastCallback } from "../dist/commands/broadcast.js";
import { MAX_CALLBACK_ERROR_LOG_LEN, safeAnswerCallback } from "../dist/commands/runtime.js";

const TEST_BOT_TOKEN = ["123456789:", "SECRET-BOT-TOKEN-TEST-0001"].join("");

function fakeConfig(overrides = {}) {
  return {
    botToken: TEST_BOT_TOKEN,
    chatId: "-1001234567890",
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function captureConsole(method) {
  const lines = [];
  const original = console[method];
  console[method] = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console[method] = original;
    },
  };
}

function buildHostileNestedUpdate(depth = 2500) {
  const root = {
    update_id: 9001,
    callback_query: {
      id: "cq-hostile-9001",
      from: {
        id: 42,
        is_bot: false,
        first_name: "SecretFirstName",
        username: "secret_operator_handle",
      },
      message: {
        message_id: 77,
        date: 1700000000,
        chat: { id: -1001234567890, type: "private", title: "PrivateOpChat" },
        text: "CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG",
      },
      data: "status",
    },
  };

  let cursor = root;
  for (let i = 0; i < depth; i += 1) {
    cursor.nested = { level: i, sensitive: "DEEP_SECRET_MARKER" };
    cursor = cursor.nested;
  }
  // Introduce a cycle to verify JSON.stringify-style traversal is never attempted.
  cursor.self = root;
  return root;
}

test("extractCallbackLogIds extracts only bounded stable IDs and handles hostile contexts", () => {
  const ids = extractCallbackLogIds({
    update: { update_id: 4242, message: { text: "secret" } },
    callbackQuery: { id: "cq-stable-1", from: { username: "alice" } },
  });
  assert.deepEqual(ids, { updateId: "4242", callbackQueryId: "cq-stable-1" });

  // Oversized, control-char, and token-bearing IDs are sanitized and bounded.
  const hostileCtx = {
    update: { update_id: Number.NaN },
    callbackQuery: {
      id: `cq\n\r\t-${TEST_BOT_TOKEN}-` + "x".repeat(200),
    },
  };
  const hostileIds = extractCallbackLogIds(hostileCtx, [TEST_BOT_TOKEN]);
  assert.equal(hostileIds.updateId, "unknown");
  assert.equal(hostileIds.callbackQueryId.includes("\n"), false);
  assert.equal(hostileIds.callbackQueryId.includes(TEST_BOT_TOKEN), false);
  assert.ok(hostileIds.callbackQueryId.length <= 64);

  // Throwing getters never crash ID extraction.
  const throwingCtx = {
    get update() {
      throw new Error("boom");
    },
    get callbackQuery() {
      throw new Error("boom");
    },
  };
  assert.deepEqual(extractCallbackLogIds(throwingCtx), {
    updateId: "unknown",
    callbackQueryId: "unknown",
  });
});

test("classifyCallbackError categorizes errors without serializing update objects", () => {
  const hostileUpdate = buildHostileNestedUpdate();

  assert.equal(classifyCallbackError(hostileUpdate), "unstructured_update_error");
  assert.equal(
    classifyCallbackError(new Error(`Update dump: ${JSON.stringify({ update_id: 1, text: "secret" })}`)),
    "runtime_error",
  );
  assert.equal(classifyCallbackError(new TypeError("bad field")), "error:TypeError");
  assert.equal(
    classifyCallbackError({
      error_code: 400,
      method: "editMessageText",
      description: "Bad Request: CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG",
      payload: { text: "secret" },
    }),
    "telegram_api_400:editMessageText",
  );
  assert.equal(
    classifyCallbackError(new Error("Bad Request: query is too old")),
    "telegram_query_expired",
  );
  assert.equal(classifyCallbackError({ code: "ECONNREFUSED" }), "code:ECONNREFUSED");
  assert.equal(classifyCallbackError({ name: "TimeoutError" }), "timeout");
  assert.equal(classifyCallbackError("raw string with secret"), "non_error_string");
  assert.equal(classifyCallbackError(null), "unknown_error");
});

test("formatCallbackErrorLog bounds hostile nested update data and redacts secrets", () => {
  const hostileUpdate = buildHostileNestedUpdate(3000);
  const line = formatCallbackErrorLog({
    ctx: {
      update: hostileUpdate,
      callbackQuery: hostileUpdate.callback_query,
    },
    action: "broadcast",
    broadcastId: "bc_12345",
    error: hostileUpdate,
    secrets: [TEST_BOT_TOKEN],
  });

  assert.ok(line.length <= MAX_CALLBACK_ERROR_LOG_LEN);
  assert.ok(line.includes("update_id=9001"));
  assert.ok(line.includes("callback_query_id=cq-hostile-9001"));
  assert.ok(line.includes("action=broadcast"));
  assert.ok(line.includes("broadcast_id=bc_12345"));
  assert.ok(line.includes("category=unstructured_update_error"));
  assert.equal(line.includes("SecretFirstName"), false);
  assert.equal(line.includes("secret_operator_handle"), false);
  assert.equal(line.includes("CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG"), false);
  assert.equal(line.includes("DEEP_SECRET_MARKER"), false);
  assert.equal(line.includes(TEST_BOT_TOKEN), false);
});

test("handleCallbackQuery logs only stable IDs and redacted error category on failure", async () => {
  const cap = captureConsole("error");
  try {
    const hostileUpdate = buildHostileNestedUpdate(100);
    const ctx = {
      from: { id: 42 },
      chat: hostileUpdate.callback_query.message.chat,
      update: hostileUpdate,
      callbackQuery: {
        ...hostileUpdate.callback_query,
        data: "status",
      },
      editMessageText: async () => {
        throw hostileUpdate;
      },
      reply: async () => {
        throw hostileUpdate;
      },
      answerCallbackQuery: async () => true,
    };

    await handleCallbackQuery(ctx, {
      config: fakeConfig(),
      status: () => ({
        running: true,
        paused: false,
        startedAt: 1,
        cycles: 1,
        lastPollAt: 1,
        lastSuccessAt: 1,
        latestLedger: 100,
        oldestLedger: 50,
        notificationsSent: 0,
        notificationsFailed: 0,
        eventsSkipped: 0,
        consecutiveFailures: 0,
        lastError: null,
        targets: [],
      }),
    });

    assert.equal(cap.lines.length, 1);
    const logged = cap.lines[0];
    assert.ok(logged.includes("update_id=9001"));
    assert.ok(logged.includes("callback_query_id=cq-hostile-9001"));
    assert.ok(logged.includes("action=status"));
    assert.ok(logged.includes("category=unstructured_update_error"));
    assert.equal(logged.includes("CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG"), false);
    assert.equal(logged.includes("secret_operator_handle"), false);
  } finally {
    cap.restore();
  }
});

test("handlePauseConfirmCallback catches and logs bounded error without update serialization", async () => {
  const cap = captureConsole("error");
  try {
    const hostileUpdate = buildHostileNestedUpdate(50);
    const ctx = {
      from: { id: 42 },
      chat: hostileUpdate.callback_query.message.chat,
      update: hostileUpdate,
      callbackQuery: {
        id: "cq-pause-1",
        data: CALLBACK_PAUSE_CONFIRM,
        message: { date: Math.floor(Date.now() / 1000) },
      },
      answerCallbackQuery: async () => true,
      editMessageText: async () => {
        throw {
          error_code: 429,
          method: "editMessageText",
          description: `Too Many Requests token=${TEST_BOT_TOKEN}`,
          payload: hostileUpdate,
        };
      },
    };

    await assert.doesNotReject(
      handlePauseConfirmCallback(ctx, {
        config: fakeConfig(),
        pause: () => "paused",
      }),
    );

    assert.equal(cap.lines.length, 1);
    const logged = cap.lines[0];
    assert.ok(logged.includes("update_id=9001"));
    assert.ok(logged.includes("callback_query_id=cq-pause-1"));
    assert.ok(logged.includes("action=pause_confirm"));
    assert.ok(logged.includes("category=telegram_api_429:editMessageText"));
    assert.equal(logged.includes(TEST_BOT_TOKEN), false);
    assert.equal(logged.includes("CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG"), false);
  } finally {
    cap.restore();
  }
});

test("handleBroadcastCallback logs broadcast_id and bounded category when delivery reply fails", async () => {
  const cap = captureConsole("error");
  try {
    const store = new BroadcastStore();
    const pending = store.create("42", "Maintenance window", ["-100111"]);
    const hostileUpdate = buildHostileNestedUpdate(50);
    const ctx = {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: hostileUpdate,
      callbackQuery: {
        id: "cq-bc-1",
        data: `broadcast:confirm:${pending.id}`,
      },
      api: {
        sendMessage: async () => ({ message_id: 1 }),
      },
      answerCallbackQuery: async () => true,
      reply: async () => {
        throw new Error(`Reply failed with update ${JSON.stringify(hostileUpdate.callback_query.from)}`);
      },
    };

    await assert.doesNotReject(
      handleBroadcastCallback(
        ctx,
        { config: fakeConfig(), broadcastStore: store, sleep: async () => {} },
        `broadcast:confirm:${pending.id}`,
      ),
    );

    assert.equal(cap.lines.length, 1);
    const logged = cap.lines[0];
    assert.ok(logged.includes("update_id=9001"));
    assert.ok(logged.includes("callback_query_id=cq-bc-1"));
    assert.ok(logged.includes("action=broadcast"));
    assert.ok(logged.includes(`broadcast_id=${pending.id}`));
    assert.ok(logged.includes("category=runtime_error"));
    assert.equal(logged.includes("secret_operator_handle"), false);
  } finally {
    cap.restore();
  }
});

test("safeAnswerCallback logs bounded category without serializing hostile error", async () => {
  const cap = captureConsole("warn");
  try {
    const hostileUpdate = buildHostileNestedUpdate(50);
    await safeAnswerCallback(
      {
        update: hostileUpdate,
        callbackQuery: { id: "cq-ans-1" },
        answerCallbackQuery: async () => {
          throw hostileUpdate;
        },
      },
      fakeConfig(),
      { text: "ok" },
    );

    assert.equal(cap.lines.length, 1);
    const logged = cap.lines[0];
    assert.ok(logged.includes("update_id=9001"));
    assert.ok(logged.includes("callback_query_id=cq-ans-1"));
    assert.ok(logged.includes("category=unstructured_update_error"));
    assert.equal(logged.includes("CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG"), false);
  } finally {
    cap.restore();
  }
});

test("bot.catch logs callback errors using stable IDs and category only", async () => {
  const cap = captureConsole("error");
  try {
    const bot = createBot({
      config: fakeConfig(),
      status: () => {
        throw buildHostileNestedUpdate(50);
      },
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "Mimir",
        username: "mimir_test_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    });

    // Trigger an error via a callback update where handleCallbackQuery's switch throws?
    // handleCallbackQuery catches its own errors; test bot.catch directly with a callback_query context.
    const errorHandler = bot.errorHandler;
    assert.equal(typeof errorHandler, "function");
    const hostileUpdate = buildHostileNestedUpdate(50);
    await errorHandler({
      ctx: {
        update: hostileUpdate,
        callbackQuery: hostileUpdate.callback_query,
      },
      error: hostileUpdate,
    });

    assert.equal(cap.lines.length, 1);
    const logged = cap.lines[0];
    assert.ok(logged.includes("update_id=9001"));
    assert.ok(logged.includes("callback_query_id=cq-hostile-9001"));
    assert.ok(logged.includes("action=callback_query"));
    assert.ok(logged.includes("category=unstructured_update_error"));
    assert.equal(logged.includes("CONFIDENTIAL_OPERATOR_PAYLOAD_DO_NOT_LOG"), false);
  } finally {
    cap.restore();
  }
});
