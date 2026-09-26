/**
 * Chat allowlist tests — enforce ALLOWED_CHAT_IDS across all bot commands.
 *
 * Coverage:
 *   - Positive: allowed chat receives replies for /status, /start, /help
 *   - Negative: blocked chat receives no reply for any command
 *   - Boundary: empty allowedChatIds means any chat is allowed
 *   - Multi-entry allowlist
 *   - Config parse / validation for ALLOWED_CHAT_IDS
 *   - Status payload never leaks the bot token; MarkdownV2 + link preview
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createBot, isChatAllowed } from "../dist/bot.js";

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

const VALID_CONTRACT_MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const VALID_CONTRACT_SQUAD = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

function makeConfig(allowedChatIds = []) {
  return {
    botToken: "0:fake-token-do-not-leak",
    chatId: "-1001234567890",
    allowedChatIds,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    marketContractId: VALID_CONTRACT_MARKET,
    squadContractId: VALID_CONTRACT_SQUAD,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
}

function makeStatus() {
  return {
    running: true,
    startedAt: 1_000,
    cycles: 0,
    latestLedger: 1000,
    oldestLedger: 900,
    lastPollAt: null,
    lastSuccessAt: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

async function dispatchCommand(bot, command, chatId) {
  const replies = [];
  const transformer = async (prev, method, payload, signal) => {
    if (method === "sendMessage") {
      replies.push({ chatId: payload.chat_id, text: payload.text, options: payload });
      return {
        ok: true,
        result: {
          message_id: 1,
          chat: { id: payload.chat_id, type: "private" },
          date: 0,
        },
      };
    }
    return prev(method, payload, signal);
  };
  bot.api.config.use(transformer);

  const update = {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private" },
      from: { id: chatId, is_bot: false, first_name: "Tester" },
      text: `/${command}`,
      entities: [{ type: "bot_command", offset: 0, length: command.length + 1 }],
    },
  };

  await bot.handleUpdate(update);
  return replies;
}

test("isChatAllowed: empty list is open", () => {
  assert.equal(isChatAllowed([], -1001234567890), true);
});

test("isChatAllowed: matching numeric id", () => {
  assert.equal(isChatAllowed(["-1001234567890"], -1001234567890), true);
});

test("isChatAllowed: non-matching id is denied", () => {
  assert.equal(isChatAllowed(["-1001234567890"], -9999999999), false);
});

test("allowed chat receives /status reply", async () => {
  const allowedId = -1001234567890;
  const bot = createBot({
    config: makeConfig([String(allowedId)]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "status", allowedId);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes("Status"));
});

test("blocked chat receives no /status reply", async () => {
  const bot = createBot({
    config: makeConfig(["-1001234567890"]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "status", -9999999999);
  assert.equal(replies.length, 0);
});

test("blocked chat receives no /start reply (full allowlist)", async () => {
  const bot = createBot({
    config: makeConfig(["-1001234567890"]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "start", -9999999999);
  assert.equal(replies.length, 0, "/start must also be gated by the allowlist");
});

test("blocked chat receives no /help reply (full allowlist)", async () => {
  const bot = createBot({
    config: makeConfig(["-1001234567890"]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "help", -9999999999);
  assert.equal(replies.length, 0, "/help must also be gated by the allowlist");
});

test("empty allowlist: any chat can use /status", async () => {
  const bot = createBot({
    config: makeConfig([]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "status", -9876543210);
  assert.equal(replies.length, 1);
});

test("empty allowlist: any chat can use /start and /help", async () => {
  const bot = createBot({
    config: makeConfig([]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  assert.equal((await dispatchCommand(bot, "start", -111)).length, 1);
  const bot2 = createBot({
    config: makeConfig([]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  assert.equal((await dispatchCommand(bot2, "help", -222)).length, 1);
});

test("multi-entry allowlist allows both listed chats", async () => {
  const firstId = -1001111111111;
  const secondId = -1002222222222;
  const bot = createBot({
    config: makeConfig([String(firstId), String(secondId)]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  assert.equal((await dispatchCommand(bot, "status", firstId)).length, 1);
  const bot2 = createBot({
    config: makeConfig([String(firstId), String(secondId)]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  assert.equal((await dispatchCommand(bot2, "help", secondId)).length, 1);
});

test("multi-entry allowlist blocks unlisted chat", async () => {
  const bot = createBot({
    config: makeConfig(["-1001111111111", "-1002222222222"]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  assert.equal((await dispatchCommand(bot, "status", -1003333333333)).length, 0);
});

test("/status reply does not leak bot token", async () => {
  const chatId = -1001234567890;
  const bot = createBot({
    config: makeConfig([String(chatId)]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "status", chatId);
  assert.equal(replies.length, 1);
  assert.ok(!replies[0].text.includes("fake-token"));
  assert.ok(!replies[0].text.includes("do-not-leak"));
});

test("/status uses MarkdownV2 and disables link preview", async () => {
  const chatId = -1001234567890;
  const bot = createBot({
    config: makeConfig([String(chatId)]),
    status: makeStatus,
    botInfo: FAKE_BOT_INFO,
  });
  const replies = await dispatchCommand(bot, "status", chatId);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].options.parse_mode, "MarkdownV2");
  assert.deepEqual(replies[0].options.link_preview_options, { is_disabled: true });
});

function withEnv(envPatch, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, envPatch);
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k];
    }
    Object.assign(process.env, saved);
  }
}

const BASE_ENV = {
  BOT_TOKEN: "123:fake",
  TELEGRAM_CHAT_ID: "-1001234567890",
  MARKET_CONTRACT_ID: VALID_CONTRACT_MARKET,
  SQUAD_CONTRACT_ID: VALID_CONTRACT_SQUAD,
};

test("config: absent ALLOWED_CHAT_IDS => open list", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const config = withEnv({ ...BASE_ENV, ALLOWED_CHAT_IDS: undefined }, () => {
    delete process.env.ALLOWED_CHAT_IDS;
    return loadConfig();
  });
  assert.deepEqual(config.allowedChatIds, []);
});

test("config: empty ALLOWED_CHAT_IDS => open list", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const config = withEnv({ ...BASE_ENV, ALLOWED_CHAT_IDS: "" }, () => loadConfig());
  assert.deepEqual(config.allowedChatIds, []);
});

test("config: parses comma-separated ids and @usernames", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const config = withEnv(
    { ...BASE_ENV, ALLOWED_CHAT_IDS: "-1001234567890, -1009876543210, @mychannel" },
    () => loadConfig(),
  );
  assert.deepEqual(config.allowedChatIds, [
    "-1001234567890",
    "-1009876543210",
    "@mychannel",
  ]);
});

test("config: invalid ALLOWED_CHAT_IDS entry throws ConfigError", async () => {
  const { loadConfig, ConfigError } = await import("../dist/config.js");
  let threw = false;
  try {
    withEnv({ ...BASE_ENV, ALLOWED_CHAT_IDS: "not-a-valid-id" }, () => loadConfig());
  } catch (err) {
    threw = true;
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.some((p) => p.includes("not-a-valid-id")));
  }
  assert.ok(threw);
});

test("config: single positive numeric id is valid", async () => {
  const { loadConfig } = await import("../dist/config.js");
  const config = withEnv({ ...BASE_ENV, ALLOWED_CHAT_IDS: "123456789" }, () => loadConfig());
  assert.deepEqual(config.allowedChatIds, ["123456789"]);
});
