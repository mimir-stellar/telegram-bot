import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMetrics } from "../dist/metrics.js";
import {
  DEFAULT_MAX_RPC_HISTOGRAM_PROVIDERS,
  DEFAULT_RPC_LATENCY_BUCKETS_MS,
  INVALID_RPC_PROVIDER_ID,
  MAX_RPC_LATENCY_BUCKETS,
  OVERFLOW_RPC_PROVIDER_ID,
  RpcProviderLatencyHistograms,
  canonicalRpcProviderId,
  instrumentRpcServer,
} from "../dist/stellar/client.js";

describe("canonicalRpcProviderId (#805)", () => {
  it("normalizes HTTP(S) URLs to lowercase origin and strips paths, query strings, fragments, and credentials", () => {
    const userInfo = ["op", ":", "redacted"].join("");
    const querySecret = ["api_key", "=", "secret-value-42"].join("");
    const raw = `HTTPS://${userInfo}@Soroban-Testnet.Stellar.ORG:443/v1/rpc/key-segment?${querySecret}&foo=bar#frag`;

    const id = canonicalRpcProviderId(raw);
    assert.equal(id, "https://soroban-testnet.stellar.org");
    assert.equal(id.includes("?"), false);
    assert.equal(id.includes("secret-value-42"), false);
    assert.equal(id.includes("key-segment"), false);
    assert.equal(id.includes("redacted"), false);
  });

  it("retains non-default ports while omitting standard :80 and :443 ports", () => {
    assert.equal(
      canonicalRpcProviderId("http://127.0.0.1:8000/rpc?debug=1"),
      "http://127.0.0.1:8000",
    );
    assert.equal(
      canonicalRpcProviderId("http://localhost:80/rpc"),
      "http://localhost",
    );
  });

  it("maps malformed, non-HTTP(S), or oversized inputs to the fixed invalid label", () => {
    assert.equal(canonicalRpcProviderId(""), INVALID_RPC_PROVIDER_ID);
    assert.equal(canonicalRpcProviderId("not a url"), INVALID_RPC_PROVIDER_ID);
    assert.equal(canonicalRpcProviderId("wss://soroban.stellar.org/rpc"), INVALID_RPC_PROVIDER_ID);
    assert.equal(canonicalRpcProviderId("file:///etc/passwd"), INVALID_RPC_PROVIDER_ID);
    assert.equal(
      canonicalRpcProviderId(`https://${"a".repeat(140)}.example.org/rpc`),
      INVALID_RPC_PROVIDER_ID,
    );
  });
});

describe("RpcProviderLatencyHistograms (#805)", () => {
  it("records cumulative finite histogram buckets and +Inf count per fixed provider identity", () => {
    const h = new RpcProviderLatencyHistograms({
      bucketsMs: [10, 50, 200],
    });

    // Different paths & query strings on the same origin collapse to one provider identity
    h.record("https://rpc-a.example.org/v1?cursor=111", "events", 8, true);
    h.record("https://rpc-a.example.org/v2?cursor=222&limit=50", "events", 45, true);
    h.record("https://rpc-a.example.org/rpc#section", "events", 500, false);

    const snap = h.snapshot();
    assert.deepEqual(snap.bucketsMs, [10, 50, 200]);
    assert.equal(snap.maxProviders, DEFAULT_MAX_RPC_HISTOGRAM_PROVIDERS);
    assert.equal(snap.series.length, 1);

    const s = snap.series[0];
    assert.equal(s.provider, "https://rpc-a.example.org");
    assert.equal(s.operation, "events");
    assert.deepEqual(s.buckets, [
      { le: 10, count: 1 },
      { le: 50, count: 2 },
      { le: 200, count: 2 },
    ]);
    assert.equal(s.infCount, 3);
    assert.equal(s.count, 3);
    assert.equal(s.failures, 1);
    assert.equal(s.sumMs, 553);
  });

  it("caps distinct provider labels at maxProviders and collapses excess URLs into 'other'", () => {
    const h = new RpcProviderLatencyHistograms({
      bucketsMs: [25, 100],
      maxProviders: 2,
    });

    assert.equal(h.record("https://p1.example.org/rpc?q=1", "health", 10), "https://p1.example.org");
    assert.equal(h.record("https://p2.example.org/rpc?q=2", "health", 20), "https://p2.example.org");

    // 3rd through 50th distinct hostnames all fold into fixed "other" label
    for (let i = 3; i <= 50; i++) {
      const label = h.record(`https://p${i}.example.org/rpc?nonce=${i}`, "health", 30);
      assert.equal(label, OVERFLOW_RPC_PROVIDER_ID);
    }

    // Previously admitted providers keep their dedicated identity
    assert.equal(h.record("https://p1.example.org/other-path?x=9", "health", 15), "https://p1.example.org");

    const snap = h.snapshot();
    assert.equal(snap.series.length, 3);
    assert.deepEqual(
      snap.series.map((s) => s.provider),
      ["https://p1.example.org", "https://p2.example.org", "other"],
    );
    const other = snap.series.find((s) => s.provider === "other");
    assert.equal(other.count, 48);
  });

  it("supports an explicit allowedProviders fixed identity set", () => {
    const h = new RpcProviderLatencyHistograms({
      bucketsMs: [50, 250],
      allowedProviders: [
        "https://primary.example.org/rpc?ignored=1",
        "https://fallback.example.org/rpc",
      ],
    });

    assert.equal(
      h.record("https://primary.example.org/v2?foo=bar", "network", 12),
      "https://primary.example.org",
    );
    assert.equal(
      h.record("https://unlisted.example.org/rpc", "network", 40),
      OVERFLOW_RPC_PROVIDER_ID,
    );
  });

  it("clamps negative and non-finite durations to 0 without poisoning bucket counts or sums", () => {
    const h = new RpcProviderLatencyHistograms({ bucketsMs: [10, 100] });
    h.record("https://rpc.example.org", "health", -25, true);
    h.record("https://rpc.example.org", "health", Number.NaN, false);
    h.record("https://rpc.example.org", "health", Number.POSITIVE_INFINITY, false);

    const [entry] = h.snapshot().series;
    assert.equal(entry.count, 3);
    assert.equal(entry.failures, 2);
    assert.equal(entry.sumMs, 0);
    assert.deepEqual(entry.buckets, [
      { le: 10, count: 3 },
      { le: 100, count: 3 },
    ]);
  });

  it("renders valid Prometheus histogram text without query strings and integrates with createMetrics", async () => {
    let now = 100;
    const h = new RpcProviderLatencyHistograms({
      bucketsMs: [20, 100],
      clock: () => now,
    });

    const fakeServer = instrumentRpcServer(
      {
        async getHealth() {
          now += 15;
          return { status: "healthy", oldestLedger: 1, latestLedger: 10 };
        },
        async getEvents() {
          now += 85;
          return { events: [], cursor: "", latestLedger: 10 };
        },
        async getNetwork() {
          now += 250;
          throw new Error("upstream timeout");
        },
      },
      "https://soroban-testnet.stellar.org/rpc?session=untrusted_query_value",
      h,
    );

    await fakeServer.getHealth();
    await fakeServer.getEvents();
    await assert.rejects(() => fakeServer.getNetwork(), /upstream timeout/);

    const metrics = createMetrics({ rpcLatencyHistograms: h });
    const rendered = metrics.render();

    assert.match(rendered, /# TYPE mimir_bot_rpc_request_duration_ms histogram/);
    assert.match(
      rendered,
      /mimir_bot_rpc_request_duration_ms_bucket\{provider="https:\/\/soroban-testnet\.stellar\.org",operation="health",le="20"\} 1/,
    );
    assert.match(
      rendered,
      /mimir_bot_rpc_request_duration_ms_bucket\{provider="https:\/\/soroban-testnet\.stellar\.org",operation="events",le="20"\} 0/,
    );
    assert.match(
      rendered,
      /mimir_bot_rpc_request_duration_ms_bucket\{provider="https:\/\/soroban-testnet\.stellar\.org",operation="events",le="100"\} 1/,
    );
    assert.match(
      rendered,
      /mimir_bot_rpc_request_duration_ms_bucket\{provider="https:\/\/soroban-testnet\.stellar\.org",operation="network",le="\+Inf"\} 1/,
    );
    assert.equal(rendered.includes("untrusted_query_value"), false);
    assert.equal(rendered.includes("?"), false);
  });

  it("validates finite bucket definitions and operation names", () => {
    assert.equal(DEFAULT_RPC_LATENCY_BUCKETS_MS.length > 0, true);
    assert.throws(() => new RpcProviderLatencyHistograms({ bucketsMs: [] }), RangeError);
    assert.throws(() => new RpcProviderLatencyHistograms({ bucketsMs: [0, 10] }), RangeError);
    assert.throws(() => new RpcProviderLatencyHistograms({ bucketsMs: [50, 20] }), RangeError);
    assert.throws(
      () => new RpcProviderLatencyHistograms({ bucketsMs: [10, Number.POSITIVE_INFINITY] }),
      RangeError,
    );
    assert.throws(
      () =>
        new RpcProviderLatencyHistograms({
          bucketsMs: Array.from({ length: MAX_RPC_LATENCY_BUCKETS + 1 }, (_, i) => i + 1),
        }),
      RangeError,
    );
    assert.throws(() => new RpcProviderLatencyHistograms({ maxProviders: 0 }), RangeError);

    const h = new RpcProviderLatencyHistograms();
    assert.throws(
      () => h.record("https://rpc.example.org", /** @type {any} */ ("arbitrary_op"), 10),
      RangeError,
    );
  });
});
