import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EXPORT_CHARS,
  REDACTED,
  attachConsole,
  createLogCapture,
  redactLine,
  renderLogExport,
  secretsFor,
} from "../dist/logger.js";

function baseConfig(overrides = {}) {
  return {
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
    logBufferLines: 500,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

// ── Redaction (negative: nothing secret survives) ────────────────────────────

test("redactLine masks the bot token and chat id everywhere they appear", () => {
  const config = baseConfig();
  const secrets = secretsFor(config);
  const line =
    `[poller] send failed for https://api.example.invalid/bot${config.botToken}/sendMessage ` +
    `chat ${config.chatId}: timeout`;

  const redacted = redactLine(line, secrets);

  assert.equal(redacted.includes(config.botToken), false);
  assert.equal(redacted.includes(config.chatId), false);
  assert.equal(redacted.includes("SECRET-TOKEN"), false);
  assert.ok(redacted.includes(REDACTED));
  // Unrelated numbers survive — redaction is substring-targeted, not nuclear.
  assert.ok(redacted.includes("timeout"));
});

test("redactLine masks full-precision strkeys but keeps readable short forms", () => {
  const config = baseConfig();
  const secrets = secretsFor(config);
  // Build a real 56-char strkey deterministically.
  const strkey = "GABCD" + "A".repeat(51);
  assert.equal(strkey.length, 56);

  const redacted = redactLine(`creator ${strkey} at ledger 42`, secretsFor(config));
  assert.equal(redacted.includes(strkey), false);
  assert.ok(redacted.includes("GABC…"));
  assert.ok(redacted.includes("AAAA"));

  // The contract ids in [boot] lines are real strkeys too.
  const boot = redactLine(`[boot] market ${config.marketContractId}`, secretsFor(config));
  assert.equal(boot.includes(config.marketContractId), false);
});

test("redactLine leaves lines without secrets byte-identical", () => {
  const line = "[poller] market: 0 event(s) up to ledger 4226729 in 13 page(s)";
  assert.equal(redactLine(line, secretsFor(baseConfig())), line);
});

test("redactLine handles empty secret lists and empty lines", () => {
  assert.equal(redactLine("hello", []), "hello");
  assert.equal(redactLine("", ["x"]), "");
});

// ── Ring buffer (positive / boundary) ────────────────────────────────────────

test("capture keeps insertion order and evicts the oldest line when full", () => {
  const capture = createLogCapture(3);
  capture.add("log", "one");
  capture.add("warn", "two");
  capture.add("error", "three");
  assert.equal(capture.size(), 3);
  assert.deepEqual(capture.lines().map((l) => l.text), ["one", "two", "three"]);

  capture.add("log", "four");
  assert.equal(capture.size(), 3);
  assert.deepEqual(capture.lines().map((l) => l.text), ["two", "three", "four"]);
  // Sequence numbers stay monotonic across wraparound.
  const seqs = capture.lines().map((l) => l.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("capture with capacity 0 is an inert no-op", () => {
  const capture = createLogCapture(0);
  capture.add("log", "invisible");
  assert.equal(capture.size(), 0);
  assert.deepEqual(capture.lines(), []);
  assert.equal(capture.capacity(), 0);
});

test("capture boundary: capacity exactly equal to the number of writes", () => {
  const capture = createLogCapture(2);
  capture.add("log", "a");
  capture.add("log", "b");
  assert.equal(capture.size(), 2);
  capture.add("log", "c");
  assert.equal(capture.size(), 2);
  assert.deepEqual(capture.lines().map((l) => l.text), ["b", "c"]);
});

// ── Console wiring (regression: host output and process must survive) ───────

test("attachConsole captures redacted copies and restores originals", () => {
  const config = baseConfig();
  const capture = createLogCapture(10);
  const seen = [];
  const originals = {};
  for (const level of ["log", "info", "warn", "error"]) {
    originals[level] = console[level];
    console[level] = (...args) => seen.push([level, args.join(" ")]);
  }

  const restore = attachConsole(capture, secretsFor(config));
  try {
    console.log(`[boot] chat ${config.chatId}`);
    console.error(`[poller] token ${config.botToken} rejected`);
    console.warn("plain warning", "with two args");
  } finally {
    restore();
    for (const level of Object.keys(originals)) console[level] = originals[level];
  }

  assert.equal(capture.size(), 3);
  const texts = capture.lines().map((l) => l.text);
  assert.equal(texts[0].includes(config.chatId), false);
  assert.equal(texts[1].includes(config.botToken), false);
  assert.ok(texts[2].includes("plain warning with two args"));
  // Levels are preserved so the export can distinguish warn/error.
  assert.deepEqual(capture.lines().map((l) => l.level), ["log", "error", "warn"]);
  // The fake host output still received every call, unredacted ordering intact.
  assert.equal(seen.length, 3);
});

test("attachConsole restores console even after double install", () => {
  const capture = createLogCapture(5);
  const restore1 = attachConsole(capture, []);
  const restore2 = attachConsole(capture, []);
  restore2();
  restore1();
  // After unwinding both layers the console must still work.
  assert.doesNotThrow(() => console.log("still alive"));
});

// ── Export rendering (positive + security regression) ───────────────────────

test("renderLogExport includes summary and logs, and never leaks secrets", () => {
  const config = baseConfig();
  const capture = createLogCapture(10);
  const secrets = secretsFor(config);
  capture.add("log", `[boot] chat ${config.chatId}`);
  capture.add("warn", `[poller] token ${config.botToken} rejected`);
  capture.add("log", "[poller] market: 0 event(s) up to ledger 4226729");

  const status = baseStatus({
    lastError: { at: 4_900, message: `market: bot ${config.botToken} was blocked` },
  });
  const text = renderLogExport(config, status, capture, 5_500);

  assert.ok(text.startsWith("Mimir notifier log export"));
  assert.ok(text.includes("cycles: 4"));
  assert.ok(text.includes("failed sends: 0"));
  assert.ok(text.includes("[poller] market: 0 event(s) up to ledger 4226729"));
  // The lastError message is also rendered — it must be redacted too.
  assert.equal(text.includes(config.botToken), false);
  assert.equal(text.includes(config.chatId), false);
  assert.equal(text.includes("SECRET-TOKEN"), false);
});

test("renderLogExport says so when nothing was captured", () => {
  const capture = createLogCapture(50);
  const text = renderLogExport(baseConfig(), baseStatus(), capture, 5_500);
  assert.ok(text.includes("(no log lines captured)"));
});

test("renderLogExport boundary: oversized output is hard-capped and keeps head and tail", () => {
  const config = baseConfig();
  const capture = createLogCapture(50);
  // Each line ~1KB; 50 lines ≫ 32KB even after the cap trims the middle.
  for (let i = 0; i < 50; i += 1) {
    capture.add("log", `line ${i} ${"x".repeat(1_000)}`);
  }
  const text = renderLogExport(config, baseStatus(), capture, 5_500);

  assert.ok(text.length <= MAX_EXPORT_CHARS + 60, `length ${text.length}`);
  assert.ok(text.startsWith("Mimir notifier log export"), "summary head kept");
  assert.ok(text.includes("…[older log lines omitted]…"), "omission marker present");
  assert.ok(text.includes("line 39"), "newest line kept");
});

// ── Truncation reporting (counts, time bounds, and size limits) ──────────────

test("renderLogExport reports retained vs omitted counts and time bounds when not truncated", () => {
  const times = [1_700_000_000_000, 1_700_000_060_000];
  let idx = 0;
  const capture = createLogCapture(5, () => times[idx++]);
  capture.add("info", "first");
  capture.add("warn", "second");

  assert.deepEqual(capture.stats(), {
    retained: 2,
    omitted: 0,
    capacity: 5,
    oldestAt: 1_700_000_000_000,
    newestAt: 1_700_000_060_000,
  });

  const text = renderLogExport(baseConfig(), baseStatus(), capture, 1_700_000_120_000);
  assert.ok(
    text.includes(
      "log capture: retained 2 · omitted 0 · truncated: no · window: 2023-11-14T22:13:20.000Z..2023-11-14T22:14:20.000Z",
    ),
    `unexpected truncation header in:\n${text}`,
  );
});

test("renderLogExport reports omitted count and advancing time bounds after ring eviction", () => {
  const times = [
    1_700_000_000_000,
    1_700_000_010_000,
    1_700_000_020_000,
    1_700_000_030_000,
    1_700_000_040_000,
  ];
  let idx = 0;
  const capture = createLogCapture(3, () => times[idx++]);
  for (let i = 0; i < 5; i += 1) {
    capture.add("info", `entry-${i}`);
  }

  assert.deepEqual(capture.stats(), {
    retained: 3,
    omitted: 2,
    capacity: 3,
    oldestAt: 1_700_000_020_000,
    newestAt: 1_700_000_040_000,
  });

  const text = renderLogExport(baseConfig(), baseStatus(), capture, 1_700_000_050_000);
  assert.ok(
    text.includes(
      "log capture: retained 3 · omitted 2 · truncated: yes · window: 2023-11-14T22:13:40.000Z..2023-11-14T22:14:00.000Z",
    ),
    `unexpected truncation header in:\n${text}`,
  );
});

test("renderLogExport reports empty window when no lines are captured or capture is disabled", () => {
  const empty = createLogCapture(10);
  const emptyText = renderLogExport(baseConfig(), baseStatus(), empty, 5_500);
  assert.ok(emptyText.includes("log capture: retained 0 · omitted 0 · truncated: no · window: none"));

  const disabled = createLogCapture(0);
  disabled.add("info", "ignored");
  const disabledText = renderLogExport(baseConfig(), baseStatus(), disabled, 5_500);
  assert.ok(disabledText.includes("log capture: retained 0 · omitted 0 · truncated: no · window: none"));
});

test("renderLogExport preserves truncation summary within MAX_EXPORT_CHARS when both ring and size caps trigger", () => {
  let ts = 1_700_000_000_000;
  const capture = createLogCapture(40, () => {
    const current = ts;
    ts += 1_000;
    return current;
  });
  for (let i = 0; i < 65; i += 1) {
    capture.add("info", `line-${i} ${"x".repeat(1_000)}`);
  }

  const text = renderLogExport(baseConfig(), baseStatus(), capture, ts + 1_000);
  assert.ok(text.length <= MAX_EXPORT_CHARS, `length ${text.length} exceeds ${MAX_EXPORT_CHARS}`);
  assert.ok(text.includes("log capture: retained 40 · omitted 25 · truncated: yes · window: "));
  assert.ok(text.includes("…[older log lines omitted]…"));
});

test("renderLogExport falls back cleanly for custom LogCapture implementations without stats()", () => {
  const legacyCapture = {
    add() {},
    lines() {
      return [{ seq: 0, at: 1_700_000_000_000, level: "info", text: "legacy" }];
    },
    size() {
      return 1;
    },
    capacity() {
      return 10;
    },
  };

  const text = renderLogExport(baseConfig(), baseStatus(), legacyCapture, 1_700_000_005_000);
  assert.ok(
    text.includes(
      "log capture: retained 1 · omitted 0 · truncated: no · window: 2023-11-14T22:13:20.000Z..2023-11-14T22:13:20.000Z",
    ),
  );
});

// ── Restart semantics ─────────────────────────────────────────────────────────

test("restart: a fresh capture starts empty (log history is not persisted)", () => {
  const before = createLogCapture(8);
  before.add("log", "pre-restart line");

  // A restart constructs a new capture; nothing is restored from disk.
  const after = createLogCapture(8);
  assert.equal(after.size(), 0);
  assert.deepEqual(after.lines(), []);
  assert.notEqual(before.size(), after.size());
});
