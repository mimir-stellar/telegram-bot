import assert from "node:assert/strict";
import test from "node:test";

import {
  compareArchiveCoverage,
  compareArchiveDirectories,
  createEventArchive,
  formatArchiveCoverageReport,
} from "../dist/stellar/archive.js";
import { formatScanJsonl, parseScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const MARKET_CONTRACT = "C" + "A".repeat(55);
const SQUAD_CONTRACT = "C" + "B".repeat(55);
const CREATOR = "G" + "C".repeat(55);

function makeEvent({
  id,
  ledger,
  source = "market",
  contractId = source === "market" ? MARKET_CONTRACT : SQUAD_CONTRACT,
  name = source === "market" ? "claim_created" : "market_created",
  category = "crypto",
}) {
  return {
    source,
    contractId,
    version: "v1",
    ledger,
    txHash: `${String(ledger).padStart(8, "0")}${"a".repeat(56)}`,
    at: 1_700_000_000 + ledger,
    eventId: id ?? `ev-${source}-${ledger}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload:
      name === "claim_created"
        ? { name: "claim_created", claimId: ledger, creator: CREATOR, category }
        : name === "claim_challenged"
          ? { name: "claim_challenged", claimId: ledger, challenger: CREATOR, stake: 10_000_000n }
          : {
              name: "market_created",
              marketId: ledger,
              captain: CREATOR,
              deadline: 1_700_100_000,
              feeBps: 100,
              question: `Question ${ledger}`,
              category,
            },
  };
}

test("reports overlapping and missing ranges with stable event counts across permutations and duplicates", () => {
  const e100 = makeEvent({ ledger: 100 });
  const e150 = makeEvent({ ledger: 150 });
  const e200 = makeEvent({ ledger: 200 });
  const e250 = makeEvent({ ledger: 250 });
  const e300 = makeEvent({ ledger: 300 });

  // Left covers 100..250, Right covers 150..300
  const leftCapture = {
    events: [e100, e150, e200, e250],
    meta: { startLedger: 100, endLedger: 250 },
  };
  const rightCapture = {
    events: [e150, e200, e250, e300],
    meta: { startLedger: 150, endLedger: 300 },
  };

  const baseline = compareArchiveCoverage(leftCapture, rightCapture);

  assert.deepEqual(baseline.overlappingRanges, [
    {
      startLedger: 150,
      endLedger: 250,
      ledgerCount: 101,
      eventCount: 3,
      leftEventCount: 3,
      rightEventCount: 3,
      sharedEventCount: 3,
    },
  ]);
  assert.deepEqual(baseline.missingInRight, [
    { startLedger: 100, endLedger: 149, ledgerCount: 50, eventCount: 1 },
  ]);
  assert.deepEqual(baseline.missingInLeft, [
    { startLedger: 251, endLedger: 300, ledgerCount: 50, eventCount: 1 },
  ]);
  assert.deepEqual(baseline.uncoveredGapRanges, []);
  assert.equal(baseline.counts.sharedEvents, 3);
  assert.equal(baseline.counts.onlyInLeft, 1);
  assert.equal(baseline.counts.onlyInRight, 1);
  assert.equal(baseline.status, "incomplete_acquisition");

  // Permute order and add duplicate boundary events
  const permuted = compareArchiveCoverage(
    {
      events: [e250, e150, e100, e200, e150],
      meta: { startLedger: 100, endLedger: 250 },
    },
    {
      events: [e300, e200, e300, e150, e250],
      meta: { startLedger: 150, endLedger: 300 },
    },
  );

  assert.equal(permuted.left.uniqueEventCount, 4);
  assert.equal(permuted.left.duplicateEventCount, 1);
  assert.equal(permuted.right.uniqueEventCount, 4);
  assert.equal(permuted.right.duplicateEventCount, 1);
  assert.deepEqual(permuted.overlappingRanges, baseline.overlappingRanges);
  assert.deepEqual(permuted.missingInLeft, baseline.missingInLeft);
  assert.deepEqual(permuted.missingInRight, baseline.missingInRight);
  assert.deepEqual(permuted.counts, baseline.counts);
});

test("distinguishes intentional contract and category filtering from incomplete acquisition", () => {
  const fullEvents = [
    makeEvent({ ledger: 100, source: "squad" }),
    makeEvent({ ledger: 120, source: "market", category: "crypto" }),
    makeEvent({ ledger: 140, source: "market", category: "sports" }),
    makeEvent({ ledger: 160, source: "market", category: "crypto" }),
    makeEvent({ ledger: 180, source: "squad" }),
  ];

  // Right capture intentionally filtered to market + crypto (even with NFKC/case differences)
  const filteredRight = {
    events: [fullEvents[1], fullEvents[3]],
    meta: {
      filter: {
        sources: ["market"],
        categories: [" CRYPTO "],
      },
    },
  };

  const filteredReport = compareArchiveCoverage(fullEvents, filteredRight);
  assert.equal(filteredReport.status, "intentional_filter");
  assert.equal(filteredReport.counts.sharedEvents, 2);
  assert.equal(filteredReport.counts.onlyInLeft, 3);
  assert.equal(filteredReport.counts.filteredOutInRight, 3);
  assert.equal(filteredReport.counts.incompleteInRight, 0);
  assert.ok(
    filteredReport.discrepancies.every((d) => d.classification === "intentional_filter"),
  );

  // Now drop one matching crypto market event inside the overlap -> incomplete acquisition + filter = mixed
  const droppedAndFiltered = {
    events: [fullEvents[1]],
    meta: {
      startLedger: 100,
      endLedger: 180,
      filter: {
        sources: ["market"],
        categories: ["crypto"],
      },
    },
  };

  const mixedReport = compareArchiveCoverage(
    { events: fullEvents, meta: { startLedger: 100, endLedger: 180 } },
    droppedAndFiltered,
  );
  assert.equal(mixedReport.status, "mixed");
  assert.equal(mixedReport.counts.filteredOutInRight, 3);
  assert.equal(mixedReport.counts.incompleteInRight, 1);
  assert.ok(mixedReport.discrepancies.some((d) => d.reason === "missing_overlap_events"));
  assert.ok(mixedReport.discrepancies.some((d) => d.reason === "filter_mismatch"));
});

test("flags truncated and clamped captures as incomplete acquisition even when observed events match", () => {
  const events = [makeEvent({ ledger: 210 }), makeEvent({ ledger: 220 })];
  const full = { events, meta: { startLedger: 200, endLedger: 250 } };
  const truncatedRight = {
    events,
    meta: { startLedger: 200, endLedger: 250, truncated: true },
  };

  const res = compareArchiveCoverage(full, truncatedRight);
  assert.equal(res.status, "incomplete_acquisition");
  assert.ok(res.discrepancies.some((d) => d.reason === "truncated_scan" && d.side === "right"));

  const clampedLeft = {
    events,
    meta: { startLedger: 200, endLedger: 250, startClamped: true },
  };
  const clampedRes = compareArchiveCoverage(clampedLeft, full);
  assert.equal(clampedRes.status, "incomplete_acquisition");
  assert.ok(
    clampedRes.discrepancies.some((d) => d.reason === "clamped_start" && d.side === "left"),
  );
});

test("handles disjoint vs adjacent ledger ranges and empty captures", () => {
  const disjoint = compareArchiveCoverage(
    { events: [makeEvent({ ledger: 110 })], meta: { startLedger: 100, endLedger: 149 } },
    { events: [makeEvent({ ledger: 210 })], meta: { startLedger: 200, endLedger: 249 } },
  );
  assert.deepEqual(disjoint.overlappingRanges, []);
  assert.deepEqual(disjoint.uncoveredGapRanges, [
    { startLedger: 150, endLedger: 199, ledgerCount: 50 },
  ]);

  const adjacent = compareArchiveCoverage(
    { events: [makeEvent({ ledger: 110 })], meta: { startLedger: 100, endLedger: 149 } },
    { events: [makeEvent({ ledger: 160 })], meta: { startLedger: 150, endLedger: 199 } },
  );
  assert.deepEqual(adjacent.overlappingRanges, []);
  assert.deepEqual(adjacent.uncoveredGapRanges, []);

  const bothEmpty = compareArchiveCoverage([], []);
  assert.equal(bothEmpty.status, "none");
  assert.equal(bothEmpty.left.bounds, null);
  assert.equal(bothEmpty.right.bounds, null);
});

test("integrates with on-disk event archives and JSONL round-trip helpers", async () => {
  await withTempDataDir(async (tmp) => {
    const dirA = tmp.file("archive-a");
    const dirB = tmp.file("archive-b");

    const ev1 = makeEvent({ ledger: 501, source: "market" });
    const ev2 = makeEvent({ ledger: 505, source: "squad" });
    const ev3 = makeEvent({ ledger: 510, source: "market" });

    const archiveA = createEventArchive({ dir: dirA });
    await archiveA.append([ev1, ev2, ev3]);
    await archiveA.close();

    const archiveB = createEventArchive({ dir: dirB });
    await archiveB.append([ev1, ev3]);
    await archiveB.close();

    const dirReport = await compareArchiveDirectories(dirA, dirB, {
      leftMeta: { startLedger: 500, endLedger: 515 },
      rightMeta: { startLedger: 500, endLedger: 515, filter: { sources: ["market"] } },
    });
    assert.equal(dirReport.status, "intentional_filter");
    assert.equal(dirReport.counts.sharedEvents, 2);
    assert.equal(dirReport.counts.filteredOutInRight, 1);

    const rendered = formatArchiveCoverageReport(dirReport);
    assert.match(rendered, /^status: intentional_filter/m);
    assert.match(rendered, /overlap: 500\.\.515 \(events=3\)/);

    // JSONL round-trip with capture metadata
    const jsonlA = formatScanJsonl([ev1, ev2, ev3], { startLedger: 500, endLedger: 515 });
    const jsonlB = formatScanJsonl([ev1], {
      startLedger: 500,
      endLedger: 505,
      truncated: true,
    });
    const parsedA = parseScanJsonl(jsonlA);
    const parsedB = parseScanJsonl(jsonlB);
    const jsonlCmp = compareArchiveCoverage(parsedA, parsedB);
    assert.equal(jsonlCmp.status, "incomplete_acquisition");
    assert.deepEqual(jsonlCmp.missingInRight, [
      { startLedger: 506, endLedger: 515, ledgerCount: 10, eventCount: 1 },
    ]);
  });
});

test("rejects invalid capture bounds and malformed JSONL inputs", () => {
  assert.throws(
    () => compareArchiveCoverage({ events: [], meta: { startLedger: 300, endLedger: 200 } }, []),
    RangeError,
  );
  assert.throws(
    () => compareArchiveCoverage({ events: [], meta: { startLedger: 0 } }, []),
    RangeError,
  );
  assert.throws(
    () => compareArchiveCoverage([{ ...makeEvent({ ledger: 10 }), ledger: -5 }], []),
    RangeError,
  );
  assert.throws(() => parseScanJsonl("{not-json}\n"), /Malformed JSONL at line 1/);
  assert.throws(() => parseScanJsonl('{"type":"bogus"}\n'), /Unknown JSONL record type/);
});
