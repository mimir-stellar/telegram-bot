import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_JSONL_CHUNK_BYTES,
  DEFAULT_MAX_JSONL_LINE_BYTES,
  JsonlLineTooLongError,
  createEventArchive,
  readArchive,
  readArchiveFile,
} from "../dist/stellar/archive.js";
import {
  formatScanJsonl,
  parseJsonlStream,
  streamBoundedJsonlLines,
} from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent(id, extraText = "") {
  return {
    source: "market",
    ledger: 1000 + id,
    txHash: `0xdeadbeef${String(id).padStart(8, "0")}`,
    eventId: `event-${id}`,
    txIndex: 1,
    operationIndex: 0,
    topicName: "claim_created",
    contractId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCM",
    blockTime: 1700000000 + id,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      stake: 10000000n,
      question: extraText || `Question ${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

async function* chunksFromBuffer(buf, chunkSize) {
  for (let i = 0; i < buf.byteLength; i += chunkSize) {
    yield buf.subarray(i, Math.min(i + chunkSize, buf.byteLength));
  }
}

test("exports explicit bounded JSONL defaults", () => {
  assert.equal(DEFAULT_MAX_JSONL_LINE_BYTES, 64 * 1024);
  assert.equal(DEFAULT_JSONL_CHUNK_BYTES, 64 * 1024);
});

test("rejects invalid maxLineBytes and chunkBytes options", async () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(async () => {
      for await (const _ of streamBoundedJsonlLines(chunksFromBuffer(Buffer.from("{}\n"), 8), {
        maxLineBytes: bad,
      })) {
        // unreachable
      }
    }, RangeError);
  }

  await withTempDataDir(async (tmp) => {
    const file = tmp.file("events-001.jsonl");
    await writeFile(file, '{"ok":true}\n', "utf8");

    for (const bad of [0, -10, 2.5, Number.NaN]) {
      await assert.rejects(async () => {
        for await (const _ of readArchiveFile(file, { chunkBytes: bad })) {
          // unreachable
        }
      }, RangeError);
    }
  });
});

test("boundary: accepts record at exact maxLineBytes (LF, CRLF, split CRLF, EOF)", async () => {
  const record = '{"k":"' + "a".repeat(20) + '"}';
  const exactBytes = Buffer.byteLength(record, "utf8");

  // 1. LF
  const lf = [];
  for await (const item of parseJsonlStream(chunksFromBuffer(Buffer.from(record + "\n"), 7), {
    maxLineBytes: exactBytes,
  })) {
    lf.push(item);
  }
  assert.deepEqual(lf, [{ k: "a".repeat(20) }]);

  // 2. CRLF in one chunk
  const crlf = [];
  for await (const item of parseJsonlStream(chunksFromBuffer(Buffer.from(record + "\r\n"), 64), {
    maxLineBytes: exactBytes,
  })) {
    crlf.push(item);
  }
  assert.deepEqual(crlf, [{ k: "a".repeat(20) }]);

  // 3. CRLF split right between \r and \n across chunks
  async function* splitCrLf() {
    yield Buffer.from(record + "\r", "utf8");
    yield Buffer.from("\n", "utf8");
  }
  const splitOut = [];
  for await (const item of parseJsonlStream(splitCrLf(), { maxLineBytes: exactBytes })) {
    splitOut.push(item);
  }
  assert.deepEqual(splitOut, [{ k: "a".repeat(20) }]);

  // 4. EOF without trailing newline
  const eof = [];
  for await (const item of parseJsonlStream(chunksFromBuffer(Buffer.from(record), 5), {
    maxLineBytes: exactBytes,
  })) {
    eof.push(item);
  }
  assert.deepEqual(eof, [{ k: "a".repeat(20) }]);
});

test("rejects oversized JSONL record BEFORE JSON.parse (one byte over maxLineBytes)", async () => {
  // Deliberately invalid JSON: if JSON.parse were called, it would throw SyntaxError.
  // Because oversized records must be rejected before parsing, it MUST throw JsonlLineTooLongError.
  const maxLineBytes = 32;
  const badOversized = "{not-valid-json:" + "x".repeat(maxLineBytes); // > 32 bytes
  const payload = `{"ok":1}\n${badOversized}\n{"ok":2}\n`;

  const seen = [];
  await assert.rejects(
    async () => {
      for await (const item of parseJsonlStream(chunksFromBuffer(Buffer.from(payload), 13), {
        maxLineBytes,
        source: "test.jsonl",
      })) {
        seen.push(item);
      }
    },
    (err) => {
      assert.ok(err instanceof JsonlLineTooLongError);
      assert.equal(err.maxLineBytes, maxLineBytes);
      assert.equal(err.lineNumber, 2);
      assert.equal(err.source, "test.jsonl");
      assert.ok(err.actualBytes > maxLineBytes);
      // Error message must be bounded and never echo the raw record payload
      assert.ok(!err.message.includes("not-valid-json"));
      assert.ok(err.message.length < 240);
      return true;
    },
  );
  // First valid record before the oversized line was streamed cleanly
  assert.deepEqual(seen, [{ ok: 1 }]);
});

test("rejects unbounded line without newline immediately without draining remaining stream", async () => {
  let chunksPulled = 0;
  async function* infiniteNoNewline() {
    for (let i = 0; i < 10_000; i++) {
      chunksPulled += 1;
      yield Buffer.alloc(1024, 0x61); // 1 KiB of 'a', no '\n'
    }
  }

  await assert.rejects(
    async () => {
      for await (const _ of parseJsonlStream(infiniteNoNewline(), { maxLineBytes: 4096 })) {
        // unreachable
      }
    },
    (err) => {
      assert.ok(err instanceof JsonlLineTooLongError);
      assert.equal(err.maxLineBytes, 4096);
      assert.equal(err.lineNumber, 1);
      return true;
    },
  );

  // Must abort on the 5th 1 KiB chunk (5120 > 4096), never draining all 10,000 chunks
  assert.equal(chunksPulled, 5);
});

test("preserves multi-byte UTF-8 characters split across small read chunks", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("utf8-archive");
    const archive = createEventArchive({ dir: archiveDir });
    const text = "🆕 Claim #7 — ⚔️ challenged… 日本語テスト ⚖️";
    await archive.append([makeEvent(1, text), makeEvent(2, text)]);
    await archive.close();

    const readBack = [];
    for await (const ev of readArchive(archiveDir, { chunkBytes: 17 })) {
      readBack.push(ev);
    }

    assert.equal(readBack.length, 2);
    assert.equal(readBack[0].payload.question, text);
    assert.equal(readBack[1].payload.question, text);
  });
});

test("readArchive streams large multi-file archive with bounded line buffer and preserves order", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("large-archive");
    await mkdir(archiveDir, { recursive: true });
    // Write 4 files of ~1 MiB each (~4 MiB total, ~10,000 events) directly as valid archive files
    const eventsPerFile = 2_500;
    const fileCount = 4;
    const totalEvents = eventsPerFile * fileCount;
    const pad = "p".repeat(180);

    let seq = 1;
    for (let f = 1; f <= fileCount; f++) {
      const lines = [];
      for (let i = 0; i < eventsPerFile; i++) {
        const ev = makeEvent(seq, `q-${seq}-${pad}`);
        lines.push(
          JSON.stringify(ev, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        );
        seq += 1;
      }
      const filename = `events-2026-01-01T00-00-00-000Z-${String(f).padStart(6, "0")}.jsonl`;
      await writeFile(path.join(archiveDir, filename), lines.join("\n") + "\n", "utf8");
    }

    let count = 0;
    let lastLedger = 0;
    for await (const ev of readArchive(archiveDir, {
      chunkBytes: 16 * 1024,
      maxLineBytes: 4 * 1024,
    })) {
      count += 1;
      assert.equal(ev.eventId, `event-${count}`);
      assert.ok(ev.ledger > lastLedger);
      lastLedger = ev.ledger;
    }

    assert.equal(count, totalEvents);
  });
});

test("readArchive rejects an oversized record inside an archive file before parsing", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("oversized-archive");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append([makeEvent(1, "small")]);
    await archive.close();

    // Write a second archive file with an oversized line
    const oversizedFile = path.join(
      archiveDir,
      "events-2099-01-01T00-00-00-000Z-000002.jsonl",
    );
    await writeFile(
      oversizedFile,
      `{"eventId":"event-2","payload":{"question":"${"z".repeat(2048)}"}}\n`,
      "utf8",
    );

    const seen = [];
    await assert.rejects(
      async () => {
        for await (const ev of readArchive(archiveDir, { maxLineBytes: 512, chunkBytes: 256 })) {
          seen.push(ev.eventId);
        }
      },
      (err) => {
        assert.ok(err instanceof JsonlLineTooLongError);
        assert.equal(err.maxLineBytes, 512);
        assert.equal(err.lineNumber, 1);
        assert.equal(err.source, "events-2099-01-01T00-00-00-000Z-000002.jsonl");
        return true;
      },
    );

    assert.deepEqual(seen, ["event-1"]);
  });
});

test("parseJsonlStream round-trips formatScanJsonl output and skips blank lines", async () => {
  const events = [makeEvent(1), makeEvent(2)];
  const raw = "\n" + formatScanJsonl(events) + "\n   \n";
  const parsed = [];
  for await (const record of parseJsonlStream(chunksFromBuffer(Buffer.from(raw, "utf8"), 31))) {
    parsed.push(record);
  }
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].type, "event");
  assert.equal(parsed[0].eventId, "event-1");
  assert.equal(parsed[1].type, "event");
  assert.equal(parsed[1].eventId, "event-2");
  assert.equal(parsed[2].type, "summary");
  assert.equal(parsed[2].eventCount, 2);
});
