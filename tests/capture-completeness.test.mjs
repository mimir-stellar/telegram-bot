import assert from "node:assert/strict";
import test from "node:test";

import {
  PartialCaptureError,
  annotatedVolumeSeries,
  assertGlobalCapture,
  formatVolumeCaptureSummary,
  volumeSeries,
} from "../dist/stellar/volume-series.js";
import {
  formatLatencyCaptureSummary,
  resolutionLatency,
} from "../dist/stellar/resolution-latency.js";

const T0 = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);

function makeEvent({ ledger, at, payload, source = "market", idx = 1 }) {
  return {
    source,
    contractId: "CMARKET1",
    version: "v1",
    ledger,
    txHash: `tx-${ledger}-${idx}`,
    at,
    eventId: `${ledger}-${idx}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("carries ledger range and gap metadata into every volume and latency result, including empty inputs", () => {
  const emptyVol = volumeSeries([], { bucket: "hour" });
  assert.ok(emptyVol.capture);
  assert.equal(emptyVol.capture.status, "partial");
  assert.equal(emptyVol.capture.isGlobalTotal, false);
  assert.ok(emptyVol.capture.reasons.includes("empty_capture"));

  const annotatedEmpty = annotatedVolumeSeries([], { bucket: "day" });
  assert.equal(Object.keys(annotatedEmpty).includes("capture"), true);
  assert.equal(annotatedEmpty.capture.isGlobalTotal, false);

  const emptyLat = resolutionLatency([]);
  assert.ok(emptyLat.capture);
  assert.equal(emptyLat.capture.status, "partial");
  assert.equal(emptyLat.capture.isGlobalTotal, false);
});

test("synthesizes retention-clamp, truncation, and explicit gaps and prevents partial captures from posing as global totals", () => {
  const events = [
    makeEvent({
      ledger: 4226510,
      at: T0 + 60,
      idx: 1,
      payload: { name: "claim_challenged", claimId: 1, challenger: "G1", stake: 50000000n },
    }),
    makeEvent({
      ledger: 4226750,
      at: T0 + 1800,
      idx: 2,
      source: "squad",
      payload: { name: "deposited", marketId: 1, side: 1, participant: "G2", amount: 80000000n, shares: 80000000n },
    }),
  ];

  const partialVol = volumeSeries(events, {
    bucket: "hour",
    capture: {
      genesisLedger: 4000000,
      requestedStartLedger: 4100000,
      oldestRetainedLedger: 4226500,
      effectiveStartLedger: 4226500,
      effectiveEndLedger: 4226800,
      requestedEndLedger: 4227000,
      latestChainLedger: 4227000,
      startClamped: true,
      truncated: true,
      gaps: [{ fromLedger: 4226600, toLedger: 4226609 }],
    },
  });

  assert.equal(partialVol.capture.status, "partial");
  assert.equal(partialVol.capture.isGlobalTotal, false);
  assert.equal(partialVol.capture.isCompleteWindow, false);
  assert.equal(partialVol.capture.scopeLabel, "partial_capture_estimate");
  assert.equal(partialVol.capture.ledgerRange.observedMinLedger, 4226510);
  assert.equal(partialVol.capture.ledgerRange.observedMaxLedger, 4226750);

  // 1) clamped head: 4100000..4226499 (126,500)
  // 2) explicit middle gap: 4226600..4226609 (10)
  // 3) truncated tail: 4226801..4227000 (200)
  assert.equal(partialVol.capture.gaps.length, 3);
  assert.equal(partialVol.capture.totalMissedLedgers, 126500 + 10 + 200);

  assert.throws(
    () => assertGlobalCapture(partialVol, "market volume"),
    (err) => err instanceof PartialCaptureError && /Refusing to present partial/.test(err.message),
  );
  assert.throws(
    () => formatVolumeCaptureSummary(partialVol, { requireGlobalTotal: true }),
    PartialCaptureError,
  );

  const summary = formatVolumeCaptureSummary(partialVol);
  assert.match(summary, /\[PARTIAL CAPTURE \(NOT GLOBAL MARKET TOTAL\)/);
  assert.match(summary, /observed_capture_total_challenge_stake=50000000/);
});

test("distinguishes clean bounded rolling windows from genesis-complete global totals", () => {
  const claimEvents = [
    makeEvent({
      ledger: 500,
      at: T0 + 10,
      idx: 1,
      payload: { name: "claim_created", claimId: 1, creator: "G1", category: "crypto", title: "C1" },
    }),
    makeEvent({
      ledger: 520,
      at: T0 + 110,
      idx: 2,
      payload: {
        name: "claim_resolved",
        claimId: 1,
        winnerSide: 1,
        summary: "Done",
        confidence: 100,
        evidenceHash: "aa",
      },
    }),
  ];

  // Clean bounded RPC window (500..550), but genesis was 100 -> bounded_window_total, NOT global!
  const windowedLatency = resolutionLatency(claimEvents, {
    capture: {
      genesisLedger: 100,
      effectiveStartLedger: 500,
      effectiveEndLedger: 550,
      latestChainLedger: 550,
    },
  });
  assert.equal(windowedLatency.capture.status, "complete_window");
  assert.equal(windowedLatency.capture.isCompleteWindow, true);
  assert.equal(windowedLatency.capture.isGlobalTotal, false);
  assert.equal(windowedLatency.capture.scopeLabel, "bounded_window_total");
  assert.throws(
    () => formatLatencyCaptureSummary(windowedLatency, { requireGlobalTotal: true }),
    PartialCaptureError,
  );
  assert.match(
    formatLatencyCaptureSummary(windowedLatency),
    /\[BOUNDED WINDOW TOTAL \(NOT ALL-TIME GLOBAL TOTAL\) — ledgers 500\.\.550, gaps=0\]/,
  );

  // Full capture anchored at genesisLedger 500 through chain tip 550 with zero gaps/exclusions
  const globalLatency = resolutionLatency(claimEvents, {
    capture: {
      genesisLedger: 500,
      effectiveStartLedger: 500,
      effectiveEndLedger: 550,
      latestChainLedger: 550,
    },
  });
  assert.equal(globalLatency.capture.status, "complete_from_genesis");
  assert.equal(globalLatency.capture.isGlobalTotal, true);
  assert.equal(globalLatency.capture.isCompleteCapture, true);
  assert.equal(globalLatency.capture.scopeLabel, "global_market_total");
  assert.doesNotThrow(() => assertGlobalCapture(globalLatency));
  assert.match(
    formatLatencyCaptureSummary(globalLatency, { requireGlobalTotal: true }),
    /\[GLOBAL MARKET TOTAL — ledgers 500\.\.550, gaps=0\]/,
  );
});

test("downgrades genesis-anchored captures to partial when events lack timestamps or claims are incomplete", () => {
  const skippedVol = volumeSeries(
    [
      makeEvent({ ledger: 100, at: undefined, idx: 1, payload: { name: "claim_challenged", stake: 100n } }),
      makeEvent({ ledger: 105, at: T0 + 30, idx: 2, payload: { name: "claim_challenged", stake: 200n } }),
    ],
    {
      bucket: "hour",
      capture: {
        genesisLedger: 100,
        effectiveStartLedger: 100,
        effectiveEndLedger: 110,
        latestChainLedger: 110,
      },
    },
  );
  assert.equal(skippedVol.capture.status, "partial");
  assert.equal(skippedVol.capture.isGlobalTotal, false);
  assert.ok(skippedVol.capture.reasons.includes("events_skipped_without_timestamp"));

  const orphanLatency = resolutionLatency(
    [
      makeEvent({
        ledger: 105,
        at: T0 + 30,
        idx: 1,
        payload: { name: "claim_cancelled", claimId: 99 },
      }),
    ],
    {
      capture: {
        genesisLedger: 100,
        effectiveStartLedger: 100,
        effectiveEndLedger: 110,
        latestChainLedger: 110,
      },
    },
  );
  assert.equal(orphanLatency.capture.status, "partial");
  assert.equal(orphanLatency.capture.isGlobalTotal, false);
  assert.ok(orphanLatency.capture.reasons.includes("incomplete_claims_excluded"));
});
