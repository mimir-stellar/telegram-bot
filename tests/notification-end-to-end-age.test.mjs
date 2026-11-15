/**
 * Focused automated coverage for end-to-end notification age tracking (#867):
 *  - Monotonic duration measurement across queuing, retry backoffs, and mid-send NTP jumps
 *  - Explicit distinction between missing ledger close time (`at === 0` / `null` / implausible)
 *    and genuine `0ms` delivery lag
 *  - Negative wall-clock skew handling without clamping skew to `0ms`
 *  - End-to-end poller + dead-letter replay + `MetricsRegistry` + `buildMetricsReport` integration
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import { EndToEndNotificationAgeTracker } from "../dist/stellar/metrics.js";
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

test("distinguishes missing or implausible ledger close time from genuine zero delivery lag", () => {
  const missingTracker = new EndToEndNotificationAgeTracker();

  // 1. Missing / omitted / implausible ledger close times
  const obsZero = missingTracker.confirm(missingTracker.begin(0, 1_700_000_000_000, 100), 125);
  const obsNull = missingTracker.confirm(missingTracker.begin(null, 1_700_000_000_000, 200), 210);
  const obsImplausible = missingTracker.confirm(
    missingTracker.begin(946_684_800, 1_700_000_000_000, 300), // year 2000 < 2015 floor
    305,
  );

  assert.equal(obsZero.status, "missing_ledger_time");
  assert.equal(obsZero.endToEndAgeMs, null);
  assert.equal(obsZero.sendDurationMs, 25);
  assert.equal(obsNull.status, "missing_ledger_time");
  assert.equal(obsImplausible.status, "missing_ledger_time");

  const missingSnap = missingTracker.snapshot();
  assert.equal(missingSnap.missingLedgerTimeCount, 3);
  assert.equal(missingSnap.ageSamples, 0);
  assert.equal(missingSnap.zeroLagCount, 0);
  assert.equal(missingSnap.lastAgeMs, null);
  assert.equal(missingSnap.minAgeMs, null);
  assert.equal(missingSnap.maxAgeMs, null);
  assert.equal(missingSnap.confirmedDeliveries, 3);
  assert.equal(missingSnap.sendDurationSumMs, 40);

  const missingProm = missingTracker.renderPrometheusLines("mimir_bot_").join("\n");
  assert.ok(missingProm.includes("mimir_bot_notification_missing_ledger_time_total 3"));
  assert.ok(missingProm.includes("mimir_bot_notification_end_to_end_age_ms_count 0"));
  assert.ok(missingProm.includes("mimir_bot_notification_zero_lag_total 0"));
  assert.ok(!missingProm.includes("mimir_bot_notification_last_age_ms"));

  // 2. Genuine zero delivery lag (valid ledger time matching ingestion + 0ms send duration)
  const zeroLagTracker = new EndToEndNotificationAgeTracker();
  const ledgerSec = 1_700_000_000;
  const obsExactZero = zeroLagTracker.confirm(
    zeroLagTracker.begin(ledgerSec, ledgerSec * 1_000, 500),
    500,
  );

  assert.equal(obsExactZero.status, "recorded");
  assert.equal(obsExactZero.endToEndAgeMs, 0);
  assert.equal(obsExactZero.sendDurationMs, 0);

  const zeroSnap = zeroLagTracker.snapshot();
  assert.equal(zeroSnap.missingLedgerTimeCount, 0);
  assert.equal(zeroSnap.ageSamples, 1);
  assert.equal(zeroSnap.zeroLagCount, 1);
  assert.equal(zeroSnap.lastAgeMs, 0);
  assert.equal(zeroSnap.minAgeMs, 0);
  assert.equal(zeroSnap.maxAgeMs, 0);

  const zeroProm = zeroLagTracker.renderPrometheusLines("mimir_bot_").join("\n");
  assert.ok(zeroProm.includes("mimir_bot_notification_missing_ledger_time_total 0"));
  assert.ok(zeroProm.includes("mimir_bot_notification_end_to_end_age_ms_count 1"));
  assert.ok(zeroProm.includes("mimir_bot_notification_end_to_end_age_ms_sum 0"));
  assert.ok(zeroProm.includes("mimir_bot_notification_zero_lag_total 1"));
  assert.ok(zeroProm.includes("mimir_bot_notification_last_age_ms 0"));
});

test("uses monotonic duration measurements so backward wall-clock jumps during send do not corrupt age", () => {
  let wallMs = 1_700_000_002_000; // 2,000ms after ledger close (1_700_000_000s)
  let monoMs = 10_000;

  const tracker = new EndToEndNotificationAgeTracker({
    wallClock: () => wallMs,
    monotonicClock: () => monoMs,
  });

  const stamp = tracker.begin(1_700_000_000);

  // Simulate NTP stepping wall clock backward by 30s while 3,500ms of real retry/send time elapses
  wallMs -= 30_000;
  monoMs += 3_500;

  const obs = tracker.confirm(stamp);
  assert.equal(obs.status, "recorded");
  assert.equal(obs.sendDurationMs, 3_500);
  assert.equal(obs.endToEndAgeMs, 5_500);

  // Also verify negative ingestion wall-clock skew is counted distinctly, never clamped to 0ms
  wallMs = 1_700_000_000_000 - 800; // 800ms before ledger close
  const skewedStamp = tracker.begin(1_700_000_000);
  monoMs += 50;
  const skewedObs = tracker.confirm(skewedStamp);
  assert.equal(skewedObs.status, "clock_skew");
  assert.equal(skewedObs.endToEndAgeMs, null);

  const snap = tracker.snapshot();
  assert.equal(snap.ageSamples, 1);
  assert.equal(snap.clockSkewCount, 1);
  assert.equal(snap.zeroLagCount, 0);
  assert.equal(snap.lastAgeMs, 5_500);
  assert.equal(snap.confirmedDeliveries, 2);
  assert.equal(snap.sendDurationSumMs, 3_550);
});

test("poller tracks end-to-end age only on confirmed send (including dead-letter recovery and missing ledger time)", async () => {
  await withTempDataDir(async ({ file }) => {
    const ledgerCloseIso = "2026-06-01T12:00:00Z";
    const ledgerCloseMs = Date.parse(ledgerCloseIso);
    let wallMs = ledgerCloseMs + 1_200; // 1,200ms after ledger close at cycle 1 ingestion
    let monoMs = 5_000;
    let failFirstEvent = true;
    let scanStep = 0;

    const metrics = createMetrics({
      wallClock: () => wallMs,
      monotonicClock: () => monoMs,
    });

    let currentTipLedger = 5_011;

    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 4_000, latestLedger: currentTipLedger };
      },
      async getEvents(req) {
        const id = req.filters?.[0]?.contractIds?.[0];
        if (id !== MARKET_ID) {
          return {
            events: [],
            cursor: cursorFor(currentTipLedger),
            latestLedger: currentTipLedger,
          };
        }
        scanStep += 1;
        if (scanStep === 1) {
          // Cycle 1: event WITH ledgerClosedAt (will fail send first, park in DLQ, then confirm in cycle 2)
          return {
            events: [
              {
                contractId: MARKET_ID,
                ledger: 5_011,
                txHash: "tx1",
                ledgerClosedAt: ledgerCloseIso,
                id: "5011-0",
                topic: [scStr("claim_created"), scU64(5_011), scAddress(ADDR)],
                value: nativeToScVal({ category: "crypto" }),
              },
            ],
            cursor: cursorFor(5_011),
            latestLedger: 5_011,
          };
        }
        if (scanStep === 2) {
          // Cycle 2: event WITHOUT ledgerClosedAt (missing ledger time -> must NOT record 0 age!)
          return {
            events: [
              {
                contractId: MARKET_ID,
                ledger: 5_012,
                txHash: "tx2",
                ledgerClosedAt: "",
                id: "5012-0",
                topic: [scStr("claim_created"), scU64(5_012), scAddress(ADDR)],
                value: nativeToScVal({ category: "macro" }),
              },
            ],
            cursor: cursorFor(5_012),
            latestLedger: 5_012,
          };
        }
        return {
          events: [],
          cursor: cursorFor(currentTipLedger),
          latestLedger: currentTipLedger,
        };
      },
    };

    const config = {
      version: "0.1.0",
      botToken: FAKE_BOT_SECRET,
      chatId: "-1001234567890",
      chatIds: ["-1001234567890"],
      marketContractId: MARKET_ID,
      squadContractId: SQUAD_ID,
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
      now: () => wallMs,
      monotonicNow: () => monoMs,
      sleep: async (ms) => {
        monoMs += ms;
      },
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      send: async () => {
        monoMs += 300; // 300ms HTTP round-trip to Telegram
        if (failFirstEvent) {
          throw new Error("Telegram temporary outage");
        }
      },
    });

    // Cycle 1: send fails -> NOT confirmed yet! Zero confirmed age samples.
    await poller.runCycle();
    assert.equal(poller.status().deadLetter.depth, 1);
    assert.equal(metrics.notificationAge.snapshot().confirmedDeliveries, 0);
    assert.equal(metrics.notificationAge.snapshot().ageSamples, 0);

    // Advance 8,000ms monotonic while wall clock jumps backward 60s (simulating NTP step)
    monoMs += 8_000;
    wallMs -= 60_000;
    currentTipLedger = 5_012;
    failFirstEvent = false;

    // Cycle 2:
    //  - Replays parked event 5011-0: chainToIngest=1200ms + monoElapsed=(300+8000+300)=8600ms => endToEndAge=9800ms!
    //  - Delivers event 5012-0 (missing ledgerClosedAt): increments missingLedgerTimeCount=1 without recording 0ms age!
    await poller.runCycle();

    const snap = metrics.notificationAge.snapshot();
    assert.equal(snap.confirmedDeliveries, 2);
    assert.equal(snap.ageSamples, 1);
    assert.equal(snap.missingLedgerTimeCount, 1);
    assert.equal(snap.zeroLagCount, 0);
    assert.equal(snap.lastAgeMs, 9_800);
    assert.equal(snap.maxAgeMs, 9_800);

    const regProm = metrics.render();
    assert.ok(regProm.includes('mimir_bot_notification_end_to_end_age_ms_bucket{le="5000"} 0'));
    assert.ok(regProm.includes('mimir_bot_notification_end_to_end_age_ms_bucket{le="15000"} 1'));
    assert.ok(regProm.includes("mimir_bot_notification_end_to_end_age_ms_sum 9800"));
    assert.ok(regProm.includes("mimir_bot_notification_end_to_end_age_ms_count 1"));
    assert.ok(regProm.includes("mimir_bot_notification_missing_ledger_time_total 1"));
    assert.ok(regProm.includes("mimir_bot_notification_last_age_ms 9800"));

    const healthProm = buildMetricsReport(config, poller.status(), ledgerCloseMs + 20_000);
    assert.ok(
      healthProm.includes(
        'mimir_telegram_notification_end_to_end_age_ms_bucket{network="testnet",le="15000"} 1',
      ),
    );
    assert.ok(
      healthProm.includes(
        'mimir_telegram_notification_missing_ledger_time_total{network="testnet"} 1',
      ),
    );
    assert.ok(
      healthProm.includes('mimir_telegram_notification_last_age_ms{network="testnet"} 9800'),
    );
  });
});
