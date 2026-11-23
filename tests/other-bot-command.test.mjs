import assert from "node:assert/strict";
import test from "node:test";

import {
  createBot,
  isCommandForAnotherBot,
  registerCommandHandlers,
} from "../dist/bot.js";

function makeConfig() {
  return {
    botToken: "123456:TEST_TOKEN_FOR_UNIT_TESTS",
    telegramChatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: null,
    locale: "en",
  };
}

function makeCommandUpdate({
  chatId = 1001,
  chatType = "private",
  text,
  entityLength,
  updateId = 1,
}) {
  const len = entityLength ?? text.split(/\s/, 1)[0].length;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatType },
      from: { id: 999, is_bot: false, first_name: "Tester" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: len }],
    },
  };
}

// ---------------------------------------------------------------------------
// Unit: isCommandForAnotherBot
// ---------------------------------------------------------------------------

test("isCommandForAnotherBot: returns false for bare command without @mention", () => {
  assert.equal(
    isCommandForAnotherBot({
      message: { text: "/status", entities: [{ type: "bot_command", offset: 0, length: 7 }] },
      me: { username: "mimir_bot" },
    }),
    false,
  );
});

test("isCommandForAnotherBot: returns false when @mention matches ctx.me.username (case-insensitive)", () => {
  assert.equal(
    isCommandForAnotherBot({
      message: {
        text: "/status@Mimir_Bot",
        entities: [{ type: "bot_command", offset: 0, length: 17 }],
      },
      me: { username: "mimir_bot" },
    }),
    false,
  );
});

test("isCommandForAnotherBot: returns true when @mention targets a different bot", () => {
  assert.equal(
    isCommandForAnotherBot({
      message: {
        text: "/status@other_bot arg1",
        entities: [{ type: "bot_command", offset: 0, length: 17 }],
      },
      me: { username: "mimir_bot" },
    }),
    true,
  );
});

test("isCommandForAnotherBot: returns true when @mention is present and ctx.me.username is absent", () => {
  assert.equal(
    isCommandForAnotherBot({
      message: {
        text: "/status@other_bot",
        entities: [{ type: "bot_command", offset: 0, length: 17 }],
      },
      me: undefined,
    }),
    true,
  );
});

test("isCommandForAnotherBot: returns false for trailing @ with empty username", () => {
  assert.equal(
    isCommandForAnotherBot({
      message: {
        text: "/status@",
        entities: [{ type: "bot_command", offset: 0, length: 8 }],
      },
      me: { username: "mimir_bot" },
    }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Integration: registerCommandHandlers & createBot
// ---------------------------------------------------------------------------

test("registerCommandHandlers: ignores known command addressed to another bot", async () => {
  const handlers = new Map();
  const registrar = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerCommandHandlers(registrar, {
    config: makeConfig(),
    status: () => ({ state: "running" }),
    pause: () => "paused",
    resume: () => "resumed",
  });

  const aboutHandler = handlers.get("about");
  assert.ok(aboutHandler, "about handler should be registered");

  let replied = false;
  await aboutHandler({
    chat: { id: 1001, type: "private" },
    from: { id: 999 },
    me: { username: "mimir_bot" },
    message: {
      text: "/about@other_bot",
      entities: [{ type: "bot_command", offset: 0, length: 16 }],
    },
    reply: async () => {
      replied = true;
    },
  });
  assert.equal(replied, false);
});

test("createBot: handles /about@test_bot and /about, ignores /about@other_bot and /xyzzy@other_bot", async () => {
  const sent = [];
  const bot = createBot({
    config: makeConfig(),
    status: () => ({ state: "running" }),
    pause: () => "paused",
    resume: () => "resumed",
    botInfo: {
      id: 42,
      is_bot: true,
      first_name: "Mimir",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
  });

  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 1001, type: "private" } } };
  });

  // 1. Known command to another bot -> ignored
  await bot.handleUpdate(makeCommandUpdate({ text: "/about@other_bot", updateId: 1 }));
  assert.equal(sent.length, 0);

  // 2. Unknown command to another bot -> ignored
  await bot.handleUpdate(makeCommandUpdate({ text: "/xyzzy@other_bot", updateId: 2 }));
  assert.equal(sent.length, 0);

  // 3. Known command to this bot -> handled
  await bot.handleUpdate(makeCommandUpdate({ text: "/about@test_bot", updateId: 3 }));
  assert.equal(sent.length, 1);

  // 4. Bare known command -> handled
  await bot.handleUpdate(makeCommandUpdate({ text: "/about", updateId: 4 }));
  assert.equal(sent.length, 2);
});

test("createBot: commands addressed to another bot consume no rate-limit state", async () => {
  const sent = [];
  const bot = createBot({
    config: makeConfig(),
    status: () => ({ state: "running" }),
    pause: () => "paused",
    resume: () => "resumed",
    botInfo: {
      id: 42,
      is_bot: true,
      first_name: "Mimir",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
  });

  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 2002, type: "private" } } };
  });

  // Flood with commands for another bot; none should reply or consume rate-limit quota.
  for (let i = 1; i <= 25; i++) {
    await bot.handleUpdate(
      makeCommandUpdate({ chatId: 2002, text: "/about@other_bot", updateId: i }),
    );
  }
  assert.equal(sent.length, 0);

  // A command for this bot in the same chat must still succeed immediately.
  await bot.handleUpdate(
    makeCommandUpdate({ chatId: 2002, text: "/about@test_bot", updateId: 26 }),
  );
  assert.equal(sent.length, 1);
});
