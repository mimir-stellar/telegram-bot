/**
 * Focused tests for command availability reporting and public-menu filtering
 * when optional runtime dependencies are absent or disabled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  commandAvailabilityReport,
  defineCommand,
  formatCommandAvailabilityReport,
  visibleCommandMetadata,
} from "../dist/commands/registry.js";
import "../dist/commands/log-export.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    ...overrides,
  };
}

function fakeLogs(capacity) {
  return {
    capacity: () => capacity,
    lines: () => [],
    push: () => undefined,
  };
}

// Register an advertised command backed by an optional data source (`audit`)
// using an existing COMMAND_DESCRIPTIONS key ("audit") so menu metadata works
// without mutating i18n tables.
defineCommand({
  command: "audit",
  operatorOnly: true,
  availability: (deps) => {
    if (!deps?.audit) {
      return {
        available: false,
        reason: "Audit log is not attached in this runtime.",
      };
    }
    return { available: true };
  },
  handler: async () => undefined,
});

// Register a command that omits its reason when unavailable to test the fallback.
defineCommand({
  command: "test-empty-reason",
  hidden: true,
  availability: (deps) => ({
    available: Boolean(deps?.broadcastStore),
    reason: "   ",
  }),
  handler: async () => undefined,
});

test("reports why /export is disabled when logs are absent or have zero capacity", () => {
  const withoutLogs = commandAvailabilityReport({ config: baseConfig() });
  const exportAbsent = withoutLogs.unavailable.find((entry) => entry.command === "export");
  assert.ok(exportAbsent, "/export should be listed as unavailable when logs are absent");
  assert.equal(exportAbsent.available, false);
  assert.match(exportAbsent.reason ?? "", /LOG_BUFFER_LINES=0|log buffer/i);

  const zeroCap = commandAvailabilityReport({ config: baseConfig(), logs: fakeLogs(0) });
  const exportZero = zeroCap.unavailable.find((entry) => entry.command === "export");
  assert.ok(exportZero, "/export should be unavailable when log buffer capacity is 0");
  assert.equal(exportZero.available, false);

  const withLogs = commandAvailabilityReport({ config: baseConfig(), logs: fakeLogs(50) });
  const exportReady = withLogs.available.find((entry) => entry.command === "export");
  assert.ok(exportReady, "/export should be available when log buffer capacity > 0");
  assert.equal(exportReady.available, true);
  assert.equal(exportReady.reason, undefined);
});

test("reports operator-only commands as unavailable when no operator is configured", () => {
  const report = commandAvailabilityReport({
    config: baseConfig({ operatorTelegramUserId: null }),
    logs: fakeLogs(50),
  });
  const exportEntry = report.unavailable.find((entry) => entry.command === "export");
  assert.ok(exportEntry);
  assert.match(exportEntry.reason ?? "", /OPERATOR_TELEGRAM_USER_ID/);
});

test("falls back to a default reason when an availability check omits one", () => {
  const report = commandAvailabilityReport({ config: baseConfig() });
  const entry = report.unavailable.find((e) => e.command === "test-empty-reason");
  assert.ok(entry);
  assert.equal(entry.available, false);
  assert.equal(entry.reason, "Required runtime dependency is not configured.");
});

test("visibleCommandMetadata keeps unavailable commands out of the public menu when deps are provided", () => {
  const config = baseConfig();

  const withoutAudit = visibleCommandMetadata(config, { logs: fakeLogs(10) });
  assert.equal(
    withoutAudit.some((item) => item.command === "audit"),
    false,
    "unavailable /audit must not appear in the public menu",
  );

  const withAudit = visibleCommandMetadata(config, {
    logs: fakeLogs(10),
    audit: { tail: () => [] },
  });
  assert.equal(
    withAudit.some((item) => item.command === "audit"),
    true,
    "available /audit should appear in the public menu",
  );

  // Backward compatibility: omitting deps preserves existing 1-arg behavior.
  const legacy = visibleCommandMetadata(config);
  assert.equal(
    legacy.some((item) => item.command === "audit"),
    true,
    "1-arg visibleCommandMetadata(config) remains backward compatible",
  );
});

test("formatCommandAvailabilityReport summarizes available and disabled commands with reasons", () => {
  const report = commandAvailabilityReport({ config: baseConfig() });
  const text = formatCommandAvailabilityReport(report);
  assert.match(text, /Command availability: \d+ available, \d+ disabled/);
  assert.match(text, /Disabled:/);
  assert.match(text, /- \/export: .*LOG_BUFFER_LINES=0/i);
  assert.match(text, /- \/audit: Audit log is not attached in this runtime\./);

  const allReady = formatCommandAvailabilityReport({
    entries: [{ command: "export", available: true, hidden: true, operatorOnly: true }],
    available: [{ command: "export", available: true, hidden: true, operatorOnly: true }],
    unavailable: [],
  });
  assert.equal(allReady, "Command availability: 1 available, 0 disabled");
});
