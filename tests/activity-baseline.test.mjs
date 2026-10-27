/**
 * Activity baseline unit tests.
 *
 * The module is pure, so every case here is table-driven and needs no RPC,
 * clock, or poller. The poller integration is covered separately in
 * activity-baseline-poller.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityBaseline,
  emptyActivityBaseline,
} from "../dist/activity-baseline.js";

test("empty baseline reports warming-up and no fabricated statistics", () => {
  assert.deepEqual(emptyActivityBaseline(), {
    windowSize: 20,
    minSamples: 10,
    zThreshold: 3,
    samples: 0,
    lastValue: null,
    baselineMean: null,
    baselineStdDev: null,
    zScore: null,
    deviation: "warming-up",
    anomalies: 0,
  });
});

test("record stays warming-up until minSamples prior observations exist", () => {
  const baseline = new ActivityBaseline({ windowSize: 5, minSamples: 3 });
  const deviations = [4, 4, 4, 4].map((value) => baseline.record(value).deviation);
  assert.deepEqual(deviations, ["warming-up", "warming-up", "warming-up", "normal"]);

  // The fourth call is the first with three prior observations.
  const fifth = baseline.record(4);
  assert.equal(fifth.samples, 4);
  assert.equal(fifth.mean, 4);
  assert.equal(fifth.stdDev, 0);
  assert.equal(fifth.zScore, 0);
  assert.equal(fifth.deviation, "normal");
  assert.equal(fifth.anomalous, false);
});

test("a value far above a stable baseline is a spike", () => {
  const baseline = new ActivityBaseline({ windowSize: 10, minSamples: 3 });
  for (const value of [5, 5, 5, 5]) baseline.record(value);

  const comparison = baseline.record(50);
  assert.equal(comparison.deviation, "spike");
  assert.equal(comparison.anomalous, true);
  assert.equal(comparison.mean, 5);
  assert.equal(comparison.stdDev, 0);
  assert.equal(comparison.zScore, 45);
  assert.equal(baseline.snapshot().anomalies, 1);
});

test("a value far below a stable baseline is a drop", () => {
  const baseline = new ActivityBaseline({ windowSize: 10, minSamples: 3 });
  for (const value of [12, 12, 12, 12]) baseline.record(value);

  const comparison = baseline.record(0);
  assert.equal(comparison.deviation, "drop");
  assert.equal(comparison.anomalous, true);
  assert.equal(comparison.mean, 12);
  assert.equal(comparison.zScore, -12);
  assert.equal(baseline.snapshot().anomalies, 1);
});

test("scaleFloor keeps a flat zero baseline from dividing by zero", () => {
  const baseline = new ActivityBaseline({
    windowSize: 10,
    minSamples: 3,
    zThreshold: 3,
    scaleFloor: 2,
  });
  for (const value of [0, 0, 0, 0]) baseline.record(value);

  assert.equal(baseline.record(1).deviation, "normal");
  // The window is now [0, 0, 0, 0, 1]: mean 0.2, sd ≈ 0.447, so
  // (10 − 0.2) / 2 = 4.9, still far above the threshold.
  const burst = baseline.record(10);
  assert.ok(Math.abs(burst.zScore - 4.9) < 1e-12, `zScore=${burst.zScore}`);
  assert.equal(burst.deviation, "spike");
});

test("the window is bounded and evicts the oldest observations", () => {
  const baseline = new ActivityBaseline({ windowSize: 3, minSamples: 2 });
  baseline.record(100);
  baseline.record(100);
  baseline.record(100);
  assert.equal(baseline.snapshot().samples, 3);

  // Replace the busy history with quiet cycles; the mean must follow the
  // retained window rather than the whole process lifetime. Three zeroes are
  // needed to evict all three 100s.
  baseline.record(0);
  baseline.record(0);
  baseline.record(0);
  const comparison = baseline.record(0);
  assert.equal(baseline.snapshot().samples, 3);
  assert.equal(comparison.mean, 0);
  assert.equal(comparison.deviation, "normal");
});

test("each value is compared before it is appended", () => {
  const baseline = new ActivityBaseline({ windowSize: 5, minSamples: 3 });
  for (const value of [5, 5, 5]) baseline.record(value);

  // A spike must not dilute its own baseline: the mean stays 5 for this call.
  const spike = baseline.record(55);
  assert.equal(spike.mean, 5);
  assert.equal(spike.deviation, "spike");

  // The NEXT observation compares against the widened window [5, 5, 5, 55].
  const next = baseline.record(5);
  assert.equal(next.mean, 17.5);
  assert.equal(next.samples, 4);
  assert.equal(next.deviation, "normal");
});

test("reset clears the window, the last comparison and anomaly history", () => {
  const baseline = new ActivityBaseline({ windowSize: 5, minSamples: 2 });
  baseline.record(1);
  baseline.record(1);
  const anomaly = baseline.record(100);
  assert.equal(anomaly.deviation, "spike");
  assert.equal(baseline.snapshot().anomalies, 1);

  baseline.reset();
  assert.deepEqual(baseline.snapshot(), {
    windowSize: 5,
    minSamples: 2,
    zThreshold: 3,
    samples: 0,
    lastValue: null,
    baselineMean: null,
    baselineStdDev: null,
    zScore: null,
    deviation: "warming-up",
    anomalies: 0,
  });
});

test("malformed counts and options fail loudly", () => {
  const baseline = new ActivityBaseline({ windowSize: 5, minSamples: 2 });
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => baseline.record(value), RangeError, `value ${value}`);
  }

  assert.throws(() => new ActivityBaseline({ windowSize: 0 }), RangeError);
  assert.throws(() => new ActivityBaseline({ minSamples: 0 }), RangeError);
  assert.throws(
    () => new ActivityBaseline({ windowSize: 2, minSamples: 3 }),
    /cannot exceed windowSize/,
  );
  assert.throws(() => new ActivityBaseline({ zThreshold: 0 }), RangeError);
  assert.throws(() => new ActivityBaseline({ scaleFloor: -1 }), RangeError);
});

