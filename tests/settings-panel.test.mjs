import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CALLBACK_FALLBACK_FEEDBACK,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
  canAccessSettings,
  createBot,
  handleCallbackQuery,
  healthMessage,
  settingsKeyboard,
  settingsMessage,
  validateCallbackData,
} from "../dist/bot.js";
import {
  clearFlagOverrides,
  getEffectiveFeatureFlags,
  getFlagOverrides,
  isNotificationAllowed,
  setFlagOverride,
  setPersistencePath,
} from "../dist/notifications/featureFlags.js";
import { buildHealthReport } from "../dist/health.js";

const OPERATOR_ID = "42";

function fakeConfig(overrides = {}) {
  return {
    botToken: "123456789:SECRET-BOT-TOKEN-TEST",
    chatId: "-1001234567890",
    operatorTelegramUserId: OPERATOR_ID,
    featureFlags: {
      enabled: true,
      market: true,
      squad: true,
    },
    ...overrides,
  };
}

function fakeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1000,
    cycles: 1,
    lastPollAt: 1500,
    lastSuccessAt: 1500,
    latestLedger: 500,
    oldestLedger: 400,
    notificationsSent: 1,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

test.beforeEach(() => {
  setPersistencePath(null);
  clearFlagOverrides();
});

test.afterEach(() => {
  setPersistencePath(null);
  clearFlagOverrides();
});

// ── 1. canAccessSettings Authorization & Chat Type ───────────────────────────

test("canAccessSettings requires operator id and private chat", () => {
  const config = fakeConfig({ operatorTelegramUserId: OPERATOR_ID });

  // Operator in private chat -> allowed
  assert.equal(
    canAccessSettings(
      { from: { id: 42 }, chat: { type: "private" } },
      config,
    ),
    true,
  );

  // Operator in supergroup chat -> denied
  assert.equal(
    canAccessSettings(
      { from: { id: 42 }, chat: { type: "supergroup" } },
      config,
    ),
    false,
  );

  // Non-operator in private chat -> denied
  assert.equal(
    canAccessSettings(
      { from: { id: 999 }, chat: { type: "private" } },
      config,
    ),
    false,
  );

  // No operator configured -> denied
  assert.equal(
    canAccessSettings(
      { from: { id: 42 }, chat: { type: "private" } },
      fakeConfig({ operatorTelegramUserId: null }),
    ),
    false,
  );
});

// ── 2. Callback Data Validation for set::<0|1> ──────────────────────────────

test("validateCallbackData validates compact set::<0|1> actions", () => {
  const validCases = [
    ["set:enabled:0", "enabled", 0],
    ["set:enabled:1", "enabled", 1],
    ["set:market:0", "market", 0],
    ["set:market:1", "market", 1],
    ["set:squad:0", "squad", 0],
    ["set:squad:1", "squad", 1],
  ];

  for (const [raw, expectedFlag, expectedVal] of validCases) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, true, `${raw} should be valid`);
    assert.equal(res.action.type, "set");
    assert.equal(res.action.flag, expectedFlag);
    assert.equal(res.action.value, expectedVal);
    assert.equal(res.action.raw, raw);
  }

  const invalidCases = [
    "set:unknown:0",
    "set:enabled:2",
    "set:enabled:-1",
    "set:enabled:true",
    "set:market",
    "set::1",
    "set:squad:0:extra",
  ];

  for (const raw of invalidCases) {
    const res = validateCallbackData(raw);
    assert.equal(res.ok, false, `${raw} should be invalid`);
    assert.equal(res.reason, "invalid-set-format");
    assert.equal(res.fallbackText, CALLBACK_FALLBACK_FEEDBACK);
  }
});

// ── 3. Toggling Overrides & isNotificationAllowed Reflection ─────────────────

test("toggling overrides updates getFlagOverrides and isNotificationAllowed", () => {
  const baseFlags = { enabled: true, market: true, squad: true };

  assert.equal(isNotificationAllowed(baseFlags, "market"), true);
  assert.equal(isNotificationAllowed(baseFlags, "squad"), true);

  // Disable market
  setFlagOverride("market", false);
  assert.deepEqual(getFlagOverrides(), { market: false });
  assert.equal(isNotificationAllowed(baseFlags, "market"), false);
  assert.equal(isNotificationAllowed(baseFlags, "squad"), true);

  // Disable master switch
  setFlagOverride("enabled", false);
  assert.deepEqual(getFlagOverrides(), { market: false, enabled: false });
  assert.equal(isNotificationAllowed(baseFlags, "market"), false);
  assert.equal(isNotificationAllowed(baseFlags, "squad"), false);

  // Re-enable master switch
  setFlagOverride("enabled", true);
  assert.equal(isNotificationAllowed(baseFlags, "market"), false);
  assert.equal(isNotificationAllowed(baseFlags, "squad"), true);

  // Clear overrides returns to base env values
  clearFlagOverrides();
  assert.deepEqual(getFlagOverrides(), {});
  assert.equal(isNotificationAllowed(baseFlags, "market"), true);
  assert.equal(isNotificationAllowed(baseFlags, "squad"), true);
});

// ── 4. Operator Settings Panel Rendering & Keyboard ──────────────────────────

test("settingsMessage and settingsKeyboard reflect current overrides", () => {
  const config = fakeConfig();
  const initialMsg = settingsMessage(config);
  assert.match(initialMsg, /Operator Settings — Notification Flags/);
  assert.match(initialMsg, /No active overrides/);

  const kbInitial = settingsKeyboard(getEffectiveFeatureFlags(config.featureFlags));
  // Buttons should offer toggle to 0 when currently true
  const buttonsInitial = kbInitial.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttonsInitial.includes("set:enabled:0"));
  assert.ok(buttonsInitial.includes("set:market:0"));
  assert.ok(buttonsInitial.includes("set:squad:0"));

  // Apply override
  setFlagOverride("market", false);
  const updatedMsg = settingsMessage(config);
  assert.match(updatedMsg, /Active overrides/);
  assert.match(updatedMsg, /market=false/);

  const kbUpdated = settingsKeyboard(getEffectiveFeatureFlags(config.featureFlags));
  const buttonsUpdated = kbUpdated.inline_keyboard.flat().map((b) => b.callback_data);
  // Market button should now offer to toggle to 1
  assert.ok(buttonsUpdated.includes("set:market:1"));
  assert.ok(buttonsUpdated.includes("set:enabled:0"));
  assert.ok(buttonsUpdated.includes("set:squad:0"));
});

// ── 5. Health Output Visibility ──────────────────────────────────────────────

test("health report and message surface featureFlagOverrides", () => {
  const config = fakeConfig();
  const status = fakeStatus();

  // No overrides initially
  const reportClean = buildHealthReport(config, status, 2000);
  assert.deepEqual(reportClean.featureFlagOverrides, {});
  assert.equal(healthMessage(config, status).includes("Feature flag overrides:"), false);

  // Set override
  setFlagOverride("squad", false);
  const reportOverridden = buildHealthReport(config, status, 2000);
  assert.deepEqual(reportOverridden.featureFlagOverrides, { squad: false });
  assert.equal(reportOverridden.featureFlags?.squad, false);

  const msg = healthMessage(config, status);
  assert.match(msg, /Feature flag overrides: `squad=false`/);
});

// ── 6. Callback Handling: Authorization & Execution ──────────────────────────

test("handleCallbackQuery authorizes operator for set actions", async () => {
  const config = fakeConfig({ operatorTelegramUserId: OPERATOR_ID });
  const answers = [];
  const edits = [];

  const fakeCtx = (userId, data) => ({
    update: { update_id: 1 },
    from: { id: userId, is_bot: false },
    callbackQuery: {
      id: "cb_1",
      data,
      message: { message_id: 10, chat: { id: 12345 } },
    },
    answerCallbackQuery: async (params) => {
      answers.push(params);
    },
    editMessageText: async (text, options) => {
      edits.push({ text, options });
    },
  });

  // Non-operator tries to toggle
  await handleCallbackQuery(fakeCtx(999, "set:market:0"), {
    config,
    status: fakeStatus,
    pause: () => "paused",
    resume: () => "resumed",
  });

  assert.equal(answers.length, 1);
  assert.equal(answers[0].text, CALLBACK_UNAUTHORIZED_FEEDBACK);
  assert.equal(answers[0].show_alert, true);
  assert.equal(edits.length, 0);
  assert.deepEqual(getFlagOverrides(), {});

  // Operator toggles
  answers.length = 0;
  await handleCallbackQuery(fakeCtx(42, "set:market:0"), {
    config,
    status: fakeStatus,
    pause: () => "paused",
    resume: () => "resumed",
  });

  assert.equal(answers.length, 1);
  assert.equal(answers[0].text, "market set to OFF");
  assert.equal(edits.length, 1);
  assert.deepEqual(getFlagOverrides(), { market: false });
});

// ── 7. Optional Persistence to JSON File & Restart Behavior ──────────────────

test("persistence saves overrides to JSON file and restores on load", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mimir-settings-test-"));
  const persistFile = path.join(tmpDir, "settings.json");

  try {
    setPersistencePath(persistFile);

    // Initial state: file does not exist
    assert.equal(fs.existsSync(persistFile), false);

    // Set overrides
    setFlagOverride("enabled", false);
    setFlagOverride("squad", false);

    assert.equal(fs.existsSync(persistFile), true);
    const content = JSON.parse(fs.readFileSync(persistFile, "utf8"));
    assert.deepEqual(content, { enabled: false, squad: false });

    // Simulate clean restart without persistence: returns to env values
    setPersistencePath(null);
    clearFlagOverrides();
    assert.deepEqual(getFlagOverrides(), {});

    // Simulate restart with persistence: restores values from JSON file
    setPersistencePath(persistFile);
    assert.deepEqual(getFlagOverrides(), { enabled: false, squad: false });

    // Clearing overrides removes file
    clearFlagOverrides();
    assert.deepEqual(getFlagOverrides(), {});
    assert.equal(fs.existsSync(persistFile), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
