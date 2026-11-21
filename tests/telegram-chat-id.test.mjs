import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTelegramChatId } from "../dist/telegram.js";

test("preserves large negative identifiers as decimal strings", () => {
  assert.equal(
    normalizeTelegramChatId("-1001234567890123456"),
    "-1001234567890123456",
  );
});

test("accepts positive and zero integer identifiers", () => {
  assert.equal(normalizeTelegramChatId("123456"), "123456");
  assert.equal(normalizeTelegramChatId("0"), "0");
});

test("accepts channel usernames", () => {
  assert.equal(normalizeTelegramChatId("@mimir_updates"), "@mimir_updates");
});

test("rejects fractional chat IDs", () => {
  assert.throws(() => normalizeTelegramChatId("-100.5"), /Invalid Telegram chat ID/);
});

test("rejects exponent-notation chat IDs", () => {
  assert.throws(() => normalizeTelegramChatId("-1e12"), /Invalid Telegram chat ID/);
  assert.throws(() => normalizeTelegramChatId("1E5"), /Invalid Telegram chat ID/);
});

test("rejects malformed channel usernames", () => {
  assert.throws(() => normalizeTelegramChatId("@ab"), /Invalid Telegram channel username/);
});
