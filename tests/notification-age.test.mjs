/**
 * Tests for end-to-end notification age tracking (`NotificationAge` in
 * `src/stellar/metrics.ts`, `MetricsRegistry` in `src/metrics.ts`, and
 * poller confirmed-send instrumentation in `src/poller.ts`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { rpc } from "@stellar/stellar-sdk";

import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import {
  MOCK_BOT_TOKEN,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";
import { formatNotificationAge, NotificationAge } from "../dist/stellar/metrics.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const CAPTAIN = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";

function pollerConfig(cursorFile, rpcUrl) {
  return {
    version: "0.1.0",
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    rpcUrl,
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: MOCK_BOT_TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 9,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

// ── Unit tests: NotificationAge ───────────────────────────────────────────────

test("NotificationAge: empty summary reports null stats and zero counts", () => {
  const tracker = new NotificationAge(() => 0);
  const summary = tracker.summary();
  assert.deepEqual(summary, {
    samples: 0,
    missingLedgerTime: 0,
    totalMs: 0,
    minMs: null,
    maxMs: null,
    avgMs: null,
    lastMs: null,
  });
  assert.equal(
    formatNotificationAge(summary),
    "notification_age samples=0 missing=0 last=none avg=none max=none",
  );
});

test("NotificationAge: distinguishes zero delivery lag from missing ledger time", () => {
  const tracker = new NotificationAge(() => 100);

  // Zero delivery lag: ledger close time equals confirmed send time.
  const zeroAge = tracker.record(1_700_000_000, 1_700_000_000_000);
  assert.equal(zeroAge, 0);

  // Missing ledger time (0, null, undefined, NaN, negative) must not overwrite
  // samples or stats, and must increment missingLedgerTime instead.
  assert.equal(tracker.record(0, 1_700_000_005_000), null);
  assert.equal(tracker.record(null, 1_700_000_005_000), null);
  assert.equal(tracker.record(undefined, 1_700_005_000), null);
  assert.equal(tracker.record(Number.NaN, 1_700_000_005_000), null);
  assert.equal(tracker.record(-10, 1_700_000_005_000), null);

  const summary = tracker.summary();
  assert.deepEqual(summary, {
    samples: 1,
    missingLedgerTime: 5,
    totalMs: 0,
    minMs: 0,
    maxMs: 0,
    avgMs: 0,
    lastMs: 0,
  });
  assert.equal(
    formatNotificationAge(summary),
    "notification_age samples=1 missing=5 last=0ms avg=0ms max=0ms",
  );
});

test("NotificationAge: uses monotonic clock from ingestion to confirmed send", () => {
  let monoNow = 1_000;
  const tracker = new NotificationAge(() => monoNow);

  // Event ledger closed at 1_700_000_000s; ingested 2_000ms later.
  const ingested = tracker.markIngested(1_700_000_002_000);
  // Send completes 350ms later on the monotonic clock.
  monoNow = 1_350;
  const age1 = tracker.recordFromIngestion(1_700_000_000, ingested);
  assert.equal(age1, 2_350);

  // Even if monotonic clock jittered backwards, duration from ingestion clamps to >= 0.
  monoNow = 900;
  const age2 = tracker.recordFromIngestion(1_700_000_000, ingested);
  assert.equal(age2, 2_000);

  const summary = tracker.summary();
  assert.equal(summary.samples, 2);
  assert.equal(summary.minMs, 2_000);
  assert.equal(summary.maxMs, 2_350);
  assert.equal(summary.lastMs, 2_000);
  assert.equal(summary.avgMs, 2_175);
});

test("NotificationAge: clamps slight chain-vs-host clock skew to 0ms sample", () => {
  const tracker = new NotificationAge(() => 0);
  const age = tracker.record(1_700_000_010, 1_700_000_009_500);
  assert.equal(age, 0);
  assert.equal(tracker.summary().samples, 1);
  assert.equal(tracker.summary().missingLedgerTime, 0);
});

// ── Poller integration tests ──────────────────────────────────────────────────

test("poller records end-to-end notification age on confirmed send using monotonic clock", async () => {
  await withTempDataDir(async (dataDir) => {
    // mock-rpc computes ledgerClosedAt as (1_790_000_000 + ledger * 5) * 1000.
    const ledgerClosedMs = (1_790_000_000 + 9 * 5) * 1000;

    const mock = await startMockRpc({
      port: 0,
      scenario: {
        latestLedger: 10,
        oldestLedger: 1,
        ledgersPerPage: 50,
        events: [
          {
            source: "market",
            ledger: 9,
            eventName: "claim_created",
            topics: [3, { address: CAPTAIN }],
            fields: { category: "sports" },
          },
        ],
      },
    });

    try {
      const metrics = createMetrics();
      let wallNow = ledgerClosedMs + 1_500;
      let monoNow = 10_000;

      const poller = createPoller({
        config: pollerConfig(dataDir.file("cursor.json"), mock.url),
        server: new rpc.Server(mock.url, { allowHttp: true }),
        metrics,
        now: () => wallNow,
        monotonicNow: () => monoNow,
        sleep: async () => {},
        sendOptions: { sendSpacingMs: 0, maxSendRetries: 0 },
        persistAudit: false,
        send: async () => {
          // Simulate 250ms send latency on monotonic clock while wall clock
          // steps backwards (NTP adjustment) — confirmed send must still advance.
          wallNow -= 5_000;
          monoNow += 250;
        },
      });

      await poller.cycle();

      assert.equal(metrics.notificationsSent.value(), 1);
      assert.equal(metrics.notificationAgeSamples.value(), 1);
      assert.equal(metrics.notificationAgeMissingLedgerTime.value(), 0);
      assert.equal(metrics.lastNotificationAgeMs.value(), 1_750);
      assert.equal(metrics.maxNotificationAgeMs.value(), 1_750);
      assert.equal(metrics.notificationAgeTotalMs.value(), 1_750);

      const ageSummary = poller.status().notificationAge;
      assert.equal(ageSummary?.samples, 1);
      assert.equal(ageSummary?.missingLedgerTime, 0);
      assert.equal(ageSummary?.lastMs, 1_750);
    } finally {
      await mock.close();
    }
  });
});

test("poller distinguishes zero lag from missing ledger time and skips failed sends", async () => {
  await withTempDataDir(async (dataDir) => {
    const ledgerClosedMs = (1_790_000_000 + 9 * 5) * 1000;

    const mock = await startMockRpc({
      port: 0,
      scenario: {
        latestLedger: 12,
        oldestLedger: 1,
        ledgersPerPage: 50,
        events: [
          {
            source: "market",
            ledger: 9,
            eventName: "claim_created",
            topics: [3, { address: CAPTAIN }],
            fields: { category: "sports" },
          },
          {
            source: "market",
            ledger: 10,
            eventName: "claim_created",
            topics: [4, { address: CAPTAIN }],
            fields: { category: "crypto" },
          },
          {
            source: "squad",
            ledger: 11,
            eventName: "market_created",
            topics: [5, { address: CAPTAIN }],
            fields: {
              deadline: 1_893_456_000,
              fee_bps: 100,
              question: "Will failed sends be excluded from age samples?",
            },
          },
        ],
      },
    });

    try {
      const metrics = createMetrics();
      let sendCount = 0;

      // Wrap rpc.Server.getEvents so ledger 10 omits ledgerClosedAt (decoded event.at === 0).
      const baseServer = new rpc.Server(mock.url, { allowHttp: true });
      const server = {
        getHealth: (...args) => baseServer.getHealth(...args),
        getEvents: async (...args) => {
          const res = await baseServer.getEvents(...args);
          return {
            ...res,
            events: res.events.map((ev) =>
              ev.ledger === 10 ? { ...ev, ledgerClosedAt: "" } : ev,
            ),
          };
        },
      };

      const poller = createPoller({
        config: pollerConfig(dataDir.file("cursor.json"), mock.url),
        server,
        metrics,
        // Wall clock == ledger 9 close time -> 0ms lag for event 1.
        now: () => ledgerClosedMs,
        monotonicNow: () => 500,
        sleep: async () => {},
        sendOptions: { sendSpacingMs: 0, maxSendRetries: 0 },
        persistAudit: false,
        send: async (_text, source) => {
          sendCount += 1;
          if (source === "squad") {
            throw new Error("Telegram 503");
          }
        },
      });

      await poller.cycle();

      assert.equal(sendCount, 3);
      assert.equal(metrics.notificationsSent.value(), 2);
      assert.equal(metrics.notificationsFailed.value(), 1);
      // Event 1: 0ms lag -> recorded as sample (not missing).
      // Event 2: missing closedAt -> recorded as missingLedgerTime.
      // Event 3: failed send -> not recorded in either.
      assert.equal(metrics.notificationAgeSamples.value(), 1);
      assert.equal(metrics.notificationAgeMissingLedgerTime.value(), 1);
      assert.equal(metrics.lastNotificationAgeMs.value(), 0);
      assert.equal(metrics.maxNotificationAgeMs.value(), 0);
      assert.equal(metrics.notificationAgeTotalMs.value(), 0);
    } finally {
      await mock.close();
    }
  });
});
