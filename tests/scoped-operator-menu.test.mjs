import assert from "node:assert/strict";
import test from "node:test";

import {
  createBot,
  publicCommandMetadata,
  registerCommands,
  scopedCommandMenus,
} from "../dist/bot.js";

const BOT_CREDENTIAL = ["123456789:", "A".repeat(35)].join("");
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function makeConfig(overrides = {}) {
  return {
    locale: "en",
    botToken: BOT_CREDENTIAL,
    chatId: "-100111",
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    allowedChatIds: [],
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

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    eventsDeduplicated: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

async function silenceWarnings(fn) {
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
  }
}

test("registerCommands scopes privileged commands strictly to the configured operator chat", async () => {
  const config = makeConfig({ operatorTelegramUserId: "424242" });
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    status: () => makeStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  const setMyCommandsCalls = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "setMyCommands") {
      setMyCommandsCalls.push(payload);
    }
    return { ok: true, result: true };
  });

  await registerCommands(bot, config);

  assert.equal(setMyCommandsCalls.length, 2);

  // Default scope seen by unrelated users contains zero privileged commands
  assert.deepEqual(setMyCommandsCalls[0].scope, { type: "default" });
  const defaultNames = setMyCommandsCalls[0].commands.map((c) => c.command);
  assert.deepEqual(
    defaultNames,
    publicCommandMetadata(config).map((c) => c.command),
  );
  for (const privileged of ["audit", "pause", "resume"]) {
    assert.equal(defaultNames.includes(privileged), false, `/${privileged} must not be in default menu`);
  }

  // Operator chat scope includes public + privileged commands
  assert.deepEqual(setMyCommandsCalls[1].scope, { type: "chat", chat_id: 424242 });
  const operatorNames = setMyCommandsCalls[1].commands.map((c) => c.command);
  for (const privileged of ["audit", "pause", "resume"]) {
    assert.equal(operatorNames.includes(privileged), true, `/${privileged} must be in operator chat menu`);
  }
});

test("/help and /start omit privileged commands for non-operators and group chats, while showing them in operator DM", async () => {
  const config = makeConfig({ operatorTelegramUserId: "42" });
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    status: () => makeStatus(),
    pause: () => "paused",
    resume: () => "resumed",
  });

  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: sent.length, date: 1 } };
    }
    return { ok: true, result: true };
  });

  // 1. Unrelated user runs /help in private chat
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 999, type: "private" },
      from: { id: 999, is_bot: false, first_name: "Stranger" },
      text: "/help",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });

  // 2. Unrelated user probes /help audit directly
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 2,
      date: 1,
      chat: { id: 999, type: "private" },
      from: { id: 999, is_bot: false, first_name: "Stranger" },
      text: "/help audit",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });

  // 3. Operator runs /help inside a shared group chat
  await bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 3,
      date: 1,
      chat: { id: -100111, type: "supergroup" },
      from: { id: 42, is_bot: false, first_name: "Operator" },
      text: "/help",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });

  // 4. Operator runs /help and /help audit in their private chat
  await bot.handleUpdate({
    update_id: 4,
    message: {
      message_id: 4,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Operator" },
      text: "/help",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });
  await bot.handleUpdate({
    update_id: 5,
    message: {
      message_id: 5,
      date: 1,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false, first_name: "Operator" },
      text: "/help audit",
      entities: [{ offset: 0, length: 5, type: "bot_command" }],
    },
  });

  assert.equal(sent.length, 5);
  for (let i = 0; i < 3; i++) {
    assert.equal(sent[i].text.includes("/audit"), false);
    assert.equal(sent[i].text.includes("/pause"), false);
    assert.equal(sent[i].text.includes("/resume"), false);
  }
  assert.equal(sent[3].text.includes("/audit"), true);
  assert.equal(sent[3].text.includes("/pause"), true);
  assert.equal(sent[3].text.includes("/resume"), true);
  assert.match(sent[4].text, /\*Command:\* \/audit/);
});

test("authorization checks remain enforced when Telegram caches stale operator menus", async () => {
  // Simulate a bot restarted with a new operator ("77") or disabled operator (null)
  // while former operator ("42") still has cached menu items on their client.
  let pauseCalls = 0;
  let resumeCalls = 0;
  const sent = [];

  for (const activeOperator of ["77", null]) {
    const bot = createBot({
      config: makeConfig({ operatorTelegramUserId: activeOperator }),
      botInfo: BOT_INFO,
      status: () => makeStatus(),
      pause: () => {
        pauseCalls += 1;
        return "paused";
      },
      resume: () => {
        resumeCalls += 1;
        return "resumed";
      },
    });

    bot.api.config.use(async (_prev, method, payload) => {
      if (method === "sendMessage") {
        sent.push(payload);
        return { ok: true, result: { message_id: sent.length, date: 1 } };
      }
      return { ok: true, result: true };
    });

    for (const [idx, cmd] of ["/audit", "/pause", "/resume"].entries()) {
      await silenceWarnings(() =>
        bot.handleUpdate({
          update_id: 100 + idx,
          message: {
            message_id: 100 + idx,
            date: 1,
            chat: { id: 42, type: "private" },
            from: { id: 42, is_bot: false, first_name: "FormerOp" },
            text: cmd,
            entities: [{ offset: 0, length: cmd.length, type: "bot_command" }],
          },
        }),
      );
    }
  }

  assert.equal(pauseCalls, 0);
  assert.equal(resumeCalls, 0);
  assert.equal(sent.length, 0, "unauthorized invocations from cached menus must be silently ignored");
});

test("boundary: non-numeric or null operatorTelegramUserId omits chat-scoped menu safely", () => {
  const withNull = scopedCommandMenus(makeConfig({ operatorTelegramUserId: null }));
  assert.equal(withNull.length, 1);
  assert.deepEqual(withNull[0].scope, { type: "default" });

  const withInvalid = scopedCommandMenus(makeConfig({ operatorTelegramUserId: "@not_numeric" }));
  assert.equal(withInvalid.length, 1);
  assert.deepEqual(withInvalid[0].scope, { type: "default" });
  assert.equal(
    withInvalid[0].commands.some((c) => ["audit", "pause", "resume"].includes(c.command)),
    false,
  );
});
