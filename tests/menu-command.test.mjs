import test from "node:test";
import assert from "node:assert/strict";
import {
  CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK,
  COMMANDS,
  TELEGRAM_OPTIONS,
  contractsMessage,
  handleCallbackQuery,
  helpMessage,
  menuKeyboard,
  menuMessage,
  registerCommandHandlers,
  statusMessage,
} from "../dist/bot.js";

const ALLOWED_CHAT_ID = -1001234567890;
const UNAPPROVED_CHAT_ID = -1009999999999;

function fakeConfig(overrides = {}) {
  return {
    botToken: "123456789:" + "A".repeat(35),
    chatId: String(ALLOWED_CHAT_ID),
    allowedChatIds: [String(ALLOWED_CHAT_ID)],
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
    channelPreviewMode: false,
    ...overrides,
  };
}

function fakeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_000_000,
    cycles: 2,
    lastPollAt: 1_000_500,
    lastSuccessAt: 1_000_500,
    latestLedger: 500_000,
    oldestLedger: 400_000,
    notificationsSent: 1,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

function makeDeps(configOverrides = {}) {
  const config = fakeConfig(configOverrides);
  const status = fakeStatus();
  return {
    config,
    status: () => status,
    pause: () => "paused",
    resume: () => "resumed",
  };
}

function makeCallbackCtx({ data, chatId = ALLOWED_CHAT_ID, userId = 100, withMessage = true } = {}) {
  const edits = [];
  const replies = [];
  const answers = [];
  const sent = [];

  const ctx = {
    from: { id: userId },
    chat: chatId != null ? { id: chatId } : undefined,
    update: { update_id: 101 },
    callbackQuery: {
      id: "cb-1",
      data,
      message: withMessage
        ? {
            message_id: 10,
            chat: chatId != null ? { id: chatId } : undefined,
          }
        : undefined,
    },
    editMessageText: async (text, opts) => {
      edits.push({ text, opts });
    },
    reply: async (text, opts) => {
      replies.push({ text, opts });
    },
    answerCallbackQuery: async (params) => {
      answers.push(params);
    },
    api: {
      sendMessage: async (targetChatId, text, opts) => {
        sent.push({ targetChatId, text, opts });
      },
    },
  };

  return { ctx, edits, replies, answers, sent };
}

test("menuMessage returns a non-empty string", () => {
  const message = menuMessage();
  assert.strictEqual(typeof message, "string");
  assert.ok(message.length > 0);
});

test("menuMessage mentions status, contracts and help", () => {
  const message = menuMessage();
  assert.match(message, /Status/i);
  assert.match(message, /Contracts/i);
  assert.match(message, /Help/i);
});

test("menuKeyboard returns inline keyboard with expected callback data", () => {
  const keyboard = menuKeyboard();
  assert.ok(keyboard.inline_keyboard);
  const data = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.deepEqual(data, ["status", "contracts", "help"]);
});

test("menuKeyboard buttons have text", () => {
  const keyboard = menuKeyboard();
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      assert.strictEqual(typeof button.text, "string");
      assert.ok(button.text.length > 0);
    }
  }
});

test("/menu is registered in COMMANDS and replies with menu message and keyboard in allowed chat", async () => {
  assert.ok(
    COMMANDS.some((c) => c.command === "menu"),
    "/menu must be present in COMMANDS",
  );

  const handlers = new Map();
  const deps = makeDeps();
  registerCommandHandlers(
    { command: (name, handler) => handlers.set(name, handler) },
    deps,
  );

  const menuHandler = handlers.get("menu");
  assert.equal(typeof menuHandler, "function");

  const replies = [];
  await menuHandler({
    from: { id: 100 },
    chat: { id: ALLOWED_CHAT_ID },
    update: { update_id: 1 },
    reply: async (text, opts) => replies.push({ text, opts }),
  });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, menuMessage());
  assert.deepEqual(replies[0].opts, {
    ...TELEGRAM_OPTIONS,
    reply_markup: menuKeyboard(),
  });
});

test("/menu is denied on initial command entry for unapproved chats", async () => {
  const handlers = new Map();
  const deps = makeDeps();
  registerCommandHandlers(
    { command: (name, handler) => handlers.set(name, handler) },
    deps,
  );

  const menuHandler = handlers.get("menu");
  const replies = [];
  await menuHandler({
    from: { id: 100 },
    chat: { id: UNAPPROVED_CHAT_ID },
    update: { update_id: 2 },
    reply: async (text, opts) => replies.push({ text, opts }),
  });

  assert.equal(replies.length, 0);
});

test("menu navigation callbacks dispatch status, contracts, help, and menu in an allowed chat", async () => {
  const deps = makeDeps();

  for (const [data, expectedText] of [
    ["status", statusMessage(deps.config, deps.status())],
    ["contracts", contractsMessage(deps.config)],
    ["help", helpMessage(deps.config)],
    ["menu", menuMessage()],
  ]) {
    const { ctx, edits, answers } = makeCallbackCtx({ data, chatId: ALLOWED_CHAT_ID });
    await handleCallbackQuery(ctx, deps);

    assert.equal(edits.length, 1, `callback "${data}" should edit the message`);
    assert.equal(edits[0].text, expectedText);
    assert.equal(answers.length, 1, `callback "${data}" should answer the callback query`);
  }
});

test("menu navigation callbacks enforce chat allowlist authorization on every callback", async () => {
  const deps = makeDeps();

  for (const data of ["menu", "status", "contracts", "help"]) {
    const { ctx, edits, replies, sent, answers } = makeCallbackCtx({
      data,
      chatId: UNAPPROVED_CHAT_ID,
    });
    await handleCallbackQuery(ctx, deps);

    assert.equal(edits.length, 0, `unauthorized "${data}" callback must not edit message`);
    assert.equal(replies.length, 0, `unauthorized "${data}" callback must not reply`);
    assert.equal(sent.length, 0, `unauthorized "${data}" callback must not send message`);
    assert.deepEqual(answers, [
      { text: CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK, show_alert: true },
    ]);
  }
});

test("menu navigation callbacks deny missing chat id when ALLOWED_CHAT_IDS is configured", async () => {
  const deps = makeDeps();
  const { ctx, edits, replies, sent, answers } = makeCallbackCtx({
    data: "status",
    chatId: null,
    withMessage: false,
  });

  await handleCallbackQuery(ctx, deps);

  assert.equal(edits.length, 0);
  assert.equal(replies.length, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(answers, [
    { text: CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK, show_alert: true },
  ]);
});
