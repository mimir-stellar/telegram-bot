/**
 * Registry invariants for slash commands.
 *
 * Commands are modules that register themselves (see `src/commands/`), so these
 * tests guard the properties a new module must not break:
 *   - names are unique and each module has a callable handler
 *   - the advertised menu (`COMMANDS`) is derived from, and stays in step with,
 *     the registered modules — including which are operator-only
 *   - hidden operator tools (`/export`) are registered and usable but never
 *     advertised
 *   - authorization is applied centrally from the module's metadata, so a new
 *     operator-only or allowlisted command cannot forget its gate
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_PAUSE_CONFIRM,
  COMMANDS,
  handleCallbackQuery,
  registerCommandHandlers,
} from "../dist/bot.js";
import {
  commandMetadata,
  defineCommand,
  registeredCommands,
  visibleCommandMetadata,
} from "../dist/commands/index.js";

const MENU = [
  "start",
  "help",
  "about",
  "status",
  "audit",
  "contracts",
  "health",
  "preview",
  "pause",
  "resume",
];

const OPERATOR_ONLY = ["audit", "pause", "resume"];

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
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

function baseStatus() {
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
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

function deps(overrides = {}) {
  return {
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    ...overrides,
  };
}

/** A bot-shaped recorder: captures commands and callback filters. */
function recorder() {
  const handlers = new Map();
  const callbackFilters = [];
  return {
    handlers,
    callbackFilters,
    bot: {
      command: (name, handler) => handlers.set(name, handler),
      callbackQuery: (filter, handler) => callbackFilters.push({ filter, handler }),
    },
  };
}

function context({ userId = 42, chatId = -1001234567890, updateId = 1 } = {}) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: userId },
      chat: { id: chatId },
      update: { update_id: updateId },
      reply: async (...args) => replies.push(args),
    },
  };
}

test("every registered command has a unique name and a callable handler", () => {
  const commands = registeredCommands();
  assert.ok(commands.length >= MENU.length);
  const seen = new Set();
  for (const module of commands) {
    assert.equal(typeof module.command, "string");
    assert.ok(module.command.length > 0);
    assert.equal(seen.has(module.command), false, `duplicate /${module.command}`);
    seen.add(module.command);
    assert.equal(typeof module.handler, "function", `/${module.command} has a handler`);
  }
});

test("COMMANDS is derived from the registry in menu order", () => {
  assert.deepEqual(
    COMMANDS.map(({ command }) => command),
    MENU,
  );
  assert.deepEqual(
    COMMANDS.filter(({ operatorOnly }) => operatorOnly).map(({ command }) => command),
    OPERATOR_ONLY,
  );
  assert.deepEqual(COMMANDS, commandMetadata());
});

test("registry metadata carries a non-empty description for every advertised command", () => {
  for (const { command, description } of COMMANDS) {
    assert.equal(typeof description, "string");
    assert.ok(description.length > 0, `/${command} has no description`);
  }
});

test("hidden operator tools are registered but never advertised", () => {
  const exportModule = registeredCommands().find(({ command }) => command === "export");
  assert.ok(exportModule, "/export is registered");
  assert.equal(exportModule.operatorOnly, true);
  assert.equal(exportModule.hidden, true);
  assert.equal(COMMANDS.some(({ command }) => command === "export"), false);
  assert.equal(visibleCommandMetadata(baseConfig()).some(({ command }) => command === "export"), false);
});

test("operator commands are hidden from the menu when no operator is configured", () => {
  const open = visibleCommandMetadata(baseConfig({ operatorTelegramUserId: null }));
  assert.deepEqual(
    open.map(({ command }) => command),
    MENU.filter((command) => !OPERATOR_ONLY.includes(command)),
  );
  const withOperator = visibleCommandMetadata(baseConfig());
  assert.deepEqual(withOperator.map(({ command }) => command), MENU);
});

test("registerCommandHandlers registers every module plus one pause-confirm callback", () => {
  const { handlers, callbackFilters, bot } = recorder();
  registerCommandHandlers(bot, deps());

  assert.deepEqual([...handlers.keys()], [...registeredCommands().map(({ command }) => command)]);
  assert.equal(callbackFilters.length, 1);
  assert.deepEqual(callbackFilters[0].filter, ["pause-confirm", "pause-cancel"]);
});

test("defineCommand rejects a second module for the same command", () => {
  assert.throws(
    () => defineCommand({ command: "status", handler: async () => undefined }),
    /duplicate command registration: \/status/,
  );
});

// ── Central authorization ────────────────────────────────────────────────────
// The registrar applies the module's declared gates before its handler runs, so
// a module that declares `operatorOnly` cannot accidentally answer strangers.

test("an operator-only module is silently ignored for non-operators", async () => {
  let calls = 0;
  defineCommand({
    command: "test-operator-only",
    hidden: true,
    operatorOnly: true,
    handler: async () => {
      calls += 1;
    },
  });

  const { handlers, bot } = recorder();
  registerCommandHandlers(bot, deps());
  const handler = handlers.get("test-operator-only");

  const stranger = context({ userId: 99 });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await handler(stranger.ctx);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, 0, "handler must not run for a non-operator");
  assert.deepEqual(stranger.replies, [], "non-operators get silence, not an error");

  await handler(context({ userId: 42 }).ctx);
  assert.equal(calls, 1, "the operator reaches the handler");
});

test("an allowlisted module is silently ignored outside ALLOWED_CHAT_IDS", async () => {
  let calls = 0;
  defineCommand({
    command: "test-allowlisted",
    hidden: true,
    chatAllowlist: true,
    handler: async () => {
      calls += 1;
    },
  });

  const { handlers, bot } = recorder();
  registerCommandHandlers(bot, deps({ config: baseConfig({ allowedChatIds: ["-100999"] }) }));
  const handler = handlers.get("test-allowlisted");

  const outsider = context({ chatId: -1001234567890 });
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await handler(outsider.ctx);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, 0);
  assert.deepEqual(outsider.replies, []);

  await handler(context({ chatId: -100999 }).ctx);
  assert.equal(calls, 1);
});

test("the action dispatcher leaves pause-confirm payloads to their own handler", async () => {
  let answered = 0;
  await handleCallbackQuery(
    {
      from: { id: 42 },
      callbackQuery: { data: CALLBACK_PAUSE_CONFIRM, message: { date: Math.floor(Date.now() / 1000) } },
      update: { update_id: 7 },
      answerCallbackQuery: async () => {
        answered += 1;
      },
    },
    deps(),
  );
  assert.equal(answered, 0, "the confirmation handler owns this payload");
});

test("the pause confirmation flow rejects payloads outside its own set", async () => {
  const { callbackFilters, bot } = recorder();
  registerCommandHandlers(bot, deps());
  const handler = callbackFilters[0].handler;

  let answered = 0;
  await handler({
    from: { id: 42 },
    callbackQuery: { data: "status", message: { date: Math.floor(Date.now() / 1000) } },
    update: { update_id: 5 },
    answerCallbackQuery: async () => {
      answered += 1;
    },
  });
  assert.equal(answered, 0, "navigation payloads are left to the action dispatcher");
});
