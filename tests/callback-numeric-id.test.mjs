import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  CALLBACK_FALLBACK_FEEDBACK,
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  MAX_CALLBACK_NUMERIC_ID_DIGITS,
  MAX_CALLBACK_SAFE_INTEGER,
  contractsKeyboard,
  handleBroadcastCallback,
  handleCallbackQuery,
  isCanonicalCallbackNumericId,
  isValidBroadcastCallbackId,
  operatorKeyboard,
  statusKeyboard,
  validateCallbackData,
  validateCallbackNumericId,
  validatePauseConfirmData,
} from "../dist/bot.js";
import { broadcastKeyboard } from "../dist/commands/broadcast.js";

const FAKE_CRED = ["123456789:", "A".repeat(35)].join("");

function makeConfig(overrides = {}) {
  return {
    botToken: FAKE_CRED,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    ...overrides,
  };
}

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_700_000_000_000,
    cycles: 1,
    lastPollAt: 1_700_000_000_000,
    lastSuccessAt: 1_700_000_000_000,
    latestLedger: 1000,
    oldestLedger: 900,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

test("validateCallbackNumericId accepts canonical unsigned safe integers", () => {
  assert.equal(MAX_CALLBACK_NUMERIC_ID_DIGITS, 16);
  assert.equal(MAX_CALLBACK_SAFE_INTEGER, 9_007_199_254_740_991);

  const validStrings = ["0", "1", "42", "100000", "9007199254740991"];
  for (const input of validStrings) {
    const res = validateCallbackNumericId(input);
    assert.equal(res.ok, true, `expected "${input}" to be valid`);
    assert.equal(res.canonical, input);
    assert.equal(res.value, Number(input));
    assert.equal(isCanonicalCallbackNumericId(input), true);
  }

  const validNumbers = [0, 1, 42, 9_007_199_254_740_991];
  for (const num of validNumbers) {
    const res = validateCallbackNumericId(num);
    assert.equal(res.ok, true, `expected ${num} to be valid`);
    assert.equal(res.canonical, String(num));
    assert.equal(res.value, num);
  }
});

test("validateCallbackNumericId rejects leading signs, leading zeros, unsafe integers, and overlong IDs", () => {
  const leadingSigns = ["+0", "-0", "+1", "-1", "+42", "-9007199254740991", " +7", " -7", -1, -0, -42];
  for (const input of leadingSigns) {
    const res = validateCallbackNumericId(input);
    assert.equal(res.ok, false, `expected ${String(input)} to fail`);
    assert.equal(res.reason, "leading-sign");
  }

  const leadingZeros = ["00", "01", "007", "0000000000000001"];
  for (const input of leadingZeros) {
    const res = validateCallbackNumericId(input);
    assert.equal(res.ok, false, `expected "${input}" to fail`);
    assert.equal(res.reason, "leading-zero");
  }

  const unsafeIntegers = [
    "9007199254740992",
    "9007199254740993",
    "9999999999999999",
    9_007_199_254_740_992,
    1e20,
  ];
  for (const input of unsafeIntegers) {
    const res = validateCallbackNumericId(input);
    assert.equal(res.ok, false, `expected ${String(input)} to fail`);
    assert.equal(res.reason, "unsafe-integer");
  }

  const overlongDecimals = [
    "10000000000000000", // 17 digits
    "00000000000000001", // 17 digits with leading zeros
    "12345678901234567890", // 20 digits
    "9".repeat(32),
  ];
  for (const input of overlongDecimals) {
    const res = validateCallbackNumericId(input);
    assert.equal(res.ok, false, `expected "${input}" to fail`);
    assert.equal(res.reason, "overlong-decimal");
  }

  const nonDecimals = [
    "1.5",
    "1.0",
    "1e5",
    "1E5",
    "0x10",
    "0o77",
    "0b101",
    "1_000",
    "42abc",
    " 42",
    "42 ",
    "NaN",
    "Infinity",
    "١٢٣",
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const input of nonDecimals) {
    const res = validateCallbackNumericId(input);
    assert.equal(res.ok, false, `expected ${String(input)} to fail`);
    assert.equal(res.reason, "non-decimal");
  }
});

test("validateCallbackData rejects noncanonical numeric IDs in colon-delimited payloads", () => {
  const rejectedPayloads = [
    // Leading signs
    "status:+1",
    "status:-1",
    "status:+0",
    "status:-0",
    "mimir:status:-42",
    "contracts:+99",
    "broadcast:confirm:+12",
    "broadcast:cancel:-12",
    // Leading zeros
    "status:00",
    "status:01",
    "mimir:contracts:007",
    "broadcast:confirm:0001",
    // Unsafe 53-bit integers (16 digits > 9007199254740991)
    "status:9007199254740992",
    "mimir:status:9007199254740999",
    "broadcast:confirm:9007199254740992",
    "broadcast:cancel:9999999999999999",
    // Overlong decimal IDs (>= 17 digits)
    "status:10000000000000000",
    "mimir:help:12345678901234567890",
    "broadcast:confirm:1234567890123456789012345",
    // Alternate / partial numeric forms
    "status:1e5",
    "status:1E5",
    "status:0x10",
    "status:0o77",
    "status:0b101",
    "status:1.5",
    "status:1_000",
    "status:123abc",
    "status:NaN",
    "status:Infinity",
    "status: 42",
    "status:42 ",
    "status:",
  ];

  for (const raw of rejectedPayloads) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, false, `Expected "${raw}" to be rejected`);
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData rejects noncanonical numeric IDs in JSON payloads including precision-loss traps", () => {
  const rejectedJsonPayloads = [
    '{"action":"status","id":"+1"}',
    '{"action":"status","id":"-1"}',
    '{"action":"status","id":-1}',
    '{"action":"status","id":-0}',
    '{"action":"status","id":+1}',
    '{"action":"status","id":"007"}',
    '{"action":"status","id":01}',
    '{"action":"status","id":9007199254740992}',
    '{"action":"status","id":9007199254740993}', // IEEE-754 rounding trap
    '{"action":"status","id":"9007199254740992"}',
    '{"action":"status","id":12345678901234567890}',
    '{"action":"status","id":"12345678901234567890"}',
    '{"action":"status","id":1e5}',
    '{"action":"status","id":1.0}',
    '{"action":"status","page":"01"}',
    '{"action":"broadcast","id":"+42"}',
    '{"action":"broadcast","id":"999999999999999999"}',
  ];

  for (const raw of rejectedJsonPayloads) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, false, `Expected JSON payload ${raw} to be rejected`);
    assert.equal(res.reason, "noncanonical-numeric-id");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

test("validateCallbackData and keyboards preserve all existing valid callback payloads", () => {
  const store = new BroadcastStore();
  const pending = store.create("42", "Maintenance check", ["-1001234567890"]);

  const validPayloads = [
    "status",
    "contracts",
    "help",
    "pause",
    "resume",
    "status:refresh",
    "status:view",
    "mimir:status",
    "contracts:view",
    "mimir:contracts",
    "help:view",
    "mimir:help",
    "pause:toggle",
    "mimir:pause",
    "resume:now",
    "mimir:resume",
    "status:0",
    "status:42",
    "mimir:status:9007199254740991",
    `broadcast:confirm:${pending.id}`,
    `broadcast:cancel:${pending.id}`,
    "broadcast:confirm:42",
    "broadcast:cancel:0",
    '{"action":"status"}',
    '{"action":"status","id":0}',
    '{"action":"status","id":42}',
    '{"action":"status","id":"42"}',
    '{"action":"status","id":9007199254740991}',
    '{"action":"status","sub":"refresh"}',
    `{"action":"broadcast","id":"${pending.id}"}`,
  ];

  for (const raw of validPayloads) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, true, `Expected valid payload "${raw}" to pass`);
  }

  // Verify every keyboard builder's callback_data passes validation
  const config = makeConfig();
  const keyboards = [
    statusKeyboard(config),
    contractsKeyboard(),
    operatorKeyboard(),
    broadcastKeyboard(pending.id),
  ];
  for (const kb of keyboards) {
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        const res = validateCallbackData(btn.callback_data);
        assert.equal(res.ok, true, `Button payload "${btn.callback_data}" must stay valid`);
      }
    }
  }

  // Pause-confirm payloads stay owned by validatePauseConfirmData
  assert.equal(validatePauseConfirmData(CALLBACK_PAUSE_CONFIRM), CALLBACK_PAUSE_CONFIRM);
  assert.equal(validatePauseConfirmData(CALLBACK_PAUSE_CANCEL), CALLBACK_PAUSE_CANCEL);
});

test("handleCallbackQuery and handleBroadcastCallback block noncanonical numeric IDs without mutating state", async () => {
  const config = makeConfig();
  const store = new BroadcastStore();
  let statusCalls = 0;

  const callbackAnswers = [];
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    await handleCallbackQuery(
      {
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        update: { update_id: 501 },
        callbackQuery: {
          id: "cb_bad_num",
          data: "status:+42",
          message: { message_id: 10 },
        },
        answerCallbackQuery: async (opts) => callbackAnswers.push(opts),
      },
      {
        config,
        status: () => {
          statusCalls += 1;
          return makeStatus();
        },
        pause: () => "paused",
        resume: () => "resumed",
        broadcastStore: store,
      },
    );
  } finally {
    console.warn = origWarn;
  }

  assert.equal(statusCalls, 0, "status() must not run for noncanonical numeric callback ID");
  assert.equal(callbackAnswers.length, 1);
  assert.equal(callbackAnswers[0].text, CALLBACK_FALLBACK_FEEDBACK);

  // Direct handleBroadcastCallback defense-in-depth check
  assert.equal(isValidBroadcastCallbackId("+42"), false);
  assert.equal(isValidBroadcastCallbackId("-1"), false);
  assert.equal(isValidBroadcastCallbackId("007"), false);
  assert.equal(isValidBroadcastCallbackId("9007199254740992"), false);
  assert.equal(isValidBroadcastCallbackId("12345678901234567890"), false);
  assert.equal(isValidBroadcastCallbackId("42"), true);

  const directBroadcastAnswers = [];
  await handleBroadcastCallback(
    {
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      update: { update_id: 502 },
      callbackQuery: {
        id: "cb_bad_bc",
        data: "broadcast:confirm:9007199254740992",
        message: { message_id: 11 },
      },
      answerCallbackQuery: async (opts) => directBroadcastAnswers.push(opts),
    },
    {
      config,
      status: makeStatus,
      pause: () => "paused",
      resume: () => "resumed",
      broadcastStore: store,
    },
    "broadcast:confirm:9007199254740992",
  );

  assert.equal(directBroadcastAnswers.length, 1);
  assert.equal(directBroadcastAnswers[0].text, "Invalid broadcast action");
});
