import assert from "node:assert/strict";
import test from "node:test";

import { applyChatMigration } from "../dist/config.js";
import {
  createNotifier,
  extractMigrateToChatId,
} from "../dist/notifications/notifier.js";

const BOT_TOKEN = "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

test("extractMigrateToChatId parses 400 migration errors and ignores others", () => {
  assert.equal(
    extractMigrateToChatId({
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: -1009876543210 },
    }),
    "-1009876543210",
  );
  assert.equal(
    extractMigrateToChatId({
      error_code: 400,
      parameters: { migrate_to_chat_id: "-100111222333" },
    }),
    "-100111222333",
  );
  assert.equal(
    extractMigrateToChatId({
      error_code: 429,
      parameters: { migrate_to_chat_id: -1009876543210 },
    }),
    null,
  );
  assert.equal(
    extractMigrateToChatId({ error_code: 400, parameters: { migrate_to_chat_id: 0 } }),
    null,
  );
  assert.equal(extractMigrateToChatId(new Error("network")), null);
});

test("applyChatMigration updates matching config routes and deduplicates chatIds", () => {
  const cfg = {
    chatId: "-12345",
    chatIds: ["-12345", "-100999"],
    marketChatId: "-12345",
    squadChatId: "-67890",
    routes: [
      { chatId: "-12345", channelPreviewMode: false },
      { chatId: "-67890", channelPreviewMode: true },
    ],
  };

  assert.equal(applyChatMigration(cfg, "-12345", "-100999"), true);
  assert.equal(cfg.chatId, "-100999");
  assert.equal(cfg.marketChatId, "-100999");
  assert.equal(cfg.squadChatId, "-67890");
  assert.deepEqual(cfg.chatIds, ["-100999"]);
  assert.equal(cfg.routes[0].chatId, "-100999");
  assert.equal(cfg.routes[0].migratedFromChatId, "-12345");
  assert.equal(cfg.routes[1].chatId, "-67890");

  // Self or empty migration is a no-op.
  assert.equal(applyChatMigration(cfg, "-100999", "-100999"), false);
  assert.equal(applyChatMigration(cfg, "", "-100111"), false);
});

test("notifier: recovers route on migrate_to_chat_id and never retries abandoned group", async () => {
  const attempts = [];
  const migrations = [];

  const fakeBot = {
    api: {
      sendMessage: async (chatId, text) => {
        attempts.push({ chatId, text });
        if (chatId === "-12345") {
          throw {
            error_code: 400,
            description: "Bad Request: group chat was upgraded to a supergroup chat",
            parameters: { migrate_to_chat_id: -10055555 },
          };
        }
        return {};
      },
    },
  };

  const config = {
    botToken: BOT_TOKEN,
    chatId: "-12345",
    marketChatId: "-12345",
    squadChatId: "-99999",
  };

  const notifier = createNotifier(fakeBot, config, {
    onRouteMigrated: (from, to) => migrations.push({ from, to }),
  });

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    // First send triggers migration, updates route, and succeeds on the new chat ID.
    await notifier("msg-1", "market");
    // Second send goes directly to the migrated supergroup, never touching -12345 again.
    await notifier("msg-2", "market");
  } finally {
    console.warn = origWarn;
  }

  assert.deepEqual(migrations, [{ from: "-12345", to: "-10055555" }]);
  assert.equal(config.marketChatId, "-10055555");
  assert.equal(config.chatId, "-10055555");
  assert.deepEqual(attempts, [
    { chatId: "-12345", text: "msg-1" },
    { chatId: "-10055555", text: "msg-1" },
    { chatId: "-10055555", text: "msg-2" },
  ]);
});

test("notifier: explicit migrateRoute avoids abandoned id and self/cyclic migration does not loop", async () => {
  const attempts = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId, text) => {
        attempts.push({ chatId, text });
        if (chatId === "-100777") {
          // Malformed self-migration must not loop.
          throw {
            error_code: 400,
            description: "Bad Request: group chat was upgraded to a supergroup chat",
            parameters: { migrate_to_chat_id: -100777 },
          };
        }
        return {};
      },
    },
  };

  const notifier = createNotifier(fakeBot, {
    botToken: BOT_TOKEN,
    chatId: "-11111",
    marketChatId: "",
    squadChatId: "",
  });

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(notifier.migrateRoute("-11111", "-100222"), true);
    await notifier("hello");
    assert.deepEqual(attempts, [{ chatId: "-100222", text: "hello" }]);

    assert.equal(notifier.migrateRoute("-100222", "-100777"), true);
    await assert.rejects(
      () => notifier("loop-check"),
      (err) => err?.error_code === 400,
    );
    assert.equal(attempts.filter((a) => a.chatId === "-100777").length, 1);
  } finally {
    console.warn = origWarn;
  }
});
