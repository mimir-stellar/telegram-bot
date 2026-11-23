/**
 * Focused coverage for the bounded RPC latency histogram (#805):
 *  - Fixed provider identity and bounded operation classes (no URL-derived labels)
 *  - Finite bucket validation and failure/boundary handling
 *  - Cumulative bucket placement, `+Inf`, and Prometheus exposition
 *  - Wiring through RpcTiming, paginatedGetEvents, and both /metrics surfaces
 *
 * All durations are injected; no live RPC, Telegram credentials, or keys.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { paginatedGetEvents } from "../dist/stellar/events.js";
import {
  classifyRpcLatencyOperation,
  DEFAULT_RPC_LATENCY_BUCKETS_MS,
  RPC_LATENCY_OPERATIONS,
  RPC_PROVIDER_ID,
  RpcLatencyHistogram,
  RpcTiming,
  validateFiniteLatencyBucketsMs,
} from "../dist/stellar/metrics.js";

const URL_WITH_QUERY = "https://rpc.example.invalid/rpc?page=7&region=west";
const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

function sampleConfig() {
  return {
    version: "0.1.0",
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: URL_WITH_QUERY,
    pollIntervalMs: 30_000,
    healthStaleMs: 90_000,
  };
}

function sampleStatus(rpcLatency) {
  return {
    running: true,
    paused: false,
    stopping: false,
    startedAt: 1_000,
    cycles: 1,
    lastPollAt: 2_000,
    lastSuccessAt: 2_000,
    latestLedger: 50,
    oldestLedger: 1,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    targets: [],
    rpcLatency,
  };
}

test("provider identity is fixed and operation classes are bounded", () => {
  assert.equal(RPC_PROVIDER_ID, "soroban-rpc");
  assert.deepEqual(RPC_LATENCY_OPERATIONS, ["health", "events", "other"]);
  assert.equal(classifyRpcLatencyOperation("health"), "health");
  assert.equal(classifyRpcLatencyOperation("  EVENTS "), "events");

  for (const untrusted of [URL_WITH_QUERY, "https://rpc.example.invalid", "custom", "", null, 42, {}]) {
    assert.equal(classifyRpcLatencyOperation(untrusted), "other");
  }
});

test("finite bucket bounds reject empty, non-finite, non-positive, and unsorted values", () => {
  assert.deepEqual(validateFiniteLatencyBucketsMs(DEFAULT_RPC_LATENCY_BUCKETS_MS), [
    5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 15_000,
  ]);

  for (const invalid of [[], [0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [10, 10], [20, 5], ["5"]]) {
    assert.throws(() => validateFiniteLatencyBucketsMs(invalid), RangeError);
  }
  assert.throws(() => new RpcLatencyHistogram([5, Number.POSITIVE_INFINITY]), RangeError);
  assert.throws(() => createMetrics({ rpcLatencyBucketsMs: [] }), RangeError);
});

test("histogram counts cumulative finite buckets and overflow without leaking URL labels", () => {
  const histogram = new RpcLatencyHistogram([5, 10, 25]);
  histogram.observe("health", 5);
  histogram.observe("health", -3);
  histogram.observe("events", 10);
  histogram.observe("events", 26);
  histogram.observe(URL_WITH_QUERY, Number.NaN);

  const snapshot = histogram.snapshot();
  assert.equal(snapshot.provider, RPC_PROVIDER_ID);
  assert.deepEqual(snapshot.bucketsMs, [5, 10, 25]);
  assert.deepEqual(snapshot.operations.health, {
    operation: "health",
    bucketCounts: [2, 2, 2],
    count: 2,
    sumMs: 5,
  });
  assert.deepEqual(snapshot.operations.events, {
    operation: "events",
    bucketCounts: [0, 1, 1],
    count: 2,
    sumMs: 36,
  });
  assert.deepEqual(snapshot.operations.other, {
    operation: "other",
    bucketCounts: [1, 1, 1],
    count: 1,
    sumMs: 0,
  });

  const rendered = histogram
    .renderPrometheusLines("mimir_bot_rpc_request_latency_ms", "RPC latency in ms.", {
      network: "testnet",
    })
    .join("\n");
  assert.ok(rendered.includes('# TYPE mimir_bot_rpc_request_latency_ms histogram'));
  assert.ok(
    rendered.includes(
      'mimir_bot_rpc_request_latency_ms_bucket{network="testnet",provider="soroban-rpc",operation="health",le="5"} 2',
    ),
  );
  assert.ok(
    rendered.includes(
      'mimir_bot_rpc_request_latency_ms_bucket{network="testnet",provider="soroban-rpc",operation="events",le="+Inf"} 2',
    ),
  );
  assert.ok(rendered.includes('mimir_bot_rpc_request_latency_ms_count{network="testnet",provider="soroban-rpc",operation="other"} 1'));
  assert.ok(!rendered.includes("rpc.example.invalid"), rendered);
  assert.ok(!rendered.includes("page=7"), rendered);
  // Three operations x (three finite buckets + +Inf + sum + count) = 18 series.
  const series = rendered.split("\n").filter((line) => line.startsWith("mimir_bot_rpc_request_latency_ms_"));
  assert.equal(series.length, 18);
});

test("RpcTiming mirrors successes and failures with counts matching its summary", async () => {
  let now = 0;
  const histogram = new RpcLatencyHistogram([5, 10]);
  const timing = new RpcTiming(() => now, histogram);

  await timing.measure("health", async () => {
    now += 4;
  });
  await assert.rejects(
    timing.measure("events", async () => {
      now += 30;
      throw new Error("rpc down");
    }),
    /rpc down/,
  );
  timing.record("events", Number.NaN, true);

  const snapshot = histogram.snapshot();
  assert.equal(snapshot.operations.health.count, 1);
  assert.equal(snapshot.operations.health.sumMs, 4);
  assert.equal(snapshot.operations.events.count, 2);
  assert.equal(snapshot.operations.events.sumMs, 30);
  assert.equal(snapshot.operations.events.count, timing.summary().operations.events.requests);
});

test("paginatedGetEvents records pages and failures under the fixed provider", async () => {
  const histogram = new RpcLatencyHistogram([5, 10]);
  const filters = [{ type: "contract", contractIds: [MARKET_ID] }];

  const server = {
    async getHealth() {
      return { oldestLedger: 1, latestLedger: 50 };
    },
    async getEvents() {
      return { events: [], cursor: "", latestLedger: 50 };
    },
  };
  const scan = await paginatedGetEvents(server, filters, { startLedger: 1, rpcLatency: histogram });
  assert.equal(scan.timing.requests, 2);
  assert.equal(histogram.snapshot().operations.health.count, 1);
  assert.equal(histogram.snapshot().operations.events.count, 1);

  const failing = {
    async getHealth() {
      return { oldestLedger: 1, latestLedger: 50 };
    },
    async getEvents() {
      throw new Error("rpc down");
    },
  };
  await assert.rejects(
    paginatedGetEvents(failing, filters, { startLedger: 1, rpcLatency: histogram }),
    /rpc down/,
  );
  assert.equal(histogram.snapshot().operations.events.count, 2);
});

test("both /metrics surfaces expose the histogram and omit RPC URL details", () => {
  const histogram = new RpcLatencyHistogram([5, 10]);
  histogram.observe("events", 7);

  const healthOutput = buildMetricsReport(
    sampleConfig(),
    sampleStatus(histogram.snapshot()),
    3_000,
  );
  assert.ok(healthOutput.includes("# TYPE mimir_telegram_rpc_request_latency_ms histogram"));
  assert.ok(
    healthOutput.includes(
      'mimir_telegram_rpc_request_latency_ms_bucket{network="testnet",provider="soroban-rpc",operation="events",le="10"} 1',
    ),
  );
  assert.ok(!healthOutput.includes("rpc.example.invalid"), healthOutput);
  assert.ok(!healthOutput.includes("page=7"), healthOutput);

  const registry = createMetrics({ rpcLatencyBucketsMs: [5, 10] });
  registry.rpcLatency.observe(URL_WITH_QUERY, 4);
  const standaloneOutput = registry.render();
  assert.ok(standaloneOutput.includes("# TYPE mimir_bot_rpc_request_latency_ms histogram"));
  assert.ok(
    standaloneOutput.includes(
      'mimir_bot_rpc_request_latency_ms_bucket{provider="soroban-rpc",operation="other",le="5"} 1',
    ),
  );
  assert.ok(!standaloneOutput.includes("rpc.example.invalid"), standaloneOutput);
  assert.ok(!standaloneOutput.includes("region=west"), standaloneOutput);
});
