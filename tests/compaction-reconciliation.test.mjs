import assert from "node:assert/strict";
import test from "node:test";

import { compactArchive, createEventArchive, readArchive } from "../dist/stellar/archive.js";
import {
  reconcileCompaction,
  renderReconciliationReport,
} from "../dist/stellar/compaction-reconciliation.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

// ---------------------------------------------------------------------------
// Synthetic fixtures (no RPC, no keys): fixed ledgers and close times.
// ---------------------------------------------------------------------------

const DAY = 86400;
const T0 = 1_790_000_000 - (1_790_000_000 % DAY); // a UTC midnight

function meta(ledger, at, n) {
  return {
    source: "market",
    contractId: "CMOCKCONTRACT",
    version: "v1",
    ledger,
    txHash: `tx-${ledger}-${n}`,
    at,
    eventId: `${ledger}-${n}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: n,
    inSuccessfulContractCall: true,
  };
}

const created = (claimId, ledger, at) => ({
  ...meta(ledger, at, 0),
  payload: { name: "claim_created", claimId, creator: "GCREATOR", category: "crypto", title: `Claim ${claimId}` },
});
const challenged = (claimId, ledger, at, stake) => ({
  ...meta(ledger, at, 1),
  payload: { name: "claim_challenged", claimId, challenger: "GCHALLENGER", stake },
});
const resolved = (claimId, ledger, at) => ({
  ...meta(ledger, at, 2),
  payload: { name: "claim_resolved", claimId, winnerSide: 1, summary: "ok", confidence: 90, evidenceHash: "00" },
});
const deposited = (ledger, at, amount) => ({
  ...meta(ledger, at, 3),
  source: "squad",
  payload: { name: "deposited", marketId: 1, member: "GMEMBER", side: 1, amount },
});

/** Two days of history across ledgers 100..400. */
function history() {
  return [
    created(1, 100, T0 + 100),
    challenged(1, 120, T0 + 200, 5_000_000n),
    deposited(150, T0 + 300, 2_000_000n),
    resolved(1, 180, T0 + 900),
    created(2, 250, T0 + DAY + 100),
    challenged(2, 260, T0 + DAY + 200, 7_000_000n),
    deposited(300, T0 + DAY + 300, 3_000_000n),
    resolved(2, 400, T0 + DAY + 1500),
  ];
}

const inRange = (events, first, last) => events.filter((e) => e.ledger >= first && e.ledger <= last);

// ---------------------------------------------------------------------------

test("identical capture reconciles OK with no findings", () => {
  const events = history();
  const report = reconcileCompaction(events, events.slice(), { bucket: "day" });
  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.rangeLoss.lost, []);
  assert.deepEqual(report.rangeLoss.gained, []);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.before.events, 8);
  assert.equal(report.after.events, 8);
});

test("ledgers dropped outside the compaction range are expected range loss, not mismatches", () => {
  const before = history();
  const range = { firstLedger: 100, lastLedger: 200 };
  const report = reconcileCompaction(before, inRange(before, 100, 200), { range });

  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.rangeLoss.lost, [
    { firstLedger: 250, lastLedger: 400, ledgers: 4, events: 4, expected: true },
  ]);
  assert.equal(report.rangeLoss.expectedEvents, 4);
  assert.equal(report.rangeLoss.unexpectedEvents, 0);
  assert.deepEqual(report.rangeLoss.impact, {
    challengeStake: "7000000",
    squadDeposit: "3000000",
    pairedClaims: 1,
  });
  // The second day's buckets disappear entirely but are not arithmetic errors.
  assert.deepEqual(report.mismatches, []);
});

test("a ledger lost inside the range is unexpected range loss and never an arithmetic mismatch", () => {
  const before = history();
  const after = before.filter((e) => e.ledger !== 120); // drops the 5 USDC challenge
  const report = reconcileCompaction(before, after, { range: { firstLedger: 100, lastLedger: 400 } });

  assert.equal(report.ok, false);
  assert.deepEqual(report.findings, ["range-loss"]);
  assert.deepEqual(report.rangeLoss.lost, [
    { firstLedger: 120, lastLedger: 120, ledgers: 1, events: 1, expected: false },
  ]);
  assert.equal(report.rangeLoss.impact.challengeStake, "5000000");
  assert.deepEqual(report.mismatches, []);
});

test("an altered amount on a retained ledger is an arithmetic mismatch, not range loss", () => {
  const before = history();
  const after = before.map((e) =>
    e.ledger === 260 ? challenged(2, 260, T0 + DAY + 200, 7_000_001n) : e,
  );
  const report = reconcileCompaction(before, after, { bucket: "day" });

  assert.deepEqual(report.findings, ["arithmetic-mismatch"]);
  assert.deepEqual(report.rangeLoss.lost, []);
  const dayTwo = new Date((T0 + DAY) * 1000).toISOString();
  assert.deepEqual(report.mismatches, [
    { reducer: "volume", key: "total", metric: "challengeStake", before: "12000000", after: "12000001", delta: "+1" },
    { reducer: "volume", key: dayTwo, metric: "challengeStake", before: "7000000", after: "7000001", delta: "+1" },
  ]);
});

test("a record lost from a retained ledger shows as a count/latency mismatch", () => {
  const before = [...history(), resolved(1, 120, T0 + 200)]; // ledger 120 now carries two events
  const after = before.filter((e) => !(e.ledger === 120 && e.payload.name === "claim_resolved"));
  const report = reconcileCompaction(before, after);

  assert.deepEqual(report.findings, ["arithmetic-mismatch"]);
  assert.deepEqual(report.rangeLoss.lost, []);
  const metrics = report.mismatches.map((m) => `${m.reducer}:${m.key}:${m.metric}`);
  assert.ok(metrics.includes("volume:total:processedEvents"));
  assert.ok(metrics.includes("latency:claim:1:seconds"));
});

test("both classes are reported side by side when they co-occur", () => {
  const before = history();
  const after = before
    .filter((e) => e.ledger !== 150)
    .map((e) => (e.ledger === 400 ? resolved(2, 400, T0 + DAY + 1600) : e));
  const report = reconcileCompaction(before, after);
  assert.deepEqual(report.findings, ["range-loss", "arithmetic-mismatch"]);
  assert.equal(report.rangeLoss.impact.squadDeposit, "2000000");
  assert.ok(report.mismatches.every((m) => m.reducer === "latency"));
});

test("ledgers that appear only after compaction are range gain", () => {
  const before = history();
  const after = [...before, deposited(999, T0 + DAY + 5000, 1n)];
  const report = reconcileCompaction(before, after);
  assert.deepEqual(report.findings, ["range-gain"]);
  assert.deepEqual(report.rangeLoss.gained, [
    { firstLedger: 999, lastLedger: 999, ledgers: 1, events: 1, expected: false },
  ]);
  assert.deepEqual(report.mismatches, []);
});

test("boundary: empty compacted archive loses the whole capture; empty inputs reconcile OK", () => {
  const before = history();
  const report = reconcileCompaction(before, []);
  assert.deepEqual(report.findings, ["range-loss"]);
  assert.deepEqual(report.rangeLoss.lost, [
    { firstLedger: 100, lastLedger: 400, ledgers: 8, events: 8, expected: false },
  ]);
  assert.equal(report.after.ledgerMin, null);

  const empty = reconcileCompaction([], null);
  assert.equal(empty.ok, true);
  assert.equal(empty.before.ledgerMin, null);
});

test("boundary: inclusive range endpoints are not counted as loss; invalid records are counted", () => {
  const before = [...history(), { not: "an event" }, null];
  const after = inRange(history(), 120, 300);
  const report = reconcileCompaction(before, after, { range: { firstLedger: 120, lastLedger: 300 } });
  assert.equal(report.ok, true);
  assert.equal(report.before.invalid, 2);
  assert.deepEqual(
    report.rangeLoss.lost.map((s) => [s.firstLedger, s.lastLedger, s.expected]),
    [
      [100, 100, true],
      [400, 400, true],
    ],
  );
});

test("invalid options throw", () => {
  assert.throws(() => reconcileCompaction([], [], { range: { firstLedger: 10, lastLedger: 5 } }), RangeError);
  assert.throws(() => reconcileCompaction([], [], { bucket: "week" }), /Invalid bucket unit/);
});

test("report and rendering are deterministic regardless of input order", () => {
  const before = history();
  const after = before.filter((e) => e.ledger !== 120 && e.ledger <= 300);
  const a = reconcileCompaction(before, after, { range: { firstLedger: 100, lastLedger: 300 } });
  const b = reconcileCompaction(
    [...before].reverse(),
    [...after].reverse(),
    { range: { firstLedger: 100, lastLedger: 300 } },
  );
  assert.deepEqual(a, b);
  assert.equal(renderReconciliationReport(a), renderReconciliationReport(b));
  assert.equal(
    renderReconciliationReport(a),
    [
      "Compaction reconciliation report (v1)",
      "status: FAIL (range-loss)",
      "bucket: day",
      "compaction range: 100..300",
      "before: events=8 invalid=0 ledgers 100..400",
      "after:  events=6 invalid=0 ledgers 100..300",
      "",
      "Range loss: 2 span(s), expected events=1, unexpected events=1",
      "  120..120  ledgers=1 events=1  UNEXPECTED",
      "  400..400  ledgers=1 events=1  expected (outside compaction range)",
      "  impact: challengeStake=5000000 squadDeposit=0 pairedClaims=1",
      "Range gain: 0 span(s)",
      "",
      "Arithmetic mismatches (shared ledgers only): 0",
      "",
    ].join("\n"),
  );
});

test("end to end: compactArchive output reconciles against the pre-compaction archive", async () => {
  await withTempDataDir(async (tmp) => {
    const dir = tmp.file("archive");
    const archive = createEventArchive({ dir });
    await archive.append(history());
    await archive.close();

    const drain = async () => {
      const out = [];
      for await (const e of readArchive(dir)) out.push(e);
      return out;
    };
    const beforeEvents = await drain();
    const range = { firstLedger: 100, lastLedger: 260 };
    await compactArchive(dir, range);
    const afterEvents = await drain();

    const report = reconcileCompaction(beforeEvents, afterEvents, { range });
    assert.equal(report.ok, true);
    assert.deepEqual(report.mismatches, []);
    assert.deepEqual(report.rangeLoss.lost, [
      { firstLedger: 300, lastLedger: 400, ledgers: 2, events: 2, expected: true },
    ]);
    assert.equal(report.rangeLoss.impact.squadDeposit, "3000000");
  });
});
