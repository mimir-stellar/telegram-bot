import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  clearHintState,
  createBot,
  isCommandAddressedToBot,
  parseSlashCommand,
  registerCommandHandlers,
} from "../dist/bot.js";
import { CommandRateLimiter } from "../dist/commands/rate-limit.js";

const BOT_INFO = {
  id: 424242,
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
    chatIds: ["-1001234567890"],
    allowedChatIds: [],
    operatorTelegramUserId: "777",
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

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_700_000_000_000,
    lastSuccessAt: 1_700_000_005_000,
    chainClockAt: 1_700_000_005_000,
    cycles: 3,
    latestLedger: 1200,
    oldestLedger: 1000,
    lastPollAt: 1_700_000_005_000,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

function makeCommandUpdate({
  text,
  chatId = -1001234567890,
  chatType = "supergroup",
  fromId = 777,
  updateId = 1,
}) {
  const tokenEnd = text.search(/\s/);
  const commandLength = tokenEnd === -1 ? text.length : tokenEnd;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: chatType },
      from: { id: fromId, is_bot: false, first_name: "Operator" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: commandLength }],
    },
  };
}

async function sendUpdate(bot, update) {
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push({ chatId: payload.chat_id, text: payload.text });
      return {
        ok: true,
        result: {
          message_id: sent.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "private" },
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });
  await bot.handleUpdate(update);
  return sent;
}

test("parseSlashCommand extracts command, optional @bot username, and arguments", () => {
  assert.deepEqual(parseSlashCommand("/status"), {
    command: "status",
    targetBotUsername: null,
    args: "",
  });

  assert.deepEqual(parseSlashCommand("/HELP@Mimir_Test_Bot   contracts  "), {
    command: "help",
    targetBotUsername: "Mimir_Test_Bot",
    args: "contracts",
  });

  assert.deepEqual(
    parseSlashCommand("/broadcast@other_bot hello\nworld", [
      { type: "bot_command", offset: 0, length: "/broadcast@other_bot".length },
    ]),
    {
      command: "broadcast",
      targetBotUsername: "other_bot",
      args: "hello\nworld",
    },
  );

  assert.deepEqual(parseSlashCommand("/status@"), {
    command: "status",
    targetBotUsername: "",
    args: "",
  });

  assert.equal(parseSlashCommand("plain message"), null);
});

test("isCommandAddressedToBot accepts bare or matching mentions and rejects foreign or malformed mentions", () => {
  assert.equal(
    isCommandAddressedToBot({
      message: { text: "/status" },
      me: { username: "mimir_test_bot" },
    }),
    true,
  );

  assert.equal(
    isCommandAddressedToBot({
      message: { text: "/status@MIMIR_TEST_BOT" },
      me: { username: "mimir_test_bot" },
    }),
    true,
  );

  assert.equal(
    isCommandAddressedToBot(
      { message: { text: "/status@mimir_test_bot" } },
      "Mimir_Test_Bot",
    ),
    true,
  );

  assert.equal(
    isCommandAddressedToBot({
      message: { text: "/status@other_bot" },
      me: { username: "mimir_test_bot" },
    }),
    false,
  );

  assert.equal(
    isCommandAddressedToBot({
      message: { text: "/status@" },
      me: { username: "mimir_test_bot" },
    }),
    false,
  );

  assert.equal(
    isCommandAddressedToBot({
      message: { text: "/status@bad!username" },
      me: { username: "mimir_test_bot" },
    }),
    false,
  );

  // Explicit @mention when this bot's username is unknown fails closed.
  assert.equal(
    isCommandAddressedToBot({
      message: { text: "/status@some_bot" },
    }),
    false,
  );
});

test("createBot ignores known, operator, broadcast, and unknown commands addressed to another bot", async () => {
  clearHintState();
  const broadcastStore = new BroadcastStore();
  const bot = createBot({
    config: makeConfig(),
    status: makeStatus,
    botInfo: BOT_INFO,
    broadcastStore,
  });

  const groupStatus = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/status@another_stellar_bot",
      chatId: -1001234567890,
      chatType: "supergroup",
      updateId: 10,
    }),
  );
  assert.equal(groupStatus.length, 0);

  const operatorPause = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/pause@another_stellar_bot",
      chatId: 777,
      chatType: "private",
      fromId: 777,
      updateId: 11,
    }),
  );
  assert.equal(operatorPause.length, 0);

  const foreignBroadcast = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/broadcast@another_stellar_botScheduled maintenance window", // malformed no-space or foreign
      chatId: 777,
      chatType: "private",
      fromId: 777,
      updateId: 12,
    }),
  );
  assert.equal(foreignBroadcast.length, 0);

  const foreignBroadcastWithArgs = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/broadcast@another_stellar_bot Scheduled maintenance window",
      chatId: 777,
      chatType: "private",
      fromId: 777,
      updateId: 13,
    }),
  );
  assert.equal(foreignBroadcastWithArgs.length, 0);
  assert.equal(broadcastStore.size(), 0);

  const foreignUnknown = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/nonexistent@another_stellar_bot",
      chatId: 777,
      chatType: "private",
      fromId: 777,
      updateId: 14,
    }),
  );
  assert.equal(foreignUnknown.length, 0);
});

test("createBot handles commands addressed to this bot case-insensitively including arguments and broadcast", async () => {
  clearHintState();
  const broadcastStore = new BroadcastStore();
  const bot = createBot({
    config: makeConfig(),
    status: makeStatus,
    botInfo: BOT_INFO,
    broadcastStore,
  });

  const statusReplies = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/status@MIMIR_TEST_BOT",
      chatId: -1001234567890,
      chatType: "supergroup",
      updateId: 20,
    }),
  );
  assert.equal(statusReplies.length, 1);
  assert.match(statusReplies[0].text, /\*Status\*/);

  const helpDetailReplies = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/help@Mimir_Test_Bot status",
      chatId: 777,
      chatType: "private",
      fromId: 777,
      updateId: 21,
    }),
  );
  assert.equal(helpDetailReplies.length, 1);
  assert.match(helpDetailReplies[0].text, /\/status/);

  const broadcastReplies = await sendUpdate(
    bot,
    makeCommandUpdate({
      text: "/broadcast@MIMIR_TEST_BOT Scheduled maintenance tonight",
      chatId: 777,
      chatType: "private",
      fromId: 777,
      updateId: 22,
    }),
  );
  assert.equal(broadcastReplies.length, 1);
  assert.match(broadcastReplies[0].text, /Broadcast Preview/);
  assert.equal(broadcastStore.size(), 1);
});

test("registerCommandHandlers skips foreign @bot commands before rate-limiting or handler execution", async () => {
  const registered = new Map();
  const registrar = {
    command(name, handler) {
      registered.set(name, handler);
    },
  };

  const rateLimiter = new CommandRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: () => 1000 });
  registerCommandHandlers(registrar, {
    config: makeConfig({ operatorTelegramUserId: null }),
    status: makeStatus,
    botInfo: BOT_INFO,
    rateLimiter,
  });

  const statusHandler = registered.get("status");
  assert.equal(typeof statusHandler, "function");

  const replies = [];
  const makeCtx = (text) => ({
    update: { update_id: 1 },
    chat: { id: -100555, type: "supergroup" },
    from: { id: 888, is_bot: false, first_name: "Member" },
    me: { username: "mimir_test_bot" },
    message: {
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
    },
    reply: async (msg) => {
      replies.push(msg);
    },
  });

  // Foreign @bot mention must be ignored AND must not consume the single token in rateLimiter.
  await statusHandler(makeCtx("/status@other_bot"));
  assert.equal(replies.length, 0);

  // Malformed empty @ suffix must also be ignored without consuming the rate-limit token.
  await statusHandler(makeCtx("/status@"));
  assert.equal(replies.length, 0);

  // Subsequent command addressed to this bot still succeeds with capacity=1!
  await statusHandler(makeCtx("/status@mimir_test_bot"));
  assert.equal(replies.length, 1);
});
