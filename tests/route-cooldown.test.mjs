import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotifier,
  isPermissionFailure,
  notifierSkips,
} from "../dist/notifications/notifier.js";
import { loadConfig } from "../dist/config.js";

const BOT_TOKEN = "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

test("isPermissionFailure classifies 403 and 400 permission errors only", () => {
  assert.equal(
    isPermissionFailure({ error_code: 403, description: "Forbidden: bot was kicked from the group chat" }),
    true,
  );
  assert.equal(
    isPermissionFailure({ error_code: 400, description: "Bad Request: not enough rights to send text messages to the chat" }),
    true,
  );
  assert.equal(
    isPermissionFailure({ error_code: 400, description: "Bad Request: can't parse entities: ..." }),
    false,
  );
  assert.equal(
    isPermissionFailure({ error_code: 429, description: "Too Many Requests: retry after 10" }),
    false,
  );
  assert.equal(
    isPermissionFailure({ error_code: 401, description: "Unauthorized" }),
    false,
  );
  assert.equal(isPermissionFailure(new Error("ECONNRESET")), false);
});

test("route cooldown: isolates permission failure per destination and supports explicit recovery", async () => {
  let nowMs = 1_000_000;
  let marketShouldFail = true;
  const sent = [];

  const fakeBot = {
    api: {
      sendMessage: async (chatId, text) => {
        if (chatId === "-100111" && marketShouldFail) {
          throw { error_code: 403, description: "Forbidden: bot was kicked from the group chat" };
        }
        sent.push({ chatId, text });
        return {};
      },
    },
  };

  const notifier = createNotifier(
    fakeBot,
    {
      botToken: BOT_TOKEN,
      chatId: "-100000",
      marketChatId: "-100111",
      squadChatId: "-100222",
    },
    { cooldownMs: 60_000, now: () => nowMs },
  );

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    // First send to market fails with 403 and arms cooldown for -100111 only.
    await assert.rejects(
      () => notifier("market-1", "market"),
      (err) => err?.error_code === 403,
    );
    assert.equal(notifier.isInCooldown("-100111"), true);
    assert.equal(notifier.isInCooldown("-100222"), false);

    // Subsequent send to market is skipped while in cooldown.
    const skipsBefore = notifierSkips.routeCooldown;
    await notifier("market-2", "market");
    assert.equal(notifierSkips.routeCooldown, skipsBefore + 1);

    // Squad destination is completely unaffected.
    await notifier("squad-1", "squad");
    assert.deepEqual(sent, [{ chatId: "-100222", text: "squad-1" }]);

    // Permissions are restored and operator explicitly clears cooldown.
    marketShouldFail = false;
    assert.equal(notifier.clearCooldown("-100111"), true);
    assert.equal(notifier.isInCooldown("-100111"), false);

    await notifier("market-3", "market");
    assert.deepEqual(sent, [
      { chatId: "-100222", text: "squad-1" },
      { chatId: "-100111", text: "market-3" },
    ]);

    // Natural expiry boundary: arm cooldown again, then advance past cooldownMs.
    marketShouldFail = true;
    await assert.rejects(() => notifier("market-4", "market"));
    assert.equal(notifier.isInCooldown("-100111"), true);

    nowMs += 60_000;
    assert.equal(notifier.isInCooldown("-100111"), false);
    marketShouldFail = false;
    await notifier("market-5", "market");
    assert.equal(sent[sent.length - 1].text, "market-5");
  } finally {
    console.warn = origWarn;
  }
});

test("route cooldown: disabled when cooldownMs is 0 and not armed on 429", async () => {
  let calls = 0;
  const fakeBot = {
    api: {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) {
          throw { error_code: 429, description: "Too Many Requests: retry after 5" };
        }
        throw { error_code: 403, description: "Forbidden: bot was blocked" };
      },
    },
  };

  const notifier = createNotifier(
    fakeBot,
    { botToken: BOT_TOKEN, chatId: "-100111", marketChatId: "", squadChatId: "" },
    { cooldownMs: 0 },
  );

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(() => notifier("m1"), (e) => e?.error_code === 429);
    assert.equal(notifier.isInCooldown("-100111"), false);

    await assert.rejects(() => notifier("m2"), (e) => e?.error_code === 403);
    assert.equal(notifier.isInCooldown("-100111"), false, "cooldownMs=0 disables cooldown");
  } finally {
    console.warn = origWarn;
  }
});

test("loadConfig reads TELEGRAM_ROUTE_COOLDOWN_MS and falls back to default", () => {
  const prev = { ...process.env };
  try {
    process.env.MIMIR_PROFILE = "mock";
    delete process.env.TELEGRAM_ROUTE_COOLDOWN_MS;
    const def = loadConfig();
    assert.equal(def.routeCooldownMs, 300_000);

    process.env.TELEGRAM_ROUTE_COOLDOWN_MS = "15000";
    const custom = loadConfig();
    assert.equal(custom.routeCooldownMs, 15_000);
  } finally {
    process.env = prev;
  }
});
