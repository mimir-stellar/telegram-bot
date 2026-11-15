import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  OversizedArchiveRecordError,
  importArchiveFromFile,
  importArchiveFromStream,
  readArchive,
  streamBoundedJsonlLines,
  streamScanJsonlEvents,
} from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent(id, question = `Question ${id}`) {
  return {
    source: "market",
    contractId: "CMARKET_STREAM",
    ledger: 6000 + id,
    txHash: `0xtx${id}`,
    eventId: `${6000 + id}-${id}`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GCREATOR",
      question,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("rejects oversized JSONL records before JSON.parse and halts upstream chunk consumption immediately", async () => {
  const validLine = JSON.stringify(makeEvent(1)) + "\n";
  let chunksPulled = 0;

  async function* hostileInfiniteLineStream() {
    yield Buffer.from(validLine, "utf8");
    // Emit 10,000 chunks without a newline (would be 2.5 MiB if buffered whole).
    for (let i = 0; i < 10_000; i++) {
      chunksPulled += 1;
      yield Buffer.from("A".repeat(256), "utf8");
    }
  }

  let jsonParseCalls = 0;
  const origParse = JSON.parse;
  JSON.parse = function (...args) {
    jsonParseCalls += 1;
    return origParse.apply(this, args);
  };

  try {
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const ev of streamScanJsonlEvents(hostileInfiniteLineStream(), {
          maxLineBytes: 600,
          sourceName: "hostile.jsonl",
        })) {
          seen.push(ev);
        }
      },
      (err) => {
        assert.ok(err instanceof OversizedArchiveRecordError);
        assert.equal(err.source, "hostile.jsonl");
        assert.equal(err.line, 2);
        assert.equal(err.maxLineBytes, 600);
        assert.ok(err.observedBytes > 600);
        return true;
      },
    );

    assert.equal(seen.length, 1, "first valid event is yielded");
    assert.equal(jsonParseCalls, 1, "JSON.parse must never be called on the oversized line");
    assert.ok(
      chunksPulled <= 4,
      `stream must halt immediately once maxLineBytes is exceeded (pulled ${chunksPulled} chunks)`,
    );
  } finally {
    JSON.parse = origParse;
  }
});

test("reassembles multi-byte UTF-8 and CRLF across tiny chunk boundaries and accepts exact maxLineBytes", async () => {
  const utf8Question = "🚀 Stellar — café 你好 🌊";
  const ev1 = makeEvent(1, utf8Question);
  const ev2 = makeEvent(2, "Second — αβγ");

  const rawCrlf =
    "\uFEFF" +
    JSON.stringify(ev1) +
    "\r\n" +
    JSON.stringify(ev2) +
    "\r\n";
  const fullBytes = Buffer.from(rawCrlf, "utf8");

  // Slice into tiny 11-byte chunks so multi-byte UTF-8 sequences and \r\n split mid-sequence.
  const tinyChunks = [];
  for (let i = 0; i < fullBytes.length; i += 11) {
    tinyChunks.push(fullBytes.subarray(i, i + 11));
  }

  const maxExact = Math.max(
    Buffer.byteLength(JSON.stringify(ev1), "utf8"),
    Buffer.byteLength(JSON.stringify(ev2), "utf8"),
  );

  const decoded = [];
  for await (const ev of streamScanJsonlEvents(tinyChunks, { maxLineBytes: maxExact })) {
    decoded.push(ev);
  }

  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].payload.question, utf8Question);
  assert.equal(decoded[1].payload.question, "Second — αβγ");

  // Reducing maxLineBytes by 1 byte rejects cleanly.
  await assert.rejects(
    async () => {
      for await (const _ of streamScanJsonlEvents(tinyChunks, { maxLineBytes: maxExact - 1 })) {
        // unreachable
      }
    },
    (err) => err instanceof OversizedArchiveRecordError,
  );
});

test("streams large multi-thousand-record imports with bounded memory and enforces maxLineBytes on readArchive", async () => {
  await withTempDataDir(async (tmp) => {
    const totalEvents = 5_000;

    async function* generateLargeJsonlChunks() {
      for (let i = 1; i <= totalEvents; i++) {
        yield JSON.stringify({ type: "event", ...makeEvent(i) }) + "\n";
      }
    }

    // Stream-consume 5,000 records without retaining them in an array; verify bounded heap delta.
    const baselineHeap = process.memoryUsage().heapUsed;
    let peakDeltaBytes = 0;
    let count = 0;

    for await (const ev of streamScanJsonlEvents(generateLargeJsonlChunks(), {
      maxLineBytes: 1024,
    })) {
      count += 1;
      assert.equal(ev.ledger, 6000 + count);
      if (count % 500 === 0) {
        const delta = process.memoryUsage().heapUsed - baselineHeap;
        if (delta > peakDeltaBytes) peakDeltaBytes = delta;
      }
    }
    assert.equal(count, totalEvents);
    assert.ok(
      peakDeltaBytes < 32 * 1024 * 1024,
      `expected bounded heap growth (<32 MiB), observed ${peakDeltaBytes}`,
    );

    // End-to-end file import and chunked readArchive
    const jsonlPath = tmp.file("source.jsonl");
    const archiveDir = tmp.file("imported-archive");
    const batchEvents = Array.from({ length: 25 }, (_, idx) => makeEvent(idx + 1));
    await writeFile(jsonlPath, formatScanJsonl(batchEvents), "utf8");

    const imported = await importArchiveFromFile(jsonlPath, {
      dir: archiveDir,
      maxBytes: 1_200,
      maxFiles: 20,
      chunkBytes: 64,
      maxLineBytes: 1_024,
    });
    assert.equal(imported.importedCount, 25);

    const readBack = [];
    for await (const ev of readArchive(archiveDir, { chunkBytes: 48, maxLineBytes: 1_024 })) {
      readBack.push(ev);
    }
    assert.equal(readBack.length, 25);
    assert.equal(readBack[24].eventId, "6025-25");

    // Oversized line on disk inside archive directory is rejected before JSON.parse
    const oversizedDir = tmp.file("oversized-archive");
    await mkdir(oversizedDir, { recursive: true });
    await writeFile(
      path.join(oversizedDir, "events-2026-11-01T00-00-00-000Z-000001.jsonl"),
      JSON.stringify(makeEvent(1, "X".repeat(2_000))) + "\n",
      "utf8",
    );

    await assert.rejects(
      async () => {
        for await (const _ of readArchive(oversizedDir, { chunkBytes: 128, maxLineBytes: 512 })) {
          // unreachable
        }
      },
      (err) => err instanceof OversizedArchiveRecordError && err.line === 1,
    );

    // Invalid option values reject with RangeError
    await assert.rejects(async () => {
      for await (const _ of streamBoundedJsonlLines(["{}\n"], { maxLineBytes: 0 })) {
        // unreachable
      }
    }, RangeError);
    await assert.rejects(
      () => importArchiveFromStream(["{}\n"], { dir: tmp.file("bad"), maxLineBytes: -1 }),
      RangeError,
    );
  });
});
