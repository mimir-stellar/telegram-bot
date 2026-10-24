/**
 * Tests for safeErrorMessage(error, secrets) in dist/notifications/format.js.
 *
 * Coverage:
 *   - Error with a cause chain that embeds the bot token
 *   - AggregateError with multiple nested errors
 *   - A thrown string (non-Error value)
 *   - undefined thrown value
 *   - A 10 KB message that must be bounded
 *
 * Acceptance criteria for every case:
 *   - Output is a non-empty string (or empty string for the undefined case –
 *     the function falls back to "unknown error", so still non-empty)
 *   - No secret survives in the returned text
 *   - The returned text never exceeds 240 characters (the documented cap)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { safeErrorMessage } from "../dist/notifications/format.js";
import { clearSecrets, registerSecret } from "../dist/redact.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A syntactically valid Telegram bot token used as the secret under test. */
const BOT_TOKEN = "987654321:ABCDefghIJKLmnopQRSTuvwxYZ-_secret01";

/** Maximum length the function may return, per its documented contract. */
const MAX_LEN = 240;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert the universal postconditions that every case must satisfy. */
function assertSafe(output, secret, label) {
  assert.equal(typeof output, "string", `${label}: output must be a string`);
  assert.ok(output.length > 0, `${label}: output must not be empty`);
  assert.ok(
    output.length <= MAX_LEN,
    `${label}: output length ${output.length} exceeds cap of ${MAX_LEN}`,
  );
  if (secret) {
    assert.ok(
      !output.includes(secret),
      `${label}: secret must not survive in output — got: ${output}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

test("Error with cause chain containing the bot token is redacted", () => {
  // The cause carries the raw token; the outer message references it by name.
  const cause = new Error(`RPC call failed: token=${BOT_TOKEN}`);
  const error = new Error("upstream request rejected", { cause });

  const output = safeErrorMessage(error, [BOT_TOKEN]);

  assertSafe(output, BOT_TOKEN, "cause-chain");
  // The outer message itself is still meaningful after redaction.
  assert.ok(
    output.includes("upstream") || output.includes("rejected") || output.includes("REDACTED"),
    `cause-chain: expected outer message text or redaction marker, got: ${output}`,
  );
});

test("AggregateError with multiple nested errors is handled and bounded", () => {
  const child1 = new Error(`connection error with token ${BOT_TOKEN}`);
  const child2 = new Error("timeout after 30 s");
  const child3 = new Error("DNS lookup failed");
  const aggregate = new AggregateError(
    [child1, child2, child3],
    `3 errors occurred; token=${BOT_TOKEN}`,
  );

  const output = safeErrorMessage(aggregate, [BOT_TOKEN]);

  assertSafe(output, BOT_TOKEN, "aggregate-error");
  // AggregateError.message is the string passed as the second argument; the
  // function reads .message, so the outer description must appear or be
  // redacted — the important guarantee is that the token is gone.
  assert.ok(
    !output.includes(BOT_TOKEN),
    `aggregate-error: token must not appear in output, got: ${output}`,
  );
});

test("A thrown string value is returned bounded and redacted", () => {
  const thrownString = `Fatal: bot token ${BOT_TOKEN} exposed in config`;

  const output = safeErrorMessage(thrownString, [BOT_TOKEN]);

  assertSafe(output, BOT_TOKEN, "thrown-string");
  // The non-secret part of the message should survive.
  assert.ok(
    output.includes("Fatal") || output.includes("REDACTED") || output.includes("config"),
    `thrown-string: expected recognisable output, got: ${output}`,
  );
});

test("undefined thrown value produces a non-empty fallback string", () => {
  const output = safeErrorMessage(undefined, [BOT_TOKEN]);

  // describeError(undefined) returns ""; safeErrorMessage falls back to
  // "unknown error" when the collapsed string is empty.
  assert.equal(typeof output, "string", "undefined: output must be a string");
  assert.ok(output.length > 0, "undefined: must produce a non-empty fallback");
  assert.ok(
    output.length <= MAX_LEN,
    `undefined: output length ${output.length} exceeds cap of ${MAX_LEN}`,
  );
});

test("A 10 KB message is bounded to at most 240 characters", () => {
  // 10 240 characters — well above the 240-char cap.
  const longMessage = "x".repeat(10_240);
  const error = new Error(longMessage);

  const output = safeErrorMessage(error, []);

  assert.equal(typeof output, "string", "10kb: output must be a string");
  assert.ok(output.length > 0, "10kb: output must not be empty");
  assert.ok(
    output.length <= MAX_LEN,
    `10kb: output length ${output.length} exceeds cap of ${MAX_LEN}`,
  );
});

test("10 KB message that contains a secret is both bounded and redacted", () => {
  // Embed the token somewhere in the middle of a large blob.
  const prefix = "a".repeat(1_000);
  const suffix = "b".repeat(9_000);
  const longMessage = `${prefix}${BOT_TOKEN}${suffix}`;
  const error = new Error(longMessage);

  const output = safeErrorMessage(error, [BOT_TOKEN]);

  assertSafe(output, BOT_TOKEN, "10kb-with-secret");
  assert.ok(
    output.length <= MAX_LEN,
    `10kb-with-secret: output length ${output.length} exceeds cap of ${MAX_LEN}`,
  );
});

test("Secret registered globally via registerSecret is redacted without explicit secrets arg", () => {
  // Simulate a boot-time registration (the real index.ts calls registerSecret
  // for the bot token and chat ids).
  clearSecrets();
  registerSecret(BOT_TOKEN);

  try {
    const error = new Error(`Rejected request, auth=${BOT_TOKEN}`);
    // No secrets array passed — relies entirely on the global registry.
    const output = safeErrorMessage(error);

    assertSafe(output, BOT_TOKEN, "globally-registered-secret");
    assert.ok(
      !output.includes(BOT_TOKEN),
      `globally-registered-secret: token must not survive, got: ${output}`,
    );
  } finally {
    // Clean up so this case does not bleed into subsequent tests.
    clearSecrets();
  }
});

test("null thrown value produces a non-empty string within the cap", () => {
  const output = safeErrorMessage(null, [BOT_TOKEN]);

  assert.equal(typeof output, "string", "null: output must be a string");
  assert.ok(output.length > 0, "null: must produce a non-empty fallback");
  assert.ok(
    output.length <= MAX_LEN,
    `null: output length ${output.length} exceeds cap of ${MAX_LEN}`,
  );
});

test("Error whose message is exactly the secret collapses to a redaction marker", () => {
  const error = new Error(BOT_TOKEN);

  const output = safeErrorMessage(error, [BOT_TOKEN]);

  assert.equal(typeof output, "string", "message-is-secret: output must be a string");
  assert.ok(
    !output.includes(BOT_TOKEN),
    `message-is-secret: secret must not survive, got: ${output}`,
  );
  assert.ok(output.length > 0, "message-is-secret: output must not be empty");
  assert.ok(
    output.length <= MAX_LEN,
    `message-is-secret: output length ${output.length} exceeds cap of ${MAX_LEN}`,
  );
});
