import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMMAND_ARGUMENT_BYTES,
  commandArgumentTooLongMessage,
  createBot,
  registerCommandHandlers,
  validateCommandArgumentBytes,
} from "../dist/bot.js";
import { defineCommand } from "../dist/commands/index.js";

const BOT_INFO = {
  id: 202,
  is_bot: true,
  first_name: "MimirBot",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeConfig(overrides = {}) {
  return {
    botToken: ["123456:", "A".repeat(35)].join(""),
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    ...overrides,
  };
}

function makeDeps(configOverrides = {}, statusFn) {
  return {
    config: makeConfig(configOverrides),
    status:
      statusFn ??
      (() => ({
        running: true,
        paused: false,
        startedAt: 1,
        cycles: 0,
        lastPollAt: null,
        lastSuccessAt: null,
        latestLedger: 100,
        oldestLedger: 50,
        notificationsSent: 0,
        notificationsFailed: 0,
        eventsSkipped: 0,
        consecutiveFailures: 0,
        lastError: null,
        targets: [],
      })),
    pause: () => "paused",
    resume: () => "resumed",
    botInfo: BOT_INFO,
  };
}

function makeCommandUpdate(command, argText, { chatId = -1001234567890, fromId = 42, updateId = 1 } = {}) {
  const prefix = `/${command}`;
  const fullText = argText.length > 0 ? `${prefix} ${argText}` : prefix;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup" },
      from: { id: fromId, is_bot: false, first_name: "Caller" },
      text: fullText,
      entities: [{ type: "bot_command", offset: 0, length: prefix.length }],
    },
  };
}

test("validateCommandArgumentBytes enforces exact UTF-8 byte boundary including multi-byte chars", () => {
  assert.equal(MAX_COMMAND_ARGUMENT_BYTES, 256);

  const exactAscii = validateCommandArgumentBytes({
    message: { text: `/help ${"a".repeat(256)}` },
  });
  assert.equal(exactAscii.ok, true);
  assert.equal(exactAscii.byteLength, 256);

  const overAscii = validateCommandArgumentBytes({
    message: { text: `/help ${"a".repeat(257)}` },
  });
  assert.equal(overAscii.ok, false);
  assert.equal(overAscii.byteLength, 257);

  // 64 four-byte UTF-8 emojis = 256 bytes (ok), 65 = 260 bytes (rejected even though .length is 130).
  const exactEmoji = validateCommandArgumentBytes({
    message: { text: `/help ${"🚀".repeat(64)}` },
  });
  assert.equal(exactEmoji.ok, true);
  assert.equal(exactEmoji.byteLength, 256);

  const overEmoji = validateCommandArgumentBytes({
    message: { text: `/help ${"🚀".repeat(65)}` },
  });
  assert.equal(overEmoji.ok, false);
  assert.equal(overEmoji.byteLength, 260);
});

test("createBot rejects oversized command arguments before handlers run without logging or echoing input", async () => {
  let statusCalls = 0;
  const bot = createBot(
    makeDeps({}, () => {
      statusCalls += 1;
      return makeDeps().status();
    }),
  );

  const replies = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      replies.push(payload.text);
      return {
        ok: true,
        result: {
          message_id: replies.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "supergroup" },
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });

  // Exact 256-byte argument passes through to /status handler.
  await bot.handleUpdate(makeCommandUpdate("status", "x".repeat(256), { updateId: 10 }));
  assert.equal(statusCalls, 1);
  assert.equal(replies.length, 1);

  // 257+ byte argument with distinctive marker is rejected BEFORE /status handler runs.
  replies.length = 0;
  const marker = "DISTINCTIVE_USER_INPUT_MARKER_98765_";
  const oversized = marker.repeat(10); // 360 bytes
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await bot.handleUpdate(makeCommandUpdate("status", oversized, { updateId: 11 }));
  } finally {
    console.warn = origWarn;
  }

  assert.equal(statusCalls, 1, "handler must not execute when argument exceeds byte limit");
  assert.equal(replies.length, 1);
  assert.equal(replies[0], commandArgumentTooLongMessage("status", 256));
  assert.ok(replies[0].length <= 100, "rejection reply stays short and bounded");
  assert.equal(replies[0].includes("DISTINCTIVE_USER_INPUT_MARKER"), false);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /360 bytes > 256 bytes/);
  assert.equal(
    warnings[0].includes("DISTINCTIVE_USER_INPUT_MARKER"),
    false,
    "log line must never echo raw user input",
  );
});

test("whitespace-stuffed arguments beyond 256 bytes are rejected and authorization gates still run first", async () => {
  const bot = createBot(
    makeDeps({
      allowedChatIds: ["-1001234567890"],
      operatorTelegramUserId: "42",
    }),
  );

  const replies = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      replies.push(payload.text);
      return {
        ok: true,
        result: {
          message_id: replies.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "supergroup" },
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });

  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    // Non-operator sending oversized /pause still gets silent ignore.
    await bot.handleUpdate(
      makeCommandUpdate("pause", "z".repeat(400), { fromId: 999, updateId: 20 }),
    );
    assert.equal(replies.length, 0);

    // Unapproved chat sending oversized /status still gets silent ignore.
    await bot.handleUpdate(
      makeCommandUpdate("status", "z".repeat(400), { chatId: -100999, updateId: 21 }),
    );
    assert.equal(replies.length, 0);

    // Whitespace-padded payload (>256 spaces) in an authorized chat is rejected cleanly.
    await bot.handleUpdate(
      makeCommandUpdate("help", " ".repeat(300), { chatId: -1001234567890, updateId: 22 }),
    );
    assert.equal(replies.length, 1);
    assert.equal(replies[0], commandArgumentTooLongMessage("help", 256));
  } finally {
    console.warn = origWarn;
  }
});

test("CommandModule maxArgumentBytes override enforces custom per-command ceiling", async () => {
  let customCalls = 0;
  defineCommand({
    command: "test-tiny-arg",
    hidden: true,
    maxArgumentBytes: 12,
    handler: async () => {
      customCalls += 1;
    },
  });

  const handlers = new Map();
  registerCommandHandlers(
    { command: (name, fn) => handlers.set(name, fn) },
    makeDeps(),
  );

  const handler = handlers.get("test-tiny-arg");
  const replies = [];
  const makeCtx = (arg) => ({
    from: { id: 42 },
    chat: { id: -1001234567890 },
    update: { update_id: 30 },
    match: arg,
    message: { text: `/test-tiny-arg ${arg}` },
    reply: async (text) => replies.push(text),
  });

  await handler(makeCtx("short-ok"));
  assert.equal(customCalls, 1);
  assert.equal(replies.length, 0);

  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    await handler(makeCtx("this-exceeds-twelve-bytes"));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(customCalls, 1, "handler not invoked past 12-byte ceiling");
  assert.equal(replies.length, 1);
  assert.equal(replies[0], commandArgumentTooLongMessage("test-tiny-arg", 12));
});
