import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_FILENAME,
  ARCHIVE_SCHEMA_FORMAT,
  DEFAULT_ARCHIVE_SCHEMA_VERSION,
  SCAN_JSONL_SCHEMA_FORMAT,
  SUPPORTED_ARCHIVE_READER_VERSIONS,
  SUPPORTED_ARCHIVE_WRITER_VERSIONS,
  UnsupportedArchiveSchemaError,
  createEventArchive,
  getSupportedArchiveSchemaVersions,
  inspectArchiveSchema,
  negotiateArchiveSchemaVersion,
  parseVersionedScanJsonl,
  readArchive,
} from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeV1Event(id = 1) {
  return {
    source: "market",
    contractId: "CMARKET_V1",
    ledger: 4000 + id,
    txHash: `0xtx${id}`,
    eventId: `${4000 + id}-${id}`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GCREATOR",
      question: `Q${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("lists supported reader and writer versions and negotiates peer capabilities", () => {
  const caps = getSupportedArchiveSchemaVersions();
  assert.equal(caps.archiveFormat, ARCHIVE_SCHEMA_FORMAT);
  assert.equal(caps.jsonlFormat, SCAN_JSONL_SCHEMA_FORMAT);
  assert.deepEqual(caps.readerVersions, [1]);
  assert.deepEqual(caps.writerVersions, [1]);
  assert.equal(caps.defaultWriterVersion, DEFAULT_ARCHIVE_SCHEMA_VERSION);
  assert.deepEqual(SUPPORTED_ARCHIVE_READER_VERSIONS, [1]);
  assert.deepEqual(SUPPORTED_ARCHIVE_WRITER_VERSIONS, [1]);

  assert.equal(
    negotiateArchiveSchemaVersion({ mode: "read", peerSupportedVersions: [1, 2] }),
    1,
  );
  assert.equal(
    negotiateArchiveSchemaVersion({ mode: "write", requestedVersion: 1 }),
    1,
  );

  assert.throws(
    () => negotiateArchiveSchemaVersion({ mode: "read", peerSupportedVersions: [2, 3] }),
    (err) => err instanceof UnsupportedArchiveSchemaError && err.code === "NO_MUTUAL_SCHEMA_VERSION",
  );
  assert.throws(
    () => negotiateArchiveSchemaVersion({ mode: "write", requestedVersion: 2 }),
    (err) =>
      err instanceof UnsupportedArchiveSchemaError &&
      err.code === "UNSUPPORTED_SCHEMA_VERSION" &&
      err.foundVersion === 2,
  );
  assert.throws(
    () => negotiateArchiveSchemaVersion({ mode: "read", requestedVersion: "1.0" }),
    (err) => err instanceof UnsupportedArchiveSchemaError && err.code === "INVALID_SCHEMA_VERSION",
  );
});

test("supports explicit v1 archive and JSONL schema headers while preserving legacy compatibility", async () => {
  await withTempDataDir(async (tmp) => {
    const ev = makeV1Event(1);

    // 1-arg formatScanJsonl remains legacy-compatible (no schema line).
    const legacyJsonl = formatScanJsonl([ev]);
    const legacyParsed = parseVersionedScanJsonl(legacyJsonl);
    assert.equal(legacyParsed.negotiatedVersion, 1);
    assert.equal(legacyParsed.explicitVersionFound, false);
    assert.equal(legacyParsed.events.length, 1);

    // requireExplicitVersion rejects unversioned captures.
    assert.throws(
      () => parseVersionedScanJsonl(legacyJsonl, { requireExplicitVersion: true }),
      (err) => err instanceof UnsupportedArchiveSchemaError && err.code === "MISSING_SCHEMA_VERSION",
    );

    // Explicit schemaVersion: 1 emits leading schema record and parses under strict mode.
    const v1Jsonl = formatScanJsonl([ev], { schemaVersion: 1 });
    const v1Parsed = parseVersionedScanJsonl(v1Jsonl, { requireExplicitVersion: true });
    assert.equal(v1Parsed.negotiatedVersion, 1);
    assert.equal(v1Parsed.explicitVersionFound, true);
    assert.equal(v1Parsed.events.length, 1);

    // Writer rejects unknown future schemaVersion synchronously.
    assert.throws(
      () => formatScanJsonl([ev], { schemaVersion: 2 }),
      (err) => err instanceof UnsupportedArchiveSchemaError && err.code === "UNSUPPORTED_SCHEMA_VERSION",
    );
    assert.throws(
      () => createEventArchive({ dir: tmp.file("bad-writer"), schemaVersion: 99 }),
      (err) => err instanceof UnsupportedArchiveSchemaError && err.code === "UNSUPPORTED_SCHEMA_VERSION",
    );

    // Versioned on-disk archive writes archive-schema.json and passes strict inspection.
    const v1Dir = tmp.file("v1-archive");
    const archive = createEventArchive({ dir: v1Dir, schemaVersion: 1 });
    await archive.append([ev]);
    await archive.close();

    const inspected = await inspectArchiveSchema(v1Dir, { requireExplicitVersion: true });
    assert.equal(inspected.negotiatedVersion, 1);
    assert.equal(inspected.explicitVersionFound, true);
  });
});

test("refuses unknown future archive and JSONL schema versions up front without best-effort field guessing", async () => {
  await withTempDataDir(async (tmp) => {
    // Even if a future v2 record still includes every v1 field alongside new v2 fields,
    // reader must refuse it deterministically without yielding or guessing fields!
    const futureV2Event = {
      ...makeV1Event(1),
      schemaVersion: 2,
      transactionHashV2: "0xnew_field",
    };

    const v2HeaderJsonl =
      JSON.stringify({ type: "schema", format: SCAN_JSONL_SCHEMA_FORMAT, schemaVersion: 2 }) +
      "\n" +
      JSON.stringify({ type: "event", ...makeV1Event(1) }) +
      "\n";

    assert.throws(
      () => parseVersionedScanJsonl(v2HeaderJsonl),
      (err) =>
        err instanceof UnsupportedArchiveSchemaError &&
        err.code === "UNSUPPORTED_SCHEMA_VERSION" &&
        err.foundVersion === 2,
    );

    // Future schema sidecar in archive directory refuses both reading and v1 appending.
    const futureDir = tmp.file("future-v2-archive");
    await mkdir(futureDir, { recursive: true });
    await writeFile(
      path.join(futureDir, ARCHIVE_SCHEMA_FILENAME),
      JSON.stringify({ format: ARCHIVE_SCHEMA_FORMAT, schemaVersion: 2 }),
      "utf8",
    );
    await writeFile(
      path.join(futureDir, "events-2026-11-01T00-00-00-000Z-000001.jsonl"),
      JSON.stringify(makeV1Event(1)) + "\n",
      "utf8",
    );

    const yieldedFromSidecar = [];
    await assert.rejects(
      async () => {
        for await (const ev of readArchive(futureDir)) {
          yieldedFromSidecar.push(ev);
        }
      },
      (err) =>
        err instanceof UnsupportedArchiveSchemaError &&
        err.code === "UNSUPPORTED_SCHEMA_VERSION" &&
        err.foundVersion === 2,
    );
    assert.equal(yieldedFromSidecar.length, 0);

    const writerAgainstFuture = createEventArchive({ dir: futureDir, schemaVersion: 1 });
    await assert.rejects(
      () => writerAgainstFuture.append([makeV1Event(2)]),
      (err) =>
        err instanceof UnsupportedArchiveSchemaError &&
        err.code === "UNSUPPORTED_SCHEMA_VERSION",
    );
    await writerAgainstFuture.close();

    // Multi-segment archive where segment 1 is v1 and segment 2 carries a future v2 record
    // must reject BEFORE yielding segment 1 events!
    const mixedSegDir = tmp.file("mixed-seg-archive");
    await mkdir(mixedSegDir, { recursive: true });
    await writeFile(
      path.join(mixedSegDir, "events-2026-11-01T00-00-00-000Z-000001.jsonl"),
      JSON.stringify(makeV1Event(1)) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(mixedSegDir, "events-2026-11-01T00-01-00-000Z-000002.jsonl"),
      JSON.stringify(futureV2Event) + "\n",
      "utf8",
    );

    const yieldedFromMixed = [];
    await assert.rejects(
      async () => {
        for await (const ev of readArchive(mixedSegDir)) {
          yieldedFromMixed.push(ev);
        }
      },
      (err) =>
        err instanceof UnsupportedArchiveSchemaError &&
        err.code === "UNSUPPORTED_SCHEMA_VERSION" &&
        err.foundVersion === 2,
    );
    assert.equal(yieldedFromMixed.length, 0);

    // Incompatible format identifier (-v3 or foreign format) is also refused.
    const foreignJsonl =
      JSON.stringify({ type: "schema", format: "mimir-scan-jsonl-v3", schemaVersion: 1 }) + "\n";
    assert.throws(
      () => parseVersionedScanJsonl(foreignJsonl),
      (err) =>
        err instanceof UnsupportedArchiveSchemaError &&
        err.code === "UNSUPPORTED_SCHEMA_VERSION" &&
        err.foundVersion === 3,
    );
  });
});
