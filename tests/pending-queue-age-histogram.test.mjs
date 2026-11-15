/**
 * Focused automated coverage for fixed-bucket pending delivery queue age histograms (#869):
 *  - Finite bucket validation (rejecting non-finite, non-positive, unsorted, or duplicate bounds)
 *  - Bounded destination classes (`market`, `squad`, `default`), collapsing raw chat IDs and event IDs
 *  - Cumulative bucket placement (`_bucket`, `_sum`, `_count`, `+Inf`) and Prometheus exposition
 *  - Integration across dead-letter parking, poller replay, `MetricsRegistry`, and `buildMetricsReport`
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { createDeadLetterQueue } from "../dist/deadLetter.js";
import { buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import {
  classifyDeliveryDestination,
  DEFAULT_PENDING_QUEUE_AGE_BUCKETS_MS,
  DELIVERY_DESTINATION_CLASSES,
  PendingDeliveryAgeHistogram,
  validateFiniteBucketsMs,
} from "../dist/stellar/metrics.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const FAKE_BOT_SECRET = ["123456:fake", "secret"].join("-");
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42)).publicKey();

const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) =>
  Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const cursorFor = (ledger) => `${BigInt(ledger) << 32n}-0`;

test("validateFiniteBucketsMs accepts strictly increasing finite bounds and rejects invalid configurations", () => {
  assert.deepEqual(
    validateFiniteBucketsMs(DEFAULT_PENDING_QUEUE_AGE_BUCKETS_MS),
    [1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000],
  );

  for (const invalid of [
    [],
    [0, 1_000],
    [-500, 1_000],
    [1_000, Number.POSITIVE_INFINITY],
    [1_000, Number.NaN],
    [5_000, 5_000],
    [5_000, 1_000],
  ]) {
    assert.throws(
      () => validateFiniteBucketsMs(invalid),
      RangeError,
      `Expected RangeError for buckets=${JSON.stringify(invalid)}`,
    );
  }

  assert.throws(
    () => createMetrics({ pendingQueueAgeBucketsMs: [1_000, Number.POSITIVE_INFINITY] }),
    RangeError,
  );
});

test("classifyDeliveryDestination maps untrusted chat IDs, handles, and event IDs to bounded classes", () => {
  assert.deepEqual(DELIVERY_DESTINATION_CLASSES, ["market", "squad", "default"]);
  assert.equal(classifyDeliveryDestination("market"), "market");
  assert.equal(classifyDeliveryDestination("  MARKET "), "market");
  assert.equal(classifyDeliveryDestination("squad"), "squad");
  assert.equal(classifyDeliveryDestination("SQUAD"), "squad");

  for (const untrusted of [
    "-1001234567890",
    "@mimir_public_channel",
    "0021474836480-0001",
    "5001-0",
    MARKET_ID,
    "",
    null,
    undefined,
    12345,
  ]) {
    assert.equal(classifyDeliveryDestination(untrusted), "default");
  }
});

test("PendingDeliveryAgeHistogram places observations into cumulative finite buckets without leaking raw IDs", () => {
  const hist = new PendingDeliveryAgeHistogram([1_000, 5_000, 60_000]);

  // Exact lower & boundary placements + overflow into +Inf only
  hist.observe("market", 1_000); // fits <=1000, <=5000, <=60000
  hist.observe("market", 5_000); // fits <=5000, <=60000
  hist.observe("market", 120_000); // fits +Inf only
  hist.observe("squad", 0); // fits all buckets
  hist.observe("-1009998887776", 2_500); // chat ID -> collapses to "default"
  hist.observe("event:99999-0", 10_000); // event ID -> collapses to "default"
  hist.observe("market", Number.NaN); // ignored
  hist.observe("market", Number.POSITIVE_INFINITY); // ignored

  const snap = hist.snapshot();
  assert.deepEqual(snap.bucketsMs, [1_000, 5_000, 60_000]);
  assert.deepEqual(snap.destinations.market, {
    destination: "market",
    bucketCounts: [1, 2, 2],
    count: 3,
    sumMs: 126_000,
  });
  assert.deepEqual(snap.destinations.squad, {
    destination: "squad",
    bucketCounts: [1, 1, 1],
    count: 1,
    sumMs: 0,
  });
  assert.deepEqual(snap.destinations.default, {
    destination: "default",
    bucketCounts: [0, 1, 2],
    count: 2,
    sumMs: 12_500,
  });

  const rendered = hist
    .renderPrometheusLines(
      "mimir_bot_pending_delivery_queue_age_ms",
      "Queue age in milliseconds of pending deliveries.",
    )
    .join("\n");

  assert.ok(
    rendered.includes(
      'mimir_bot_pending_delivery_queue_age_ms_bucket{destination="market",le="1000"} 1',
    ),
  );
  assert.ok(
    rendered.includes(
      'mimir_bot_pending_delivery_queue_age_ms_bucket{destination="market",le="5000"} 2',
    ),
  );
  assert.ok(
    rendered.includes(
      'mimir_bot_pending_delivery_queue_age_ms_bucket{destination="market",le="+Inf"} 3',
    ),
  );
  assert.ok(
    rendered.includes('mimir_bot_pending_delivery_queue_age_ms_sum{destination="market"} 126000'),
  );
  assert.ok(
    rendered.includes('mimir_bot_pending_delivery_queue_age_ms_count{destination="market"} 3'),
  );
  assert.ok(
    rendered.includes(
      'mimir_bot_pending_delivery_queue_age_ms_bucket{destination="default",le="5000"} 1',
    ),
  );
  assert.ok(!rendered.includes("-1009998887776"));
  assert.ok(!rendered.includes("99999-0"));
});

test("dead-letter queue, poller replay, MetricsRegistry, and buildMetricsReport expose pending delivery queue age histograms", async () => {
  await withTempDataDir(async ({ file }) => {
    let clockMs = Date.UTC(2026, 5, 1, 12, 0, 0);

    // 1. Direct DeadLetterQueue point-in-time snapshot verification
    const dlq = createDeadLetterQueue({
      filePath: null,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => clockMs,
    });
    await dlq.enqueue({
      source: "market",
      ledger: 5_001,
      eventName: "claim_created",
      text: "secret body for chat -1001234567890 event 5001-0",
      error: new Error("timeout"),
    });
    clockMs += 12_000;
    await dlq.enqueue({
      source: "-1001234567890",
      ledger: 5_002,
      eventName: "claim_created",
      text: "untrusted source label",
      error: new Error("timeout"),
    });
    clockMs += 3_000;
    // Now market item is 15_000ms old, "-1001234567890" (default) item is 3_000ms old
    const dlqSnap = dlq.pendingAgeSnapshot(clockMs);
    assert.equal(dlqSnap.destinations.market.count, 1);
    assert.equal(dlqSnap.destinations.market.sumMs, 15_000);
    // Buckets: [1000, 5000, 15000, 60000, 300000, 900000, 3600000]
    assert.deepEqual(dlqSnap.destinations.market.bucketCounts, [0, 0, 1, 1, 1, 1, 1]);
    assert.equal(dlqSnap.destinations.default.count, 1);
    assert.equal(dlqSnap.destinations.default.sumMs, 3_000);
    assert.deepEqual(dlqSnap.destinations.default.bucketCounts, [0, 1, 1, 1, 1, 1, 1]);

    // 2. End-to-end Poller + MetricsRegistry + buildMetricsReport verification
    const metrics = createMetrics();
    let failTelegram = true;
    let scanCalls = 0;

    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 4_000, latestLedger: 5_010 };
      },
      async getEvents(req) {
        const id = req.filters?.[0]?.contractIds?.[0];
        if (id !== MARKET_ID || scanCalls > 0) {
          return { events: [], cursor: cursorFor(5_010), latestLedger: 5_010 };
        }
        scanCalls += 1;
        return {
          events: [
            {
              contractId: MARKET_ID,
              ledger: 5_010,
              txHash: "abc123",
              ledgerClosedAt: "2026-06-01T12:00:00Z",
              id: "5010-0",
              topic: [scStr("claim_created"), scU64(5_010), scAddress(ADDR)],
              value: nativeToScVal({ category: "crypto" }),
            },
          ],
          cursor: cursorFor(5_010),
          latestLedger: 5_010,
        };
      },
    };

    const config = {
      version: "0.1.0",
      botToken: FAKE_BOT_SECRET,
      chatId: "-1007778889990",
      chatIds: ["-1007778889990"],
      marketChatId: "-1007778889991",
      squadChatId: "-1007778889992",
      marketContractId: MARKET_ID,
      squadContractId: SQUAD_ID,
      marketContractVersion: "v1",
      squadContractVersion: "v1",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      pollIntervalMs: 30_000,
      startLookbackLedgers: 60,
      cursorFile: file("cursor.json"),
      lockFile: file("poller.lock"),
      deadLetterFile: file("dead-letter.json"),
      deadLetterMax: 10,
      deadLetterMaxAttempts: 5,
      maxNotificationsPerCycle: 20,
      dedupWindow: 100,
      healthHost: "127.0.0.1",
      healthPort: 0,
      healthStaleMs: 90_000,
    };

    const poller = createPoller({
      config,
      server,
      metrics,
      now: () => clockMs,
      sleep: async (ms) => {
        clockMs += ms;
      },
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      send: async () => {
        if (failTelegram) throw new Error("Telegram 502 Bad Gateway");
      },
    });

    // Cycle 1: initial send fails -> event is parked in dead-letter queue
    await poller.runCycle();
    assert.equal(poller.status().deadLetter.depth, 1);

    // Advance 45 seconds while parked, then inspect health `/metrics` report
    clockMs += 45_000;
    const healthProm = buildMetricsReport(config, poller.status(), clockMs);
    assert.ok(
      healthProm.includes(
        'mimir_telegram_pending_delivery_queue_age_ms_bucket{network="testnet",destination="market",le="60000"} 1',
      ),
    );
    assert.ok(
      healthProm.includes(
        'mimir_telegram_pending_delivery_queue_age_ms_bucket{network="testnet",destination="market",le="15000"} 0',
      ),
    );
    assert.ok(
      healthProm.includes(
        'mimir_telegram_pending_delivery_queue_age_ms_sum{network="testnet",destination="market"} 45000',
      ),
    );
    assert.ok(!healthProm.includes("-1007778889990"));
    assert.ok(!healthProm.includes("-1007778889991"));
    assert.ok(!healthProm.includes("5010-0"));

    // Cycle 2: Telegram recovers -> parked delivery replays and records 45_000ms wait in registry
    failTelegram = false;
    await poller.runCycle();
    assert.equal(poller.status().deadLetter.depth, 0);

    const regProm = metrics.render();
    // Registry observed initial in-cycle wait (0ms) + dead-letter parked wait (45_000ms) => count=2, sum=45000
    assert.ok(
      regProm.includes(
        'mimir_bot_pending_delivery_queue_age_ms_bucket{destination="market",le="1000"} 1',
      ),
    );
    assert.ok(
      regProm.includes(
        'mimir_bot_pending_delivery_queue_age_ms_bucket{destination="market",le="60000"} 2',
      ),
    );
    assert.ok(
      regProm.includes('mimir_bot_pending_delivery_queue_age_ms_sum{destination="market"} 45000'),
    );
    assert.ok(
      regProm.includes('mimir_bot_pending_delivery_queue_age_ms_count{destination="market"} 2'),
    );
    assert.ok(!regProm.includes("-1007778889990"));
    assert.ok(!regProm.includes("5010-0"));
  });
});
