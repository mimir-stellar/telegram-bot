import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { formatDigest } from "../dist/notifications/format.js";

function baseConfig(overrides = {}) {
  return {
    chatIds: ["-1001234567890"],
    marketChatId: "-1001111111111",
    squadChatId: "-1002222222222",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    ...overrides,
  };
}

test("createNotifier: skips empty, whitespace-only, and null MarkdownV2 messages", async () => {
  const sent = [];
  const warnings = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const notifier = createNotifier(fakeBot, baseConfig());

  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const invalidInputs = ["", "   ", " \n\t  \r\n ", null, undefined];
    for (const input of invalidInputs) {
      await notifier(input, "market", { eventRef: { eventId: "1-1", ledger: 100, source: "market" } });
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sent.length, 0, "sendMessage must never be called for empty or whitespace messages");
  assert.equal(warnings.length, 5, "all 5 invalid inputs must log a skip warning");
  for (const warn of warnings) {
    assert.ok(warn.includes("[notifier] skipped empty message"), `warning must state message was skipped: ${warn}`);
  }
});

test("createNotifier: skips when MarkdownV2 fails and plain fallback is empty or whitespace", async () => {
  const sent = [];
  const warnings = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId, text, options) => {
        sent.push({ chatId, text, options });
        // Simulate Telegram MarkdownV2 entity parse error on the first attempt
        throw {
          error_code: 400,
          description: "Bad Request: can't parse entities: unclosed token",
        };
      },
    },
  };

  const notifier = createNotifier(fakeBot, baseConfig());

  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    // Attempt send with invalid markdown and whitespace-only fallback
    await notifier("invalid *markdown", "market", {
      plainText: "   \n\t  ",
      eventRef: { eventId: "2-1", ledger: 200, source: "market" },
    });
  } finally {
    console.warn = originalWarn;
  }

  // Only the initial Markdown attempt was made before being rejected; no second attempt with whitespace was sent
  assert.equal(sent.length, 1);
  assert.ok(
    warnings.some((w) => w.includes("[notifier] skipped empty plain text fallback")),
    "must warn that empty plain text fallback was skipped",
  );
});

test("createNotifier: digest path producing null or empty rendering is cleanly skipped", async () => {
  const sent = [];
  const warnings = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
      },
    },
  };

  const notifier = createNotifier(fakeBot, baseConfig());

  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    // formatDigest([]) evaluates to null
    const digestText = formatDigest([]);
    assert.equal(digestText, null);
    await notifier(digestText);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sent.length, 0, "digest producing null must not trigger sendMessage");
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("[notifier] skipped empty message"));
});

test("createNotifier: non-empty messages still send normally", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId, text, options) => {
        sent.push({ chatId, text, options });
      },
    },
  };

  const notifier = createNotifier(fakeBot, baseConfig());
  await notifier("Valid notification message", "market");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Valid notification message");
  assert.equal(sent[0].chatId, "-1001111111111");
});
