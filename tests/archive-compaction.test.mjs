import assert from "node:assert/strict";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_METADATA_FILENAME,
  ArchiveCompactionError,
  compactArchiveByLedgerRange,
  compactScanJsonlByLedgerRange,
  createEventArchive,
  readArchive,
  verifyCompactedArchive,
} from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent({
  id = 1,
  ledger = 1000 + id,
  source = "market",
  contractId = "CMARKET1",
  name = "claim_created",
} = {}) {
  return {
    source,
    contractId,
    ledger,
    txHash: `0xtx${id}`,
    eventId: `${ledger}-${id}`,
    payload:
      name === "deposited"
        ? {
            name: "deposited",
            marketId: id,
            squadId: 1,
            member: "GUSER",
            amount: 1000n,
            shares: 1000n,
          }
        : {
            name: "claim_created",
            claimId: id,
            creator: "GCREATOR",
            question: `Claim ${id}`,
            deadline: 1700001000,
            feeBps: 100,
          },
  };
}

test("compacts rotated archive in place to bounded ledger range and rebuilds metadata", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("compact-source");
    const archive = createEventArchive({ dir: archiveDir, maxBytes: 260, maxFiles: 20 });

    const e1 = makeEvent({ id: 1, ledger: 100 });
    const e2 = makeEvent({ id: 2, ledger: 200 });
    const e3 = makeEvent({ id: 3, ledger: 250, source: "squad", contractId: "CSQUAD1", name: "deposited" });
    const e4 = makeEvent({ id: 4, ledger: 300 });
    const e5 = makeEvent({ id: 5, ledger: 400 });

    // Include an out-of-order batch and duplicate of e3 inside range [200, 300].
    await archive.append([e5, e1, e3, e2, e3, e4]);
    await archive.close();

    const result = await compactArchiveByLedgerRange({
      dir: archiveDir,
      fromLedger: 200,
      toLedger: 300,
      maxBytes: 300,
    });

    assert.equal(result.metadata.eventCount, 3);
    assert.equal(result.metadata.droppedOutOfRangeCount, 2);
    assert.equal(result.metadata.duplicateCount, 1);
    assert.deepEqual(result.metadata.requestedRange, { fromLedger: 200, toLedger: 300 });
    assert.deepEqual(result.metadata.retainedLedgerRange, { minLedger: 200, maxLedger: 300 });
    assert.deepEqual(result.metadata.histogram, { claim_created: 2, deposited: 1 });
    assert.deepEqual(result.metadata.contracts, { market: "CMARKET1", squad: "CSQUAD1" });

    const retained = [];
    for await (const ev of readArchive(archiveDir)) {
      retained.push(ev);
    }
    assert.deepEqual(
      retained.map((e) => e.ledger),
      [200, 250, 300],
    );

    const onDiskMeta = JSON.parse(
      await readFile(path.join(archiveDir, ARCHIVE_METADATA_FILENAME), "utf8"),
    );
    assert.deepEqual(onDiskMeta, result.metadata);
    await verifyCompactedArchive(archiveDir);

    // Ensure no leftover staging or backup sibling directories remain.
    const parentEntries = await readdir(path.dirname(archiveDir));
    assert.equal(
      parentEntries.some((n) => n.includes("compact-staging") || n.includes("compact-backup")),
      false,
    );
  });
});

test("never replaces source archive when verification or retention checks fail", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("atomic-guard");
    const archive = createEventArchive({ dir: archiveDir, maxBytes: 500 });
    const originalEvents = [
      makeEvent({ id: 1, ledger: 100 }),
      makeEvent({ id: 2, ledger: 200 }),
      makeEvent({ id: 3, ledger: 210 }),
      makeEvent({ id: 4, ledger: 220 }),
      makeEvent({ id: 5, ledger: 500 }),
    ];
    await archive.append(originalEvents);
    await archive.close();

    // Case 1: staged metadata tampered during verifyStaging -> fails verification, source untouched!
    await assert.rejects(
      () =>
        compactArchiveByLedgerRange({
          dir: archiveDir,
          fromLedger: 200,
          toLedger: 250,
          verifyStaging: async (stagingDir) => {
            const badMeta = path.join(stagingDir, ARCHIVE_METADATA_FILENAME);
            await writeFile(badMeta, JSON.stringify({ format: "mimir-archive-meta-v1", requestedRange: { fromLedger: 200, toLedger: 250 }, eventCount: 999, segmentFiles: [], histogram: {}, retainedLedgerRange: null }), "utf8");
          },
        }),
      (err) => err instanceof ArchiveCompactionError && err.code === "VERIFICATION_FAILED",
    );

    // Case 2: maxFiles=1 with tiny maxBytes purges retained events -> verification catches loss, source untouched!
    await assert.rejects(
      () =>
        compactArchiveByLedgerRange({
          dir: archiveDir,
          fromLedger: 200,
          toLedger: 250,
          maxBytes: 200,
          maxFiles: 1,
        }),
      (err) => err instanceof ArchiveCompactionError && err.code === "VERIFICATION_FAILED",
    );

    // Verify all 5 original events remain completely untouched in `archiveDir`!
    const stillIntact = [];
    for await (const ev of readArchive(archiveDir)) {
      stillIntact.push(ev);
    }
    assert.equal(stillIntact.length, 5);
    assert.deepEqual(
      stillIntact.map((e) => e.ledger),
      [100, 200, 210, 220, 500],
    );

    // Case 3: malformed record in source archive aborts without modifying source.
    const files = (await readdir(archiveDir)).filter((f) => f.endsWith(".jsonl"));
    await appendFile(path.join(archiveDir, files[0]), "{corrupt_json\n", "utf8");
    await assert.rejects(
      () => compactArchiveByLedgerRange({ dir: archiveDir, fromLedger: 200, toLedger: 250 }),
      (err) => err instanceof ArchiveCompactionError && err.code === "MALFORMED_SOURCE",
    );
  });
});

test("handles empty bounded ranges, separate outputDir, JSONL compaction, and invalid range rejections", async () => {
  await withTempDataDir(async (tmp) => {
    const sourceDir = tmp.file("source-archive");
    const outDir = tmp.file("compacted-out");
    const archive = createEventArchive({ dir: sourceDir });
    await archive.append([makeEvent({ id: 1, ledger: 100 }), makeEvent({ id: 2, ledger: 200 })]);
    await archive.close();

    // Separate outputDir with zero matching events in [300, 400]
    const emptyRes = await compactArchiveByLedgerRange({
      dir: sourceDir,
      outputDir: outDir,
      fromLedger: 300,
      toLedger: 400,
    });
    assert.equal(emptyRes.metadata.eventCount, 0);
    assert.equal(emptyRes.metadata.retainedLedgerRange, null);
    assert.equal(emptyRes.metadata.droppedOutOfRangeCount, 2);

    // Source archive still has its 2 events.
    const sourceEvents = [];
    for await (const ev of readArchive(sourceDir)) {
      sourceEvents.push(ev);
    }
    assert.equal(sourceEvents.length, 2);

    // JSONL compaction
    const rawJsonl = formatScanJsonl([
      makeEvent({ id: 1, ledger: 50 }),
      makeEvent({ id: 2, ledger: 150 }),
      makeEvent({ id: 2, ledger: 150 }),
      makeEvent({ id: 3, ledger: 250 }),
    ]);
    const compactedJsonl = compactScanJsonlByLedgerRange(rawJsonl, {
      fromLedger: 100,
      toLedger: 200,
    });
    assert.equal(compactedJsonl.retainedCount, 1);
    assert.equal(compactedJsonl.droppedOutOfRangeCount, 2);
    assert.equal(compactedJsonl.duplicateCount, 1);
    assert.deepEqual(compactedJsonl.retainedLedgerRange, { minLedger: 150, maxLedger: 150 });

    // Invalid ranges and missing source
    assert.throws(
      () => compactScanJsonlByLedgerRange(rawJsonl, { fromLedger: 200, toLedger: 100 }),
      (err) => err instanceof ArchiveCompactionError && err.code === "INVALID_RANGE",
    );
    assert.throws(
      () => compactScanJsonlByLedgerRange(rawJsonl, { fromLedger: -1, toLedger: 100 }),
      (err) => err instanceof ArchiveCompactionError && err.code === "INVALID_RANGE",
    );
    await assert.rejects(
      () =>
        compactArchiveByLedgerRange({
          dir: tmp.file("missing-dir"),
          fromLedger: 1,
          toLedger: 10,
        }),
      (err) => err instanceof ArchiveCompactionError && err.code === "SOURCE_NOT_FOUND",
    );
  });
});
