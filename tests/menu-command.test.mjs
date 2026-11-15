import test from "node:test";
import assert from "node:assert/strict";

import {
  CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
  contractsMessage,
  createBot,
  helpDetailMessage,
  helpMessage,
  menuBackKeyboard,
  menuKeyboard,
  menuMessage,
  statusMessage,
  validateCallbackData,
} from "../dist/bot.js";
import { commandModule } from "../dist/commands/index.js";
import { menuCommand } from "../dist/commands/menu.js";
import { assertValidMarkdownV2 } from "./markdown-lint.test.mjs";

const BOT_INFO = {
  id: 888000,
  is_bot: true,
  first_name: "MimirBot",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeHarness(configOverrides = {}) {
  const botCredential = ["123456789:", "A".repeat(35)].join("");
  const config = {
    locale: "en",
    version: "0.1.0",
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: botCredential,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    lockFile: "/tmp/unused-poller.lock",
    statusFile: "/tmp/unused-status.json",
    maxNotificationsPerCycle: 20,
    interSendDelayMs: 1_500,
    metricsPort: null,
    notificationCategories: [],
    silentEvents: [],
    csvOutputFile: "/tmp/unused-scanner.csv",
    featureFlags: { enabled: true, market: true, squad: true },
    auditFile: "/tmp/unused-audit.jsonl",
    dedupWindow: 256,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    sendJournalFile: "/tmp/unused-send-journal.jsonl",
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 0,
    startupHealthRetryMs: 0,
    shutdownTimeoutMs: 1_000,
    telegramSendTimeoutMs: 5_000,
    channelPreviewMode: false,
    linkPreviewMarket: false,
    linkPreviewSquad: false,
    logSampleMaxPerWindow: 3,
    logSampleWindowMs: 300_000,
    logBufferLines: 0,
    telegramWebhookUrl: null,
    telegramApiRoot: null,
    mimirAppUrl: null,
    healthAuthToken: null,
    ...configOverrides,
  };

  let statusCalls = 0;
  let pauseCalls = 0;
  const pollerStatus = {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 5,
    lastPollAt: 2_000,
    lastSuccessAt: 2_000,
    latestLedger: 123_456,
    oldestLedger: 100_000,
    notificationsSent: 4,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };

  const apiCalls = [];
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    status: () => {
      statusCalls += 1;
      return pollerStatus;
    },
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
  });

  bot.api.config.use((prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      return Promise.resolve({
        ok: true,
        result: {
          message_id: 200 + apiCalls.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "supergroup" },
          text: payload.text,
        },
      });
    }
    return Promise.resolve({ ok: true, result: true });
  });

  return {
    bot,
    config,
    pollerStatus,
    apiCalls,
    getStatusCalls: () => statusCalls,
    getPauseCalls: () => pauseCalls,
  };
}

function slashUpdate(text, { updateId = 1, chatId = -1001234567890, userId = 100 } = {}) {
  const cmdLen = text.indexOf(" ") === -1 ? text.length : text.indexOf(" ");
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup", title: "Mimir Group" },
      from: { id: userId, is_bot: false, first_name: "Member" },
      text,
      entities: [{ offset: 0, length: cmdLen, type: "bot_command" }],
    },
  };
}

function callbackUpdate(
  data,
  { updateId = 10, chatId = -1001234567890, userId = 100, hasMessage = true } = {},
) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: userId, is_bot: false, first_name: "Member" },
      ...(hasMessage
        ? {
            message: {
              message_id: 500 + updateId,
              date: 1_700_000_000,
              chat: { id: chatId, type: "supergroup", title: "Mimir Group" },
              text: "📋 Menu",
            },
          }
        : {}),
      data,
    },
  };
}

test("menuMessage returns a non-empty valid MarkdownV2 string", () => {
  const message = menuMessage();
  assert.strictEqual(typeof message, "string");
  assert.ok(message.length > 0);
  assertValidMarkdownV2(message, "menuMessage()");
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

test("/menu is registered in the command catalogue with allowlist gating and help detail", () => {
  const registered = commandModule("menu");
  assert.equal(registered, menuCommand);
  assert.equal(registered?.chatAllowlist, true);
  assert.notEqual(registered?.operatorOnly, true);

  for (const raw of ["menu", "mimir:menu", JSON.stringify({ action: "menu" })]) {
    const validated = validateCallbackData(raw);
    assert.equal(validated.ok, true, `${raw} should validate as menu callback`);
    assert.equal(validated.action.type, "menu");
  }

  const detail = helpDetailMessage("menu");
  assert.match(detail, /\*Command:\* \/menu/);
  assertValidMarkdownV2(detail, "helpDetailMessage(menu)");
});

test("/menu command sends menuMessage with menuKeyboard and dispatches status, contracts, help, and menu callbacks", async () => {
  const { bot, config, pollerStatus, apiCalls } = makeHarness({
    allowedChatIds: ["-1001234567890"],
  });

  // 1. Initial /menu command entry
  await bot.handleUpdate(slashUpdate("/menu", { updateId: 1, chatId: -1001234567890 }));
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].method, "sendMessage");
  assert.equal(apiCalls[0].payload.text, menuMessage());
  assert.equal(apiCalls[0].payload.parse_mode, "MarkdownV2");
  assert.deepEqual(apiCalls[0].payload.reply_markup, menuKeyboard());

  // 2. Navigate to Status
  apiCalls.length = 0;
  await bot.handleUpdate(callbackUpdate("status", { updateId: 2, chatId: -1001234567890 }));
  const statusEdit = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(statusEdit);
  assert.equal(statusEdit.payload.text, statusMessage(config, pollerStatus));

  // 3. Navigate to Contracts
  apiCalls.length = 0;
  await bot.handleUpdate(callbackUpdate("contracts", { updateId: 3, chatId: -1001234567890 }));
  const contractsEdit = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(contractsEdit);
  assert.equal(contractsEdit.payload.text, contractsMessage(config));

  // 4. Navigate to Help (includes back-to-menu button)
  apiCalls.length = 0;
  await bot.handleUpdate(callbackUpdate("help", { updateId: 4, chatId: -1001234567890 }));
  const helpEdit = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(helpEdit);
  assert.equal(helpEdit.payload.text, helpMessage(config));
  assert.deepEqual(helpEdit.payload.reply_markup, menuBackKeyboard());

  // 5. Navigate back to Menu via callback
  apiCalls.length = 0;
  await bot.handleUpdate(callbackUpdate("menu", { updateId: 5, chatId: -1001234567890 }));
  const menuEdit = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(menuEdit);
  assert.equal(menuEdit.payload.text, menuMessage());
  assert.deepEqual(menuEdit.payload.reply_markup, menuKeyboard());
  const menuAnswer = apiCalls.find((c) => c.method === "answerCallbackQuery");
  assert.equal(menuAnswer?.payload.text, "Menu");
});

test("authorization is enforced on initial /menu command entry AND on every navigation/operator callback", async () => {
  const { bot, config, apiCalls, getStatusCalls, getPauseCalls } = makeHarness({
    allowedChatIds: ["-1001234567890"],
    operatorTelegramUserId: "42",
  });

  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    // 1. Initial /menu in disallowed chat is silently ignored
    await bot.handleUpdate(slashUpdate("/menu", { updateId: 10, chatId: -1009999999999 }));
    assert.equal(apiCalls.length, 0);

    // 2. Every navigation callback in disallowed chat is rejected without touching status or editing
    for (const [idx, action] of ["menu", "status", "contracts", "help"].entries()) {
      apiCalls.length = 0;
      await bot.handleUpdate(
        callbackUpdate(action, {
          updateId: 20 + idx,
          chatId: -1009999999999,
          userId: 42,
        }),
      );
      assert.equal(
        apiCalls.find((c) => c.method === "editMessageText" || c.method === "sendMessage"),
        undefined,
        `disallowed chat must not edit or send on ${action} callback`,
      );
      const answer = apiCalls.find((c) => c.method === "answerCallbackQuery");
      assert.ok(answer, `callback ${action} must be answered`);
      assert.equal(answer.payload.text, CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK);
      assert.equal(answer.payload.show_alert, true);
    }
    assert.equal(getStatusCalls(), 0, "status() must never run for unauthorized chat callbacks");

    // 3. Callback without chat context when ALLOWED_CHAT_IDS is active is also rejected
    apiCalls.length = 0;
    await bot.handleUpdate(
      callbackUpdate("status", {
        updateId: 30,
        hasMessage: false,
        userId: 42,
      }),
    );
    assert.equal(getStatusCalls(), 0);
    assert.equal(
      apiCalls.find((c) => c.method === "answerCallbackQuery")?.payload.text,
      CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK,
    );

    // 4. Tightening ALLOWED_CHAT_IDS after /menu was posted blocks subsequent callbacks in the old chat
    apiCalls.length = 0;
    await bot.handleUpdate(slashUpdate("/menu", { updateId: 40, chatId: -1001234567890 }));
    assert.equal(apiCalls.length, 1);

    config.allowedChatIds = ["-1005555555555"];
    apiCalls.length = 0;
    await bot.handleUpdate(callbackUpdate("status", { updateId: 41, chatId: -1001234567890 }));
    assert.equal(getStatusCalls(), 0);
    assert.equal(
      apiCalls.find((c) => c.method === "answerCallbackQuery")?.payload.text,
      CALLBACK_CHAT_UNAUTHORIZED_FEEDBACK,
    );

    // 5. Operator callback from non-operator inside allowed chat is still rejected
    config.allowedChatIds = ["-1001234567890"];
    apiCalls.length = 0;
    await bot.handleUpdate(
      callbackUpdate("pause", { updateId: 50, chatId: -1001234567890, userId: 999 }),
    );
    assert.equal(getPauseCalls(), 0);
    assert.equal(
      apiCalls.find((c) => c.method === "answerCallbackQuery")?.payload.text,
      CALLBACK_UNAUTHORIZED_FEEDBACK,
    );
  } finally {
    console.warn = origWarn;
  }
});
