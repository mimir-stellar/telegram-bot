import assert from "node:assert/strict";
import test from "node:test";

import { createBot, helpDetailMessage } from "../dist/bot.js";
import { commandModule } from "../dist/commands/index.js";
import {
  filtersCommand,
  filtersMessage,
  MARKET_EVENT_TYPES,
  SQUAD_EVENT_TYPES,
} from "../dist/commands/filters.js";
import { escapeMd } from "../dist/notifications/format.js";
import { assertValidMarkdownV2 } from "./markdown-lint.test.mjs";

const BOT_INFO = {
  id: 777000,
  is_bot: true,
  first_name: "MimirBot",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeBotConfig(overrides = {}) {
  const botCredential = ["123456789:", "A".repeat(35)].join("");
  const healthBearer = ["health-bearer-", "Z".repeat(24)].join("");
  const rpcQueryParam = ["api", "_key=", "placeholderRpcKey99"].join("");
  return {
    locale: "en",
    version: "0.1.0",
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: `https://soroban-testnet.stellar.org?${rpcQueryParam}`,
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: botCredential,
    healthAuthToken: healthBearer,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    allowedChatIds: [],
    operatorTelegramUserId: "99887766",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    lockFile: "/tmp/unused-poller.lock",
    statusFile: "/tmp/unused-status.json",
    maxNotificationsPerCycle: 20,
    interSendDelayMs: 1_500,
    metricsPort: null,
    notificationCategories: [],
    silentEvents: ["fee_claimed", "fees_claimed"],
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
    ...overrides,
  };
}

function makeBotHarness(configOverrides = {}) {
  const config = makeBotConfig(configOverrides);
  const sent = [];
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
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
    pause: () => "paused",
    resume: () => "resumed",
  });

  bot.api.config.use((prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return Promise.resolve({
        ok: true,
        result: {
          message_id: sent.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "supergroup" },
          text: payload.text,
        },
      });
    }
    return Promise.resolve({ ok: true, result: true });
  });

  return { bot, config, sent };
}

function slashUpdate(text, { updateId = 1, chatId = -1001234567890, userId = 555 } = {}) {
  const cmdLen = text.indexOf(" ") === -1 ? text.length : text.indexOf(" ");
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup", title: "Mimir Alerts" },
      from: { id: userId, is_bot: false, first_name: "Reader" },
      text,
      entities: [{ offset: 0, length: cmdLen, type: "bot_command" }],
    },
  };
}

test("filtersMessage: default configuration renders 'all notifications enabled' line", () => {
  const config = {
    chatId: "-1001234567890",
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  // Acceptance criteria: Default configuration renders an "all notifications enabled" line.
  assert.match(message, /all notifications (are )?enabled/i);
  // Acceptance criteria: No chat ids or tokens appear unredacted.
  assert.ok(!message.includes("-1001234567890"), "chat id must be redacted");
  assert.match(message, /-…7890/);

  // Lists enabled event types
  for (const eventName of MARKET_EVENT_TYPES) {
    assert.ok(message.includes(escapeMd(eventName)), `should include market event ${eventName}`);
  }
  for (const eventName of SQUAD_EVENT_TYPES) {
    assert.ok(message.includes(escapeMd(eventName)), `should include squad event ${eventName}`);
  }

  // Categories show none restricted / all allowed
  assert.match(message, /all allowed/i);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "default config filtersMessage");
});

test("filtersMessage: category-filtered config reports allowed categories and escapes properly", () => {
  const config = {
    chatId: "-1009876543210",
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: ["crypto", "sports_&_games"],
  };

  const message = filtersMessage(config);

  // Should NOT render "All notifications are enabled" line because category filter is active
  assert.doesNotMatch(message, /All notifications are enabled/i);

  // Check category listing and escaping
  assert.match(message, /crypto/);
  assert.ok(message.includes(escapeMd("sports_&_games")));

  // Chat ID redacted
  assert.ok(!message.includes("-1009876543210"), "raw chat id must not appear");
  assert.match(message, /-…3210/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "category-filtered config filtersMessage");
});

test("filtersMessage: squad-disabled config lists squad events as disabled", () => {
  const config = {
    chatId: "@my_channel",
    featureFlags: { enabled: true, market: true, squad: false },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  // Should NOT render "All notifications are enabled" line
  assert.doesNotMatch(message, /All notifications are enabled/i);

  // Squad events should be mentioned in disabled list
  for (const eventName of SQUAD_EVENT_TYPES) {
    assert.ok(message.includes(escapeMd(eventName)), `should mention squad event ${eventName}`);
  }

  // Redacted username channel
  assert.ok(!message.includes("@my_channel"), "channel username must be redacted");
  assert.match(message, /@m…/);

  // Market enabled, squad disabled
  assert.match(message, /mimir\\-market: enabled/);
  assert.match(message, /mimir\\-squad: disabled/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "squad-disabled config filtersMessage");
});

test("filtersMessage: master kill switch disabled marks all events disabled", () => {
  const config = {
    chatId: "123456789",
    featureFlags: { enabled: false, market: true, squad: true },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  assert.match(message, /Master switch: disabled/);
  assert.match(message, /Enabled: none/);
  assert.ok(!message.includes("123456789"), "raw chat id must not appear");
  assert.match(message, /…6789/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "master-disabled config filtersMessage");
});

test("filtersMessage: chat routing with separate market and squad destinations", () => {
  const config = {
    chatId: "-1001111111111",
    marketChatId: "-1002222222222",
    squadChatId: "-1003333333333",
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: [],
  };

  const message = filtersMessage(config);

  assert.ok(!message.includes("-1001111111111"));
  assert.ok(!message.includes("-1002222222222"));
  assert.ok(!message.includes("-1003333333333"));

  assert.match(message, /-…1111/);
  assert.match(message, /-…2222/);
  assert.match(message, /-…3333/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "chat-routing config filtersMessage");
});

test("filtersMessage: handles empty or missing config gracefully", () => {
  const message = filtersMessage();

  assert.match(message, /Active Notification Filters/);
  assert.match(message, /all notifications (are )?enabled/i);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "empty config filtersMessage");
});

test("/filters is registered in the command catalogue with allowlist gating and help detail", () => {
  const registered = commandModule("filters");
  assert.equal(registered, filtersCommand);
  assert.equal(registered?.chatAllowlist, true);
  assert.notEqual(registered?.operatorOnly, true);

  const detail = helpDetailMessage("filters");
  assert.match(detail, /\*Command:\* \/filters/);
  assert.match(detail, /global notification filters/i);
  assertValidMarkdownV2(detail, "helpDetailMessage(filters)");
});

test("/filters renders global versus route-specific settings and redacts all sensitive values", async () => {
  const seedKey = "S" + "A".repeat(55);
  const { bot, config, sent } = makeBotHarness({
    chatId: "-1004444555566",
    chatIds: ["-1004444555566", "-1007777888899", "@alpha_alerts"],
    marketChatId: "-1002020202020",
    squadChatId: "-1004444555566",
    allowedChatIds: ["-1001234567890"],
    featureFlags: { enabled: true, market: true, squad: false },
    notificationCategories: ["politics", seedKey],
    silentEvents: ["withdrawal_pending"],
    channelPreviewMode: false,
    linkPreviewMarket: true,
    linkPreviewSquad: false,
    routes: [
      { chatId: "-1009090909090", channelPreviewMode: true },
      { chatId: "@beta_channel", channelPreviewMode: false },
    ],
  });

  await bot.handleUpdate(slashUpdate("/filters", { chatId: -1001234567890 }));
  assert.equal(sent.length, 1);

  const reply = sent[0].text;
  assert.equal(sent[0].parse_mode, "MarkdownV2");
  assertValidMarkdownV2(reply, "/filters live reply");

  // Explains Global vs Route-Specific settings clearly
  assert.ok(reply.includes("*Global Settings*"));
  assert.ok(reply.includes("*Route\\-Specific Settings \\(Chat Routing\\)*"));
  assert.ok(reply.includes("Global settings apply across every destination before routing"));
  assert.ok(reply.includes("Global channel preview mode: disabled"));
  assert.ok(reply.includes("Link previews: mimir\\-market enabled, mimir\\-squad disabled"));
  assert.ok(reply.includes("Silent events \\(no sound\\): `withdrawal\\_pending`"));
  assert.ok(reply.includes("mimir\\-market chat: `\\-…2020` \\(route override\\)"));
  assert.ok(reply.includes("mimir\\-squad chat: inherits default route"));
  assert.ok(reply.includes("Route \\#1: `\\-…9090` — channel preview enabled"));
  assert.ok(reply.includes("Route \\#2: `@b…` — channel preview disabled"));

  // Redacts all sensitive values: tokens, bearer secrets, strkey seeds, operator IDs, raw chat IDs, RPC creds
  for (const sensitive of [
    config.botToken,
    config.healthAuthToken,
    seedKey,
    "placeholderRpcKey99",
    "99887766",
    "-1004444555566",
    "-1007777888899",
    "@alpha_alerts",
    "-1002020202020",
    "-1009090909090",
    "@beta_channel",
    "-1001234567890",
  ]) {
    assert.equal(
      reply.includes(sensitive),
      false,
      `sensitive value "${sensitive}" must never appear in /filters output`,
    );
  }
});

test("/filters enforces ALLOWED_CHAT_IDS and stays bounded under large category/route lists", async () => {
  const manyCategories = Array.from({ length: 40 }, (_, idx) => `category_${idx + 1}`);
  const manyRoutes = Array.from({ length: 25 }, (_, idx) => ({
    chatId: `-100555500${String(idx + 1000)}`,
    channelPreviewMode: idx % 2 === 0,
  }));

  const { bot, sent } = makeBotHarness({
    allowedChatIds: ["-1001234567890"],
    notificationCategories: manyCategories,
    routes: manyRoutes,
  });

  // Unauthorized chat gets silence
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    await bot.handleUpdate(slashUpdate("/filters", { updateId: 1, chatId: -1009999999999 }));
  } finally {
    console.warn = origWarn;
  }
  assert.equal(sent.length, 0, "disallowed chat must be ignored silently");

  // Authorized chat receives a bounded, valid MarkdownV2 reply
  await bot.handleUpdate(slashUpdate("/filters", { updateId: 2, chatId: -1001234567890 }));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.length < 4096, "reply must fit in a single Telegram message");
  assert.match(sent[0].text, /more/);
  assert.match(sent[0].text, /additional route/);
  assertValidMarkdownV2(sent[0].text, "bounded /filters reply");
});
