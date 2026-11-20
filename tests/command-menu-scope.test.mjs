/**
 * Telegram command-menu scoping.
 *
 * Telegram caches command menus per chat, so the default menu must never
 * advertise operator commands. Those are registered only for the configured
 * operator's private chat, and the central dispatch gates remain authoritative.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerCommandHandlers, registerCommands } from "../dist/bot.js";
import { commandMenus } from "../dist/commands/index.js";

const PUBLIC_COMMANDS = ["start", "help", "about", "status", "contracts", "health", "preview"];
const OPERATOR_COMMANDS = ["audit", "pause", "resume"];
const ALL_COMMANDS = [
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
const FAKE_VALUE = "123456789:TEST-ONLY-FAKE_VALUE-NEVER-USE";

function config(operatorTelegramUserId = "42") {
  return { operatorTelegramUserId, botToken: FAKE_VALUE, allowedChatIds: [] };
}

function names(commands) {
  return commands.map(({ command }) => command);
}

function menuApi(failOnCall = 0) {
  const calls = [];
  return {
    calls,
    bot: {
      api: {
        setMyCommands: async (commands, options) => {
          calls.push({ commands, options });
          if (calls.length === failOnCall) {
            throw new Error(`${FAKE_VALUE} ${remote(100)}`);
          }
          return true;
        },
      },
    },
  };
}

function remote(times) {
  return "remote".repeat(times);
}

function captureWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.warn = original;
    })
    .then(() => warnings);
}

test("operator commands are omitted from the default menu and scoped to the operator chat", () => {
  const menus = commandMenus(config());
  assert.equal(menus.length, 2);
  assert.deepEqual(names(menus[0].commands), PUBLIC_COMMANDS);
  assert.equal(menus[0].scope, undefined);
  assert.deepEqual(names(menus[1].commands), ALL_COMMANDS);
  assert.deepEqual(menus[1].scope, { type: "chat", chat_id: "42" });
  for (const command of OPERATOR_COMMANDS) {
    assert.equal(names(menus[0].commands).includes(command), false);
    assert.equal(names(menus[1].commands).includes(command), true);
  }
});

test("no operator menu when no config or operator id is supplied", async () => {
  for (const [label, cfg] of [
    ["no config", undefined],
    ["null", config(null)],
    ["empty", config("")],
  ]) {
    const menus = commandMenus(cfg);
    assert.equal(menus.length, 1, label);
    assert.deepEqual(names(menus[0].commands), PUBLIC_COMMANDS, label);
    assert.equal(menus[0].scope, undefined, label);

    const { calls, bot } = menuApi();
    await registerCommands(bot, cfg);
    assert.equal(calls.length, 1, label);
    assert.deepEqual(calls[0].options, undefined, label);
    assert.deepEqual(names(calls[0].commands), PUBLIC_COMMANDS, label);
  }
});

test("registerCommands sends the scoped menu with Telegram's chat-scope option", async () => {
  const { calls, bot } = menuApi();
  await registerCommands(bot, config());
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options, undefined);
  assert.deepEqual(calls[1].options, { scope: { type: "chat", chat_id: "42" } });
  assert.deepEqual(names(calls[1].commands), ALL_COMMANDS);
});

test("a failed scoped registration is cosmetic, bounded, and redacted", async () => {
  const { calls, bot } = menuApi(2);
  const warnings = await captureWarnings(() => registerCommands(bot, config()));
  assert.deepEqual(names(calls[0].commands), PUBLIC_COMMANDS);
  assert.deepEqual(calls[1].options, { scope: { type: "chat", chat_id: "42" } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\(operator\)/);
  assert.equal(warnings[0].includes(FAKE_VALUE), false);
  assert.ok(warnings[0].length <= 280);
});

test("a failed public registration still attempts the operator-scoped menu", async () => {
  const { calls, bot } = menuApi(1);
  const warnings = await captureWarnings(() => registerCommands(bot, config()));
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(FAKE_VALUE), false);
});

test("a cached privileged menu never authorizes a non-operator", async () => {
  const handlers = new Map();
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
    callbackQuery: () => undefined,
    on: () => undefined,
  };
  let pauseCalls = 0;
  registerCommandHandlers(bot, {
    config: config(),
    status: () => {
      throw new Error("unused");
    },
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => {
      throw new Error("unused");
    },
  });

  const { bot: menuBot } = menuApi();
  await registerCommands(menuBot, config());

  const replies = [];
  const ctx = {
    from: { id: 7 },
    chat: { id: 7 },
    update: { update_id: 1 },
    reply: async (...args) => replies.push(args),
  };
  await captureWarnings(() => handlers.get("pause")(ctx));
  assert.equal(pauseCalls, 0);
  assert.deepEqual(replies, []);
});
