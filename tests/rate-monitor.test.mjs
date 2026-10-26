/**
 * Event-rate monitor tests (issue #450).
 *
 * Every case drives an injected clock, so windows open and close exactly
 * where the test says and the results are deterministic.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createRateMonitor, MAX_SOURCE_LENGTH } from "../dist/stellar/rate-monitor.js";

const WINDOW = 1_000;

function setup(overrides = {}) {
  let now = 0;
  const monitor = createRateMonitor({
    windowMs: WINDOW,
    baselineWindows: 4,
    silenceWindows: 2,
    spikeFactor: 3,
    clock: () => now,
    ...overrides,
  });
  return {
    monitor,
    /** Record `count` events in the current window, then advance one window. */
    windowOf(source, count) {
      monitor.observe(source, count);
      now += WINDOW;
    },
    advance(windows = 1) {
      now += windows * WINDOW;
    },
    stateOf(source) {
      return monitor.check().sources.find((s) => s.source === source);
    },
  };
}

test("warm-up: no alert before the baseline has enough completed windows", () => {
  const t = setup();
  // A huge first windows must not look like a spike against nothing.
  t.windowOf("market", 500);
  t.windowOf("market", 0);
  t.windowOf("market", 0);
  assert.equal(t.stateOf("market").state, "warming-up");
  assert.deepEqual(t.monitor.check().alerts, []);
  t.windowOf("market", 900);
  assert.equal(t.stateOf("market").state, "warming-up");
  assert.deepEqual(t.monitor.check().alerts, []);
});

test("an open window is never judged: a fresh source has no completed window", () => {
  const t = setup();
  t.monitor.observe("squad", 3);
  const report = t.stateOf("squad");
  assert.equal(report.state, "warming-up");
  assert.equal(report.latest, null);
  assert.equal(report.windowStart, null);
});

test("normal: steady activity after warm-up reports normal with its baseline", () => {
  const t = setup();
  for (let i = 0; i < 6; i++) t.windowOf("market", 5);
  const report = t.stateOf("market");
  assert.equal(report.state, "normal");
  assert.equal(report.baseline, 5);
  assert.equal(report.latest, 5);
  assert.equal(report.windowStart, 5 * WINDOW);
});

test("spike: a window above k times the baseline raises a spike alert", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 4);
  t.windowOf("market", 13); // 13 > 3 × 4
  const { alerts } = t.monitor.check();
  assert.deepEqual(alerts, [
    { source: "market", kind: "spike", latest: 13, baseline: 4, windowStart: 4 * WINDOW },
  ]);
});

test("spike: exactly k times the baseline is not a spike", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 4);
  t.windowOf("market", 12);
  assert.equal(t.stateOf("market").state, "normal");
});

test("spike: the spiking window does not dilute its own baseline", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 2);
  t.windowOf("market", 100);
  assert.equal(t.stateOf("market").baseline, 2);
});

test("spike: minBaseline keeps a near-silent source from spiking on a handful of events", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 0);
  t.windowOf("market", 2); // 2 <= 3 × max(0, 1)
  assert.equal(t.stateOf("market").state, "normal");
  t.windowOf("market", 4); // baseline still ~0.5 → floor 1, 4 > 3
  assert.equal(t.stateOf("market").state, "spike");
});

test("silence: N empty windows after a non-zero baseline raise a silence alert", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("squad", 6);
  t.advance(1);
  assert.equal(t.stateOf("squad").state, "normal", "one empty window is not yet a silence");
  t.advance(1);
  const { alerts } = t.monitor.check();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "silence");
  assert.equal(alerts[0].source, "squad");
  assert.equal(alerts[0].latest, 0);
  assert.equal(alerts[0].baseline, 6);
});

test("silence: a source that has always been quiet is never silent", () => {
  const t = setup();
  for (let i = 0; i < 10; i++) t.windowOf("squad", 0);
  assert.equal(t.stateOf("squad").state, "normal");
  assert.deepEqual(t.monitor.check().alerts, []);
});

test("silence: a long gap with no observe() calls is back-filled and detected", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 3);
  t.advance(50);
  assert.equal(t.stateOf("market").state, "silence");
});

test("recovery: activity after a silence or spike returns the source to normal", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 5);
  t.advance(2);
  assert.equal(t.stateOf("market").state, "silence");
  // Back to steady traffic; baseline shifts but state recovers.
  for (let i = 0; i < 4; i++) t.windowOf("market", 5);
  assert.equal(t.stateOf("market").state, "normal");

  t.windowOf("market", 40);
  assert.equal(t.stateOf("market").state, "spike");
  t.windowOf("market", 5);
  assert.equal(t.stateOf("market").state, "normal");
  assert.deepEqual(t.monitor.check().alerts, []);
});

test("sources are judged independently", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) {
    t.monitor.observe("market", 5);
    t.windowOf("squad", 5);
  }
  t.monitor.observe("market", 50);
  t.windowOf("squad", 5);
  const states = Object.fromEntries(t.monitor.check().sources.map((s) => [s.source, s.state]));
  assert.deepEqual(states, { market: "spike", squad: "normal" });
});

test("several observe() calls in one window are summed", () => {
  const t = setup();
  for (let i = 0; i < 4; i++) t.windowOf("market", 2);
  t.monitor.observe("market", 3);
  t.monitor.observe("market", 4);
  t.windowOf("market", 0);
  assert.equal(t.stateOf("market").latest, 7);
  assert.equal(t.stateOf("market").state, "spike");
});

test("deterministic: identical inputs and clock produce identical reports", () => {
  const run = () => {
    const t = setup();
    for (const c of [1, 4, 2, 9, 0, 30, 0, 0, 3]) t.windowOf("market", c);
    return t.monitor.check();
  };
  assert.deepEqual(run(), run());
});

test("bounded memory: sources are capped and the least recently observed is evicted", () => {
  const t = setup({ maxSources: 3 });
  t.monitor.observe("a", 1);
  t.monitor.observe("b", 1);
  t.monitor.observe("c", 1);
  t.monitor.observe("a", 1); // refresh a
  t.monitor.observe("d", 1); // evicts b
  assert.equal(t.monitor.size(), 3);
  const names = t.monitor.check().sources.map((s) => s.source).sort();
  assert.deepEqual(names, ["a", "c", "d"]);
});

test("bounded memory: long source labels are clipped", () => {
  const t = setup();
  t.monitor.observe("x".repeat(500), 1);
  const [report] = t.monitor.check().sources;
  assert.equal(report.source.length, MAX_SOURCE_LENGTH);
});

test("invalid counts are ignored and invalid options are rejected", () => {
  const t = setup();
  t.monitor.observe("market", -5);
  t.monitor.observe("market", Number.NaN);
  assert.equal(t.monitor.size(), 0);
  assert.throws(() => createRateMonitor({ windowMs: 0, baselineWindows: 3 }), RangeError);
  assert.throws(() => createRateMonitor({ windowMs: 1000, baselineWindows: 0 }), RangeError);
  assert.throws(() => createRateMonitor({ windowMs: 1000, baselineWindows: 2.5 }), RangeError);
});
