/**
 * The command module registry (issue #327).
 *
 * Commands are self-contained `CommandModule`s listed in menu order by
 * `COMMAND_MODULES` (`src/commands/index.ts`). These tests register the
 * modules on a fake bot and pin:
 *   - the module shape and the catalogue's names and order
 *   - that handlers, `/help` and `setMyCommands` all follow registry order
 *   - that `operatorOnly` / `allowlisted` are enforced centrally from module
 *     flags, with the same silent-ignore behaviour and log lines as before
 *   - that `/contracts` and `/preview` — the first modules moved — reply
 *     exactly as their message builders render
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  contractsMessage,
  helpMessage,
  previewMessage,
  registerCommandHandlers,
  registerCommands,
} from "../dist/bot.js";
import {
  COMMAND_MODULES,
  contractsCommand,
  createCommandModule,
  defineCommand,
  previewCommand,
  registeredCommands,
} from "../dist/commands/index.js";
import { COMMAND_DESCRIPTIONS } from "../dist/i18n.js";

const OPTIONS = {
  parse_mode: "MarkdownV2",
  link_preview_options: { is_disabled: true },
};

const REGISTRY_ORDER = [
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
  "export",
];
const ADVERTISED = REGISTRY_ORDER.filter((command) => command !== "export");
const OPERATOR_ONLY = ["audit", "pause", "resume", "export"];
const ALLOWLISTED = ["status", "contracts", "health", "preview"];

const OPERATOR_ID = 42;
const STRANGER_ID = 99;
const ALLOWED_CHAT = -100111;
const OTHER_CHAT = -100222;

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: String(ALLOWED_CHAT),
    allowedChatIds: [String(ALLOWED_CHAT)],
    operatorTelegramUserId: String(OPERATOR_ID),
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
    pagesScanned: 0,
    emptyPages: 0,
    lastCyclePages: 0,
    lastCycleEmptyPages: 0,
    cursorRewinds: 0,
    restartGaps: 0,
  };
}

/** Never rate-limits, so authorization is the only gate under test. */
const OPEN_LIMITER = { consume: () => true, now: () => Date.now() };

function deps(overrides = {}) {
  return {
    config: baseConfig(),
    status: () => baseStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    rateLimiter: OPEN_LIMITER,
    ...overrides,
  };
}

/** A bot-shaped recorder: command registrations in order, plus the menu. */
function fakeBot() {
  const handlers = new Map();
  const menus = [];
  return {
    handlers,
    menus,
    bot: {
      command: (name, handler) => handlers.set(name, handler),
      api: { setMyCommands: async (commands) => menus.push(commands) },
    },
  };
}

function context({ userId = OPERATOR_ID, chatId = ALLOWED_CHAT, updateId = 7, text } = {}) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: userId },
      chat: { id: chatId, type: "group" },
      update: { update_id: updateId },
      message: text === undefined ? undefined : { text },
      reply: async (...args) => replies.push(args),
    },
  };
}

async function withWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

// ── Module shape and catalogue order ─────────────────────────────────────────

test("COMMAND_MODULES lists every command module in menu order", () => {
  assert.deepEqual(
    COMMAND_MODULES.map(({ command }) => command),
    REGISTRY_ORDER,
  );
  assert.ok(Object.isFrozen(COMMAND_MODULES), "the catalogue is not mutable at runtime");
});

test("every module has the CommandModule shape", () => {
  for (const module of COMMAND_MODULES) {
    assert.equal(typeof module.command, "string", `/${module.command} command`);
    assert.equal(typeof module.description, "string", `/${module.command} description`);
    assert.equal(typeof module.operatorOnly, "boolean", `/${module.command} operatorOnly`);
    assert.equal(typeof module.allowlisted, "boolean", `/${module.command} allowlisted`);
    assert.equal(typeof module.hidden, "boolean", `/${module.command} hidden`);
    assert.equal(typeof module.handle, "function", `/${module.command} handle`);
    if (!module.hidden) {
      assert.equal(module.description, COMMAND_DESCRIPTIONS[module.command]);
    }
  }
  assert.deepEqual(
    COMMAND_MODULES.filter(({ operatorOnly }) => operatorOnly).map(({ command }) => command),
    OPERATOR_ONLY,
  );
  assert.deepEqual(
    COMMAND_MODULES.filter(({ allowlisted }) => allowlisted).map(({ command }) => command),
    ALLOWLISTED,
  );
});

test("/contracts and /preview are self-contained allowlisted modules", () => {
  for (const [module, command] of [
    [contractsCommand, "contracts"],
    [previewCommand, "preview"],
  ]) {
    assert.equal(module.command, command);
    assert.equal(module.description, COMMAND_DESCRIPTIONS[command]);
    assert.equal(module.operatorOnly, false);
    assert.equal(module.allowlisted, true);
    assert.equal(module.hidden, false);
    assert.ok(COMMAND_MODULES.includes(module), `/${command} is in the catalogue`);
  }
});

test("the registry holds the catalogue modules themselves, in catalogue order", () => {
  const registered = registeredCommands().slice(0, COMMAND_MODULES.length);
  assert.equal(registered.length, COMMAND_MODULES.length);
  registered.forEach((module, index) => assert.equal(module, COMMAND_MODULES[index]));
});

// ── Registration follows registry order ──────────────────────────────────────

test("registerCommandHandlers registers module commands in registry order", () => {
  const { handlers, bot } = fakeBot();
  registerCommandHandlers(bot, deps());
  assert.deepEqual(
    [...handlers.keys()].slice(0, REGISTRY_ORDER.length),
    REGISTRY_ORDER,
  );
});

for (const operatorTelegramUserId of [String(OPERATOR_ID), null]) {
  test(`setMyCommands and /help list module commands in registry order (operator=${operatorTelegramUserId})`, async () => {
    const config = baseConfig({ operatorTelegramUserId });
    const { handlers, menus, bot } = fakeBot();
    registerCommandHandlers(bot, deps({ config }));
    await registerCommands(bot, config);

    const expected =
      operatorTelegramUserId === null
        ? ADVERTISED.filter((command) => !OPERATOR_ONLY.includes(command))
        : ADVERTISED;
    assert.equal(menus.length, 1);
    assert.deepEqual(menus[0].map(({ command }) => command), expected);
    for (const { command, description } of menus[0]) {
      assert.equal(description, COMMAND_DESCRIPTIONS[command]);
      assert.ok(handlers.has(command), `/${command} has a handler`);
    }

    const helpLines = helpMessage(config)
      .split("\n")
      .filter((line) => line.startsWith("/"))
      .map((line) => line.split(" ")[0].slice(1));
    assert.deepEqual(helpLines, expected);
  });
}

// ── Central authorization from module flags ──────────────────────────────────

for (const command of OPERATOR_ONLY) {
  test(`/${command} (operatorOnly) ignores non-operators silently and logs the attempt`, async () => {
    const { handlers, bot } = fakeBot();
    registerCommandHandlers(bot, deps());
    const stranger = context({ userId: STRANGER_ID, updateId: 7 });
    const warnings = await withWarnings(() => handlers.get(command)(stranger.ctx));
    assert.deepEqual(stranger.replies, []);
    assert.deepEqual(warnings, [`[bot] ignored unauthorized /${command} on update 7`]);
  });
}

for (const command of ALLOWLISTED) {
  test(`/${command} (allowlisted) ignores chats outside ALLOWED_CHAT_IDS silently and logs it`, async () => {
    const { handlers, bot } = fakeBot();
    registerCommandHandlers(bot, deps());
    const outsider = context({ chatId: OTHER_CHAT });
    const warnings = await withWarnings(() => handlers.get(command)(outsider.ctx));
    assert.deepEqual(outsider.replies, []);
    assert.deepEqual(warnings, [
      `[bot] /${command} denied for chat ${OTHER_CHAT} (not in ALLOWED_CHAT_IDS)`,
    ]);
  });
}

test("public commands answer anyone, anywhere", async () => {
  const { handlers, bot } = fakeBot();
  registerCommandHandlers(bot, deps());
  for (const command of ["start", "help", "about"]) {
    const stranger = context({ userId: STRANGER_ID, chatId: OTHER_CHAT });
    await handlers.get(command)(stranger.ctx);
    assert.equal(stranger.replies.length >= 1, true, `/${command} replied`);
  }
});

test("the operator passes operatorOnly gates", async () => {
  const { handlers, bot } = fakeBot();
  let resumed = 0;
  registerCommandHandlers(bot, deps({ resume: () => { resumed += 1; return "resumed"; } }));
  const operator = context({ userId: OPERATOR_ID });
  await handlers.get("resume")(operator.ctx);
  assert.equal(resumed, 1);
  assert.equal(operator.replies.length, 1);
});

test("flags on a new module are enforced without any code in the module", async () => {
  const calls = [];
  defineCommand(
    createCommandModule({
      command: "test-registry-gated",
      hidden: true,
      operatorOnly: true,
      allowlisted: true,
      handle: async (ctx) => {
        calls.push(ctx.from.id);
      },
    }),
  );
  const { handlers, bot } = fakeBot();
  registerCommandHandlers(bot, deps());
  const handler = handlers.get("test-registry-gated");
  assert.equal(typeof handler, "function", "a defined module is registered on the bot");

  await withWarnings(async () => {
    await handler(context({ userId: STRANGER_ID, chatId: ALLOWED_CHAT }).ctx);
    await handler(context({ userId: OPERATOR_ID, chatId: OTHER_CHAT }).ctx);
  });
  assert.deepEqual(calls, [], "both gates apply");

  await handler(context({ userId: OPERATOR_ID, chatId: ALLOWED_CHAT }).ctx);
  assert.deepEqual(calls, [OPERATOR_ID]);
});

// ── Moved commands reply exactly as before ───────────────────────────────────

test("/contracts replies with exactly the contracts message", async () => {
  const { handlers, bot } = fakeBot();
  const d = deps();
  registerCommandHandlers(bot, d);
  const { ctx, replies } = context();
  await handlers.get("contracts")(ctx);
  assert.deepEqual(replies, [[contractsMessage(d.config), OPTIONS]]);
});

test("/preview replies with the market sample by default and honours its argument", async () => {
  const { handlers, bot } = fakeBot();
  const d = deps();
  registerCommandHandlers(bot, d);

  const bare = context({ text: "/preview" });
  await handlers.get("preview")(bare.ctx);
  assert.deepEqual(bare.replies, [[previewMessage(d.config, "market"), OPTIONS]]);

  const squad = context({ text: "/preview squad" });
  await handlers.get("preview")(squad.ctx);
  assert.deepEqual(squad.replies, [[previewMessage(d.config, "squad"), OPTIONS]]);
});

// ── createCommandModule ──────────────────────────────────────────────────────

test("createCommandModule fills flag defaults and the menu description", () => {
  const module = createCommandModule({ command: "contracts", handle: async () => undefined });
  assert.equal(module.description, COMMAND_DESCRIPTIONS.contracts);
  assert.equal(module.operatorOnly, false);
  assert.equal(module.allowlisted, false);
  assert.equal(module.hidden, false);
  assert.equal(createCommandModule(module), module, "normalising a module is idempotent");
});

test("createCommandModule rejects a module without a handler or an advertised description", () => {
  assert.throws(() => createCommandModule({ command: "test-no-handler" }), /no handler/);
  assert.throws(
    () => createCommandModule({ command: "test-no-description", handle: async () => undefined }),
    /no COMMAND_DESCRIPTIONS entry for \/test-no-description/,
  );
});
