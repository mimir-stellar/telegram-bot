import assert from "node:assert/strict";
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  compactArchive,
  createEventArchive,
  MalformedArchiveRecordError,
  readArchive,
} from "../dist/stellar/archive.js";
import {
  compactScanJsonl,
  formatScanJsonl,
  MalformedScanJsonlRecordError,
} from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(id, ledger) {
  return {
    source: "market",
    ledger,
    txHash: `0xdeadbeef${id}`,
    eventId: `event-${id}`,
    txIndex: 1,
    operationIndex: 1,
    topicName: "claim_created",
    contractId: "C1234567890",
    blockTime: 1700000000 + ledger,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GABCD",
      stake: BigInt(id * 1000),
      question: `Question ${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

async function buildArchive(archiveDir, ledgers, { maxBytes } = {}) {
  const archive = createEventArchive({ dir: archiveDir, maxBytes });
  for (let i = 0; i < ledgers.length; i += 1) {
    await archive.append([makeEvent(i + 1, ledgers[i])]);
  }
  await archive.close();
}

async function drainArchive(archiveDir) {
  const events = [];
  for await (const event of readArchive(archiveDir)) {
    events.push(event);
  }
  return events;
}

/** Byte-for-byte snapshot of a directory, for "source is untouched" assertions. */
async function snapshotDir(dir) {
  const entries = (await readdir(dir)).sort();
  const snapshot = {};
  for (const entry of entries) {
    snapshot[entry] = await readFile(path.join(dir, entry), "utf8");
  }
  return snapshot;
}

/** Assert no compaction scratch directories were left beside the archive. */
async function assertOnlyArchive(parentDir, archiveName) {
  const entries = await readdir(parentDir);
  assert.deepEqual(entries, [archiveName]);
}

// ---------------------------------------------------------------------------
// compactArchive
// ---------------------------------------------------------------------------

test("compactArchive retains only the inclusive ledger range and reports counts", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    await buildArchive(archiveDir, [100, 110, 120, 130, 140, 150]);

    const result = await compactArchive(archiveDir, {
      firstLedger: 110,
      lastLedger: 140,
    });

    assert.equal(result.retained, 4);
    assert.equal(result.dropped, 2);
    assert.ok(result.files >= 1);
    assert.match(result.digest, /^[0-9a-f]{64}$/);

    const events = await drainArchive(archiveDir);
    assert.deepEqual(
      events.map((event) => event.ledger),
      [110, 120, 130, 140],
    );
    // Retained payloads survive the rewrite unchanged.
    assert.equal(events[0].payload.stake, "2000");
    assert.equal(events[0].eventId, "event-2");

    await assertOnlyArchive(tmp.root, "archive");
  });
});

test("compactArchive keeps both endpoints at the boundary (firstLedger === lastLedger)", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    await buildArchive(archiveDir, [99, 100, 101]);

    const result = await compactArchive(archiveDir, {
      firstLedger: 100,
      lastLedger: 100,
    });

    assert.equal(result.retained, 1);
    assert.equal(result.dropped, 2);
    assert.deepEqual(
      (await drainArchive(archiveDir)).map((event) => event.ledger),
      [100],
    );
  });
});

test("compactArchive rebuilds rotation and preserves order across output files", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    await buildArchive(archiveDir, [100, 200, 300, 400, 500], { maxBytes: 200 });

    const result = await compactArchive(
      archiveDir,
      { firstLedger: 200, lastLedger: 400 },
      { maxBytes: 200 },
    );

    assert.equal(result.retained, 3);
    assert.equal(result.dropped, 2);

    const files = (await readdir(archiveDir)).filter((name) => name.endsWith(".jsonl"));
    assert.equal(files.length, result.files);
    assert.ok(result.files > 1, "small maxBytes must rotate the compacted archive");

    const events = await drainArchive(archiveDir);
    assert.deepEqual(
      events.map((event) => event.ledger),
      [200, 300, 400],
    );
  });
});

test("compactArchive with an out-of-range window leaves a valid empty archive", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    await buildArchive(archiveDir, [100, 200, 300]);

    const result = await compactArchive(archiveDir, {
      firstLedger: 400,
      lastLedger: 500,
    });

    assert.equal(result.retained, 0);
    assert.equal(result.dropped, 3);
    assert.equal(result.files, 0);
    assert.deepEqual(await readdir(archiveDir), []);
    await assertOnlyArchive(tmp.root, "archive");
  });
});

test("compactArchive aborts before replacing the source when a record is malformed", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    await buildArchive(archiveDir, [100, 200, 300]);

    const [fileName] = await readdir(archiveDir);
    await appendFile(path.join(archiveDir, fileName), '{"ledger":200,}\n', "utf8");
    const before = await snapshotDir(archiveDir);

    await assert.rejects(
      compactArchive(archiveDir, { firstLedger: 200, lastLedger: 200 }),
      MalformedArchiveRecordError,
    );

    // The source is byte-for-byte unchanged and no scratch directory remains.
    assert.deepEqual(await snapshotDir(archiveDir), before);
    await assertOnlyArchive(tmp.root, "archive");
  });
});

test("compactArchive rejects an invalid range without touching the source", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    await buildArchive(archiveDir, [100, 200]);
    const before = await snapshotDir(archiveDir);

    for (const range of [
      { firstLedger: 200, lastLedger: 100 },
      { firstLedger: 0, lastLedger: 100 },
      { firstLedger: 100.5, lastLedger: 200 },
      { firstLedger: 100, lastLedger: Number.NaN },
    ]) {
      await assert.rejects(compactArchive(archiveDir, range), RangeError);
    }

    assert.deepEqual(await snapshotDir(archiveDir), before);
  });
});

test("compactArchive rejects a missing archive directory instead of creating one", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("does-not-exist");
    await assert.rejects(
      compactArchive(archiveDir, { firstLedger: 100, lastLedger: 200 }),
      /Archive directory does not exist/,
    );
    await assert.rejects(stat(archiveDir), { code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// compactScanJsonl
// ---------------------------------------------------------------------------

test("compactScanJsonl retains the range and rebuilds the summary metadata", async () => {
  const before = formatScanJsonl([
    makeEvent(1, 100),
    makeEvent(2, 200),
    makeEvent(3, 300),
  ]);
  assert.equal(before.trimEnd().split("\n").length, 4);

  const result = compactScanJsonl(before, { firstLedger: 200, lastLedger: 300 });

  assert.equal(result.retained, 2);
  assert.equal(result.dropped, 1);
  assert.equal(result.jsonl.includes("\r\n"), false, "output must stay canonical LF");
  assert.ok(result.jsonl.endsWith("\n"));

  const lines = result.jsonl.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.slice(0, 2).map((line) => line.ledger),
    [200, 300],
  );
  assert.deepEqual(
    lines.slice(0, 2).map((line) => line.type),
    ["event", "event"],
  );
  assert.equal(lines[2].type, "summary");
  assert.equal(lines[2].eventCount, 2);
  assert.deepEqual(lines[2].histogram, { claim_created: 2 });
});

test("compactScanJsonl replaces a stale summary instead of carrying it forward", async () => {
  const inputLines = formatScanJsonl([makeEvent(1, 100)]).trimEnd().split("\n");
  inputLines.splice(
    1,
    0,
    JSON.stringify({ type: "summary", eventCount: 99, histogram: { stale: 99 } }),
  );
  const stale = inputLines.join("\r\n") + "\r\n";

  const result = compactScanJsonl(stale, { firstLedger: 100, lastLedger: 100 });

  const lines = result.jsonl.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].eventCount, 1);
  assert.deepEqual(lines[1].histogram, { claim_created: 1 });
});

test("compactScanJsonl on an empty range emits only a zeroed summary line", () => {
  const input = formatScanJsonl([makeEvent(1, 100), makeEvent(2, 200)]);
  const result = compactScanJsonl(input, { firstLedger: 300, lastLedger: 400 });

  assert.equal(result.retained, 0);
  assert.equal(result.dropped, 2);
  assert.equal(
    result.jsonl,
    JSON.stringify({ type: "summary", eventCount: 0, histogram: {} }) + "\n",
  );
});

test("compactScanJsonl reports a distinct line number for malformed records", () => {
  const valid = formatScanJsonl([makeEvent(1, 100)]).trimEnd().split("\n")[0];
  const malformed = `${valid}\nnot-json\n`;
  assert.throws(
    () => compactScanJsonl(malformed, { firstLedger: 1, lastLedger: 100 }),
    (err) => {
      assert.ok(err instanceof MalformedScanJsonlRecordError);
      assert.equal(err.lineNumber, 2);
      assert.match(err.message, /Malformed JSONL record at line 2/);
      return true;
    },
  );

  const unknownType = `${JSON.stringify({ type: "other", ledger: 100 })}\n`;
  assert.throws(
    () => compactScanJsonl(unknownType, { firstLedger: 1, lastLedger: 100 }),
    MalformedScanJsonlRecordError,
  );
});

test("compactScanJsonl rejects an invalid range", () => {
  const input = formatScanJsonl([makeEvent(1, 100)]);
  assert.throws(
    () => compactScanJsonl(input, { firstLedger: 200, lastLedger: 100 }),
    RangeError,
  );
});
