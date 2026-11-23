/**
 * notifier-module.test.mjs
 *
 * Verifies that src/notifications/notifier.ts (dist/notifications/notifier.js)
 * exports the same functions/objects as the re-exports in src/bot.ts, so that
 * consumers can import from either path without behaviour change.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createNotifier as createNotifierFromBot,
  extractMessageId as extractMessageIdFromBot,
  InvalidDeliveryResultError as InvalidDeliveryResultErrorFromBot,
  isMarkdownParseError as isMarkdownParseErrorFromBot,
  notifierSkips as notifierSkipsFromBot,
} from "../dist/bot.js";

import {
  createNotifier as createNotifierDirect,
  extractMessageId as extractMessageIdDirect,
  InvalidDeliveryResultError as InvalidDeliveryResultErrorDirect,
  isMarkdownParseError as isMarkdownParseErrorDirect,
  notifierSkips as notifierSkipsDirect,
  resolveForumTopicId,
} from "../dist/notifications/notifier.js";
import { loadConfig } from "../dist/config.js";

// ── Function identity ─────────────────────────────────────────────────────────
// ES re-exports create the same binding, so the references are strictly equal.

test("createNotifier re-exported from bot.js is the same function as the direct export", () => {
  assert.strictEqual(
    createNotifierFromBot,
    createNotifierDirect,
    "createNotifier must be the identical function reference through re-export",
  );
});

test("isMarkdownParseError re-exported from bot.js is the same function", () => {
  assert.strictEqual(
    isMarkdownParseErrorFromBot,
    isMarkdownParseErrorDirect,
    "isMarkdownParseError must be the identical function reference through re-export",
  );
});

test("notifierSkips re-exported from bot.js is the same object", () => {
  assert.strictEqual(
    notifierSkipsFromBot,
    notifierSkipsDirect,
    "notifierSkips must be the identical object reference through re-export",
  );
});

// ── Module exports are callable / the right shape ────────────────────────────

test("createNotifier from notifier module is a function", () => {
  assert.equal(typeof createNotifierDirect, "function");
});

test("createNotifier from notifier module returns an async function", () => {
  const fakeBot = { api: { sendMessage: async () => ({}) } };
  const notifier = createNotifierDirect(fakeBot, { chatId: "-1001234567890" });
  assert.equal(typeof notifier, "function");
});

test("isMarkdownParseError from notifier module is a function", () => {
  assert.equal(typeof isMarkdownParseErrorDirect, "function");
});

test("isMarkdownParseError correctly classifies a parse-entities error", () => {
  const err = { error_code: 400, description: "Bad Request: can't parse entities: …" };
  assert.equal(isMarkdownParseErrorDirect(err), true);
});

test("isMarkdownParseError does not classify a rate-limit error (429) as parse failure", () => {
  const err = { error_code: 429, description: "Too Many Requests: retry after 30" };
  assert.equal(isMarkdownParseErrorDirect(err), false);
});

test("notifierSkips from notifier module has an emptyText counter", () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(notifierSkipsDirect, "emptyText"),
    "notifierSkips should have an emptyText property",
  );
  assert.equal(typeof notifierSkipsDirect.emptyText, "number");
});

// ── Behaviour is unchanged: empty sends are still skipped ────────────────────

test("notifier module: empty text is skipped and notifierSkips.emptyText increments", async () => {
  const fakeBot = {
    api: {
      sendMessage: async () => {
        throw new Error("sendMessage must not be called for empty text");
      },
    },
  };
  const notifier = createNotifierDirect(fakeBot, { chatId: "-1001234567890" });
  const before = notifierSkipsDirect.emptyText;

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    await notifier("   "); // whitespace-only
  } finally {
    console.warn = origWarn;
  }

  assert.ok(
    notifierSkipsDirect.emptyText > before,
    "notifierSkips.emptyText should have incremented",
  );
});

test("notifier module: valid text reaches sendMessage", async () => {
  const sent = [];
  const fakeBot = {
    api: { sendMessage: async (...args) => { sent.push(args); return {}; } },
  };
  const notifier = createNotifierDirect(fakeBot, { chatId: "-1001234567890" });

  await notifier("hello world");

  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], "-1001234567890");
  assert.equal(sent[0][1], "hello world");
  assert.equal(sent[0][2].message_thread_id, undefined);
});

// ── Forum topic routing with default and category overrides ──────────────────

test("resolveForumTopicId resolves category override before default, handles unmatched and disabled categories", () => {
  const cfg = {
    defaultForumTopicId: 100,
    categoryForumTopics: {
      crypto: 202,
      politics: null,
    },
  };

  assert.equal(resolveForumTopicId(cfg, "  CRYPTO "), 202, "category override wins over default");
  assert.equal(resolveForumTopicId(cfg, "sports"), 100, "unmatched category falls back to default");
  assert.equal(resolveForumTopicId(cfg, undefined), 100, "missing category falls back to default");
  assert.equal(
    resolveForumTopicId(cfg, "politics"),
    undefined,
    "explicitly disabled category returns undefined instead of default",
  );
  assert.equal(resolveForumTopicId({}, "crypto"), undefined, "no topic config returns undefined");
});

test("createNotifier sends message_thread_id for default, category override, and omits for disabled category", async () => {
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };
  const notifier = createNotifierDirect(fakeBot, {
    chatId: "-1001234567890",
    defaultForumTopicId: 42,
    categoryForumTopics: {
      crypto: 99,
      offtopic: null,
    },
  });

  await notifier("crypto event", "market", { category: "Crypto" });
  await notifier("sports event", "market", { category: "sports" });
  await notifier("offtopic event", "market", { category: "offtopic" });

  assert.equal(sent.length, 3);
  assert.equal(sent[0][2].message_thread_id, 99);
  assert.equal(sent[1][2].message_thread_id, 42);
  assert.equal(Object.prototype.hasOwnProperty.call(sent[2][2], "message_thread_id"), false);
});

test("loadConfig parses TELEGRAM_DEFAULT_TOPIC_ID and TELEGRAM_CATEGORY_TOPICS and rejects invalid values", () => {
  const withEnv = (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  const baseEnv = {
    BOT_TOKEN: "1234567890:" + "A".repeat(35),
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    SQUAD_CONTRACT_ID: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4",
    TELEGRAM_DEFAULT_TOPIC_ID: undefined,
    TELEGRAM_CATEGORY_TOPICS: undefined,
  };

  withEnv(
    {
      ...baseEnv,
      TELEGRAM_DEFAULT_TOPIC_ID: "15",
      TELEGRAM_CATEGORY_TOPICS: "Crypto:77,Politics:off,Sports:0",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.defaultForumTopicId, 15);
      assert.deepEqual(cfg.categoryForumTopics, {
        crypto: 77,
        politics: null,
        sports: null,
      });
    },
  );

  withEnv(
    {
      ...baseEnv,
      TELEGRAM_CATEGORY_TOPICS: '{"crypto": 88, "politics": null}',
    },
    () => {
      const cfgJson = loadConfig();
      assert.deepEqual(cfgJson.categoryForumTopics, {
        crypto: 88,
        politics: null,
      });
    },
  );

  withEnv({ ...baseEnv, TELEGRAM_DEFAULT_TOPIC_ID: "0" }, () => {
    assert.throws(() => loadConfig(), /TELEGRAM_DEFAULT_TOPIC_ID/);
  });

  withEnv({ ...baseEnv, TELEGRAM_CATEGORY_TOPICS: "badentry" }, () => {
    assert.throws(() => loadConfig(), /TELEGRAM_CATEGORY_TOPICS/);
  });
});

test("requireMessageId rejects Telegram responses missing a valid message_id", async () => {
  assert.strictEqual(InvalidDeliveryResultErrorFromBot, InvalidDeliveryResultErrorDirect);
  assert.strictEqual(extractMessageIdFromBot, extractMessageIdDirect);
  assert.equal(extractMessageIdDirect({ message_id: 42 }), 42);
  assert.equal(extractMessageIdDirect({ message_id: 0 }), null);
  assert.equal(extractMessageIdDirect({ message_id: "42" }), null);
  assert.equal(extractMessageIdDirect({}), null);
  assert.equal(extractMessageIdDirect(null), null);

  for (const badResponse of [{}, undefined, null, { ok: true }, { message_id: 0 }, { message_id: "9" }]) {
    const fakeBot = { api: { sendMessage: async () => badResponse } };
    const notifier = createNotifierDirect(
      fakeBot,
      { chatId: "-1001234567890" },
      { requireMessageId: true },
    );
    await assert.rejects(
      () => notifier("hello world", "market", { plainText: "hello world" }),
      (err) => err instanceof InvalidDeliveryResultErrorDirect,
    );
  }

  const goodBot = { api: { sendMessage: async () => ({ message_id: 101 }) } };
  const goodNotifier = createNotifierDirect(
    goodBot,
    { chatId: "-1001234567890" },
    { requireMessageId: true },
  );
  await goodNotifier("hello world");
});
