import assert from "node:assert/strict";
import test from "node:test";

import { Bot } from "grammy";

import { loadConfig } from "../dist/config.js";
import { startFakeTelegram } from "../dist/dev/fake-telegram.js";
import {
  createNotifier,
  hasConfiguredForumTopics,
  notifierSkips,
  verifyNotificationRoutes,
} from "../dist/notifications/notifier.js";

const VALID_MARKET = "C" + "A".repeat(55);
const VALID_SQUAD = "C" + "B".repeat(55);
const SYNTHETIC_TOKEN = ["123456789", "AA" + "TopicCheckCanaryValue".repeat(2)].join(":");

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function makeFakeBot(apiRoot) {
  return new Bot(SYNTHETIC_TOKEN, {
    botInfo: {
      id: 900001,
      is_bot: true,
      first_name: "Mimir Fake Bot",
      username: "mimir_fake_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
    client: { apiRoot },
  });
}

test("verifies forum topics via fake Telegram API, disables only invalid routes, and preserves working chats", async (t) => {
  const fake = await startFakeTelegram({
    chats: {
      "-1001001": {
        type: "supergroup",
        isForum: true,
        openTopics: [10],
        closedTopics: [77],
      },
      "-1002002": {
        type: "supergroup",
        isForum: false,
      },
      "-1003003": {
        type: "supergroup",
        isForum: false,
      },
    },
  });
  t.after(() => fake.close());

  const config = withEnv(
    {
      MIMIR_PROFILE: undefined,
      BOT_TOKEN: SYNTHETIC_TOKEN,
      TELEGRAM_CHAT_ID: "-1001001:10, -1001001:999, -1001001:77, -1002002:5, -1003003",
      TELEGRAM_MARKET_CHAT_ID: undefined,
      TELEGRAM_SQUAD_CHAT_ID: undefined,
      MARKET_CONTRACT_ID: VALID_MARKET,
      SQUAD_CONTRACT_ID: VALID_SQUAD,
      TELEGRAM_API_ROOT: fake.url,
    },
    () => loadConfig(),
  );

  assert.equal(hasConfiguredForumTopics(config), true);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  let verified;
  try {
    const bot = makeFakeBot(fake.url);
    verified = await verifyNotificationRoutes(bot, config);
    const notify = createNotifier(bot, verified.config);
    await notify("Claim settled on\\-chain");
  } finally {
    console.warn = origWarn;
  }

  assert.equal(verified.disabledRoutes.length, 3);
  assert.deepEqual(
    verified.disabledRoutes.map((r) => r.key).sort(),
    ["-1001001#77", "-1001001#999", "-1002002#5"],
  );
  assert.deepEqual(
    verified.activeRoutes.map((r) => ({ chatId: r.chatId, topicId: r.topicId })),
    [
      { chatId: "-1001001", topicId: 10 },
      { chatId: "-1003003", topicId: undefined },
    ],
  );

  const received = fake.getReceivedMessages();
  assert.equal(received.length, 2, "only the valid forum topic and valid standard chat receive messages");
  assert.equal(String(received[0].chat_id), "-1001001");
  assert.equal(received[0].message_thread_id, 10);
  assert.equal(String(received[1].chat_id), "-1003003");
  assert.equal(received[1].message_thread_id, undefined);

  // Ensure BOT_TOKEN never leaks into warnings or disabled route reasons.
  const combinedWarnings = warnings.join("\n");
  assert.equal(combinedWarnings.includes(SYNTHETIC_TOKEN), false);
  for (const disabled of verified.disabledRoutes) {
    assert.equal(disabled.reason.includes(SYNTHETIC_TOKEN), false);
  }
});

test("disables only an invalid per-contract forum topic route while preserving other contract routes", async (t) => {
  const fake = await startFakeTelegram({
    chats: {
      "-1005001": {
        type: "supergroup",
        isForum: true,
        openTopics: [12],
      },
    },
  });
  t.after(() => fake.close());

  const bot = makeFakeBot(fake.url);
  const rawConfig = {
    botToken: SYNTHETIC_TOKEN,
    chatId: "-1005001:12",
    marketChatId: "-1005001:404", // invalid missing topic
    squadChatId: "-1005001:12", // valid open topic
  };

  const origWarn = console.warn;
  console.warn = () => {};
  let verified;
  try {
    verified = await verifyNotificationRoutes(bot, rawConfig);
  } finally {
    console.warn = origWarn;
  }

  assert.deepEqual(
    verified.disabledRoutes.map((r) => r.key),
    ["-1005001#404"],
  );

  const skipsBefore = notifierSkips.disabledRoute;
  const notify = createNotifier(bot, verified.config);
  await notify("market event suppressed on invalid topic", "market");
  await notify("squad event delivered to valid topic", "squad");

  assert.equal(notifierSkips.disabledRoute, skipsBefore + 1);
  const received = fake.getReceivedMessages();
  assert.equal(received.length, 1);
  assert.equal(String(received[0].chat_id), "-1005001");
  assert.equal(received[0].message_thread_id, 12);
  assert.equal(received[0].text, "squad event delivered to valid topic");
});
