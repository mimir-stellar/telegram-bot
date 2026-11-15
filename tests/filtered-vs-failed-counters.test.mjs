import assert from "node:assert/strict";
import test from "node:test";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { buildHealthReport, buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { parseNotificationFeatureFlags } from "../dist/notifications/featureFlags.js";
import { createPoller } from "../dist/poller.js";
import {
  DeliveryOutcomeTracker,
  normalizeEventFilterReason,
} from "../dist/stellar/metrics.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
const CREATOR = kp.publicKey();
const MARKET_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SQUAD_CONTRACT = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD2KM";

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

function makeRawEvent({
  id,
  ledger,
  eventName,
  claimId = 1n,
  category = "crypto",
}) {
  const addrScVal = Address.account(
    Buffer.from(Keypair.fromPublicKey(CREATOR).rawPublicKey()),
  ).toScVal();

  if (eventName === "claim_created") {
    return {
      id,
      ledger,
      ledgerClosedAt: "2026-03-26T12:00:00Z",
      txHash: "a".repeat(64),
      topic: [
        nativeToScVal("claim_created", { type: "string" }),
        nativeToScVal(claimId, { type: "u64" }),
        addrScVal,
      ],
      value: nativeToScVal({ category }),
    };
  }

  if (eventName === "claim_cancelled") {
    return {
      id,
      ledger,
      ledgerClosedAt: "2026-03-26T12:00:00Z",
      txHash: "b".repeat(64),
      topic: [
        nativeToScVal("claim_cancelled", { type: "string" }),
        nativeToScVal(claimId, { type: "u64" }),
      ],
      value: nativeToScVal(null),
    };
  }

  if (eventName === "oracle_changed") {
    return {
      id,
      ledger,
      ledgerClosedAt: "2026-03-26T12:00:00Z",
      txHash: "c".repeat(64),
      topic: [nativeToScVal("oracle_changed", { type: "string" })],
      value: nativeToScVal({ admin: addrScVal, oracle: addrScVal }),
    };
  }

  return {
    id,
    ledger,
    ledgerClosedAt: "2026-03-26T12:00:00Z",
    txHash: "d".repeat(64),
    topic: [nativeToScVal(eventName, { type: "string" })],
    value: nativeToScVal(null),
  };
}

test("DeliveryOutcomeTracker keeps filtered events out of deliveryAttempts and failureRate", () => {
  const tracker = new DeliveryOutcomeTracker();
  assert.equal(tracker.failureRate(), null);

  tracker.recordFiltered("feature_flag", 25);
  tracker.recordFiltered("category_filter", 15);
  tracker.recordFiltered("admin_event", 10);
  tracker.recordFiltered("unexpected_untrusted_reason", 5);

  // Zero delivery attempts -> failureRate remains null, never 0 or NaN
  const filteredOnly = tracker.snapshot();
  assert.equal(filteredOnly.filteredTotal, 55);
  assert.equal(filteredOnly.filteredByReason.feature_flag, 25);
  assert.equal(filteredOnly.filteredByReason.category_filter, 15);
  assert.equal(filteredOnly.filteredByReason.admin_event, 10);
  assert.equal(filteredOnly.filteredByReason.other, 5);
  assert.equal(filteredOnly.deliveryAttempts, 0);
  assert.equal(filteredOnly.failureRate, null);

  // 3 successes and 1 failure -> failureRate is strictly 1 / 4 = 0.25 (not 1 / 59!)
  tracker.recordDeliverySuccess(3);
  tracker.recordDeliveryFailure(1);
  const afterDeliveries = tracker.snapshot();
  assert.equal(afterDeliveries.deliveryAttempts, 4);
  assert.equal(afterDeliveries.deliverySucceeded, 3);
  assert.equal(afterDeliveries.deliveryFailed, 1);
  assert.equal(afterDeliveries.failureRate, 0.25);

  // Additional filtered events must not dilute failureRate
  tracker.recordFiltered("category_filter", 100);
  assert.equal(tracker.snapshot().failureRate, 0.25);
});

test("boundary validation normalizes unknown filter reasons and rejects negative deltas", () => {
  assert.equal(normalizeEventFilterReason("FEATURE_FLAG"), "feature_flag");
  assert.equal(normalizeEventFilterReason("category_filter"), "category_filter");
  assert.equal(normalizeEventFilterReason("sports-category-payload"), "other");
  assert.equal(normalizeEventFilterReason(null), "other");

  const m = createMetrics();
  assert.throws(() => m.eventsFiltered.inc("feature_flag", -1), /delta must be >= 0/);
  assert.throws(() => m.eventsFiltered.inc("feature_flag", Number.NaN), /delta must be >= 0/);
  assert.equal(m.deliveryFailureRate(), null);

  m.eventsFiltered.inc("feature_flag", 50);
  m.eventsFiltered.inc("untrusted_dynamic_category", 3);
  assert.equal(m.eventsFiltered.value("feature_flag"), 50);
  assert.equal(m.eventsFiltered.value("other"), 3);
  assert.equal(m.eventsFiltered.value(), 53);
  assert.equal(m.deliveryFailureRate(), null);

  m.notificationsAttempted.inc(2);
  m.notificationsSent.inc(1);
  m.notificationsFailed.inc(1);
  assert.equal(m.deliveryFailureRate(), 0.5);

  const rendered = m.render();
  assert.ok(
    rendered.includes('mimir_bot_events_filtered_total{reason="feature_flag"} 50'),
    rendered,
  );
  assert.ok(
    rendered.includes('mimir_bot_events_filtered_total{reason="other"} 3'),
    rendered,
  );
  assert.ok(rendered.includes("mimir_bot_notifications_attempted_total 2"), rendered);
  assert.ok(!rendered.includes("untrusted_dynamic_category"), rendered);
});

test("poller increments separate filter-reason counters and excludes filtered events from failure denominator", async () => {
  await withTempDataDir(async ({ file }) => {
    const marketEvents = [
      // 1. Admin event -> filtered: admin_event
      makeRawEvent({ id: "0001001-0001", ledger: 1001, eventName: "oracle_changed" }),
      // 2. Category filter ("sports" not in ["crypto"]) -> filtered: category_filter
      makeRawEvent({
        id: "0001003-0001",
        ledger: 1003,
        eventName: "claim_created",
        claimId: 3n,
        category: "sports",
      }),
      // 3. Allowed crypto claim -> delivery succeeds
      makeRawEvent({
        id: "0001004-0001",
        ledger: 1004,
        eventName: "claim_created",
        claimId: 4n,
        category: "crypto",
      }),
      // 4. Allowed crypto claim -> delivery fails
      makeRawEvent({
        id: "0001005-0001",
        ledger: 1005,
        eventName: "claim_created",
        claimId: 5n,
        category: "crypto",
      }),
    ];

    // 5. Squad deposited event while NOTIFY_SQUAD=false -> filtered: feature_flag
    const squadEvents = [
      makeRawEvent({ id: "0001002-0001", ledger: 1002, eventName: "deposited" }),
    ];

    let marketCalls = 0;
    let squadCalls = 0;
    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 900, latestLedger: 1200 };
      },
      async getEvents(req) {
        const cid = req.filters?.[0]?.contractIds?.[0];
        if (cid === MARKET_CONTRACT && marketCalls === 0) {
          marketCalls += 1;
          return {
            events: marketEvents,
            oldestLedger: 900,
            latestLedger: 1200,
            cursor: makeCursor(1200, 1),
          };
        }
        if (cid === SQUAD_CONTRACT && squadCalls === 0) {
          squadCalls += 1;
          return {
            events: squadEvents,
            oldestLedger: 900,
            latestLedger: 1200,
            cursor: makeCursor(1200, 2),
          };
        }
        return {
          events: [],
          oldestLedger: 900,
          latestLedger: 1200,
          cursor: makeCursor(1200, 3),
        };
      },
    };

    const { flags: featureFlags } = parseNotificationFeatureFlags({ NOTIFY_SQUAD: "false" });
    const config = {
      version: "0.1.0",
      botToken: ["123456:fake", "secret"].join("-"),
      chatId: "-1001234",
      chatIds: ["-1001234"],
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      marketContractId: MARKET_CONTRACT,
      squadContractId: SQUAD_CONTRACT,
      pollIntervalMs: 30_000,
      startLookbackLedgers: 100,
      cursorFile: file("cursor.json"),
      lockFile: file("poller.lock"),
      maxNotificationsPerCycle: 20,
      dedupWindow: 200,
      featureFlags,
      notificationCategories: ["crypto"],
      healthStaleMs: 90_000,
      logSampleWindowMs: 60_000,
      logSampleMaxPerWindow: 5,
    };

    const metrics = createMetrics();
    let sendAttempt = 0;
    const poller = createPoller({
      config,
      server,
      metrics,
      persistAudit: false,
      sendOptions: {
        maxSendRetries: 1,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        sendSpacingMs: 0,
      },
      now: () => 10_000,
      sleep: async () => {},
      send: async () => {
        sendAttempt += 1;
        if (sendAttempt === 2) {
          throw new Error("Telegram 503 outage");
        }
      },
    });

    await poller.runCycle();

    assert.equal(metrics.eventsDecoded.value(), 5);
    assert.equal(metrics.eventsFiltered.value("admin_event"), 1);
    assert.equal(metrics.eventsFiltered.value("feature_flag"), 1);
    assert.equal(metrics.eventsFiltered.value("category_filter"), 1);
    assert.equal(metrics.eventsFiltered.value(), 3);

    // Only the 2 unfiltered events entered deliveryAttempts: 1 succeeded, 1 failed -> 0.5
    assert.equal(metrics.notificationsAttempted.value(), 2);
    assert.equal(metrics.notificationsSent.value(), 1);
    assert.equal(metrics.notificationsFailed.value(), 1);
    assert.equal(metrics.deliveryFailureRate(), 0.5);

    const status = poller.status();
    const healthReport = buildHealthReport(config, status, 10_000);
    assert.equal(healthReport.poller.notificationsAttempted, 2);
    assert.equal(healthReport.poller.deliveryFailureRate, 0.5);
    assert.deepEqual(healthReport.poller.eventsFiltered, {
      feature_flag: 1,
      category_filter: 1,
      admin_event: 1,
      unformatted: 0,
      other: 0,
    });

    const prom = buildMetricsReport(config, status, 10_000);
    assert.ok(
      prom.includes('mimir_telegram_notifications_attempted_total{network="testnet"} 2'),
      prom,
    );
    assert.ok(
      prom.includes('mimir_telegram_events_filtered_total{network="testnet",reason="admin_event"} 1'),
      prom,
    );
    assert.ok(
      prom.includes('mimir_telegram_events_filtered_total{network="testnet",reason="feature_flag"} 1'),
      prom,
    );
    assert.ok(
      prom.includes('mimir_telegram_events_filtered_total{network="testnet",reason="category_filter"} 1'),
      prom,
    );
  });
});
