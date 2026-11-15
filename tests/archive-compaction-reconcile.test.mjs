import assert from "node:assert/strict";
import test from "node:test";

import {
  compactArchive,
  compactArchiveEvents,
  createEventArchive,
} from "../dist/stellar/archive.js";
import {
  buildAggregateSnapshot,
  compareCompactedAggregates,
  formatReconciliationReport,
  reconcileAggregateSnapshots,
  reconcileArchiveCompaction,
} from "../dist/stellar/volume-series.js";
import { compareCompactedAggregates as compareFromLatency } from "../dist/stellar/resolution-latency.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const T0 = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);

function makeEvent({
  eventId,
  ledger,
  at,
  source = "market",
  contractId = "CMARKET123",
  txHash,
  transactionIndex = 0,
  operationIndex = 0,
  payload,
}) {
  return {
    source,
    contractId,
    version: "v1",
    ledger,
    txHash: txHash ?? `tx-${ledger}-${eventId}`,
    at,
    eventId,
    eventType: "contract",
    transactionIndex,
    operationIndex,
    inSuccessfulContractCall: true,
    payload,
  };
}

function buildBaselineArchiveFixture() {
  return [
    // Hour 0 (10:00Z): ledgers 100..130
    makeEvent({
      eventId: "000100-0001",
      ledger: 100,
      at: T0 + 120,
      payload: { name: "claim_created", claimId: 1, creator: "G1", category: "crypto", title: "Q1" },
    }),
    makeEvent({
      eventId: "000110-0001",
      ledger: 110,
      at: T0 + 600,
      payload: { name: "claim_challenged", claimId: 1, challenger: "G2", stake: 250000000n },
    }),
    makeEvent({
      eventId: "000130-0001",
      ledger: 130,
      at: T0 + 1800,
      payload: {
        name: "claim_resolved",
        claimId: 1,
        winnerSide: 1,
        summary: "Resolved",
        confidence: 100,
        evidenceHash: "aa",
      },
    }),

    // Hour 1 (11:00Z): ledgers 200..260 (two events so we can also test boundary trimming)
    makeEvent({
      eventId: "000200-0001",
      ledger: 200,
      at: T0 + 3600 + 300,
      source: "squad",
      contractId: "CSQUAD123",
      payload: { name: "deposited", marketId: 1, member: "G3", amount: 500000000n, shares: 500000000n },
    }),
    makeEvent({
      eventId: "000240-0001",
      ledger: 240,
      at: T0 + 3600 + 1500,
      payload: { name: "claim_created", claimId: 2, creator: "G1", category: "macro", title: "Q2" },
    }),
    makeEvent({
      eventId: "000260-0001",
      ledger: 260,
      at: T0 + 3600 + 2400,
      payload: { name: "claim_challenged", claimId: 2, challenger: "G4", stake: 750000000n },
    }),

    // Hour 2 (12:00Z): ledgers 310..350
    makeEvent({
      eventId: "000310-0001",
      ledger: 310,
      at: T0 + 7200 + 600,
      payload: { name: "claim_cancelled", claimId: 2 },
    }),
    makeEvent({
      eventId: "000340-0001",
      ledger: 340,
      at: T0 + 7200 + 1200,
      payload: { name: "claim_created", claimId: 3, creator: "G5", category: "tech", title: "Q3" },
    }),
    makeEvent({
      eventId: "000350-0001",
      ledger: 350,
      at: T0 + 7200 + 2100,
      payload: {
        name: "claim_resolved",
        claimId: 3,
        winnerSide: 0,
        summary: "Resolved Q3",
        confidence: 95,
        evidenceHash: "bb",
      },
    }),
  ];
}

test("lossless archive compaction reconciles with match status across rotated JSONL files", async () => {
  assert.equal(compareCompactedAggregates, compareFromLatency);

  await withTempDataDir(async (tmp) => {
    const rawDir = tmp.file("archive-before");
    const compactedDir = tmp.file("archive-after");

    const baseEvents = buildBaselineArchiveFixture();
    // Write small rotated files plus redelivered duplicates in raw archive
    const rawArchive = createEventArchive({ dir: rawDir, maxBytes: 320, maxFiles: 50 });
    await rawArchive.append([baseEvents[0], baseEvents[1], baseEvents[1], baseEvents[2]]);
    await rawArchive.append([baseEvents[3], baseEvents[4], baseEvents[5]]);
    await rawArchive.append([baseEvents[6], baseEvents[7], baseEvents[8], baseEvents[0]]);
    await rawArchive.close();

    const stats = await compactArchive(rawDir, compactedDir, { maxBytes: 1024 * 1024, maxFiles: 5 });
    assert.equal(stats.beforeCount, 11);
    assert.equal(stats.afterCount, 9);
    assert.equal(stats.duplicatesRemoved, 2);
    assert.equal(stats.droppedByRange, 0);

    const report = await reconcileArchiveCompaction(rawDir, compactedDir, {
      bucket: "hour",
      deduplicate: true,
    });

    assert.equal(report.status, "match");
    assert.equal(report.ok, true);
    assert.equal(report.hasRangeLoss, false);
    assert.equal(report.hasArithmeticMismatch, false);
    assert.deepEqual(report.ledgerSpan.before, { minLedger: 100, maxLedger: 350 });
    assert.deepEqual(report.ledgerSpan.after, { minLedger: 100, maxLedger: 350 });
    assert.equal(report.totals.beforeChallengeStake, "1000000000");
    assert.equal(report.totals.afterChallengeStake, "1000000000");
    assert.equal(report.totals.beforeSquadDeposit, "500000000");
    assert.equal(report.totals.afterSquadDeposit, "500000000");
    assert.equal(report.rangeLosses.length, 0);
    assert.equal(report.arithmeticMismatches.length, 0);
  });
});

test("reconciliation report and formatted output are deterministic regardless of input ordering", () => {
  const events = buildBaselineArchiveFixture();
  const reversed = [...events].reverse();
  const { events: compacted } = compactArchiveEvents(reversed, { minLedger: 220 });

  const r1 = compareCompactedAggregates(events, compacted, { bucket: "hour" });
  const r2 = compareCompactedAggregates(reversed, [...compacted].reverse(), { bucket: "hour" });

  assert.deepEqual(r1, r2);
  assert.equal(formatReconciliationReport(r1), formatReconciliationReport(r2));
});

test("identifies head/tail range loss separately from arithmetic mismatch (including partial boundary buckets)", () => {
  const beforeEvents = buildBaselineArchiveFixture();
  // Trim ledgers below 220: drops all of Hour 0 (100..130) AND the first event of Hour 1 (ledger 200 deposit),
  // leaving ledgers 240..350 intact.
  const { events: afterEvents, stats } = compactArchiveEvents(beforeEvents, { minLedger: 220 });
  assert.equal(stats.droppedByRange, 4);

  const report = compareCompactedAggregates(beforeEvents, afterEvents, { bucket: "hour" });

  assert.equal(report.status, "range_loss");
  assert.equal(report.ok, false);
  assert.equal(report.hasRangeLoss, true);
  assert.equal(report.hasArithmeticMismatch, false);
  assert.equal(report.arithmeticMismatches.length, 0);

  const kinds = report.rangeLosses.map((r) => r.kind);
  assert.ok(kinds.includes("ledger_head_trimmed"));
  assert.ok(kinds.includes("volume_bucket_missing"));
  assert.ok(kinds.includes("volume_bucket_trimmed"));
  assert.ok(kinds.includes("claim_missing"));

  const text = formatReconciliationReport(report);
  assert.match(text, /status=range_loss ok=false bucket=hour/);
  assert.match(text, /\[range_loss\] ledger:ledger_head_trimmed:minLedger \(100 -> 240\)/);
});

test("identifies arithmetic mismatch without range loss when amounts, counts, or claim outcomes diverge", () => {
  const beforeEvents = buildBaselineArchiveFixture();
  // Simulate buggy compaction that truncates a stake amount and flips a resolution timestamp/outcome
  // while keeping the exact outer ledger range [100..350].
  const corruptedAfter = beforeEvents.map((ev) => {
    if (ev.eventId === "000260-0001") {
      return {
        ...ev,
        payload: { ...ev.payload, stake: 749999999n }, // 1 stroop lost
      };
    }
    if (ev.eventId === "000310-0001") {
      return {
        ...ev,
        payload: {
          name: "claim_resolved",
          claimId: 2,
          winnerSide: 1,
          summary: "Wrong outcome",
          confidence: 100,
          evidenceHash: "cc",
        },
      };
    }
    if (ev.eventId === "000350-0001") {
      return {
        ...ev,
        at: ev.at + 45, // duration changed inside retained window
      };
    }
    return ev;
  });

  const report = compareCompactedAggregates(beforeEvents, corruptedAfter, { bucket: "hour" });

  assert.equal(report.status, "arithmetic_mismatch");
  assert.equal(report.ok, false);
  assert.equal(report.hasRangeLoss, false);
  assert.equal(report.hasArithmeticMismatch, true);
  assert.equal(report.rangeLosses.length, 0);

  const mismatchKinds = report.arithmeticMismatches.map((m) => m.kind);
  assert.ok(mismatchKinds.includes("bucket_challenge_stake_mismatch"));
  assert.ok(mismatchKinds.includes("overlap_total_mismatch"));
  assert.ok(mismatchKinds.includes("claim_outcome_mismatch"));
  assert.ok(mismatchKinds.includes("claim_duration_mismatch"));
  assert.ok(mismatchKinds.includes("latency_summary_mismatch"));
});

test("reports combined range_loss_and_arithmetic_mismatch when both occur simultaneously", () => {
  const beforeEvents = buildBaselineArchiveFixture();
  const { events: trimmed } = compactArchiveEvents(beforeEvents, { maxLedger: 300 });
  // Also corrupt interior stake at ledger 110
  const trimmedAndCorrupted = trimmed.map((ev) =>
    ev.eventId === "000110-0001"
      ? { ...ev, payload: { ...ev.payload, stake: 999999999n } }
      : ev,
  );

  const report = compareCompactedAggregates(beforeEvents, trimmedAndCorrupted, { bucket: "hour" });

  assert.equal(report.status, "range_loss_and_arithmetic_mismatch");
  assert.equal(report.ok, false);
  assert.equal(report.hasRangeLoss, true);
  assert.equal(report.hasArithmeticMismatch, true);
  assert.ok(report.rangeLosses.some((r) => r.kind === "ledger_tail_trimmed"));
  assert.ok(
    report.arithmeticMismatches.some((m) => m.kind === "bucket_challenge_stake_mismatch"),
  );
});

test("handles boundary cases: empty archives, complete compaction loss, and mismatched bucket units", () => {
  const emptyReport = compareCompactedAggregates([], [], { bucket: "day" });
  assert.equal(emptyReport.status, "match");
  assert.equal(emptyReport.ok, true);
  assert.deepEqual(emptyReport.ledgerSpan.before, { minLedger: null, maxLedger: null });
  assert.match(formatReconciliationReport(emptyReport), /ledgers before=empty after=empty/);

  const beforeEvents = buildBaselineArchiveFixture();
  const wipedReport = compareCompactedAggregates(beforeEvents, [], { bucket: "hour" });
  assert.equal(wipedReport.status, "range_loss");
  assert.equal(wipedReport.hasRangeLoss, true);
  assert.equal(wipedReport.hasArithmeticMismatch, false);

  const snapHour = buildAggregateSnapshot(beforeEvents, { bucket: "hour" });
  const snapDay = buildAggregateSnapshot(beforeEvents, { bucket: "day" });
  assert.throws(
    () => reconcileAggregateSnapshots(snapHour, snapDay),
    /Cannot reconcile snapshots with different bucket units/,
  );
});
