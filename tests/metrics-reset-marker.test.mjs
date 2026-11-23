/**
 * Versioned metrics reset marker persistence & exposition tests.
 *
 * Uses ephemeral temporary directories; no live network calls or credentials.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  METRICS_RESET_MARKER_SCHEMA,
  METRICS_RESET_MARKER_VERSION,
  advanceMetricsResetMarkerSync,
  createMetrics,
  formatMetricsResetMarker,
  parseMetricsResetMarker,
} from "../dist/metrics.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "mimir-metrics-reset-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("createMetrics without resetMarkerFile starts at generation 1 in-memory and renders alongside counters", () => {
  const fixedNow = 1_700_000_000_000;
  const m = createMetrics({ now: () => fixedNow });

  assert.equal(m.resetGeneration.value(), 1);
  assert.equal(m.resetTimestampSeconds.value(), 1_700_000_000);
  assert.equal(m.resetMarkerWarning(), undefined);

  const marker = m.resetMarker();
  assert.equal(marker.schema, METRICS_RESET_MARKER_SCHEMA);
  assert.equal(marker.version, METRICS_RESET_MARKER_VERSION);
  assert.equal(marker.generation, 1);
  assert.equal(marker.resetAtMs, fixedNow);
  assert.equal(marker.resetAt, new Date(fixedNow).toISOString());

  m.pollCycles.inc(4);
  m.notificationsSent.inc(2);

  const text = m.render();
  assert.match(text, /mimir_bot_poll_cycles_total 4/);
  assert.match(text, /mimir_bot_notifications_sent_total 2/);
  assert.match(text, /# TYPE mimir_bot_reset_generation gauge/);
  assert.match(text, /mimir_bot_reset_generation 1/);
  assert.match(text, /# TYPE mimir_bot_reset_timestamp_seconds gauge/);
  assert.match(text, /mimir_bot_reset_timestamp_seconds 1700000000/);
});

test("reset marker persists and increments generation across restarts", () => {
  withTempDir((dir) => {
    const markerFile = path.join(dir, "state", "metrics-reset.json");

    // Boot 1: fresh start
    const m1 = createMetrics({ resetMarkerFile: markerFile, now: () => 1_700_000_100_000 });
    m1.pollCycles.inc(12);
    m1.notificationsSent.inc(5);
    assert.equal(m1.resetGeneration.value(), 1);
    assert.equal(m1.resetMarkerWarning(), undefined);

    const disk1 = JSON.parse(readFileSync(markerFile, "utf8"));
    assert.equal(disk1.schema, METRICS_RESET_MARKER_SCHEMA);
    assert.equal(disk1.version, METRICS_RESET_MARKER_VERSION);
    assert.equal(disk1.generation, 1);

    // Boot 2: simulated restart — counters reset to 0, but generation advances to 2
    const m2 = createMetrics({ resetMarkerFile: markerFile, now: () => 1_700_000_200_000 });
    assert.equal(m2.pollCycles.value(), 0);
    assert.equal(m2.notificationsSent.value(), 0);
    assert.equal(m2.resetGeneration.value(), 2);
    assert.equal(m2.resetTimestampSeconds.value(), 1_700_000_200);
    assert.equal(m2.resetMarkerWarning(), undefined);

    const rendered2 = m2.render();
    assert.match(rendered2, /mimir_bot_poll_cycles_total 0/);
    assert.match(rendered2, /mimir_bot_reset_generation 2/);

    // Boot 3: second restart — generation advances to 3
    const m3 = createMetrics({ resetMarkerFile: markerFile, now: () => 1_700_000_300_000 });
    assert.equal(m3.resetGeneration.value(), 3);
    assert.equal(m3.resetTimestampSeconds.value(), 1_700_000_300);

    const disk3 = JSON.parse(readFileSync(markerFile, "utf8"));
    assert.equal(disk3.generation, 3);
    assert.equal(
      formatMetricsResetMarker(m3.resetMarker()),
      `metrics_reset version=1 generation=3 reset_at=${new Date(1_700_000_300_000).toISOString()}`,
    );
  });
});

test("parseMetricsResetMarker rejects invalid payloads with specific reasons", () => {
  assert.deepEqual(parseMetricsResetMarker("{not-json"), { ok: false, reason: "invalid_json" });
  assert.deepEqual(parseMetricsResetMarker("[]"), { ok: false, reason: "invalid_schema" });
  assert.deepEqual(
    parseMetricsResetMarker(JSON.stringify({ schema: "wrong", version: 1, generation: 1, resetAtMs: 0 })),
    { ok: false, reason: "invalid_schema" },
  );
  assert.deepEqual(
    parseMetricsResetMarker(
      JSON.stringify({ schema: METRICS_RESET_MARKER_SCHEMA, version: 99, generation: 1, resetAtMs: 0 }),
    ),
    { ok: false, reason: "unsupported_version" },
  );
  assert.deepEqual(
    parseMetricsResetMarker(
      JSON.stringify({ schema: METRICS_RESET_MARKER_SCHEMA, version: 1, generation: 0, resetAtMs: 0 }),
    ),
    { ok: false, reason: "invalid_generation" },
  );
  assert.deepEqual(
    parseMetricsResetMarker(
      JSON.stringify({ schema: METRICS_RESET_MARKER_SCHEMA, version: 1, generation: 1, resetAtMs: -5 }),
    ),
    { ok: false, reason: "invalid_timestamp" },
  );
});

test("corrupt or unsupported version marker recovers to generation 1 and repairs file", () => {
  withTempDir((dir) => {
    const markerFile = path.join(dir, "metrics-reset.json");

    // Corrupt JSON
    writeFileSync(markerFile, "{corrupt json", "utf8");
    const corruptResult = advanceMetricsResetMarkerSync(markerFile, { now: () => 1_700_001_000_000 });
    assert.equal(corruptResult.persisted, true);
    assert.equal(corruptResult.marker.generation, 1);
    assert.equal(corruptResult.warning, "reset_marker_invalid_json");

    // Next restart increments cleanly from repaired file
    const nextResult = advanceMetricsResetMarkerSync(markerFile, { now: () => 1_700_002_000_000 });
    assert.equal(nextResult.persisted, true);
    assert.equal(nextResult.marker.generation, 2);
    assert.equal(nextResult.warning, undefined);

    // Unsupported future schema version
    writeFileSync(
      markerFile,
      JSON.stringify({
        schema: METRICS_RESET_MARKER_SCHEMA,
        version: 2,
        generation: 10,
        resetAtMs: 1_700_002_000_000,
      }),
      "utf8",
    );
    const versionResult = advanceMetricsResetMarkerSync(markerFile, { now: () => 1_700_003_000_000 });
    assert.equal(versionResult.persisted, true);
    assert.equal(versionResult.marker.generation, 1);
    assert.equal(versionResult.warning, "reset_marker_unsupported_version");
  });
});

test("unwritable marker path does not throw and falls back to in-memory generation 1", () => {
  withTempDir((dir) => {
    // Point markerFile at an existing directory so read/rename fail.
    const dirAsFile = path.join(dir, "occupied-dir");
    mkdirSync(dirAsFile);

    const m = createMetrics({ resetMarkerFile: dirAsFile, now: () => 1_700_004_000_000 });
    assert.equal(m.resetGeneration.value(), 1);
    assert.ok(
      typeof m.resetMarkerWarning() === "string" && m.resetMarkerWarning().includes("reset_marker_write_error"),
      `Expected write error warning, got: ${m.resetMarkerWarning()}`,
    );
  });
});
