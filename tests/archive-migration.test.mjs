import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ARCHIVE_SCHEMA_VERSION,
  createEventArchive,
  readArchive,
  toArchivedRecord,
  adaptArchivedTypedEvent,
  adaptArchivedGenericEvent,
  migrateArchivedRecord,
  migrateArchivedRecordDetailed,
  isArchivedEvent,
  UnsupportedArchiveVersionError,
  MalformedArchiveRecordError,
} from "../dist/stellar/archive.js";
import { scanJsonReplacer } from "../dist/stellar/events.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeHistoricalMarketEvent(id = 1, amount = 10000000n) {
  // Legacy pre-migration shape with blockTime, txIndex, topicName, and unversioned metadata
  return {
    source: "market",
    ledger: 1000 + id,
    txHash: `0xdeadbeef${id}`,
    eventId: `event-${id}`,
    txIndex: id,
    operationIndex: 0,
    topicName: "claim_created",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    blockTime: 1700000000 + id,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      stake: amount,
      question: `Test Question ${id}`,
      deadline: 1700001000 + id,
      feeBps: 100,
    },
  };
}

function makeHistoricalGenericEvent(id = 1) {
  return {
    source: "generic",
    ledger: 2000 + id,
    txHash: `0xabcdef${id}`,
    eventId: `generic-${id}`,
    txIndex: id,
    operationIndex: 1,
    topicName: "transfer",
    contractId: "CTOKEN1234567890",
    blockTime: 1700000500 + id,
    topics: ["transfer", "GAAA", "GBBB"],
    value: "5000000",
    topicSummary: "transfer | GAAA | GBBB",
    valueSummary: "5000000",
    summary: "[transfer] transfer | GAAA | GBBB => 5000000",
    payload: {
      name: "generic",
      eventName: "transfer",
      topics: ["transfer", "GAAA", "GBBB"],
      value: "5000000",
      summary: "[transfer] transfer | GAAA | GBBB => 5000000",
    },
  };
}

test("ARCHIVE_SCHEMA_VERSION is pinned to 1", () => {
  assert.equal(ARCHIVE_SCHEMA_VERSION, 1);
});

test("toArchivedRecord explicitly stamps schemaVersion: 1", () => {
  const raw = makeHistoricalMarketEvent(1);
  const archived = toArchivedRecord(raw);
  assert.equal(archived.schemaVersion, 1);
  assert.equal(archived.eventId, "event-1");
  assert.equal(archived.ledger, 1001);
});

test("archive appends versioned records with schemaVersion: 1 to disk", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });

    const event1 = makeHistoricalMarketEvent(1, 5000000n);
    const event2 = makeHistoricalGenericEvent(2);

    await archive.append([event1, event2]);
    await archive.close();

    const fs = await import("node:fs/promises");
    const files = await fs.readdir(archiveDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    assert.equal(jsonlFiles.length, 1);

    const content = await readFile(path.join(archiveDir, jsonlFiles[0]), "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2);

    const parsed1 = JSON.parse(lines[0]);
    assert.equal(parsed1.schemaVersion, 1);
    assert.equal(parsed1.eventId, "event-1");

    const parsed2 = JSON.parse(lines[1]);
    assert.equal(parsed2.schemaVersion, 1);
    assert.equal(parsed2.eventId, "generic-2");
  });
});

test("adaptArchivedTypedEvent migrates legacy unversioned record with blockTime and txIndex", () => {
  const legacy = makeHistoricalMarketEvent(42, 10000000n);
  delete legacy.at;
  delete legacy.transactionIndex;

  const migrated = adaptArchivedTypedEvent(legacy);
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.at, 1700000042);
  assert.equal(migrated.transactionIndex, 42);
  assert.equal(migrated.operationIndex, 0);
  assert.equal(migrated.eventId, "event-42");
  assert.equal(migrated.source, "market");
  assert.equal(migrated.eventType, "contract");
  assert.equal(migrated.inSuccessfulContractCall, true);
  assert.equal(migrated.version, "v1");
  assert.equal(migrated.payload.name, "claim_created");
  assert.equal(migrated.payload.claimId, 42);

  // Preserves backward compatibility fields
  assert.equal(migrated.blockTime, 1700000042);
  assert.equal(migrated.txIndex, 42);
});

test("adaptArchivedGenericEvent migrates legacy generic event", () => {
  const legacy = makeHistoricalGenericEvent(7);
  delete legacy.at;
  delete legacy.transactionIndex;

  const migrated = adaptArchivedGenericEvent(legacy);
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.at, 1700000507);
  assert.equal(migrated.transactionIndex, 7);
  assert.equal(migrated.eventId, "generic-7");
  assert.equal(migrated.source, "generic");
  assert.equal(migrated.eventName, "transfer");
  assert.deepEqual(migrated.topics, ["transfer", "GAAA", "GBBB"]);
  assert.equal(migrated.value, "5000000");
  assert.equal(migrated.payload.name, "generic");
});

test("migrateArchivedRecord handles enveloped records and reports detailed migration metadata", () => {
  const rawEvent = makeHistoricalMarketEvent(1);
  const enveloped = {
    schemaVersion: 1,
    event: rawEvent,
  };

  const detailed = migrateArchivedRecordDetailed(enveloped);
  assert.equal(detailed.version, 1);
  assert.equal(detailed.kind, "typed");
  assert.equal(detailed.source, "legacy-envelope");
  assert.equal(detailed.migrated, true);
  assert.equal(detailed.event.eventId, "event-1");
  assert.equal(detailed.event.at, 1700000001);
});

test("readArchive transparently migrates historical unversioned records on read", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const fileName = "events-historical.jsonl";
    await mkdir(archiveDir, { recursive: true });

    const legacy1 = makeHistoricalMarketEvent(1, 10000000n);
    const legacy2 = makeHistoricalGenericEvent(2);

    // Write raw legacy records without schemaVersion
    await writeFile(
      path.join(archiveDir, fileName),
      `${JSON.stringify(legacy1, scanJsonReplacer)}\n${JSON.stringify(legacy2, scanJsonReplacer)}\n`,
      "utf8",
    );

    const readBack = [];
    for await (const event of readArchive(archiveDir)) {
      readBack.push(event);
    }

    assert.equal(readBack.length, 2);

    // Event 1 (typed) migrated to v1 schema
    assert.equal(readBack[0].schemaVersion, 1);
    assert.equal(readBack[0].eventId, "event-1");
    assert.equal(readBack[0].at, 1700000001);
    assert.equal(readBack[0].transactionIndex, 1);
    assert.equal(readBack[0].source, "market");

    // Event 2 (generic) migrated to v1 schema
    assert.equal(readBack[1].schemaVersion, 1);
    assert.equal(readBack[1].eventId, "generic-2");
    assert.equal(readBack[1].at, 1700000502);
    assert.equal(readBack[1].transactionIndex, 2);
    assert.equal(readBack[1].source, "generic");
  });
});

test("readArchive supports optional reviveBigInts flag", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const fileName = "events-bigint.jsonl";
    await mkdir(archiveDir, { recursive: true });

    const event = {
      schemaVersion: 1,
      source: "market",
      ledger: 100,
      txHash: "0x123",
      eventId: "event-bigint",
      at: 1700000000,
      transactionIndex: 0,
      operationIndex: 0,
      payload: {
        name: "claim_challenged",
        claimId: 1,
        challenger: "GBMGZ3D",
        stake: "5000000000000000000",
      },
    };

    await writeFile(path.join(archiveDir, fileName), `${JSON.stringify(event)}\n`, "utf8");

    // Default: string preserved
    for await (const ev of readArchive(archiveDir)) {
      assert.equal(typeof ev.payload.stake, "string");
      assert.equal(ev.payload.stake, "5000000000000000000");
    }

    // With reviveBigInts: true -> bigint revived
    for await (const ev of readArchive(archiveDir, { reviveBigInts: true })) {
      assert.equal(typeof ev.payload.stake, "bigint");
      assert.equal(ev.payload.stake, 5000000000000000000n);
    }
  });
});

test("rejects unknown future schema version and does not leak payload contents", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const fileName = "events-future-version.jsonl";
    const privateSecret = "HIGHLY_CONFIDENTIAL_SECRET_TOKEN_XYZ";
    await mkdir(archiveDir, { recursive: true });

    // schemaVersion 2 is not yet supported
    const record = {
      schemaVersion: 2,
      eventId: "event-future",
      payload: { secret: privateSecret },
    };

    await writeFile(path.join(archiveDir, fileName), `${JSON.stringify(record)}\n`, "utf8");

    let thrownError;
    try {
      for await (const _ev of readArchive(archiveDir)) {
        // should throw
      }
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError instanceof UnsupportedArchiveVersionError);
    assert.equal(thrownError.fileName, fileName);
    assert.equal(thrownError.lineNumber, 1);
    assert.equal(thrownError.version, 2);
    assert.match(thrownError.message, /Unsupported archive schema version 2/);
    assert.match(thrownError.message, /expected version 1/);
    // Boundary check: ensure private payload strings never leak into error message
    assert.equal(String(thrownError).includes(privateSecret), false);
  });
});

test("readArchive with retainCommitted retains valid prefix before unknown version error", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const fileName = "events-mixed-versions.jsonl";
    await mkdir(archiveDir, { recursive: true });

    const validRecord = {
      schemaVersion: 1,
      eventId: "event-valid-1",
      source: "market",
      ledger: 100,
      at: 1700000000,
      payload: { name: "claim_created", claimId: 1 },
    };

    const invalidVersionRecord = {
      schemaVersion: 99,
      eventId: "event-invalid-version",
      payload: { name: "claim_created", claimId: 2 },
    };

    await writeFile(
      path.join(archiveDir, fileName),
      `${JSON.stringify(validRecord)}\n${JSON.stringify(invalidVersionRecord)}\n`,
      "utf8",
    );

    // Without retainCommitted: nothing yielded, error thrown
    const defaultEvents = [];
    let defaultError;
    try {
      for await (const ev of readArchive(archiveDir)) {
        defaultEvents.push(ev);
      }
    } catch (err) {
      defaultError = err;
    }
    assert.ok(defaultError instanceof UnsupportedArchiveVersionError);
    assert.equal(defaultError.lineNumber, 2);
    assert.equal(defaultError.version, 99);
    assert.deepEqual(defaultEvents, []);

    // With retainCommitted: validRecord yielded before error
    const retainedEvents = [];
    let retainedError;
    try {
      for await (const ev of readArchive(archiveDir, { retainCommitted: true })) {
        retainedEvents.push(ev);
      }
    } catch (err) {
      retainedError = err;
    }
    assert.ok(retainedError instanceof UnsupportedArchiveVersionError);
    assert.equal(retainedError.lineNumber, 2);
    assert.equal(retainedEvents.length, 1);
    assert.equal(retainedEvents[0].eventId, "event-valid-1");
  });
});

test("direct adapter functions reject unknown versions and malformed input", () => {
  // Unknown numeric version
  assert.throws(
    () => adaptArchivedTypedEvent({ schemaVersion: 5, eventId: "ev-1" }),
    (err) => err instanceof UnsupportedArchiveVersionError && err.version === 5,
  );

  // Unknown string version
  assert.throws(
    () => adaptArchivedGenericEvent({ schemaVersion: "v99", eventId: "ev-2" }),
    (err) => err instanceof UnsupportedArchiveVersionError && err.version === "v99",
  );

  // Unknown format envelope
  assert.throws(
    () => migrateArchivedRecord({ format: "mimir-archive-v99", eventId: "ev-3" }),
    (err) => err instanceof UnsupportedArchiveVersionError,
  );

  // Malformed non-object input
  assert.throws(
    () => adaptArchivedTypedEvent(null),
    (err) => err instanceof MalformedArchiveRecordError,
  );
  assert.throws(
    () => adaptArchivedTypedEvent("not-an-object"),
    (err) => err instanceof MalformedArchiveRecordError,
  );
});

test("isArchivedEvent validates event shape", () => {
  assert.equal(isArchivedEvent(null), false);
  assert.equal(isArchivedEvent({}), false);
  assert.equal(isArchivedEvent({ ledger: 100, eventId: "ev-1", payload: {} }), true);
});
