import assert from "node:assert/strict";
import test from "node:test";

import {
  Logger,
  createLogCapture,
  neutralizeTerminalEscapes,
  redactLine,
  renderLogExport,
} from "../dist/logger.js";
import { clearSecrets, redactError, redactText } from "../dist/redact.js";

const FAKE_BOT_TOKEN = ["123456789:AA", "x".repeat(33)].join("");

function captureLoggerLines() {
  const lines = [];
  Logger.configure({
    format: "text",
    sink: (level, line) => lines.push({ level, line }),
  });
  return lines;
}

test.afterEach(() => {
  Logger.reset();
  clearSecrets();
});

test("strips ANSI CSI color, cursor-movement, and erase-screen sequences in human-readable mode", () => {
  const lines = captureLoggerLines();
  Logger.warn(
    "poller",
    "[poller] remote reason: \u001B[31m\u001B[1mBAD_TOPIC\u001B[0m\u001B[2J\u001B[H\u001B[2K\u009B32mok\u009B0m",
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, "[poller] remote reason: BAD_TOPICok");
  assert.equal(lines[0].line.includes("\u001B"), false);
  assert.equal(lines[0].line.includes("\u009B"), false);
});

test("strips OSC 0/52/8 sequences (BEL, ST, 8-bit OSC, and unterminated tails)", () => {
  const oscTitle = "\u001B]0;PWNED_WINDOW_TITLE\u0007";
  const oscClipboard = "\u001B]52;c;SGVsbG8gV29ybGQ=\u001B\\";
  const oscHyperlink = "\u001B]8;;https://evil.invalid/phish\u001B\\visible-label\u001B]8;;\u001B\\";
  const osc8Bit = "\u009D2;c1-title\u009C";
  const oscUnterminated = "\u001B]0;dangling-osc-at-end";

  const lines = captureLoggerLines();
  Logger.error(
    "poller",
    `rpc failed: ${oscTitle}${oscClipboard}${oscHyperlink}${osc8Bit} tail${oscUnterminated}`,
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, "rpc failed: visible-label tail");
  assert.equal(lines[0].line.includes("PWNED_WINDOW_TITLE"), false);
  assert.equal(lines[0].line.includes("SGVsbG8gV29ybGQ="), false);
  assert.equal(lines[0].line.includes("evil.invalid"), false);
  assert.equal(lines[0].line.includes("dangling-osc-at-end"), false);
});

test("strips nested escape payloads, DCS/APC strings, RIS reset, standalone CR, and C0/C1 controls", () => {
  const nested = "\u001B[\u001B]0;hidden\u000731m";
  const dcsAndApc = "\u001BP1$r0m\u001B\\\u001B_app-cmd\u001B\\";
  const risAndCr = "\u001Bcreal-error\r[boot] spoofed-prefix\u0008\u0000\u007F\u0085";

  const cleaned = neutralizeTerminalEscapes(`${nested}${dcsAndApc}${risAndCr}`);
  assert.equal(cleaned, "real-error[boot] spoofed-prefix");
  assert.equal(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(cleaned), false);

  // CRLF line breaks normalize cleanly to LF while preserving multi-line text.
  assert.equal(neutralizeTerminalEscapes("line1\r\n\tline2"), "line1\n\tline2");
});

test("preserves ordinary Unicode content including accents, CJK, RTL scripts, and ZWJ emoji", () => {
  const unicodeMsg =
    "Mimir · marché résumé — 日本語テスト — العربية — עברית — 🚀 👩‍🔬 CDV6…PKZI";
  const lines = captureLoggerLines();
  Logger.info("poller", unicodeMsg);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].line, unicodeMsg);
  assert.equal(redactText(unicodeMsg), unicodeMsg);
  assert.equal(redactLine(unicodeMsg, []), unicodeMsg);
});

test("neutralizes ANSI-wrapped bot tokens BEFORE redaction so SGR bytes cannot bypass token regexes", () => {
  // Without pre-neutralization, `m` in `\x1b[31m` sits immediately before the
  // digit `1` with no `\b` word boundary, letting the raw token survive once stripped.
  const wrapped = `upstream echoed \u001B[31m${FAKE_BOT_TOKEN}\u001B[0m`;

  const lines = captureLoggerLines();
  Logger.error("process", wrapped);
  assert.equal(lines[0].line.includes(FAKE_BOT_TOKEN), false);
  assert.equal(lines[0].line, "upstream echoed [REDACTED]");

  const fromRedactError = redactError(new Error(wrapped));
  assert.equal(fromRedactError.includes(FAKE_BOT_TOKEN), false);
  assert.equal(fromRedactError, "upstream echoed [REDACTED]");
});

test("LogCapture and renderLogExport neutralize escape sequences from captured console lines", () => {
  const config = {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    logBufferLines: 20,
  };
  const status = {
    running: true,
    startedAt: 1_000,
    cycles: 1,
    lastPollAt: 2_000,
    lastSuccessAt: 2_000,
    latestLedger: 10,
    oldestLedger: 1,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: { at: 1_900, message: "\u001B]0;evil\u0007\u001B[31mtimeout\u001B[0m" },
    targets: [],
  };

  const capture = createLogCapture(10);
  capture.add("warn", "\u001B[33mwarn-payload\u001B[0m \u001B]52;c;YWJj\u0007 café");

  const exported = renderLogExport(config, status, capture, 3_000);
  assert.equal(exported.includes("\u001B"), false);
  assert.equal(exported.includes("YWJj"), false);
  assert.ok(exported.includes("warn-payload  café"));
  assert.ok(exported.includes("timeout"));
});
