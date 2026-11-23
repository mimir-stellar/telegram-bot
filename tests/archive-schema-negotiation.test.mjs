import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_FILENAME,
  ARCHIVE_SCHEMA_FORMAT,
  SUPPORTED_ARCHIVE_READER_VERSIONS,
  SUPPORTED_ARCHIVE_WRITER_VERSIONS,
  UnsupportedArchiveSchemaError,
  createEventArchive,
  getSupportedArchiveSchemaVersions,
  inspectArchiveSchema,
  negotiateArchiveSchemaVersion,
  readArchive,
} from "../dist/stellar/archive.js";
import {
  SCAN_JSONL_SCHEMA_FORMAT,
  formatScanJsonl,
  parseScanJsonl,
} from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const event = {
  source: "market",
  ledger: 101,
  txHash: "fake-hash",
  eventId: "event-101",
  payload: { name: "claim_created" },
};

test("archive schema capabilities list reader and writer versions and negotiate mutual support", () => {
  assert.deepEqual(SUPPORTED_ARCHIVE_READER_VERSIONS, [1]);
  assert.deepEqual(SUPPORTED_ARCHIVE_WRITER_VERSIONS, [1]);
  assert.deepEqual(getSupportedArchiveSchemaVersions(), {
    archiveFormat: ARCHIVE_SCHEMA_FORMAT,
    jsonlFormat: SCAN_JSONL_SCHEMA_FORMAT,
    readerVersions: [1],
    writerVersions: [1],
    defaultWriterVersion: 1,
  });
  assert.equal(
    negotiateArchiveSchemaVersion({
      format: ARCHIVE_SCHEMA_FORMAT,
      mode: "read",
      peerSupportedVersions: [2, 1],
    }),
    1,
  );
  assert.throws(
    () =>
      negotiateArchiveSchemaVersion({
        format: ARCHIVE_SCHEMA_FORMAT,
        mode: "read",
        requestedVersion: 2,
      }),
    (error) =>
      error instanceof UnsupportedArchiveSchemaError &&
      error.code === "UNSUPPORTED_SCHEMA_VERSION",
  );
});

test("archive writer records its schema and legacy archives remain readable", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("versioned-archive");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append([event]);
    await archive.close();

    assert.deepEqual(await inspectArchiveSchema(archiveDir), {
      schemaVersion: 1,
      explicitVersionFound: true,
    });
    const metadata = JSON.parse(
      await readFile(path.join(archiveDir, ARCHIVE_SCHEMA_FILENAME), "utf8"),
    );
    assert.deepEqual(metadata, { format: ARCHIVE_SCHEMA_FORMAT, schemaVersion: 1 });

    const oldArchiveDir = tmp.file("legacy-archive");
    await mkdir(oldArchiveDir, { recursive: true });
    await writeFile(
      path.join(oldArchiveDir, "events-legacy.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
    assert.deepEqual(await inspectArchiveSchema(oldArchiveDir), {
      schemaVersion: 1,
      explicitVersionFound: false,
    });

    const legacyEvents = [];
    for await (const item of readArchive(oldArchiveDir)) legacyEvents.push(item);
    assert.equal(legacyEvents[0].eventId, "event-101");
    await assert.rejects(
      async () => {
        for await (const _item of readArchive(oldArchiveDir, { requireExplicitVersion: true })) {
          // drain
        }
      },
      (error) =>
        error instanceof UnsupportedArchiveSchemaError &&
        error.code === "MISSING_SCHEMA_VERSION",
    );
  });
});

test("archive reader rejects a future sidecar version before yielding any records", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("future-archive");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, ARCHIVE_SCHEMA_FILENAME),
      JSON.stringify({ format: ARCHIVE_SCHEMA_FORMAT, schemaVersion: 2 }),
      "utf8",
    );
    await writeFile(
      path.join(archiveDir, "events-future.jsonl"),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );

    const yielded = [];
    await assert.rejects(
      async () => {
        for await (const item of readArchive(archiveDir)) yielded.push(item);
      },
      (error) =>
        error instanceof UnsupportedArchiveSchemaError &&
        error.code === "UNSUPPORTED_SCHEMA_VERSION" &&
        error.foundVersion === 2,
    );
    assert.deepEqual(yielded, []);
  });
});

test("scan JSONL version headers round-trip and future versions are rejected before parsing events", () => {
  const output = formatScanJsonl([], { schemaVersion: 1 });
  const lines = output.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines[0], {
    type: "schema",
    format: SCAN_JSONL_SCHEMA_FORMAT,
    schemaVersion: 1,
  });
  assert.equal(parseScanJsonl(output).explicitVersionFound, true);

  assert.throws(
    () =>
      parseScanJsonl(
        `{"type":"schema","format":"${SCAN_JSONL_SCHEMA_FORMAT}","schemaVersion":2}\nnot-json\n`,
      ),
    (error) =>
      error instanceof UnsupportedArchiveSchemaError &&
      error.code === "UNSUPPORTED_SCHEMA_VERSION" &&
      error.foundVersion === 2,
  );
  assert.throws(
    () => formatScanJsonl([], { schemaVersion: 2 }),
    (error) =>
      error instanceof UnsupportedArchiveSchemaError &&
      error.code === "UNSUPPORTED_SCHEMA_VERSION",
  );
});
