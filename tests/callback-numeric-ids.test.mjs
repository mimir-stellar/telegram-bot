/**
 * Tests for rejecting noncanonical callback numeric identifiers.
 *
 * Covers:
 *   - isCanonicalNumericId: canonical decimal IDs, boundary checks (0, MAX_SAFE_INTEGER)
 *   - isNoncanonicalNumericId: disallowing leading signs, unsafe integers, overlong decimal IDs
 *   - validateCallbackData: rejection of noncanonical IDs in colon-delimited, JSON, and direct forms
 *   - Preservation of existing valid callback payloads (status, broadcast with base36 store ID, pause, etc.)
 *   - handleBroadcastCallback: rejection of noncanonical broadcast confirmation IDs
 *   - BroadcastStore: defensive handling of noncanonical IDs in get and delete
 *   - broadcastKeyboard: throws when attempting to create keyboard with noncanonical ID
 *   - Integration via handleCallbackQuery: operator-authorized update dispatch rejecting noncanonical queries
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_FALLBACK_FEEDBACK,
  CALLBACK_FALLBACK_PAYLOAD,
  handleCallbackQuery,
  isCanonicalNumericId,
  isNoncanonicalNumericId,
  MAX_CANONICAL_NUMERIC_DIGITS,
  validateCallbackData,
} from "../dist/bot.js";
import {
  broadcastKeyboard,
  BroadcastStore,
  handleBroadcastCallback,
} from "../dist/commands/broadcast.js";

// ── Test Helpers ─────────────────────────────────────────────────────────────

function fakeConfig(overrides = {}) {
  return {
    botToken: "TEST_TOKEN_123456789:ABCDEF",
    chatId: "-100111",
    chatIds: ["-100111"],
    operatorTelegramUserId: "42",
    interSendDelayMs: 0,
    ...overrides,
  };
}

function createFakeApi() {
  const sent = [];
  const edits = [];
  const answeredCallbacks = [];

  const api = {
    sent,
    edits,
    answeredCallbacks,
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId: String(chatId), text, options });
      return { message_id: sent.length };
    },
    editMessageText: async (text, options) => {
      edits.push({ text, options });
      return true;
    },
    answerCallbackQuery: async (options) => {
      answeredCallbacks.push(options);
      return true;
    },
  };
  return api;
}

// ── 1. Unit Tests: isCanonicalNumericId ───────────────────────────────────────

test("isCanonicalNumericId accepts canonical non-negative decimal identifiers", () => {
  const validCases = [
    "0",
    "1",
    "42",
    "100",
    "999999",
    "1234567890",
    String(Number.MAX_SAFE_INTEGER), // "9007199254740991" (16 digits)
    0,
    42,
    Number.MAX_SAFE_INTEGER,
    0n,
    42n,
    BigInt(Number.MAX_SAFE_INTEGER),
  ];

  for (const c of validCases) {
    assert.equal(isCanonicalNumericId(c), true, `Expected ${c} to be a canonical numeric ID`);
  }
});

test("isCanonicalNumericId rejects noncanonical, signed, or unsafe numeric values", () => {
  const invalidCases = [
    // Leading signs
    "+0",
    "-0",
    "+1",
    "-1",
    "+42",
    "-42",
    "+12345",
    "-12345",
    "+9007199254740991",
    -0,
    -1,
    -42,
    -1n,
    // Redundant leading zeros (overlong decimal IDs)
    "00",
    "01",
    "000",
    "007",
    "0123",
    "0000000000000042",
    // Unsafe integers (exceeding Number.MAX_SAFE_INTEGER = 9007199254740991)
    "9007199254740992", // 2^53 (boundary failure case)
    "9007199254740993",
    9007199254740992,
    9007199254740992n,
    // Overlong decimal strings (> 16 digits)
    "10000000000000000", // 17 digits
    "99999999999999999999999999999999",
    // Non-decimal, floating point, scientific notation, hex
    "1.5",
    "1e5",
    "1E10",
    "0x10",
    "0o77",
    "0b101",
    1.5,
    NaN,
    Infinity,
    -Infinity,
    // Non-numeric strings
    "abc",
    "refresh",
    "",
    null,
    undefined,
  ];

  for (const c of invalidCases) {
    assert.equal(isCanonicalNumericId(c), false, `Expected ${String(c)} NOT to be a canonical numeric ID`);
  }
});

// ── 2. Unit Tests: isNoncanonicalNumericId ───────────────────────────────────

test("isNoncanonicalNumericId detects leading signs, unsafe integers, and overlong decimal IDs", () => {
  const noncanonicalCases = [
    // Leading signs
    "+123",
    "-123",
    "+0",
    "-0",
    "+42",
    "-42",
    "+1",
    "-1",
    -1,
    -42,
    -0,
    -1n,
    // Redundant leading zeros (overlong decimal IDs)
    "00",
    "01",
    "000",
    "007",
    "0123",
    "0000000000000042",
    // Unsafe integers (> Number.MAX_SAFE_INTEGER)
    "9007199254740992", // 2^53 boundary failure
    "9007199254740993",
    9007199254740992,
    9007199254740992n,
    // Overlong decimal strings (> 16 digits)
    "10000000000000000",
    "99999999999999999999999999999999",
    // Non-decimal notations
    "1e5",
    "1E10",
    "1.5",
    "0x10",
    "0o77",
    "0b101",
    1.5,
  ];

  for (const c of noncanonicalCases) {
    assert.equal(isNoncanonicalNumericId(c), true, `Expected ${String(c)} to be recognized as noncanonical`);
  }
});

test("isNoncanonicalNumericId preserves canonical numeric IDs and valid non-numeric payloads", () => {
  const preservedCases = [
    // Canonical decimal numeric IDs
    "0",
    "1",
    "42",
    "123",
    "9007199254740991",
    0,
    42,
    Number.MAX_SAFE_INTEGER,
    0n,
    42n,
    // Existing valid non-numeric callback payloads
    "refresh",
    "view",
    "toggle",
    "now",
    "status",
    "contracts",
    "help",
    "pause",
    "resume",
    "confirm",
    "cancel",
    // Standard BroadcastStore IDs (base36 + timestamp + counter + random)
    "lx9abc_1_def",
    "mwo73wiy_1_3a8b",
  ];

  for (const c of preservedCases) {
    assert.equal(isNoncanonicalNumericId(c), false, `Expected ${String(c)} NOT to be flagged as noncanonical`);
  }
});

// ── 3. validateCallbackData Tests ───────────────────────────────────────────

test("validateCallbackData rejects noncanonical numeric identifiers in colon-delimited callbacks", () => {
  const rejected = [
    // Leading signs
    "broadcast:confirm:+123",
    "broadcast:confirm:-123",
    "broadcast:confirm:+0",
    "broadcast:confirm:-0",
    "broadcast:cancel:+42",
    "broadcast:cancel:-42",
    "status:+1",
    "status:-1",
    "mimir:status:+1",
    "mimir:status:-1",
    "pause:+1",
    "resume:-1",
    "help:+1",
    "contracts:-1",
    // Redundant leading zeros (overlong decimal IDs)
    "broadcast:confirm:0123",
    "broadcast:confirm:00",
    "broadcast:confirm:007",
    "status:01",
    "mimir:status:001",
    "contracts:001",
    // Unsafe integers (> Number.MAX_SAFE_INTEGER = 9007199254740991)
    "broadcast:confirm:9007199254740992",
    "broadcast:cancel:9007199254740992",
    "status:9007199254740992",
    "mimir:status:9007199254740992",
    // Overlong decimal strings (> 16 digits)
    "broadcast:confirm:99999999999999999999999999999",
    "status:99999999999999999999999999999",
    // Non-decimal notations
    "broadcast:confirm:1e5",
    "broadcast:confirm:0x10",
    "broadcast:confirm:1.5",
  ];

  for (const raw of rejected) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, false, `Raw payload "${raw}" should be rejected`);
    assert.equal(res.reason, "noncanonical-numeric-id");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData rejects top-level noncanonical numeric identifiers", () => {
  const rejected = [
    "+123",
    "-123",
    "+0",
    "-0",
    "00",
    "01",
    "0123",
    "9007199254740992",
    "99999999999999999999999999999",
    "1e5",
    "0x10",
  ];

  for (const raw of rejected) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "noncanonical-numeric-id");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData rejects JSON callbacks containing noncanonical numeric fields", () => {
  const rejected = [
    JSON.stringify({ action: "broadcast", id: "+123" }),
    JSON.stringify({ action: "broadcast", id: "-123" }),
    JSON.stringify({ action: "broadcast", id: -5 }),
    JSON.stringify({ action: "broadcast", id: "0123" }),
    JSON.stringify({ action: "broadcast", id: "00" }),
    JSON.stringify({ action: "broadcast", id: 9007199254740992 }),
    JSON.stringify({ action: "broadcast", id: "9007199254740992" }),
    JSON.stringify({ action: "broadcast", id: "99999999999999999999999999999" }),
    JSON.stringify({ action: "status", page: "+1" }),
    JSON.stringify({ action: "status", page: -1 }),
    JSON.stringify({ action: "status", nested: { id: "+42" } }),
  ];

  for (const raw of rejected) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, false, `JSON payload "${raw}" should be rejected`);
    assert.equal(res.reason, "noncanonical-numeric-id");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData preserves existing valid callback payloads", () => {
  const validCases = [
    // Direct canonical action tokens
    ["status", "status"],
    ["contracts", "contracts"],
    ["help", "help"],
    ["pause", "pause"],
    ["resume", "resume"],
    // Colon-delimited actions
    ["status:refresh", "status"],
    ["status:view", "status"],
    ["mimir:status", "status"],
    ["contracts:view", "contracts"],
    ["mimir:contracts", "contracts"],
    ["help:view", "help"],
    ["mimir:help", "help"],
    ["pause:toggle", "pause"],
    ["mimir:pause", "pause"],
    ["resume:now", "resume"],
    ["mimir:resume", "resume"],
    // Broadcast with canonical decimal numeric ID
    ["broadcast:confirm:42", "broadcast"],
    ["broadcast:confirm:0", "broadcast"],
    ["broadcast:confirm:9007199254740991", "broadcast"],
    ["broadcast:cancel:42", "broadcast"],
    ["broadcast:cancel:0", "broadcast"],
    // Broadcast with standard alphanumeric BroadcastStore ID
    ["broadcast:confirm:lx9abc_1_def", "broadcast"],
    ["broadcast:cancel:lx9abc_1_def", "broadcast"],
    ["broadcast:confirm:mwo73wiy_1_3a8b", "broadcast"],
    // Valid JSON actions
    [JSON.stringify({ action: "status" }), "status"],
    [JSON.stringify({ action: "pause" }), "pause"],
    [JSON.stringify({ action: "broadcast", id: 42 }), "broadcast"],
    [JSON.stringify({ action: "broadcast", id: "42" }), "broadcast"],
    [JSON.stringify({ action: "broadcast", id: "lx9abc_1_def" }), "broadcast"],
  ];

  for (const [raw, expectedType] of validCases) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, true, `Payload "${raw}" should be valid`);
    assert.equal(res.action.type, expectedType);
  }
});

// ── 4. handleBroadcastCallback Tests ─────────────────────────────────────────

test("handleBroadcastCallback rejects noncanonical numeric broadcast IDs", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  const api = createFakeApi();

  const noncanonicalIds = [
    "+123",
    "-123",
    "+0",
    "-0",
    "0123",
    "00",
    "9007199254740992",
    "99999999999999999999999999999",
    "1e5",
    "0x10",
  ];

  for (const id of noncanonicalIds) {
    api.answeredCallbacks.length = 0;
    const ctx = {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 200 },
      api,
      callbackQuery: {
        id: `cb_${id}`,
        data: `broadcast:confirm:${id}`,
        message: { message_id: 100 },
      },
      answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
    };

    await handleBroadcastCallback(
      ctx,
      { config, broadcastStore: store },
      `broadcast:confirm:${id}`,
    );

    assert.equal(api.sent.length, 0, `Must not send any broadcast for noncanonical ID "${id}"`);
    assert.equal(api.answeredCallbacks.length, 1);
    assert.equal(api.answeredCallbacks[0].text, "Invalid broadcast action");
  }
});

test("handleBroadcastCallback accepts canonical decimal numeric broadcast IDs", async () => {
  const config = fakeConfig({ interSendDelayMs: 0 });
  const store = new BroadcastStore();
  // Manually insert pending broadcast with canonical numeric ID "42"
  const pending = {
    id: "42",
    operatorId: "42",
    message: "Canonical numeric ID test",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    chats: ["-100111"],
    confirmed: false,
  };
  store["items"].set("42", pending);

  const api = createFakeApi();
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 201 },
    api,
    callbackQuery: {
      id: "cb_confirm_42",
      data: "broadcast:confirm:42",
      message: { message_id: 100 },
    },
    editMessageText: async () => true,
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    "broadcast:confirm:42",
  );

  assert.equal(api.sent.length, 1, "Should send broadcast for canonical ID 42");
  assert.equal(api.sent[0].text, "Canonical numeric ID test");
});

test("handleBroadcastCallback accepts canonical cancellation with decimal numeric ID", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  const pending = {
    id: "100",
    operatorId: "42",
    message: "Cancel test",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    chats: ["-100111"],
    confirmed: false,
  };
  store["items"].set("100", pending);

  const api = createFakeApi();
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 202 },
    api,
    callbackQuery: {
      id: "cb_cancel_100",
      data: "broadcast:cancel:100",
      message: { message_id: 100 },
    },
    editMessageText: async () => true,
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    "broadcast:cancel:100",
  );

  assert.equal(store.get("100"), undefined, "Pending broadcast should be deleted from store");
  assert.equal(api.answeredCallbacks.some((a) => a.text === "Broadcast cancelled"), true);
});

// ── 5. BroadcastStore Defensive Checks ───────────────────────────────────────

test("BroadcastStore get and delete safely reject noncanonical numeric IDs", () => {
  const store = new BroadcastStore();
  const noncanonicalIds = ["+42", "-42", "0123", "9007199254740992", "99999999999999999999999999999"];

  for (const id of noncanonicalIds) {
    assert.equal(store.get(id), undefined);
    assert.equal(store.delete(id), false);
  }
});

// ── 6. broadcastKeyboard Validation ─────────────────────────────────────────

test("broadcastKeyboard throws Error on noncanonical numeric IDs", () => {
  const invalidIds = ["+123", "-5", "007", "9007199254740992", "99999999999999999999999999999"];
  for (const id of invalidIds) {
    assert.throws(
      () => broadcastKeyboard(id),
      /noncanonical numeric identifier/i,
      `broadcastKeyboard should throw for "${id}"`,
    );
  }

  // Canonical and alphanumeric IDs succeed
  assert.doesNotThrow(() => broadcastKeyboard("42"));
  assert.doesNotThrow(() => broadcastKeyboard("0"));
  assert.doesNotThrow(() => broadcastKeyboard("lx9abc_1_def"));
});

// ── 7. Integration: handleCallbackQuery with Noncanonical Query ──────────────

test("handleCallbackQuery rejects noncanonical numeric callback query at ingress", async () => {
  const config = fakeConfig();
  const api = createFakeApi();
  let pauseCalled = false;

  const deps = {
    config,
    status: () => ({}),
    pause: () => {
      pauseCalled = true;
      return "paused";
    },
    resume: () => "resumed",
  };

  const noncanonicalQueries = [
    "broadcast:confirm:+123",
    "broadcast:confirm:0123",
    "status:+1",
    "pause:-1",
  ];

  for (const data of noncanonicalQueries) {
    api.answeredCallbacks.length = 0;
    const ctx = {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 300 },
      callbackQuery: {
        id: "cq_noncanonical",
        data,
      },
      answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
    };

    await handleCallbackQuery(ctx, deps);

    assert.equal(pauseCalled, false, "pause() should not be called on invalid callback");
    assert.equal(api.sent.length, 0, "No messages sent on invalid callback");
    assert.equal(api.answeredCallbacks.length, 1);
    assert.equal(api.answeredCallbacks[0].text, CALLBACK_FALLBACK_FEEDBACK);
  }
});
