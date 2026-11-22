/**
 * Focused tests for the shared slash-command argument byte limit.
 *
 * Verifies:
 *   - exact UTF-8 byte boundary (at limit passes, 1 byte over fails)
 *   - multi-byte UTF-8 characters are counted by byte length, not JS string length
 *   - oversized arguments are rejected with a bounded reply that never echoes user input
 *   - rejection logs record command name, update id, and byte count only — never user input
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMMAND_ARGUMENT_BYTES,
  TELEGRAM_OPTIONS,
  checkCommandArgumentLength,
  commandArgumentAllowed,
  commandArgumentTooLongMessage,
} from "../dist/commands/runtime.js";

function makeCtx({ text, match, updateId = 77 } = {}) {
  const replies = [];
  return {
    replies,
    ctx: {
      ...(text !== undefined ? { message: { text } } : {}),
      ...(match !== undefined ? { match } : {}),
      update: { update_id: updateId },
      reply: async (...args) => {
        replies.push(args);
      },
    },
  };
}

test("MAX_COMMAND_ARGUMENT_BYTES is 256", () => {
  assert.equal(MAX_COMMAND_ARGUMENT_BYTES, 256);
});

test("checkCommandArgumentLength accepts empty and exact-limit arguments", () => {
  const empty = checkCommandArgumentLength(makeCtx({ text: "/help" }).ctx);
  assert.deepEqual(empty, { ok: true, argument: "", bytes: 0 });

  const exactAscii = "a".repeat(MAX_COMMAND_ARGUMENT_BYTES);
  const atLimit = checkCommandArgumentLength(makeCtx({ match: exactAscii }).ctx);
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.bytes, MAX_COMMAND_ARGUMENT_BYTES);
  assert.equal(atLimit.argument, exactAscii);

  const viaMessageText = checkCommandArgumentLength(
    makeCtx({ text: `/help ${exactAscii}` }).ctx,
  );
  assert.equal(viaMessageText.ok, true);
  assert.equal(viaMessageText.bytes, MAX_COMMAND_ARGUMENT_BYTES);
});

test("checkCommandArgumentLength rejects arguments 1 byte over the limit", () => {
  const overAscii = "a".repeat(MAX_COMMAND_ARGUMENT_BYTES + 1);
  const result = checkCommandArgumentLength(makeCtx({ match: overAscii }).ctx);
  assert.deepEqual(result, {
    ok: false,
    bytes: MAX_COMMAND_ARGUMENT_BYTES + 1,
    maxBytes: MAX_COMMAND_ARGUMENT_BYTES,
  });
});

test("checkCommandArgumentLength counts UTF-8 bytes for multi-byte characters", () => {
  // Each '🚀' is 4 UTF-8 bytes (2 UTF-16 code units).
  const exactEmoji = "🚀".repeat(64); // 64 * 4 = 256 bytes, .length = 128
  assert.equal(Buffer.byteLength(exactEmoji, "utf8"), 256);
  assert.equal(exactEmoji.length, 128);
  const okResult = checkCommandArgumentLength(makeCtx({ match: exactEmoji }).ctx);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.bytes, 256);

  const overEmoji = "🚀".repeat(65); // 65 * 4 = 260 bytes, .length = 130
  assert.equal(Buffer.byteLength(overEmoji, "utf8"), 260);
  const failResult = checkCommandArgumentLength(makeCtx({ match: overEmoji }).ctx);
  assert.deepEqual(failResult, {
    ok: false,
    bytes: 260,
    maxBytes: MAX_COMMAND_ARGUMENT_BYTES,
  });
});

test("commandArgumentAllowed allows valid arguments without replying or warning", async () => {
  const { ctx, replies } = makeCtx({ match: "status", updateId: 101 });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const allowed = await commandArgumentAllowed(ctx, "help");
    assert.equal(allowed, true);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(replies, []);
  assert.deepEqual(warnings, []);
});

test("commandArgumentAllowed rejects oversized arguments with bounded reply and without logging user input", async () => {
  const sentinel = "USER_PAYLOAD_MARKER_DO_NOT_ECHO_OR_LOG";
  const oversized = `${sentinel}_${"x".repeat(MAX_COMMAND_ARGUMENT_BYTES)}`;
  const expectedBytes = Buffer.byteLength(oversized, "utf8");
  const { ctx, replies } = makeCtx({ text: `/help ${oversized}`, updateId: 404 });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const allowed = await commandArgumentAllowed(ctx, "help");
    assert.equal(allowed, false);
  } finally {
    console.warn = originalWarn;
  }

  // Bounded reply, never echoing user input
  assert.equal(replies.length, 1);
  const [replyText, replyOpts] = replies[0];
  assert.equal(replyText, commandArgumentTooLongMessage());
  assert.deepEqual(replyOpts, TELEGRAM_OPTIONS);
  assert.ok(replyText.length <= 128, "rejection reply must stay tightly bounded");
  assert.equal(replyText.includes(sentinel), false, "reply must never echo user input");

  // Bounded warning log, never logging user input
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\[bot\] rejected \/help on update 404/);
  assert.ok(warnings[0].includes(`${expectedBytes} bytes`), "warning should include byte count");
  assert.ok(warnings[0].length <= 200, "warning log must stay bounded");
  assert.equal(warnings[0].includes(sentinel), false, "warning must never log user input");
});
