import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigError,
  canonicalizeNotificationRoute,
  canonicalizeNotificationRoutes,
  loadConfig,
} from "../dist/config.js";
import {
  DuplicateRouteError,
  createNotifier,
} from "../dist/notifications/notifier.js";

const VALID_MARKET = "C" + "A".repeat(55);
const VALID_SQUAD = "C" + "B".repeat(55);
const SYNTHETIC_TOKEN = ["123456789", "AA" + "CanaryRouteCheckValue".repeat(2)].join(":");

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

function baseBotEnv(overrides = {}) {
  return {
    MIMIR_PROFILE: undefined,
    BOT_TOKEN: SYNTHETIC_TOKEN,
    TELEGRAM_CHAT_ID: "-1001234567890",
    TELEGRAM_MARKET_CHAT_ID: undefined,
    TELEGRAM_SQUAD_CHAT_ID: undefined,
    MARKET_CONTRACT_ID: VALID_MARKET,
    SQUAD_CONTRACT_ID: VALID_SQUAD,
    STELLAR_RPC_URL: undefined,
    STELLAR_HORIZON_URL: undefined,
    STELLAR_NETWORK_PASSPHRASE: undefined,
    CHANNEL_PREVIEW_MODE: undefined,
    ...overrides,
  };
}

test("canonicalizes chat and topic route identities consistently before startup", () => {
  const r1 = canonicalizeNotificationRoute("  @MimirChannel:042  ");
  assert.equal(r1.chatId, "@mimirchannel");
  assert.equal(r1.topicId, 42);
  assert.equal(r1.canonicalKey, "@mimirchannel#42");

  const r2 = canonicalizeNotificationRoute({ chatId: "-001001234567890", topicId: "42" });
  assert.equal(r2.chatId, "-1001234567890");
  assert.equal(r2.topicId, 42);
  assert.equal(r2.canonicalKey, "-1001234567890#42");

  withEnv(
    baseBotEnv({
      TELEGRAM_CHAT_ID: "-1001234567890:10, -1001234567890:20, @MimirFeed",
    }),
    () => {
      const config = loadConfig();
      assert.deepEqual(config.chatIds, [
        "-1001234567890:10",
        "-1001234567890:20",
        "@mimirfeed",
      ]);
      assert.equal(config.routes?.length, 3);
      assert.equal(config.routes?.[0]?.canonicalKey, "-1001234567890#10");
      assert.equal(config.routes?.[1]?.canonicalKey, "-1001234567890#20");
      assert.equal(config.routes?.[2]?.canonicalKey, "@mimirfeed#root");
    },
  );
});

test("rejects duplicate chat and topic routes in loadConfig without exposing BOT_TOKEN", () => {
  const duplicateCases = [
    "-1001234567890, -1001234567890",
    "@MimirAlerts, @mimiralerts",
    "-1001234567890:42, -1001234567890#042",
    "-001001234567890, -1001234567890",
  ];

  for (const chatIdValue of duplicateCases) {
    withEnv(baseBotEnv({ TELEGRAM_CHAT_ID: chatIdValue }), () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.match(err.message, /duplicate notification route/i);
          assert.equal(
            err.message.includes(SYNTHETIC_TOKEN),
            false,
            "ConfigError message must never expose BOT_TOKEN",
          );
          assert.equal(
            JSON.stringify(err.problems).includes(SYNTHETIC_TOKEN),
            false,
            "ConfigError.problems must never expose BOT_TOKEN",
          );
          return true;
        },
      );
    });
  }
});

test("never leaks BOT_TOKEN even if accidentally pasted into TELEGRAM_CHAT_ID", () => {
  withEnv(
    baseBotEnv({
      TELEGRAM_CHAT_ID: `${SYNTHETIC_TOKEN}, ${SYNTHETIC_TOKEN}`,
    }),
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.message.includes(SYNTHETIC_TOKEN), false);
          assert.equal(
            err.message.includes("CanaryRouteCheckValue"),
            false,
            "secret part of token must be scrubbed",
          );
          return true;
        },
      );
    },
  );
});

test("createNotifier rejects duplicate routes before sending and preserves distinct topic routes", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId, text, options) => {
        sent.push({ chatId, text, options });
        return { message_id: 1 };
      },
    },
  };

  assert.throws(
    () =>
      createNotifier(fakeBot, {
        botToken: SYNTHETIC_TOKEN,
        chatId: "-1001234567890:7",
        routes: [
          { chatId: "-1001234567890", topicId: 7, channelPreviewMode: false },
          { chatId: "-1001234567890#007", channelPreviewMode: true },
        ],
      }),
    (err) => {
      assert.ok(err instanceof DuplicateRouteError);
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.duplicateKeys, ["-1001234567890#7"]);
      assert.equal(err.message.includes(SYNTHETIC_TOKEN), false);
      return true;
    },
  );
  assert.equal(sent.length, 0, "no message may be sent when duplicate routes fail validation");

  // Distinct topics in the same supergroup remain valid and forward message_thread_id.
  const notify = createNotifier(fakeBot, {
    botToken: SYNTHETIC_TOKEN,
    chatId: "-1001234567890:11",
    marketChatId: "-1001234567890:11",
    squadChatId: "-1001234567890:22",
    routes: [
      { chatId: "-1001234567890", topicId: 11, channelPreviewMode: false },
      { chatId: "-1001234567890", topicId: 22, channelPreviewMode: false },
    ],
  });

  await notify("market update", "market");
  await notify("squad update", "squad");

  assert.equal(sent.length, 2);
  assert.equal(sent[0].chatId, "-1001234567890");
  assert.equal(sent[0].options.message_thread_id, 11);
  assert.equal(sent[1].chatId, "-1001234567890");
  assert.equal(sent[1].options.message_thread_id, 22);

  // Invalid topic ids (0, negative, conflicting) are rejected cleanly.
  const bad = canonicalizeNotificationRoutes(["-1001234567890:0", "-1001234567890:-3"], {
    secrets: [SYNTHETIC_TOKEN],
  });
  assert.equal(bad.routes.length, 0);
  assert.equal(bad.problems.length, 2);
});
