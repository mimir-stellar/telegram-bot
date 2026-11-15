import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSampledRepeatSuffix,
  formatSuppressedCategorySuffix,
  LogSampler,
} from "../dist/log-sampler.js";
import { Logger } from "../dist/logger.js";
import { clearSecrets, registerSecret, sanitizeLogLabel } from "../dist/redact.js";

function captureLoggerLines() {
  const lines = [];
  Logger.configure({
    sink: (level, line) => {
      lines.push({ level, line });
    },
  });
  return lines;
}

function makeClock(startMs = Date.UTC(2026, 10, 1, 12, 0, 0)) {
  let currentMs = startMs;
  return {
    nowMs: () => currentMs,
    nowDate: () => new Date(currentMs),
    advance: (deltaMs) => {
      currentMs += deltaMs;
    },
    set: (nextMs) => {
      currentMs = nextMs;
    },
  };
}

test.afterEach(() => {
  Logger.reset();
  clearSecrets();
});

test("distinguishes sampled_repeat from suppressed_category in JSON and text modes", () => {
  const clock = makeClock();
  const lines = captureLoggerLines();
  Logger.configure({
    format: "json",
    now: clock.nowDate,
    sampleWindowMs: 10_000,
    sampleMaxPerWindow: 2,
    suppressedCategories: ["rpc_transient"],
    categorySummaryWindowMs: 10_000,
  });

  // 1. Sampled repeats: first 2 emit, next 3 withheld, rollover reports sampledRepeats=3 and aggregateCount=6
  for (let i = 0; i < 5; i += 1) {
    Logger.sampled("warn", "poller", "scan:market", "market RPC slow", { action: "rpc_slow" });
  }
  // 2. Suppressed error category: first occurrence emits, next 4 muted, rollover reports suppressedCount=4 and aggregateCount=6
  for (let i = 0; i < 5; i += 1) {
    Logger.error("poller", "upstream transient 502", {
      action: "scan_failed",
      errorCategory: "rpc_transient",
    });
  }

  assert.equal(lines.length, 3, "2 sampled lines + 1 category first-occurrence line in window 1");
  const records = lines.map((entry) => JSON.parse(entry.line));

  assert.equal(records[0].suppressionKind, "sampled_repeat");
  assert.equal(records[0].sampleKey, "scan:market");
  assert.equal(records[0].firstOccurrence, true);
  assert.equal(records[0].sampledRepeats, 0);
  assert.equal(records[0].aggregateCount, 1);

  assert.equal(records[1].suppressionKind, "sampled_repeat");
  assert.equal(records[1].firstOccurrence, false);
  assert.equal(records[1].sampledRepeats, 0);
  assert.equal(records[1].aggregateCount, 2);

  assert.equal(records[2].suppressionKind, "suppressed_category");
  assert.equal(records[2].errorCategory, "rpc_transient");
  assert.equal(records[2].firstOccurrence, true);
  assert.equal(records[2].suppressedCount, 0);
  assert.equal(records[2].aggregateCount, 1);

  const midSnap = Logger.getSuppressionSnapshot();
  assert.equal(midSnap.sampledRepeatsTotal, 3);
  assert.equal(midSnap.suppressedCategoriesTotal, 4);
  assert.equal(midSnap.sampledKeys["scan:market"].aggregateCount, 5);
  assert.equal(midSnap.categories["rpc_transient"].aggregateCount, 5);

  // Advance past the 10s window and emit one more of each
  clock.advance(10_000);
  Logger.sampled("warn", "poller", "scan:market", "market RPC slow", { action: "rpc_slow" });
  Logger.error("poller", "upstream transient 502", {
    action: "scan_failed",
    errorCategory: "rpc_transient",
  });

  assert.equal(lines.length, 5);
  const rolledSample = JSON.parse(lines[3].line);
  assert.equal(rolledSample.suppressionKind, "sampled_repeat");
  assert.equal(rolledSample.firstOccurrence, false);
  assert.equal(rolledSample.sampledRepeats, 3);
  assert.equal(rolledSample.aggregateCount, 6);
  assert.match(rolledSample.msg, /\[sampled_repeat: \+3 identical repeats in 10s \(6 total\)\]/);

  const rolledCategory = JSON.parse(lines[4].line);
  assert.equal(rolledCategory.suppressionKind, "suppressed_category");
  assert.equal(rolledCategory.firstOccurrence, false);
  assert.equal(rolledCategory.suppressedCount, 4);
  assert.equal(rolledCategory.aggregateCount, 6);
  assert.match(
    rolledCategory.msg,
    /\[suppressed_category=rpc_transient: \+4 suppressed \(6 total\)\]/,
  );
});

test("keeps first occurrence and aggregate count coherent across flushSuppressed without extra occurrences", () => {
  const clock = makeClock();
  const lines = captureLoggerLines();
  Logger.configure({
    format: "text",
    now: clock.nowDate,
    sampleWindowMs: 60_000,
    sampleMaxPerWindow: 1,
    suppressedCategories: ["stale_cursor"],
  });

  // 1st + 2 suppressed = 3 total occurrences for category
  Logger.error("poller", "cursor behind window", { errorCategory: "stale_cursor" });
  Logger.error("poller", "cursor behind window", { errorCategory: "stale_cursor" });
  Logger.error("poller", "cursor behind window", { errorCategory: "stale_cursor" });

  // 1st + 3 sampled repeats = 4 total occurrences for sampleKey
  Logger.sampled("info", "poller", "cycle:idle", "idle poll");
  Logger.sampled("info", "poller", "cycle:idle", "idle poll");
  Logger.sampled("info", "poller", "cycle:idle", "idle poll");
  Logger.sampled("info", "poller", "cycle:idle", "idle poll");

  assert.equal(lines.length, 2);
  assert.match(
    lines[0].line,
    /cursor behind window \[suppressed_category=stale_cursor: first occurrence \(1 total\), repeats muted\]/,
  );
  assert.equal(lines[1].line, "idle poll");

  const flushed = Logger.flushSuppressed();
  assert.equal(flushed, 2);
  assert.equal(lines.length, 4);
  assert.match(lines[2].line, /\[sampled_repeat: \+3 identical repeats in 60s \(4 total\)\]/);
  assert.match(lines[3].line, /\[suppressed_category=stale_cursor: \+2 suppressed \(3 total\)\]/);

  // Calling flushSuppressed again when nothing new occurred emits nothing and preserves totals
  assert.equal(Logger.flushSuppressed(), 0);
  const snap = Logger.getSuppressionSnapshot();
  assert.equal(snap.sampledKeys["cycle:idle"].aggregateCount, 4);
  assert.equal(snap.categories["stale_cursor"].aggregateCount, 3);
});

test("reset boundaries and backward clock steps never report negative counts", () => {
  const clock = makeClock(50_000);
  const lines = captureLoggerLines();
  Logger.configure({
    format: "json",
    now: clock.nowDate,
    sampleWindowMs: 5_000,
    sampleMaxPerWindow: 1,
    suppressedCategories: ["rate_limited"],
  });

  for (let i = 0; i < 6; i += 1) {
    Logger.sampled("warn", "bot", "chat:flood", "rate limit hit");
    Logger.error("poller", "429 from upstream", { errorCategory: "rate_limited" });
  }

  const beforeReset = Logger.getSuppressionSnapshot();
  assert.equal(beforeReset.sampledRepeatsTotal, 5);
  assert.equal(beforeReset.suppressedCategoriesTotal, 5);

  // Step clock backwards BEFORE resetting to ensure clock rollback cannot yield negative elapsed/counts
  clock.set(10_000);
  Logger.sampled("warn", "bot", "chat:flood", "rate limit hit after clock jump");
  const midSnap = Logger.getSuppressionSnapshot();
  assert.equal(midSnap.sampledRepeatsTotal, 6);

  // Reset suppression state and emit fewer occurrences than beforeReset held
  Logger.resetSuppression();
  Logger.sampled("warn", "bot", "chat:flood", "fresh epoch #1");
  Logger.sampled("warn", "bot", "chat:flood", "fresh epoch #2");
  Logger.error("poller", "fresh 429", { errorCategory: "rate_limited" });

  const deltaAfterSuppressionReset = Logger.diffSuppressionSnapshot(beforeReset);
  assert.equal(deltaAfterSuppressionReset.resetBoundaryCrossed, true);
  assert.ok(deltaAfterSuppressionReset.sampledRepeatsDelta >= 0);
  assert.ok(deltaAfterSuppressionReset.suppressedCategoriesDelta >= 0);
  assert.equal(deltaAfterSuppressionReset.sampledRepeatsDelta, 1);
  assert.equal(deltaAfterSuppressionReset.suppressedCategoriesDelta, 0);
  assert.equal(deltaAfterSuppressionReset.sampledKeys["chat:flood"].aggregateDelta, 2);
  assert.equal(deltaAfterSuppressionReset.categories["rate_limited"].aggregateDelta, 1);

  // Full Logger.reset() boundary also increments epoch and prevents negative deltas
  const preFullReset = Logger.getSuppressionSnapshot();
  Logger.reset();
  const deltaAfterFullReset = Logger.diffSuppressionSnapshot(preFullReset);
  assert.equal(deltaAfterFullReset.resetBoundaryCrossed, true);
  assert.equal(deltaAfterFullReset.sampledRepeatsDelta, 0);
  assert.equal(deltaAfterFullReset.suppressedCategoriesDelta, 0);

  // LogSampler reset & clock rollback boundaries also never report negative counts
  const sampler = new LogSampler({ maxPerWindow: 1, windowMs: 1_000, now: clock.nowMs });
  sampler.record("scan:market");
  sampler.record("scan:market");
  sampler.record("scan:market");
  const samplerBefore = sampler.snapshot();
  assert.equal(samplerBefore.suppressedTotal, 2);
  assert.equal(samplerBefore.keys["scan:market"].aggregateCount, 3);

  // Clock steps backwards, then advances by windowMs -> rolls cleanly with non-negative counts
  clock.set(1_000);
  assert.equal(sampler.record("scan:market").log, false);
  clock.advance(1_000);
  assert.deepEqual(sampler.record("scan:market"), { log: true, suppressed: 3 });

  sampler.reset();
  sampler.record("scan:market");
  const samplerDelta = sampler.deltaSince(samplerBefore);
  assert.equal(samplerDelta.resetBoundaryCrossed, true);
  assert.equal(samplerDelta.suppressedDelta, 0);
  assert.equal(samplerDelta.keys["scan:market"].aggregateDelta, 1);

  // Suffix formatters clamp negative or NaN counts defensively
  assert.equal(formatSampledRepeatSuffix(-5, -10, -1_000), "");
  assert.equal(formatSampledRepeatSuffix(Number.NaN, 0, 1_000), "");
  assert.equal(
    formatSuppressedCategorySuffix("rpc_err", false, -4, -9),
    " [suppressed_category=rpc_err: +0 suppressed (1 total)]",
  );
  assert.ok(lines.length >= 2);
});

test("redacts secret substrings inside sampleKey and errorCategory labels", () => {
  const syntheticSecret = ["9988776655:AA", "Q".repeat(33)].join("");
  registerSecret(syntheticSecret);
  const lines = captureLoggerLines();
  Logger.configure({
    format: "json",
    secrets: [syntheticSecret],
    suppressedCategories: [`auth_${syntheticSecret}`],
  });

  Logger.error("boot", "auth failed", { errorCategory: `auth_${syntheticSecret}` });
  Logger.sampled("warn", "poller", `url:${syntheticSecret}`, "retry scheduled");

  for (const entry of lines) {
    assert.equal(entry.line.includes(syntheticSecret), false);
  }
  const catRecord = JSON.parse(lines[0].line);
  assert.equal(catRecord.errorCategory, "auth_[REDACTED]");
  const sampleRecord = JSON.parse(lines[1].line);
  assert.equal(sampleRecord.sampleKey, "url:[REDACTED]");
  assert.equal(sanitizeLogLabel(`  cat\n${syntheticSecret}  `), "cat [REDACTED]");
});
