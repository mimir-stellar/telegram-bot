import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCaptureCompleteness,
  normalizeGaps,
  isNonNegativeSafeInteger,
  IncompleteCaptureError,
  assertCompleteCapture,
} from "../dist/stellar/capture-completeness.js";

test("isNonNegativeSafeInteger utility", () => {
  assert.equal(isNonNegativeSafeInteger(0), true);
  assert.equal(isNonNegativeSafeInteger(100), true);
  assert.equal(isNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER), true);

  assert.equal(isNonNegativeSafeInteger(-1), false);
  assert.equal(isNonNegativeSafeInteger(-100), false);
  assert.equal(isNonNegativeSafeInteger(NaN), false);
  assert.equal(isNonNegativeSafeInteger(Infinity), false);
  assert.equal(isNonNegativeSafeInteger(-Infinity), false);
  assert.equal(isNonNegativeSafeInteger(1.5), false);
  assert.equal(isNonNegativeSafeInteger("100"), false);
  assert.equal(isNonNegativeSafeInteger(null), false);
  assert.equal(isNonNegativeSafeInteger(undefined), false);
  assert.equal(isNonNegativeSafeInteger({}), false);
});

test("computeCaptureCompleteness: distinguishes absent bounds from invalid supplied bounds", () => {
  // Absent bounds fall back to observed events
  const res1 = computeCaptureCompleteness([{ ledger: 50 }, { ledger: 150 }]);
  assert.equal(res1.startLedger, 50);
  assert.equal(res1.endLedger, 150);
  assert.deepEqual(res1.ledgerRange, { fromLedger: 50, toLedger: 150 });

  // Absent bounds with empty events fall back to null
  const res2 = computeCaptureCompleteness([]);
  assert.equal(res2.startLedger, null);
  assert.equal(res2.endLedger, null);
  assert.deepEqual(res2.ledgerRange, { fromLedger: null, toLedger: null });

  // Explicit undefined bounds fall back to observed events
  const res3 = computeCaptureCompleteness([{ ledger: 20 }], { fromLedger: undefined, toLedger: undefined });
  assert.equal(res3.startLedger, 20);
  assert.equal(res3.endLedger, 20);

  // Invalid supplied bounds throw Error
  assert.throws(
    () => computeCaptureCompleteness([], { fromLedger: -5, toLedger: -1 }),
    /Invalid ledger range: fromLedger must be a non-negative safe integer; got -5/,
  );
  assert.throws(
    () => computeCaptureCompleteness([], { fromLedger: NaN, toLedger: 100 }),
    /Invalid ledger range: fromLedger must be a non-negative safe integer; got NaN/,
  );
  assert.throws(
    () => computeCaptureCompleteness([], { fromLedger: 10, toLedger: -1 }),
    /Invalid ledger range: toLedger must be a non-negative safe integer; got -1/,
  );
  assert.throws(
    () => computeCaptureCompleteness([], { fromLedger: 10.5, toLedger: 100 }),
    /Invalid ledger range: fromLedger must be a non-negative safe integer; got 10.5/,
  );
  assert.throws(
    () => computeCaptureCompleteness([], { startLedger: -10 }),
    /Invalid ledger range: startLedger must be a non-negative safe integer; got -10/,
  );
  assert.throws(
    () => computeCaptureCompleteness([], { endLedger: "not-a-number" }),
    /Invalid ledger range: endLedger must be a non-negative safe integer; got not-a-number/,
  );
});

test("computeCaptureCompleteness: rejects missing or non-finite gap endpoints", () => {
  // User reproduction case: { fromLedger: 50, toLedger: NaN }
  assert.throws(
    () =>
      computeCaptureCompleteness([{ ledger: 100 }], {
        isComplete: true,
        requireComplete: true,
        gaps: [{ fromLedger: 50, toLedger: NaN }],
      }),
    /Invalid gap entry at index 0: toLedger must be a non-negative safe integer; got NaN/,
  );

  // Incomplete JSON entry without toLedger: { fromLedger: 50 }
  assert.throws(
    () =>
      computeCaptureCompleteness([{ ledger: 100 }], {
        isComplete: true,
        requireComplete: true,
        gaps: [{ fromLedger: 50 }],
      }),
    /Invalid gap entry at index 0: toLedger must be a non-negative safe integer; got undefined/,
  );

  // Incomplete JSON entry without fromLedger: { toLedger: 100 }
  assert.throws(
    () =>
      computeCaptureCompleteness([{ ledger: 100 }], {
        gaps: [{ toLedger: 100 }],
      }),
    /Invalid gap entry at index 0: fromLedger must be a non-negative safe integer; got undefined/,
  );

  // Non-object gap entry
  assert.throws(
    () =>
      computeCaptureCompleteness([], {
        gaps: [null],
      }),
    /Invalid gap entry at index 0: expected an object; got null/,
  );
  assert.throws(
    () =>
      computeCaptureCompleteness([], {
        gaps: ["invalid"],
      }),
    /Invalid gap entry at index 0: expected an object; got invalid/,
  );

  // Negative gap endpoints
  assert.throws(
    () =>
      computeCaptureCompleteness([], {
        gaps: [{ fromLedger: -10, toLedger: 20 }],
      }),
    /Invalid gap entry at index 0: fromLedger must be a non-negative safe integer; got -10/,
  );

  // Inverted gap range
  assert.throws(
    () =>
      computeCaptureCompleteness([], {
        gaps: [{ fromLedger: 100, toLedger: 50 }],
      }),
    /Invalid gap range at index 0: fromLedger \(100\) cannot exceed toLedger \(50\)/,
  );

  // Invalid missedLedgers in gap entry
  assert.throws(
    () =>
      computeCaptureCompleteness([], {
        gaps: [{ fromLedger: 10, toLedger: 20, missedLedgers: 0 }],
      }),
    /Invalid gap entry at index 0: missedLedgers must be a positive safe integer; got 0/,
  );
  assert.throws(
    () =>
      computeCaptureCompleteness([], {
        gaps: [{ fromLedger: 10, toLedger: 20, missedLedgers: -5 }],
      }),
    /Invalid gap entry at index 0: missedLedgers must be a positive safe integer; got -5/,
  );
});

test("normalizeGaps: merges overlapping and adjacent gaps without double-counting missed ledgers", () => {
  // Overlapping gaps: [10..20] (11) and [15..30] (16) -> merged to [10..30] (21 missed ledgers)
  const overlapping = [
    { fromLedger: 10, toLedger: 20, missedLedgers: 11 },
    { fromLedger: 15, toLedger: 30, missedLedgers: 16 },
  ];
  const merged1 = normalizeGaps(overlapping);
  assert.deepEqual(merged1, [
    { fromLedger: 10, toLedger: 30, missedLedgers: 21 },
  ]);

  // Adjacent gaps: [10..20] and [21..25] -> merged to [10..25] (16 missed ledgers)
  const adjacent = [
    { fromLedger: 10, toLedger: 20, missedLedgers: 11 },
    { fromLedger: 21, toLedger: 25, missedLedgers: 5 },
  ];
  const merged2 = normalizeGaps(adjacent);
  assert.deepEqual(merged2, [
    { fromLedger: 10, toLedger: 25, missedLedgers: 16 },
  ]);

  // Fully enclosed gap: [10..50] and [20..30] -> [10..50]
  const enclosed = [
    { fromLedger: 20, toLedger: 30, missedLedgers: 11 },
    { fromLedger: 10, toLedger: 50, missedLedgers: 41 },
  ];
  const merged3 = normalizeGaps(enclosed);
  assert.deepEqual(merged3, [
    { fromLedger: 10, toLedger: 50, missedLedgers: 41 },
  ]);

  // Disjoint gaps: [10..20] and [30..40] -> remain separate
  const disjoint = [
    { fromLedger: 30, toLedger: 40, missedLedgers: 11 },
    { fromLedger: 10, toLedger: 20, missedLedgers: 11 },
  ];
  const merged4 = normalizeGaps(disjoint);
  assert.deepEqual(merged4, [
    { fromLedger: 10, toLedger: 20, missedLedgers: 11 },
    { fromLedger: 30, toLedger: 40, missedLedgers: 11 },
  ]);
});

test("computeCaptureCompleteness: normalizes overlapping gaps and totals missed ledgers accurately", () => {
  const result = computeCaptureCompleteness([{ ledger: 5 }, { ledger: 100 }], {
    isComplete: true,
    gaps: [
      { fromLedger: 10, toLedger: 20 },
      { fromLedger: 15, toLedger: 30 },
      { fromLedger: 50, toLedger: 60 },
    ],
  });

  // Gaps [10..20] and [15..30] merged to [10..30] (21 ledgers), [50..60] is 11 ledgers -> total 32
  assert.equal(result.hasGaps, true);
  assert.equal(result.isComplete, false);
  assert.equal(result.isPartial, true);
  assert.equal(result.totalMissedLedgers, 32);
  assert.deepEqual(result.gaps, [
    { fromLedger: 10, toLedger: 30, missedLedgers: 21 },
    { fromLedger: 50, toLedger: 60, missedLedgers: 11 },
  ]);
});
