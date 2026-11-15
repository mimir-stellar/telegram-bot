import assert from "node:assert/strict";
import test from "node:test";

import { createAuditLog } from "../dist/audit.js";
import {
  commandAvailabilityReport,
  evaluateCommandAvailability,
  formatCommandAvailabilityReport,
  helpMessage,
  registerCommandHandlers,
  registerCommands,
} from "../dist/bot.js";
import { defineCommand, visibleCommandMetadata } from "../dist/commands/index.js";
import { createLogCapture } from "../dist/logger.js";

function makeConfig(overrides = {}) {
  return {
    botToken: ["123456:", "A".repeat(35)].join(""),
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    auditFile: "/tmp/mimir-test-audit.jsonl",
    logBufferLines: 100,
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

function makeDeps(configOverrides = {}, depOverrides = {}) {
  const config = makeConfig(configOverrides);
  return {
    config,
    status: () => ({
      running: true,
      paused: false,
      startedAt: 1,
      cycles: 1,
      lastPollAt: 1,
      lastSuccessAt: 1,
      latestLedger: 100,
      oldestLedger: 50,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 0,
      lastError: null,
      targets: [],
    }),
    pause: () => "paused",
    resume: () => "resumed",
    audit: createAuditLog(),
    logs: createLogCapture(50),
    ...depOverrides,
  };
}

test("commandAvailabilityReport marks all commands available when dependencies are configured", () => {
  const deps = makeDeps();
  const report = commandAvailabilityReport(deps.config, deps);

  assert.equal(report.every((entry) => entry.available), true);
  assert.equal(report.every((entry) => entry.reason === null), true);

  const exportEntry = report.find((entry) => entry.command === "export");
  assert.ok(exportEntry);
  assert.equal(exportEntry.available, true);
  assert.equal(exportEntry.hidden, true);
  assert.equal(exportEntry.menuVisible, false, "hidden commands stay out of public menu");

  const formatted = formatCommandAvailabilityReport(report);
  assert.match(formatted, /Command availability \(11\/11 available\):/);
  assert.match(formatted, /- \/audit: available \[menu\]/);
  assert.match(formatted, /- \/export: available \[hidden\]/);
});

test("audit command explains disabled reason and leaves the public menu when audit trail is absent", async () => {
  const deps = makeDeps({ auditFile: "" }, { audit: undefined, auditFile: undefined });
  const report = commandAvailabilityReport(deps.config, deps);
  const auditEntry = report.find((entry) => entry.command === "audit");

  assert.ok(auditEntry);
  assert.equal(auditEntry.available, false);
  assert.equal(auditEntry.menuVisible, false);
  assert.match(auditEntry.reason ?? "", /AUDIT_FILE is empty/i);

  const menuCommands = visibleCommandMetadata(deps.config, deps).map((c) => c.command);
  assert.equal(menuCommands.includes("audit"), false, "/audit must be excluded from menu");
  assert.equal(menuCommands.includes("pause"), true, "other operator commands remain visible");

  const helpText = helpMessage(deps.config, deps);
  assert.equal(helpText.includes("/audit"), false, "/help must omit disabled /audit");

  const sentMenus = [];
  const fakeBot = {
    api: {
      setMyCommands: async (cmds) => {
        sentMenus.push(cmds);
      },
    },
  };
  await registerCommands(fakeBot, deps.config, deps);
  assert.equal(sentMenus.length, 1);
  assert.equal(sentMenus[0].some((c) => c.command === "audit"), false);

  // Supplying an in-memory AuditLog re-enables /audit even when AUDIT_FILE is empty.
  const withLiveAudit = makeDeps({ auditFile: "" }, { audit: createAuditLog() });
  const enabledReport = commandAvailabilityReport(withLiveAudit.config, withLiveAudit);
  const reenabled = enabledReport.find((entry) => entry.command === "audit");
  assert.equal(reenabled?.available, true);
  assert.equal(reenabled?.menuVisible, true);
});

test("export command reports disabled reason when LOG_BUFFER_LINES=0 or log buffer is absent", () => {
  const zeroBufferDeps = makeDeps({ logBufferLines: 0 }, { logs: createLogCapture(0) });
  const report = commandAvailabilityReport(zeroBufferDeps.config, zeroBufferDeps);
  const exportEntry = report.find((entry) => entry.command === "export");

  assert.ok(exportEntry);
  assert.equal(exportEntry.available, false);
  assert.equal(exportEntry.menuVisible, false);
  assert.match(exportEntry.reason ?? "", /LOG_BUFFER_LINES=0/);

  const formatted = formatCommandAvailabilityReport(report);
  assert.match(formatted, /- \/export: disabled — .*LOG_BUFFER_LINES=0/);
});

test("operator commands explain missing OPERATOR_TELEGRAM_USER_ID and stay out of public menu", () => {
  const deps = makeDeps({ operatorTelegramUserId: null });
  const report = commandAvailabilityReport(deps.config, deps);

  for (const name of ["audit", "pause", "resume", "export"]) {
    const entry = report.find((item) => item.command === name);
    assert.ok(entry, `expected ${name} in report`);
    assert.equal(entry.available, false);
    assert.equal(entry.menuVisible, false);
    assert.match(entry.reason ?? "", /OPERATOR_TELEGRAM_USER_ID/);
  }

  const publicCommands = visibleCommandMetadata(deps.config, deps).map((c) => c.command);
  for (const name of ["audit", "pause", "resume", "export"]) {
    assert.equal(publicCommands.includes(name), false);
  }
});

test("missing poller status or pause/resume providers exclude affected commands from the menu", () => {
  const deps = makeDeps({}, { status: undefined, pause: undefined });
  const report = commandAvailabilityReport(deps.config, deps);

  const statusEntry = report.find((item) => item.command === "status");
  const healthEntry = report.find((item) => item.command === "health");
  const pauseEntry = report.find((item) => item.command === "pause");
  const resumeEntry = report.find((item) => item.command === "resume");

  assert.equal(statusEntry?.available, false);
  assert.match(statusEntry?.reason ?? "", /status provider is absent/i);
  assert.equal(healthEntry?.available, false);
  assert.equal(pauseEntry?.available, false);
  assert.match(pauseEntry?.reason ?? "", /pause control is absent/i);
  assert.equal(resumeEntry?.available, true);

  const visible = visibleCommandMetadata(deps.config, deps).map((c) => c.command);
  assert.equal(visible.includes("status"), false);
  assert.equal(visible.includes("health"), false);
  assert.equal(visible.includes("pause"), false);
  assert.equal(visible.includes("resume"), true);
});

test("dispatch preserves silent authorization before reporting disabled optional dependencies", async () => {
  const handlers = new Map();
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
  };
  const deps = makeDeps({ auditFile: "" }, { audit: undefined, auditFile: undefined });
  registerCommandHandlers(bot, deps);

  const auditHandler = handlers.get("audit");
  assert.equal(typeof auditHandler, "function");

  // Non-operator still gets silent ignore — availability does not leak command existence.
  const strangerReplies = [];
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await auditHandler({
      from: { id: 999 },
      chat: { id: 999, type: "private" },
      update: { update_id: 1 },
      reply: async (text) => strangerReplies.push(text),
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(strangerReplies.length, 0);

  // Authorized operator receives a clear explanation of why /audit is disabled.
  const operatorReplies = [];
  await auditHandler({
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 2 },
    reply: async (text) => operatorReplies.push(text),
  });
  assert.equal(operatorReplies.length, 1);
  assert.match(operatorReplies[0], /\/audit is currently disabled:.*AUDIT_FILE is empty/i);
});

test("custom CommandModule availability hook supplies fallback or custom disabled reasons", () => {
  const customWithBlankReason = evaluateCommandAvailability({
    command: "synthetic-feed",
    availability: () => ({ available: false, reason: "   " }),
    handler: async () => undefined,
  });
  assert.equal(customWithBlankReason.available, false);
  assert.equal(customWithBlankReason.menuVisible, false);
  assert.match(
    customWithBlankReason.reason ?? "",
    /Optional runtime dependency for \/synthetic-feed is absent/,
  );

  defineCommand({
    command: "test-optional-dep",
    hidden: true,
    availability: ({ deps }) =>
      deps?.version
        ? { available: true }
        : { available: false, reason: "Package version metadata was not injected" },
    handler: async () => undefined,
  });

  const withoutVersion = commandAvailabilityReport(makeConfig(), makeDeps({}, { version: undefined }));
  const entryOff = withoutVersion.find((item) => item.command === "test-optional-dep");
  assert.equal(entryOff?.available, false);
  assert.equal(entryOff?.reason, "Package version metadata was not injected");

  const withVersion = commandAvailabilityReport(makeConfig(), makeDeps({}, { version: "1.2.3" }));
  const entryOn = withVersion.find((item) => item.command === "test-optional-dep");
  assert.equal(entryOn?.available, true);
  assert.equal(entryOn?.reason, null);
});
