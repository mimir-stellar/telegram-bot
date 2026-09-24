import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import {
  classifyTelegramError,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  redactSecrets,
} from "../dist/telegramErrors.js";

const FAKE_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

test("redactSecrets strips BotFather tokens and bounds length", () => {
  const raw = `Call failed with token ${FAKE_TOKEN} and url https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage ` + "x".repeat(500);
  const redacted = redactSecrets(raw, 120);
  assert.equal(redacted.includes(FAKE_TOKEN), false);
  assert.match(redacted, /\[REDACTED_BOT_TOKEN\]/);
  assert.ok(redacted.length <= 120);
});

test("classifyTelegramError maps Grammy-shaped API codes", () => {
  const cases = [
    [429, "Too Many Requests: retry after 12", "rate_limit", true],
    [401, "Unauthorized", "unauthorized", false],
    [403, "Forbidden: bot was kicked", "forbidden", false],
    [404, "Not Found", "not_found", false],
    [409, "Conflict: terminated by other getUpdates", "conflict", true],
    [400, "Bad Request: chat not found", "bad_request", false],
  ];

  for (const [code, description, kind, retryable] of cases) {
    const classified = classifyTelegramError({
      error_code: code,
      description,
      method: "sendMessage",
      message: `Call to 'sendMessage' failed! (${code}: ${description})`,
      parameters: code === 429 ? { retry_after: 12 } : {},
    });
    assert.equal(classified.kind, kind, description);
    assert.equal(classified.retryable, retryable, description);
    assert.equal(classified.errorCode, code);
    assert.equal(classified.method, "sendMessage");
    assert.equal(classified.safeMessage.includes(FAKE_TOKEN), false);
    assert.match(classified.safeMessage, new RegExp(`telegram ${kind}`));
  }
});

test("classifyTelegramError caps retry_after and treats network failures as retryable", () => {
  const rate = classifyTelegramError({
    error_code: 429,
    description: "Too Many Requests: retry after 999",
    method: "sendMessage",
    parameters: { retry_after: 999 },
  });
  assert.equal(rate.kind, "rate_limit");
  assert.equal(rate.retryAfterSeconds, MAX_RATE_LIMIT_WAIT_SECONDS);

  const network = classifyTelegramError(
    Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      name: "HttpError",
      error: new Error(`fetch failed talking to bot${FAKE_TOKEN}`),
    }),
  );
  assert.equal(network.kind, "network");
  assert.equal(network.retryable, true);
  assert.equal(network.safeMessage.includes(FAKE_TOKEN), false);
  assert.match(network.safeMessage, /REDACTED_BOT_TOKEN/);
});

test("createNotifier retries a single rate_limit then succeeds", async () => {
  let calls = 0;
  const fakeBot = {
    api: {
      sendMessage: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("rate limited");
          Object.assign(err, {
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            method: "sendMessage",
            parameters: { retry_after: 1 },
          });
          throw err;
        }
        return {};
      },
    },
  };

  const started = Date.now();
  await createNotifier(fakeBot, { chatId: "-1001234567890" })("hello");
  const elapsed = Date.now() - started;
  assert.equal(calls, 2);
  assert.ok(elapsed >= 900, `expected ~1s wait, got ${elapsed}ms`);
});

test("createNotifier rethrows the original non-rate-limit error", async () => {
  const error = new Error("Telegram API unavailable");
  const fakeBot = { api: { sendMessage: async () => Promise.reject(error) } };
  const notify = createNotifier(fakeBot, { chatId: "-1001234567890" });
  await assert.rejects(notify("message"), error);
});

test("classifyTelegramError never echoes an unbounded payload blob", () => {
  const huge = "PAYLOAD-" + "Z".repeat(10_000);
  const classified = classifyTelegramError({
    error_code: 400,
    description: huge,
    method: "sendMessage",
    payload: { text: huge },
  });
  assert.ok(classified.safeMessage.length < 250);
  assert.equal(classified.safeMessage.includes("Z".repeat(500)), false);
});
