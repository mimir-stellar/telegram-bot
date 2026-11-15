import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_NEWLINE,
  computeArchiveRecordIdentity,
  createEventArchive,
  exportCanonicalArchive,
  normalizeArchiveDirectoryNewlines,
  normalizeScanJsonl,
  parseScanJsonlEvents,
  readArchive,
} from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent(id, question = `Question ${id}`) {
  return {
    source: "market",
    contractId: "CMARKET_NORM_1",
    ledger: 3000 + id,
    txHash: `0xhash${id}`,
    eventId: `${3000 + id}-${id}`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GCREATOR",
      stake: BigInt(id * 1000),
      question,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("accepts LF, CRLF, CR, mixed endings, and UTF-8 BOM without changing record identities", async () => {
  await withTempDataDir(async (tmp) => {
    const ev1 = makeEvent(1, "Multiline\r\nQuestion\nBody");
    const ev2 = makeEvent(2, "Second event");

    const baseLf = formatScanJsonl([ev1, ev2]);
    assert.equal(baseLf.includes("\r"), false);
    assert.ok(baseLf.endsWith(CANONICAL_NEWLINE));

    const crlfWithBom = "\uFEFF" + baseLf.replace(/\n/g, "\r\n");
    const crOnly = baseLf.replace(/\n/g, "\r");
    const lfLines = baseLf.trim().split("\n");
    const mixedNoTrailing = `${lfLines[0]}\r\n\r\n${lfLines[1]}\n${lfLines[2]}`;

    const parsedLf = parseScanJsonlEvents(baseLf);
    const parsedCrlf = parseScanJsonlEvents(Buffer.from(crlfWithBom, "utf8"));
    const parsedCr = parseScanJsonlEvents(crOnly);
    const parsedMixed = parseScanJsonlEvents(mixedNoTrailing);

    assert.deepEqual(parsedCrlf, parsedLf);
    assert.deepEqual(parsedCr, parsedLf);
    assert.deepEqual(parsedMixed, parsedLf);

    // Embedded \r\n inside payload string literal must remain intact!
    assert.equal(parsedCrlf[0].payload.question, "Multiline\r\nQuestion\nBody");

    // Record identities are invariant across LF, CRLF+BOM, CR, and shuffled property order.
    const idsLf = parsedLf.map(computeArchiveRecordIdentity);
    const idsCrlf = parsedCrlf.map(computeArchiveRecordIdentity);
    assert.deepEqual(idsCrlf, idsLf);

    const shuffledEv1 = {
      eventId: parsedLf[0].eventId,
      payload: {
        feeBps: 100,
        deadline: 1700001000,
        question: "Multiline\r\nQuestion\nBody",
        stake: "1000",
        creator: "GCREATOR",
        claimId: 1,
        name: "claim_created",
      },
      txHash: parsedLf[0].txHash,
      ledger: parsedLf[0].ledger,
      contractId: parsedLf[0].contractId,
      source: parsedLf[0].source,
    };
    assert.equal(computeArchiveRecordIdentity(shuffledEv1), idsLf[0]);

    // Compare LF vs CRLF on-disk archive directories.
    const lfDir = tmp.file("lf-archive");
    const crlfDir = tmp.file("crlf-archive");
    await mkdir(lfDir, { recursive: true });
    await mkdir(crlfDir, { recursive: true });

    const segName = "events-2026-11-01T00-00-00-000Z-000001.jsonl";
    const rawLine1 = JSON.stringify(parsedLf[0]);
    const rawLine2 = JSON.stringify(shuffledEv1).replace("3001-1", "3002-2");

    await writeFile(path.join(lfDir, segName), `${rawLine1}\n${rawLine2}\n`, "utf8");
    await writeFile(
      path.join(crlfDir, segName),
      Buffer.from(`\uFEFF${rawLine1}\r\n\r\n${rawLine2}\r\n`, "utf8"),
    );

    const fromLfDir = [];
    for await (const e of readArchive(lfDir)) fromLfDir.push(e);
    const fromCrlfDir = [];
    for await (const e of readArchive(crlfDir)) fromCrlfDir.push(e);

    assert.deepEqual(fromCrlfDir, fromLfDir);
    assert.deepEqual(
      fromCrlfDir.map(computeArchiveRecordIdentity),
      fromLfDir.map(computeArchiveRecordIdentity),
    );
  });
});

test("produces documented canonical UTF-8 pure-LF export format across platforms", async () => {
  await withTempDataDir(async (tmp) => {
    const dirA = tmp.file("dir-a");
    const dirB = tmp.file("dir-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    const ev = makeEvent(7, "LineA\r\nLineB");
    const archiveA = createEventArchive({ dir: dirA });
    await archiveA.append([ev]);
    await archiveA.close();

    // Verify createEventArchive wrote zero CR bytes even on Windows!
    const createdFiles = await import("node:fs/promises").then((fs) => fs.readdir(dirA));
    const createdBytes = await readFile(path.join(dirA, createdFiles[0]));
    assert.equal(createdBytes.includes(0x0d), false, "archive writer must never emit CR bytes");

    // Write CRLF + BOM + reversed keys into dirB
    const reversedJson = JSON.stringify({
      txHash: ev.txHash,
      source: ev.source,
      payload: {
        stake: "7000",
        question: ev.payload.question,
        name: ev.payload.name,
        feeBps: ev.payload.feeBps,
        deadline: ev.payload.deadline,
        creator: ev.payload.creator,
        claimId: ev.payload.claimId,
      },
      ledger: ev.ledger,
      eventId: ev.eventId,
      contractId: ev.contractId,
    });
    const segB = path.join(dirB, "events-2026-11-01T00-00-00-000Z-000001.jsonl");
    await writeFile(segB, `\uFEFF${reversedJson}\r\n`, "utf8");

    const exportA = await exportCanonicalArchive(dirA, { includeSummary: true });
    const exportB = await exportCanonicalArchive(dirB, { includeSummary: true });

    assert.equal(exportA, exportB);
    assert.equal(exportA.includes("\r"), false);
    assert.equal(exportA.charCodeAt(0) === 0xfeff, false);
    assert.ok(exportA.endsWith("\n"));

    // Normalize dirB in place and verify CR + BOM are stripped while record identity holds.
    const normStats = await normalizeArchiveDirectoryNewlines(dirB);
    assert.equal(normStats.filesNormalized, 1);
    assert.equal(normStats.recordCount, 1);

    const normalizedBytes = await readFile(segB);
    assert.equal(normalizedBytes.includes(0x0d), false);
    assert.equal(normalizedBytes[0] === 0xef, false);

    // Second pass is a no-op since segment is already canonical.
    const secondStats = await normalizeArchiveDirectoryNewlines(dirB);
    assert.equal(secondStats.filesNormalized, 0);
  });
});

test("rejects invalid UTF-8 byte sequences and malformed JSON lines cleanly", async () => {
  await withTempDataDir(async (tmp) => {
    const badUtf8 = Buffer.from([0xff, 0xfe, 0x7b, 0x7d, 0x0a]);
    assert.throws(() => normalizeScanJsonl(badUtf8));
    assert.throws(() => normalizeScanJsonl('{"broken":\r\n'));
    assert.equal(normalizeScanJsonl("\uFEFF\r\n   \r\n"), "");

    const badDir = tmp.file("bad-utf8-dir");
    await mkdir(badDir, { recursive: true });
    await writeFile(
      path.join(badDir, "events-2026-11-01T00-00-00-000Z-000001.jsonl"),
      badUtf8,
    );

    await assert.rejects(async () => {
      for await (const _ of readArchive(badDir)) {
        // unreachable
      }
    });

    const emptyDir = tmp.file("empty-dir");
    await mkdir(emptyDir, { recursive: true });
    assert.equal(await exportCanonicalArchive(emptyDir), "");
  });
});
