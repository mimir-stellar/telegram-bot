/**
 * Activity baseline poller integration.
 *
 * Drives the real poller against the local mock RPC to prove the per-cycle
 * event count is recorded in the status snapshot, compared with the rolling
 * baseline, surfaced in /health and exported through the metrics registry.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { rpc } from "@stellar/stellar-sdk";

import { buildHealthReport, buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import {
  MOCK_BOT_TOKEN,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";
import { startMockRpc } from "../dist/stellar/mock-rpc.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const CAPTAIN = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";

function config(cursorFile, rpcUrl) {
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

test("poller records complete cycles, compares them and exposes the result", async () => {
  await withTempDataDir(async (dataDir) => {
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
          {
            source: "squad",
            ledger: 10,
            eventName: "market_created",
            topics: [5, { address: CAPTAIN }],
            fields: {
              deadline: 1_893_456_000,
              fee_bps: 100,
              question: "Will baseline activity be observed?",
            },
          },
        ],
      },
    });

    try {
      const metrics = createMetrics();
      const pollerConfig = config(dataDir.file("cursor.json"), mock.url);
      const poller = createPoller({
        config: pollerConfig,
        server: new rpc.Server(mock.url, { allowHttp: true }),
        metrics,
        sleep: async () => {},
        sendOptions: { sendSpacingMs: 0 },
        persistAudit: false,
        activityBaselineOptions: { windowSize: 4, minSamples: 1, zThreshold: 2 },
        send: async () => {},
      });

      // Cycle 1: two events. One observation is not enough to compare.
      await poller.cycle();
      let activity = poller.status().activityBaseline;
      assert.equal(activity.samples, 1);
      assert.equal(activity.lastValue, 2);
      assert.equal(activity.deviation, "warming-up");
      assert.equal(activity.anomalies, 0);

      // Cycle 2: the cursor is at the tip, so no events. Against [2], zero is
      // a two-deviation drop at the configured threshold.
      await poller.cycle();
      activity = poller.status().activityBaseline;
      assert.equal(activity.samples, 2);
      assert.equal(activity.lastValue, 0);
      assert.equal(activity.baselineMean, 2);
      assert.equal(activity.baselineStdDev, 0);
      assert.equal(activity.zScore, -2);
      assert.equal(activity.deviation, "drop");
      assert.equal(activity.anomalies, 1);
      assert.equal(metrics.lastCycleEvents.value(), 0);
      assert.equal(metrics.activityBaselineEvents.value(), 2);
      assert.equal(metrics.activityAnomalies.value(), 1);

      // Cycle 3: ten new events against [2, 0] is a spike.
      for (let i = 0; i < 10; i += 1) {
        mock.addEvent({
          source: "market",
          ledger: 11 + i,
          eventName: "claim_created",
          topics: [100 + i, { address: CAPTAIN }],
          fields: { category: "sports" },
        });
      }
      await poller.cycle();
      activity = poller.status().activityBaseline;
      assert.equal(activity.lastValue, 10);
      assert.equal(activity.deviation, "spike");
      assert.equal(activity.anomalies, 2);
      assert.equal(metrics.lastCycleEvents.value(), 10);
      assert.equal(metrics.activityAnomalies.value(), 2);

      // /health carries the same snapshot, JSON-serialisable and unchanged.
      const report = buildHealthReport(pollerConfig, poller.status(), Date.now());
      assert.deepEqual(JSON.parse(JSON.stringify(report.poller.activity)), activity);
      // Driving cycles directly never calls start(), so the poller reports
      // stopped; the activity snapshot is independent of that lifecycle flag.
      assert.equal(report.poller.running, false);

      // The default (health) metrics endpoint exposes the same comparison.
      const prometheus = buildMetricsReport(pollerConfig, poller.status(), Date.now());
      assert.match(prometheus, /mimir_telegram_activity_last_cycle_events\{network="[^"]+"\} 10/);
      assert.match(prometheus, /mimir_telegram_activity_baseline_events\{network="[^"]+"\} 1/);
      assert.match(prometheus, /mimir_telegram_activity_anomalies_total\{network="[^"]+"\} 2/);
      assert.match(prometheus, /mimir_telegram_activity_deviation\{network="[^"]+"\} 6\.3/);
    } finally {
      await mock.close();
    }
  }, "mimir-activity-baseline-");
});
