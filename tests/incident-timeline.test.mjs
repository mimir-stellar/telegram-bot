import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_INCIDENT_TIMELINE_MAX_ENTRIES,
  Logger,
  MAX_INCIDENT_TIMELINE_ENTRIES,
  MAX_INCIDENT_TIMELINE_LINE_CHARS,
  MAX_INCIDENT_TIMELINE_WINDOW_MS,
  exportIncidentTimeline,
  formatIncidentTimeline,
} from "../dist/logger.js";
import { clearSecrets, registerSecret } from "../dist/redact.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const FAKE_BOT_TOKEN = ["123456789:AA", "x".repeat(33)].join("");
const FAKE_SEED = ["S", "A".repeat(55)].join("");
const CHAT_VALUE = "-1009876543210";

test.afterEach(() => {
  Logger.reset();
  clearSecrets();
});

test("exports constants for bounded incident timeline queries", () => {
  assert.equal(MAX_INCIDENT_TIMELINE_WINDOW_MS, 24 * 60 * 60 * 1_000);
  assert.equal(DEFAULT_INCIDENT_TIMELINE_MAX_ENTRIES, 500);
  assert.equal(MAX_INCIDENT_TIMELINE_ENTRIES, 5_000);
  assert.equal(MAX_INCIDENT_TIMELINE_LINE_CHARS, 65_536);
});

test("filters structured logs by bounded time range and correlation ID across field styles", async () => {
  await withTempDataDir(async (dir) => {
    const logPath = dir.file("ops.jsonl");
    const rows = [
      // Before window
      JSON.stringify({
        ts: "2026-10-18T09:59:59.999Z",
        level: "info",
        component: "poller",
        correlationId: "corr-42",
        msg: "before window",
      }),
      // Matching via structured correlationId
      JSON.stringify({
        ts: "2026-10-18T10:02:00.000Z",
        level: "warn",
        component: "poller",
        action: "notification_cap_reached",
        correlationId: "corr-42",
        source: "market",
        ledger: 1200,
        msg: "cap reached",
      }),
      // Different correlationId inside window
      JSON.stringify({
        ts: "2026-10-18T10:01:00.000Z",
        level: "error",
        component: "poller",
        correlationId: "corr-99",
        msg: "unrelated cycle error",
      }),
      // Matching via msg `correlation=...` token (earlier timestamp, later line -> sorted first!)
      JSON.stringify({
        ts: "2026-10-18T10:00:30.000Z",
        level: "info",
        component: "poller",
        action: "event_skipped",
        source: "squad",
        ledger: 1199,
        msg: "skipped unknown event correlation=corr-42",
      }),
      // Matching via `correlation` field at exact upper boundary
      JSON.stringify({
        ts: "2026-10-18T10:05:00.000Z",
        level: "error",
        component: "poller",
        action: "send_failed",
        correlation: "corr-42",
        eventId: "0001200-1",
        error: "timeout after 10000ms",
        msg: "send failed after retries",
      }),
      // After window
      JSON.stringify({
        ts: "2026-10-18T10:05:00.001Z",
        level: "info",
        component: "poller",
        correlationId: "corr-42",
        msg: "after window",
      }),
    ];
    await writeFile(logPath, `${rows.join("\n")}\n`, "utf8");

    const report = await exportIncidentTimeline(logPath, {
      from: "2026-10-18T10:00:00.000Z",
      to: "2026-10-18T10:05:00.000Z",
      correlationId: "corr-42",
    });

    assert.equal(report.correlationId, "corr-42");
    assert.equal(report.window.durationMs, 5 * 60 * 1_000);
    assert.equal(report.stats.scannedLines, 6);
    assert.equal(report.stats.matchedEntries, 3);
    assert.equal(report.stats.exportedEntries, 3);
    assert.equal(report.stats.droppedEntries, 0);
    assert.equal(report.stats.truncated, false);

    // Chronologically sorted despite out-of-order lines in the file.
    assert.deepEqual(
      report.entries.map((e) => [e.ts, e.action, e.line]),
      [
        ["2026-10-18T10:00:30.000Z", "event_skipped", 4],
        ["2026-10-18T10:02:00.000Z", "notification_cap_reached", 2],
        ["2026-10-18T10:05:00.000Z", "send_failed", 5],
      ],
    );

    const renderedText = formatIncidentTimeline(report, "text");
    assert.match(renderedText, /^Incident timeline · 2026-10-18T10:00:00\.000Z \.\. 2026-10-18T10:05:00\.000Z · correlation=corr-42/m);
    assert.match(renderedText, /2026-10-18T10:00:30\.000Z \[info\] poller action=event_skipped correlation=corr-42 source=squad ledger=1199/);
    assert.match(renderedText, /2026-10-18T10:05:00\.000Z \[error\] poller action=send_failed correlation=corr-42 eventId=0001200-1/);
  });
});

test("produces byte-identical deterministic text and JSON output across chunk sizes and UTF-8 splits", async () => {
  const payload = [
    JSON.stringify({
      bField: "beta",
      aField: "alpha — café 🚀",
      ts: "2026-10-18T12:00:01.000Z",
      level: "info",
      component: "poller",
      correlationId: "c-1",
      msg: "tie second line",
    }),
    JSON.stringify({
      zKey: { second: 2, first: 1 },
      ts: "2026-10-18T12:00:01.000Z",
      level: "warn",
      component: "poller",
      correlationId: "c-1",
      msg: "tie third line — résumé",
    }),
  ].join("\r\n");

  const fullBytes = Buffer.from(payload, "utf8");
  async function* tinyByteChunks(step) {
    for (let i = 0; i < fullBytes.length; i += step) {
      yield fullBytes.subarray(i, i + step);
    }
  }

  const opts = {
    from: Date.parse("2026-10-18T12:00:00.000Z"),
    to: new Date("2026-10-18T12:01:00.000Z"),
    correlationId: "c-1",
  };

  const r1 = await exportIncidentTimeline(tinyByteChunks(7), opts);
  const r2 = await exportIncidentTimeline([payload], opts);

  assert.deepEqual(r1, r2);
  assert.equal(formatIncidentTimeline(r1, "text"), formatIncidentTimeline(r2, "text"));
  assert.equal(formatIncidentTimeline(r1, "json"), formatIncidentTimeline(r2, "json"));

  // Extra object keys are canonically sorted.
  assert.deepEqual(Object.keys(r1.entries[0].fields), ["aField", "bField", "correlationId"]);
  assert.deepEqual(Object.keys(r1.entries[1].fields.zKey), ["first", "second"]);
});

test("redacts secrets, bot tokens, seed strkeys, and URL credentials in exported entries", async () => {
  registerSecret(CHAT_VALUE);
  const line = JSON.stringify({
    ts: "2026-10-18T14:00:00.000Z",
    level: "error",
    component: "poller",
    correlationId: "cycle-sec",
    error:
      "POST https://op:supersecret@rpc.example.invalid/?api_key=" +
      `abcdef1234567890 seed=${FAKE_SEED}`,
    nested: {
      chat: `target ${CHAT_VALUE}`,
      url: `https://api.telegram.org/bot${FAKE_BOT_TOKEN}/sendMessage`,
      extra: "CUSTOM_RUNTIME_SECRET_99",
    },
    msg: `send failed to ${CHAT_VALUE} via ${FAKE_BOT_TOKEN}`,
  });

  const report = await exportIncidentTimeline([line], {
    from: "2026-10-18T13:59:00.000Z",
    to: "2026-10-18T14:01:00.000Z",
    correlationId: "cycle-sec",
    secrets: ["CUSTOM_RUNTIME_SECRET_99"],
  });

  const serialized = formatIncidentTimeline(report, "json");
  const textOut = formatIncidentTimeline(report, "text");

  for (const forbidden of [
    FAKE_BOT_TOKEN,
    FAKE_SEED,
    CHAT_VALUE,
    "supersecret",
    "abcdef1234567890",
    "CUSTOM_RUNTIME_SECRET_99",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `JSON leaked ${forbidden}`);
    assert.equal(textOut.includes(forbidden), false, `Text leaked ${forbidden}`);
  }
  assert.match(report.entries[0].msg, /\[REDACTED\]/);
});

test("streams large logs with bounded retention, skips oversized/malformed lines, and honors maxScanBytes", async () => {
  const baseMs = Date.parse("2026-10-18T15:00:00.000Z");

  async function* syntheticStream() {
    yield "not-json-at-all\n";
    yield `${JSON.stringify(["array-not-object"])}\n`;
    yield `${JSON.stringify({ ts: "bad-date", level: "info", component: "x", msg: "bad" })}\n`;
    yield `${JSON.stringify({ ts: "2026-10-18T15:00:01.000Z", level: "unknown_lvl", component: "x", msg: "bad" })}\n`;
    // Oversized single line split across multiple chunks without buffering unbounded memory.
    yield `{"ts":"2026-10-18T15:00:02.000Z","level":"info","component":"x","msg":"`;
    for (let c = 0; c < 10; c += 1) {
      yield "X".repeat(200);
    }
    yield `"}\n`;
    // 25 valid matching lines; maxEntries=5 should deterministically keep the newest 5 (20..24).
    for (let i = 0; i < 25; i += 1) {
      yield `${JSON.stringify({
        ts: new Date(baseMs + (i + 1) * 1_000).toISOString(),
        level: "info",
        component: "poller",
        correlationId: "stream-corr",
        seq: i,
        msg: `entry-${i}`,
      })}\n`;
    }
  }

  const report = await exportIncidentTimeline(syntheticStream(), {
    from: baseMs,
    to: baseMs + 60_000,
    correlationId: "stream-corr",
    maxEntries: 5,
    maxLineChars: 1_024,
  });

  assert.equal(report.stats.malformedLines, 4);
  assert.equal(report.stats.oversizedLines, 1);
  assert.equal(report.stats.matchedEntries, 25);
  assert.equal(report.stats.exportedEntries, 5);
  assert.equal(report.stats.droppedEntries, 20);
  assert.equal(report.stats.truncated, true);
  assert.deepEqual(
    report.entries.map((e) => e.fields.seq),
    [20, 21, 22, 23, 24],
  );

  // Also verify maxScanBytes stops scanning cleanly without treating a cut line as malformed.
  const twoLines = [
    JSON.stringify({
      ts: new Date(baseMs + 1_000).toISOString(),
      level: "info",
      component: "poller",
      msg: "first complete line",
    }),
    JSON.stringify({
      ts: new Date(baseMs + 2_000).toISOString(),
      level: "info",
      component: "poller",
      msg: "second line cut mid-stream",
    }),
  ].join("\n");

  const firstLineBytes = Buffer.byteLength(twoLines.split("\n")[0], "utf8") + 10;
  const byteCapped = await exportIncidentTimeline([twoLines], {
    from: baseMs,
    to: baseMs + 10_000,
    maxScanBytes: firstLineBytes,
  });
  assert.equal(byteCapped.stats.exportedEntries, 1);
  assert.equal(byteCapped.stats.malformedLines, 0);
  assert.equal(byteCapped.stats.truncated, true);
  assert.equal(byteCapped.entries[0].msg, "first complete line");
});

test("rejects unbounded, inverted, or malformed filter options and handles empty results", async () => {
  await assert.rejects(
    () =>
      exportIncidentTimeline([], {
        from: "2026-10-18T10:05:00.000Z",
        to: "2026-10-18T10:00:00.000Z",
      }),
    RangeError,
  );

  // Exceeds 24h MAX_INCIDENT_TIMELINE_WINDOW_MS
  await assert.rejects(
    () =>
      exportIncidentTimeline([], {
        from: "2026-10-18T00:00:00.000Z",
        to: "2026-10-20T00:00:00.000Z",
      }),
    RangeError,
  );

  // Exceeds custom tighter maxWindowMs
  await assert.rejects(
    () =>
      exportIncidentTimeline([], {
        from: "2026-10-18T10:00:00.000Z",
        to: "2026-10-18T10:02:00.000Z",
        maxWindowMs: 60_000,
      }),
    RangeError,
  );

  // Blank correlationId rejected rather than silently matching everything
  await assert.rejects(
    () =>
      exportIncidentTimeline([], {
        from: "2026-10-18T10:00:00.000Z",
        to: "2026-10-18T10:01:00.000Z",
        correlationId: "   ",
      }),
    RangeError,
  );

  await assert.rejects(
    () =>
      exportIncidentTimeline([], {
        from: "not-a-timestamp",
        to: "2026-10-18T10:01:00.000Z",
      }),
    RangeError,
  );

  const empty = await exportIncidentTimeline([], {
    from: "2026-10-18T10:00:00.000Z",
    to: "2026-10-18T10:01:00.000Z",
  });
  assert.equal(empty.entries.length, 0);
  assert.match(formatIncidentTimeline(empty, "text"), /\(no matching log entries\)/);
});
