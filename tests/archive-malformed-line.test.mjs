import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MAX_DIAGNOSTIC_LENGTH,
  MalformedArchiveRecordError,
  createEventArchive,
  importScanJsonlToArchive,
  parseScanJsonl,
  readArchive,
  readArchiveRecords,
} from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeValidEvent(id = 1) {
  return {
    source: "market",
    contractId: "CMARKET123456",
    ledger: 2000 + id,
    txHash: `0xabc${id}`,
    eventId: `${2000 + id}-${id}`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GCREATOR",
      question: `Question ${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("reports exact 1-based physical line number across blank lines and rotated files", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("line-number-archive");
    await mkdir(archiveDir, { recursive: true });

    const seg1 = "events-2026-11-01T00-00-00-000Z-000001.jsonl";
    const seg2 = "events-2026-11-01T00-01-00-000Z-000002.jsonl";

    await writeFile(
      path.join(archiveDir, seg1),
      `${JSON.stringify(makeValidEvent(1))}\n`,
      "utf8",
    );

    // Line 1: valid event, Line 2: blank, Line 3: valid event, Line 4: whitespace, Line 5: malformed JSON
    await writeFile(
      path.join(archiveDir, seg2),
      [
        JSON.stringify(makeValidEvent(2)),
        "",
        JSON.stringify(makeValidEvent(3)),
        "   ",
        '{"broken": ',
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(
      () => readArchiveRecords(archiveDir),
      (err) => {
        assert.ok(err instanceof MalformedArchiveRecordError);
        assert.equal(err.file, seg2);
        assert.equal(err.line, 5);
        assert.equal(err.reasonCode, "INVALID_JSON");
        assert.equal(err.committedCount, 3);
        assert.deepEqual(err.retainedEvents, []);
        assert.ok(err.diagnostic.length <= MAX_DIAGNOSTIC_LENGTH);
        return true;
      },
    );
  });
});

test("returns bounded diagnostics without echoing raw payloads or field values", () => {
  const rawCanary = ["RAW_SENSITIVE_PAYLOAD_", "1234567890_DO_NOT_ECHO"].join("");
  const hugeGarbage = rawCanary + "X".repeat(50_000);

  // Case 1: unquoted garbage that V8 JSON.parse normally echoes in SyntaxError.message
  assert.throws(
    () => parseScanJsonl(`${JSON.stringify(makeValidEvent(1))}\n${hugeGarbage}\n`, { sourceName: "huge.jsonl" }),
    (err) => {
      assert.ok(err instanceof MalformedArchiveRecordError);
      assert.equal(err.line, 2);
      assert.equal(err.reasonCode, "INVALID_JSON");
      assert.ok(err.message.length <= MAX_DIAGNOSTIC_LENGTH);
      assert.ok(err.diagnostic.length <= MAX_DIAGNOSTIC_LENGTH);
      assert.equal(err.message.includes(rawCanary), false);
      assert.equal(err.diagnostic.includes("RAW_SENSITIVE"), false);
      return true;
    },
  );

  // Case 2: non-object JSON record (array / string containing sensitive payload)
  assert.throws(
    () => parseScanJsonl(`${JSON.stringify([rawCanary])}\n`, { sourceName: "array.jsonl" }),
    (err) => {
      assert.ok(err instanceof MalformedArchiveRecordError);
      assert.equal(err.line, 1);
      assert.equal(err.reasonCode, "NON_OBJECT_RECORD");
      assert.equal(err.message.includes(rawCanary), false);
      return true;
    },
  );

  // Case 3: invalid field value inside object record must not echo field value
  const badShape = {
    ...makeValidEvent(2),
    source: rawCanary,
  };
  assert.throws(
    () => parseScanJsonl(`${JSON.stringify(badShape)}\n`, { sourceName: "shape.jsonl" }),
    (err) => {
      assert.ok(err instanceof MalformedArchiveRecordError);
      assert.equal(err.line, 1);
      assert.equal(err.reasonCode, "INVALID_RECORD_SHAPE");
      assert.equal(err.message.includes(rawCanary), false);
      return true;
    },
  );
});

test("importScanJsonlToArchive discards partial output by default and retains committed output only when explicitly requested", async () => {
  await withTempDataDir(async (tmp) => {
    const validLines = formatScanJsonl([makeValidEvent(1), makeValidEvent(2)])
      .trim()
      .split("\n")
      .slice(0, 2);
    const mixedJsonl = [validLines[0], "", validLines[1], '{"corrupt": true'].join("\n") + "\n";

    // Default behavior: retainCommittedOutput omitted -> zero partial output left behind.
    const defaultDir = tmp.file("import-default");
    await assert.rejects(
      () =>
        importScanJsonlToArchive(mixedJsonl, {
          dir: defaultDir,
          sourceName: "batch.jsonl",
        }),
      (err) => {
        assert.ok(err instanceof MalformedArchiveRecordError);
        assert.equal(err.line, 4);
        assert.deepEqual(err.retainedEvents, []);
        return true;
      },
    );

    const remainingDefault = [];
    for await (const ev of readArchive(defaultDir)) {
      remainingDefault.push(ev);
    }
    assert.equal(remainingDefault.length, 0);

    // Pre-existing archive files remain intact and unpolluted when default import fails.
    const existingDir = tmp.file("import-existing");
    const seedArchive = createEventArchive({ dir: existingDir, maxFiles: 1 });
    await seedArchive.append([makeValidEvent(99)]);
    await seedArchive.close();

    await assert.rejects(() =>
      importScanJsonlToArchive(mixedJsonl, {
        dir: existingDir,
        maxFiles: 1,
        sourceName: "batch.jsonl",
      }),
    );
    const preservedExisting = await readArchiveRecords(existingDir);
    assert.equal(preservedExisting.length, 1);
    assert.equal(preservedExisting[0].eventId, "2099-99");

    // Explicit opt-in: retainCommittedOutput: true -> prior 2 valid records remain committed on disk.
    const retainedDir = tmp.file("import-retained");
    await assert.rejects(
      () =>
        importScanJsonlToArchive(mixedJsonl, {
          dir: retainedDir,
          sourceName: "batch.jsonl",
          retainCommittedOutput: true,
        }),
      (err) => {
        assert.ok(err instanceof MalformedArchiveRecordError);
        assert.equal(err.line, 4);
        assert.equal(err.committedCount, 2);
        assert.equal(err.retainedEvents.length, 2);
        return true;
      },
    );

    const files = await readdir(retainedDir);
    assert.ok(files.some((f) => f.endsWith(".jsonl")));
    const committedOnDisk = await readArchiveRecords(retainedDir);
    assert.equal(committedOnDisk.length, 2);
    assert.deepEqual(
      committedOnDisk.map((e) => e.eventId),
      ["2001-1", "2002-2"],
    );
  });
});
