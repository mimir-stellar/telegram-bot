import assert from "node:assert/strict";
import test from "node:test";

import {
  compareArchiveDirCoverage,
  compareLedgerCoverage,
  formatArchiveCoverageReport,
  MalformedArchiveRecordError,
  createEventArchive,
} from "../dist/stellar/archive.js";
import {
  compareScanJsonlCoverage,
  formatScanJsonl,
  MalformedScanJsonlRecordError,
} from "../dist/stellar/scan-jsonl.js";
import {
  compareArchiveCoverage,
  renderArchiveCoverageReport,
} from "../dist/stellar/archive-coverage.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function event(ledger, n = 0) {
  return {
    source: "market",
    contractId: "CMOCKCONTRACT",
    version: "v1",
    ledger,
    txHash: `tx-${ledger}-${n}`,
    at: 1_790_000_000 + ledger,
    eventId: `${ledger}-${n}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: n,
    inSuccessfulContractCall: true,
    payload: { name: "claim_created", claimId: ledger, creator: "GCREATOR", category: "crypto", title: `Claim ${ledger}` },
  };
}

const capture = [event(100), event(100, 1), event(110), event(120), event(120, 1), event(130)];
const retained = [event(110), event(120), event(120, 1)];

test("missing and overlapping ranges carry stable event counts regardless of input order", () => {
  const report = compareLedgerCoverage(capture, retained);
  const shuffled = compareLedgerCoverage([...capture].reverse(), [...retained].reverse());

  assert.equal(report.ok, false);
  assert.deepEqual(report.findings, ["missing"]);
  assert.deepEqual(report.missing, [
    { firstLedger: 100, lastLedger: 100, ledgers: 1, events: 2, expected: false, firstEvents: 2, secondEvents: 0 },
    { firstLedger: 130, lastLedger: 130, ledgers: 1, events: 1, expected: false, firstEvents: 1, secondEvents: 0 },
  ]);
  assert.deepEqual(report.overlap, [
    { firstLedger: 110, lastLedger: 120, ledgers: 2, events: 3, expected: true, firstEvents: 3, secondEvents: 3 },
  ]);
  assert.deepEqual(report.totals, {
    firstEvents: 6,
    secondEvents: 3,
    missingEvents: 3,
    expectedEvents: 0,
    unexpectedEvents: 3,
    filteredEvents: 0,
    overlapFirstEvents: 3,
    overlapSecondEvents: 3,
    extraEvents: 0,
  });
  assert.deepEqual(report, shuffled);
  assert.equal(formatArchiveCoverageReport(report), formatArchiveCoverageReport(shuffled));
  assert.match(formatArchiveCoverageReport(report), /ledgers=2 first=3 second=3 events=3/);
});

test("intentional compaction filtering is not reported as incomplete acquisition", () => {
  const range = { firstLedger: 110, lastLedger: 120 };
  const complete = compareLedgerCoverage(capture, retained, { range });

  assert.equal(complete.ok, true);
  assert.deepEqual(complete.findings, []);
  assert.deepEqual(complete.incomplete, []);
  assert.deepEqual(complete.filtered, complete.missing);
  assert.deepEqual(complete.filtered, [
    { firstLedger: 100, lastLedger: 100, ledgers: 1, events: 2, expected: true, firstEvents: 2, secondEvents: 0 },
    { firstLedger: 130, lastLedger: 130, ledgers: 1, events: 1, expected: true, firstEvents: 1, secondEvents: 0 },
  ]);
  assert.equal(complete.filtered[0].intentional, true);
  assert.equal(complete.totals.filteredEvents, 3);

  const incomplete = compareLedgerCoverage(capture, retained.filter((e) => e.ledger !== 120), { range });
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.findings, ["missing"]);
  assert.deepEqual(incomplete.incomplete, [
    { firstLedger: 120, lastLedger: 120, ledgers: 1, events: 2, expected: false, firstEvents: 2, secondEvents: 0 },
  ]);
  assert.equal(incomplete.incomplete[0].intentional, false);
  assert.equal(incomplete.incomplete[0].cause, "incomplete");
  assert.deepEqual(incomplete.missing.map((span) => span.firstLedger), [100, 120, 130]);
  assert.deepEqual(incomplete.filtered.map((span) => span.firstLedger), [100, 130]);
});

test("an expected acquisition scope combines with the filter range", () => {
  const report = compareLedgerCoverage(capture, retained, {
    range: { firstLedger: 100, lastLedger: 130 },
    expectedRange: { firstLedger: 110, lastLedger: 130 },
  });
  assert.deepEqual(report.expectedRange, { firstLedger: 110, lastLedger: 130 });
  assert.deepEqual(report.filtered.map((span) => span.firstLedger), [100]);
  assert.deepEqual(report.incomplete.map((span) => span.firstLedger), [130]);
});

test("scan JSONL captures ignore the summary line and reject malformed records", () => {
  const report = compareScanJsonlCoverage(formatScanJsonl(capture), formatScanJsonl(retained));
  assert.deepEqual(report.missing.map((span) => span.firstLedger), [100, 130]);
  assert.deepEqual(report.overlap.map((span) => span.lastLedger), [120]);

  assert.throws(
    () => compareScanJsonlCoverage('{"type":"summary","eventCount":0}\n{"type":"oops"}\n', ""),
    (err) => err instanceof MalformedScanJsonlRecordError && err.lineNumber === 2,
  );
});

test("raw archive JSONL and JSON arrays compare the same as decoded events", () => {
  const rawArchive = capture.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const rawRetained = retained.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const expected = compareLedgerCoverage(capture, retained);

  assert.deepEqual(compareLedgerCoverage(rawArchive, rawRetained), expected);
  assert.deepEqual(compareArchiveCoverage(JSON.stringify(capture), rawRetained), expected);
});

test("two archive directories compare the same as their drained events", async () => {
  await withTempDataDir(async (dir) => {
    const firstDir = dir.file("first");
    const secondDir = dir.file("second");
    const first = createEventArchive({ dir: firstDir, maxBytes: 256 });
    const second = createEventArchive({ dir: secondDir });
    await first.append(capture);
    await second.append(retained);
    await Promise.all([first.close(), second.close()]);

    const expected = compareLedgerCoverage(capture, retained);
    assert.deepEqual(await compareArchiveDirCoverage(firstDir, secondDir), expected);
    assert.deepEqual(await compareArchiveCoverage(firstDir, secondDir), expected);
  });
});

test("a malformed archive record fails the comparison without changing either capture", async () => {
  await withTempDataDir(async (dir) => {
    const firstDir = dir.file("first");
    const secondDir = dir.file("second");
    const first = createEventArchive({ dir: firstDir });
    const second = createEventArchive({ dir: secondDir });
    await first.append(capture);
    await second.append(retained);
    await Promise.all([first.close(), second.close()]);

    const { readdir, readFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const files = (await readdir(secondDir)).filter((name) => name.endsWith(".jsonl"));
    const target = path.join(secondDir, files[0]);
    const before = await readFile(target, "utf8");
    await writeFile(target, `${before}{not json}\n`, "utf8");
    const corrupted = await readFile(target, "utf8");

    await assert.rejects(
      compareArchiveDirCoverage(firstDir, secondDir),
      (err) =>
        err instanceof MalformedArchiveRecordError &&
        err.fileName === files[0] &&
        err.lineNumber === retained.length + 1,
    );
    assert.equal(await readFile(target, "utf8"), corrupted);
  });
});

test("empty captures and ledger-count drift are reported without changing existing behavior", () => {
  const empty = compareLedgerCoverage([], []);
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.findings, []);
  assert.deepEqual(empty.overlap, []);
  assert.equal(empty.totals.firstEvents, 0);
  assert.equal(empty.totalSecond, undefined);

  const drifted = compareLedgerCoverage(capture, [...capture, event(130, 1)]);
  assert.deepEqual(drifted.findings, ["count-mismatch"]);
  assert.deepEqual(drifted.countMismatches, [
    { firstLedger: 130, lastLedger: 130, ledgers: 1, firstEvents: 1, secondEvents: 2 },
  ]);
  assert.equal(drifted.ok, false);

  const extra = compareLedgerCoverage(retained, capture);
  assert.deepEqual(extra.findings, ["extra"]);
  assert.deepEqual(extra.extra.map((span) => span.firstLedger), [100, 130]);
  assert.deepEqual(extra.extra[0], {
    firstLedger: 100,
    lastLedger: 100,
    ledgers: 1,
    events: 2,
    expected: false,
    firstEvents: 0,
    secondEvents: 2,
  });

  assert.throws(
    () => compareLedgerCoverage(capture, retained, { range: { firstLedger: 0, lastLedger: 5 } }),
    RangeError,
  );
  assert.throws(
    () => compareLedgerCoverage(capture, retained, { firstLedger: 5, lastLedger: 1 }),
    RangeError,
  );
  assert.equal(formatArchiveCoverageReport(empty), renderArchiveCoverageReport(empty));
});
