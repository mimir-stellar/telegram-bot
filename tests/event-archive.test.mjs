import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ArchiveMetadataConflictError,
  createEventArchive,
  MalformedArchiveRecordError,
  readArchive,
  writeArchiveManifest,
  verifyArchiveManifest,
} from "../dist/stellar/archive.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeDummyEvent(id, amountBigInt = 10000000n) {
  return {
    source: "market",
    ledger: 100 + id,
    txHash: `0xdeadbeef${id}`,
    eventId: `event-${id}`,
    txIndex: 1,
    operationIndex: 1,
    topicName: "claim_created",
    contractId: "C1234567890",
    blockTime: 1700000000 + id,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GABCD",
      stake: amountBigInt,
      question: `Question ${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("archive creates files with 0o600 permissions and appends events", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });

    const event1 = makeDummyEvent(1, 5000000000000000000n);
    await archive.append([event1]);
    await archive.close();

    // Verify file exists and has 0o600 permissions (on platforms that support it)
    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, 1);
    assert.equal(readBack[0].eventId, "event-1");
    // Verify bigint round-trip as string
    assert.equal(readBack[0].payload.stake, "5000000000000000000");

    // Check mode if on posix
    if (process.platform !== "win32") {
      const files = await import("node:fs/promises").then((fs) => fs.readdir(archiveDir));
      assert.ok(files.length > 0);
      const st = await stat(path.join(archiveDir, files[0]));
      assert.equal(st.mode & 0o777, 0o600);
    }
  });
});

test("archive rotates by size and preserves ordering across files", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    // Set maxBytes small enough so each event triggers a new file or rotation
    const archive = createEventArchive({
      dir: archiveDir,
      maxBytes: 250,
      maxFiles: 10,
    });

    const events = [];
    for (let i = 1; i <= 5; i++) {
      events.push(makeDummyEvent(i, BigInt(i * 1000)));
    }

    // Append one by one or in batches
    await archive.append(events);
    await archive.close();

    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.equal(readBack[i].eventId, `event-${i + 1}`);
      assert.equal(readBack[i].payload.stake, String((i + 1) * 1000));
    }
  });
});

test("archive enforces maxFiles retention on rotation", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({
      dir: archiveDir,
      maxBytes: 250,
      maxFiles: 3,
    });

    // Write 6 events, each in a separate rotation
    for (let i = 1; i <= 6; i++) {
      await archive.append([makeDummyEvent(i, BigInt(i))]);
    }
    await archive.close();

    const fs = await import("node:fs/promises");
    const files = await fs.readdir(archiveDir);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length <= 3, `Expected <= 3 files, found ${jsonlFiles.length}`);

    // Read back remaining events
    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    // Older files were purged, but remaining ones must be in order
    assert.ok(readBack.length <= 6);
    assert.ok(readBack.length >= 3);
    const lastEvent = readBack[readBack.length - 1];
    assert.equal(lastEvent.eventId, "event-6");

    // Check monotonic order of remaining events
    for (let i = 1; i < readBack.length; i++) {
      assert.ok(readBack[i].ledger > readBack[i - 1].ledger);
    }
  });
});

test("archive rotation never loses or duplicates a line", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    // Large maxFiles so nothing is purged
    const archive = createEventArchive({
      dir: archiveDir,
      maxBytes: 300,
      maxFiles: 100,
    });

    const total = 20;
    const allEvents = [];
    for (let i = 1; i <= total; i++) {
      allEvents.push(makeDummyEvent(i, BigInt(i * 12345)));
    }

    // Append in mixed batches
    await archive.append(allEvents.slice(0, 5));
    await archive.append(allEvents.slice(5, 12));
    await archive.append(allEvents.slice(12));
    await archive.close();

    const readBack = [];
    for await (const ev of readArchive(archiveDir)) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, total);
    for (let i = 0; i < total; i++) {
      assert.equal(readBack[i].eventId, `event-${i + 1}`);
      assert.equal(readBack[i].payload.stake, String((i + 1) * 12345));
    }
  });
});

test("archive reports malformed record line without payload and retains valid prefix only on request", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const fileName = "events-malformed.jsonl";
    const payload = "PRIVATE_PAYLOAD_SHOULD_NOT_APPEAR";
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, fileName),
      `{"eventId":"event-1"}\n\n{"payload":"${payload}",}\n`,
      "utf8",
    );

    const defaultEvents = [];
    let defaultError;
    try {
      for await (const event of readArchive(archiveDir)) {
        defaultEvents.push(event);
      }
    } catch (error) {
      defaultError = error;
    }

    assert.ok(defaultError instanceof MalformedArchiveRecordError);
    assert.equal(defaultError.fileName, fileName);
    assert.equal(defaultError.lineNumber, 3);
    assert.equal(defaultError.message, `Malformed archive record at ${fileName}:3`);
    assert.equal(String(defaultError).includes(payload), false);
    assert.deepEqual(defaultEvents, []);

    const retainedEvents = [];
    let retainedError;
    try {
      for await (const event of readArchive(archiveDir, { retainCommitted: true })) {
        retainedEvents.push(event);
      }
    } catch (error) {
      retainedError = error;
    }

    assert.ok(retainedError instanceof MalformedArchiveRecordError);
    assert.equal(retainedError.lineNumber, 3);
    assert.equal(retainedEvents.length, 1);
    assert.equal(retainedEvents[0].eventId, "event-1");
  });
});

test("manifest verification accepts an intact hash-chained archive", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append([makeDummyEvent(1), makeDummyEvent(2), makeDummyEvent(3)]);
    await archive.close();

    const manifest = await writeArchiveManifest(archiveDir, {
      network: "testnet",
      ledgerMin: 101,
      ledgerMax: 103,
    });
    assert.equal(manifest.recordCount, 3);
    assert.equal(manifest.network, "testnet");

    const result = await verifyArchiveManifest(archiveDir);
    assert.equal(result.ok, true);
    assert.equal(result.recordCount, 3);
  });
});

test("manifest verification rejects altered, reordered and missing records", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append([makeDummyEvent(1), makeDummyEvent(2), makeDummyEvent(3)]);
    await archive.close();
    await writeArchiveManifest(archiveDir, {
      network: "testnet",
      ledgerMin: 101,
      ledgerMax: 103,
    });

    const files = (await import("node:fs/promises"))
      .readdir(archiveDir)
      .then((names) => names.filter((n) => n.endsWith(".jsonl")));
    const [fileName] = await files;
    const filePath = path.join(archiveDir, fileName);
    const original = (await import("node:fs/promises")).readFile(filePath, "utf8");
    const lines = (await original).split("\n").filter(Boolean);

    // Altered record
    await writeFile(filePath, lines.map((l, i) => (i === 1 ? l.replace("event-2", "event-X") : l)).join("\n") + "\n", "utf8");
    const altered = await verifyArchiveManifest(archiveDir);
    assert.equal(altered.ok, false);

    // Reordered records
    await writeFile(filePath, [lines[1], lines[0], lines[2]].join("\n") + "\n", "utf8");
    const reordered = await verifyArchiveManifest(archiveDir);
    assert.equal(reordered.ok, false);

    // Missing record
    await writeFile(filePath, [lines[0], lines[2]].join("\n") + "\n", "utf8");
    const missing = await verifyArchiveManifest(archiveDir);
    assert.equal(missing.ok, false);
  });
});

test("archive accepts LF and CRLF input without changing record identities and writes canonical LF", async () => {
  await withTempDataDir(async (tmp) => {
    const lfDir = tmp.file("events-lf");
    const crlfDir = tmp.file("events-crlf");

    const archive = createEventArchive({ dir: lfDir });
    const event1 = makeDummyEvent(1, 1000n);
    const event2 = makeDummyEvent(2, 2000n);
    await archive.append([event1, event2]);
    await archive.close();

    const fs = await import("node:fs/promises");
    const lfFiles = await fs.readdir(lfDir);
    assert.equal(lfFiles.length, 1);
    const lfRaw = await fs.readFile(path.join(lfDir, lfFiles[0]), "utf8");
    assert.equal(lfRaw.includes("\r\n"), false, "canonical archive output must use LF, not CRLF");
    assert.equal(lfRaw.endsWith("\n"), true);

    await mkdir(crlfDir, { recursive: true });
    // Write same records with CRLF and a blank CRLF line
    const crlfRaw = lfRaw.replace(/\n/g, "\r\n") + "\r\n";
    await writeFile(path.join(crlfDir, lfFiles[0]), crlfRaw, "utf8");

    const fromLf = [];
    for await (const ev of readArchive(lfDir)) fromLf.push(ev);

    const fromCrlf = [];
    for await (const ev of readArchive(crlfDir)) fromCrlf.push(ev);

    assert.deepEqual(fromCrlf, fromLf);
    assert.equal(fromCrlf[0].eventId, "event-1");
    assert.equal(fromCrlf[1].eventId, "event-2");
  });
});

test("archive reports exact line number for malformed record in CRLF input", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-crlf-malformed");
    await mkdir(archiveDir, { recursive: true });
    const fileName = "events-2026-01-01T00-00-00-000Z-000001.jsonl";
    await writeFile(
      path.join(archiveDir, fileName),
      `{"eventId":"event-1"}\r\n\r\n{"eventId":bad}\r\n`,
      "utf8",
    );

    let caught;
    try {
      for await (const _ of readArchive(archiveDir)) {
        // drain
      }
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof MalformedArchiveRecordError);
    assert.equal(caught.fileName, fileName);
    assert.equal(caught.lineNumber, 3);
  });
});
