/**
 * Focused automated coverage for bounded dropped metric sample reason counters (#868):
 *  - Counting `invalid_number` (`NaN`, `Infinity`, `-Infinity`) on counters, gauges, and `recordSample`
 *  - Counting `negative_delta` while preserving existing `RangeError` behavior on `Counter.inc(-1)`
 *  - Counting `unknown_label` and `unknown_metric` on labeled metrics, `recordSample`, `RpcTiming`, and `buildMetricsReport`
 *  - Guaranteeing `NaN`, `Infinity`, and `-Infinity` never appear in Prometheus exposition output
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildMetricsReport } from "../dist/health.js";
import { createMetrics, DROPPED_SAMPLE_REASONS } from "../dist/metrics.js";
import { DroppedMetricSamplesTracker, RpcTiming } from "../dist/stellar/metrics.js";

const FAKE_BOT_SECRET = ["123456:fake", "secret"].join("-");
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

function assertNoNonFinitePrometheusLines(exposition) {
  for (const line of exposition.split(/\r?\n|\\n/)) {
    if (!line || line.startsWith("#")) continue;
    assert.doesNotMatch(
      line,
      /\b(?:NaN|Infinity|-Infinity)\b/,
      `Prometheus line emitted non-finite value: "${line}"`,
    );
  }
}

test("Counter and Gauge reject NaN and Infinity without poisoning Prometheus output", () => {
  const m = createMetrics();
  m.pollCycles.inc(4);
  m.consecutiveFailures.set(2);

  // Attempt invalid updates
  m.pollCycles.inc(Number.NaN);
  m.pollCycles.inc(Number.POSITIVE_INFINITY);
  m.pollCycles.inc(Number.NEGATIVE_INFINITY);
  m.consecutiveFailures.set(Number.NaN);
  m.consecutiveFailures.set(Number.POSITIVE_INFINITY);
  m.consecutiveFailures.set(Number.NEGATIVE_INFINITY);

  // Negative counter delta still throws RangeError and increments `negative_delta`
  assert.throws(() => m.pollCycles.inc(-3), RangeError);

  assert.equal(m.pollCycles.value(), 4);
  assert.equal(m.consecutiveFailures.value(), 2);
  assert.equal(m.droppedSamples.value("invalid_number"), 6);
  assert.equal(m.droppedSamples.value("negative_delta"), 1);
  assert.equal(m.droppedSamples.value("unknown_label"), 0);
  assert.equal(m.droppedSamples.value("unknown_metric"), 0);
  assert.equal(m.droppedSamples.value(), 7);

  const output = m.render();
  assertNoNonFinitePrometheusLines(output);
  assert.ok(output.includes("mimir_bot_poll_cycles_total 4"));
  assert.ok(output.includes("mimir_bot_consecutive_failures 2"));
  assert.ok(
    output.includes('mimir_bot_dropped_metric_samples_total{reason="invalid_number"} 6'),
  );
  assert.ok(
    output.includes('mimir_bot_dropped_metric_samples_total{reason="negative_delta"} 1'),
  );
  assert.ok(
    output.includes('mimir_bot_dropped_metric_samples_total{reason="unknown_label"} 0'),
  );
  assert.ok(
    output.includes('mimir_bot_dropped_metric_samples_total{reason="unknown_metric"} 0'),
  );
});

test("defineLabeledCounter, defineLabeledGauge, and recordSample count unknown labels and unknown metrics", () => {
  const m = createMetrics();
  const targetCounter = m.defineLabeledCounter({
    name: "mimir_bot_custom_events_total",
    help: "Events per bounded target.",
    labelNames: ["source"],
    allowedValues: { source: ["market", "squad"] },
  });
  const targetGauge = m.defineLabeledGauge({
    name: "mimir_bot_custom_lag_ms",
    help: "Lag per bounded target.",
    labelNames: ["source"],
    allowedValues: { source: ["market", "squad"] },
  });

  // Valid labeled updates
  targetCounter.inc({ source: "market" }, 3);
  targetGauge.set({ source: "squad" }, 125);
  assert.equal(targetCounter.value({ source: "market" }), 3);
  assert.equal(targetGauge.value({ source: "squad" }), 125);

  // Unknown label key, missing label key, disallowed value, and control-char label value
  targetCounter.inc({ source: "market", extra: "bad" }, 1);
  targetCounter.inc({}, 1);
  targetCounter.inc({ source: "-1001234567890" }, 1);
  targetGauge.set({ source: "market\x00injected" }, 10);

  // Non-throwing recordSample checks
  assert.equal(m.recordSample("nonexistent_metric_total", 1), false); // unknown_metric (1)
  assert.equal(m.recordSample("pollCycles", 5, { unexpected: "x" }), false); // unknown_label (5)
  assert.equal(m.recordSample("pollCycles", Number.NaN), false); // invalid_number (1)
  assert.equal(m.recordSample("pollCycles", -2), false); // negative_delta (1)
  assert.equal(m.recordSample("mimir_bot_custom_events_total", 2, { source: "squad" }), true);

  assert.equal(m.droppedSamples.value("unknown_label"), 5);
  assert.equal(m.droppedSamples.value("unknown_metric"), 1);
  assert.equal(m.droppedSamples.value("invalid_number"), 1);
  assert.equal(m.droppedSamples.value("negative_delta"), 1);
  assert.equal(targetCounter.value({ source: "squad" }), 2);

  const output = m.render();
  assertNoNonFinitePrometheusLines(output);
  assert.ok(output.includes('mimir_bot_custom_events_total{source="market"} 3'));
  assert.ok(output.includes('mimir_bot_custom_events_total{source="squad"} 2'));
  assert.ok(output.includes('mimir_bot_custom_lag_ms{source="squad"} 125'));
  assert.ok(!output.includes("-1001234567890"));
});

test("DroppedMetricSamplesTracker keeps reason cardinality strictly bounded under untrusted inputs", () => {
  const tracker = new DroppedMetricSamplesTracker();
  tracker.recordDrop("invalid_number", 2);
  tracker.recordDrop("attacker_reason_12345", 1);
  tracker.recordDrop("invalid_number", Number.NaN);

  const snap = tracker.byReason();
  assert.deepEqual(Object.keys(snap), [...DROPPED_SAMPLE_REASONS]);
  assert.equal(snap.invalid_number, 3);
  assert.equal(snap.unknown_label, 1);
});

test("RpcTiming counts non-finite durations, negative durations, and unknown operation labels without crashing", () => {
  const timing = new RpcTiming(() => 0);
  timing.record("health", 8, true);
  timing.record("events", Number.NaN, true);
  timing.record("events", Number.POSITIVE_INFINITY, true);
  timing.record("events", -25, false);
  timing.record("untrusted_op", 10, true);

  const summary = timing.summary();
  assert.equal(summary.requests, 4);
  assert.equal(summary.failures, 1);
  assert.equal(summary.totalMs, 8);
  assert.deepEqual(timing.droppedSamples(), {
    invalid_number: 2,
    negative_delta: 1,
    unknown_label: 1,
    unknown_metric: 0,
  });
  assert.equal(timing.droppedSamplesTotal(), 4);
});

test("buildMetricsReport suppresses NaN/Infinity fields and unknown target labels while incrementing bounded drop reasons", () => {
  const config = {
    version: "0.1.0",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: FAKE_BOT_SECRET,
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };

  const corruptedStatus = {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: Number.NaN, // invalid_number #1
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: Number.POSITIVE_INFINITY, // invalid_number #2
    oldestLedger: 1,
    chainClockAt: 5_000,
    notificationsSent: 9,
    notificationsFailed: 0,
    eventsSkipped: 0,
    activityBaseline: {
      window: 20,
      samples: 5,
      warmedUp: true,
      lastValue: 3,
      baselineMean: 3,
      baselineStdDev: 0,
      zScore: Number.NaN, // invalid_number #3
      anomalous: false,
      deviation: "normal",
      anomalies: 0,
    },
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    droppedMetricSamples: { unknown_metric: 2 },
    targets: [
      {
        source: "market",
        contractId: MARKET_ID,
        cursor: null,
        lastEventLedger: 100,
        lastError: null,
      },
      {
        source: "rogue_target", // unknown_label #1
        contractId: SQUAD_ID,
        cursor: null,
        lastEventLedger: 101,
        lastError: null,
      },
      {
        source: "squad",
        contractId: SQUAD_ID,
        cursor: null,
        lastEventLedger: Number.NEGATIVE_INFINITY, // invalid_number #4
        lastError: null,
      },
    ],
  };

  const report = buildMetricsReport(config, corruptedStatus, 6_000);
  assertNoNonFinitePrometheusLines(report);
  assert.ok(!report.includes("rogue_target"));
  assert.ok(report.includes('mimir_telegram_notifications_sent_total{network="testnet"} 9'));
  assert.ok(
    report.includes(
      'mimir_telegram_dropped_metric_samples_total{network="testnet",reason="invalid_number"} 4',
    ),
  );
  assert.ok(
    report.includes(
      'mimir_telegram_dropped_metric_samples_total{network="testnet",reason="unknown_label"} 1',
    ),
  );
  assert.ok(
    report.includes(
      'mimir_telegram_dropped_metric_samples_total{network="testnet",reason="unknown_metric"} 2',
    ),
  );
});
