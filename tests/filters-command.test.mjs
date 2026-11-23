import assert from "node:assert/strict";
import test from "node:test";

import { COMMANDS, registerCommandHandlers } from "../dist/bot.js";
import { commandModule } from "../dist/commands/index.js";
import { filtersCommand, filtersMessage, MARKET_EVENT_TYPES, SQUAD_EVENT_TYPES } from "../dist/commands/filters.js";
import { escapeMd } from "../dist/notifications/format.js";
import { assertValidMarkdownV2 } from "./markdown-lint.test.mjs";

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
  assert.match(message, /Per\\-chat routes: none/);

  // Valid MarkdownV2
  assertValidMarkdownV2(message, "empty config filtersMessage");
});

test("filtersMessage: explains global vs route-specific settings and redacts route chat ids", () => {
  const config = {
    chatId: "-1001111111111",
    marketChatId: "-1002222222222",
    squadChatId: "-1001111111111",
    channelPreviewMode: false,
    featureFlags: { enabled: true, market: true, squad: true },
    notificationCategories: ["crypto"],
    routes: [
      { chatId: "-1004444444444", channelPreviewMode: true },
      { chatId: "@secret_ops_channel", channelPreviewMode: false },
    ],
  };

  const message = filtersMessage(config);

  // Explains global vs route-specific scope
  assert.match(message, /apply globally/i);
  assert.match(message, /route\\-specific/i);

  // Redacts all chat ids including per-chat routes
  assert.ok(!message.includes("-1001111111111"));
  assert.ok(!message.includes("-1002222222222"));
  assert.ok(!message.includes("-1004444444444"));
  assert.ok(!message.includes("@secret_ops_channel"));

  assert.match(message, /-…1111/);
  assert.match(message, /-…2222/);
  assert.match(message, /-…4444/);
  assert.match(message, /@s…/);

  // Shows per-chat route preview settings
  assert.ok(message.includes("Per\\-chat routes \\(2\\):"));
  assert.match(message, /preview on/);
  assert.match(message, /preview off/);

  assertValidMarkdownV2(message, "global vs route-specific filtersMessage");
});

test("/filters command is registered, replies with effective config, and enforces chatAllowlist", async () => {
  assert.equal(commandModule("filters"), filtersCommand);
  assert.ok(COMMANDS.some((entry) => entry.command === "filters"));

  const handlers = new Map();
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
    callbackQuery: () => {},
  };

  const config = {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: ["-1001234567890"],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    featureFlags: { enabled: true, market: true, squad: false },
    notificationCategories: ["politics"],
    routes: [{ chatId: "-1009999999999", channelPreviewMode: true }],
  };

  registerCommandHandlers(bot, {
    config,
    status: () => ({}),
    pause: () => "paused",
    resume: () => "resumed",
  });

  const handler = handlers.get("filters");
  assert.equal(typeof handler, "function");

  // Allowed chat receives redacted active filters
  const allowedReplies = [];
  await handler({
    from: { id: 99 },
    chat: { id: -1001234567890 },
    update: { update_id: 1 },
    reply: async (...args) => allowedReplies.push(args),
  });
  assert.equal(allowedReplies.length, 1);
  const [replyText, replyOpts] = allowedReplies[0];
  assert.equal(replyOpts.parse_mode, "MarkdownV2");
  assert.match(replyText, /Active Notification Filters/);
  assert.match(replyText, /politics/);
  assert.match(replyText, /mimir\\-squad: disabled/);
  assert.ok(!replyText.includes(config.botToken), "botToken must never leak");
  assert.ok(!replyText.includes("-1001234567890"), "default chat id must be redacted");
  assert.ok(!replyText.includes("-1009999999999"), "route chat id must be redacted");
  assertValidMarkdownV2(replyText, "/filters command reply");

  // Disallowed chat is silently ignored (boundary / authorization case)
  const disallowedReplies = [];
  await handler({
    from: { id: 99 },
    chat: { id: -1008888888888 },
    update: { update_id: 2 },
    reply: async (...args) => disallowedReplies.push(args),
  });
  assert.equal(disallowedReplies.length, 0);
});
