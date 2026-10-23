import test from 'node:test';
import assert from 'node:assert';

import { RpcTiming, formatRpcTiming } from '../dist/stellar/metrics.js';

// Pins the statistics RpcTiming reports and the line formatRpcTiming prints.
// Durations are injected through record() (no real timers), so every
// expectation below is hand-computed and exact.
//
// RpcTiming (#58/#309) deliberately keeps only fixed-size aggregates per
// operation (requests, failures, total/min/max ms) so memory is O(1) and no
// sample is retained. It therefore has no percentiles and no sample window;
// the #665 version of this file guessed at such an API (and at several
// record() signatures) and never matched the real class.

function recordAll(timing, operation, durations, ok = true) {
  for (const d of durations) timing.record(operation, d, ok);
}

test('RpcTiming reports min/max/average for a skewed distribution', () => {
  const timing = new RpcTiming();
  // [1, 2, 3, 4, 100]: min 1, max 100, avg 110 / 5 = 22
  recordAll(timing, 'events', [1, 2, 3, 4, 100]);

  const stats = timing.summary();
  assert.strictEqual(stats.requests, 5);
  assert.strictEqual(stats.minMs, 1);
  assert.strictEqual(stats.maxMs, 100);
  assert.strictEqual(stats.totalMs, 110);
  assert.strictEqual(stats.avgMs, 22);
});

test('RpcTiming aggregates across operations and keeps per-operation figures', () => {
  const timing = new RpcTiming();
  recordAll(timing, 'health', [5, 15]);
  recordAll(timing, 'events', [30, 50]);

  const stats = timing.summary();
  assert.deepStrictEqual(stats.operations, {
    health: { requests: 2, failures: 0, totalMs: 20, minMs: 5, maxMs: 15 },
    events: { requests: 2, failures: 0, totalMs: 80, minMs: 30, maxMs: 50 },
  });
  // Overall: min 5, max 50, avg 100 / 4 = 25
  assert.strictEqual(stats.minMs, 5);
  assert.strictEqual(stats.maxMs, 50);
  assert.strictEqual(stats.avgMs, 25);
});

test('RpcTiming state stays bounded after many observations', () => {
  const timing = new RpcTiming();
  const total = 5000;
  for (let i = 0; i < total; i++) timing.record('events', i, true);

  const stats = timing.summary();
  // Every observation is counted, but only aggregates are kept: the summary
  // has the same fixed shape however many requests were recorded.
  assert.strictEqual(stats.requests, total);
  assert.strictEqual(stats.minMs, 0);
  assert.strictEqual(stats.maxMs, total - 1);
  // sum(0..4999) = 4999 * 5000 / 2 = 12_497_500; avg = 2499.5
  assert.strictEqual(stats.totalMs, 12_497_500);
  assert.strictEqual(stats.avgMs, 2499.5);
  assert.deepStrictEqual(Object.keys(stats.operations.events).sort(), [
    'failures', 'maxMs', 'minMs', 'requests', 'totalMs',
  ]);
});

test('RpcTiming counts failures alongside successes', () => {
  const timing = new RpcTiming();
  recordAll(timing, 'events', [10, 20, 30], true);
  recordAll(timing, 'events', [40, 50], false);

  const stats = timing.summary();
  assert.strictEqual(stats.failures, 2, 'two failures were recorded');
  assert.strictEqual(stats.requests - stats.failures, 3, 'three successes were recorded');
  assert.strictEqual(stats.requests, 5, 'requests counts successes and failures');
  // Failed requests still contribute their duration: avg = 150 / 5 = 30
  assert.strictEqual(stats.avgMs, 30);
});

test('RpcTiming clamps non-finite and negative durations to 0', () => {
  const timing = new RpcTiming();
  timing.record('health', Number.NaN, true);
  timing.record('health', -5, true);
  timing.record('health', 9, true);
  const stats = timing.summary();
  assert.strictEqual(stats.minMs, 0);
  assert.strictEqual(stats.maxMs, 9);
  assert.strictEqual(stats.avgMs, 3);
});

test('formatRpcTiming produces the exact one-line summary', () => {
  const timing = new RpcTiming();
  // events: min 10, max 50, avg (10+20+30+40+50) / 5 = 30; one health probe
  recordAll(timing, 'events', [10, 20, 30, 40, 50]);
  timing.record('health', 30, false);

  assert.strictEqual(
    formatRpcTiming(timing.summary()),
    'rpc requests=6 failures=1 total=180ms avg=30ms max=50ms health=1 events=5',
  );
});
