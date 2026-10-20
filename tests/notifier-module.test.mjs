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
  isMarkdownParseError as isMarkdownParseErrorFromBot,
  notifierSkips as notifierSkipsFromBot,
} from "../dist/bot.js";

import {
  createNotifier as createNotifierDirect,
  isMarkdownParseError as isMarkdownParseErrorDirect,
  notifierSkips as notifierSkipsDirect,
} from "../dist/notifications/notifier.js";

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
});
