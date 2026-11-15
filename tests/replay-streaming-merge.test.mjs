import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { decodeEvent } from "../dist/stellar/decode.js";
import { buildScanJsonReport, buildScanJsonTarget } from "../dist/stellar/events.js";
import {
  ReplayChunkMergeError,
  mergeReplayChunkFiles,
  mergeReplayScanChunks,
  runReplayCli,
} from "../dist/stellar/replay.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import {
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimChallengedEvent,
  claimCreatedEvent,
  claimResolvedEvent,
  marketSettledEvent,
  squadDepositedEvent,
  squadMarketCreatedEvent,
} from "./fixtures/events.mjs";

function makeCursor(ledger, index = 0) {
  const toid = BigInt(ledger) << 32n;
  return `${toid}-${index}`;
}

function makeDecoded(source, raw, overrides = {}) {
  const ev = decodeEvent(source, raw);
  return { ...ev, ...overrides };
}

test("mergeReplayChunkFiles merges overlapping multi-contract JSONL chunks into identical canonical order regardless of chunk argument order", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimir-merge-chunks-"));
  try {
    // Chunk 1: simulates `npm run scan -- --jsonl` (market events first, then squad events)
    const ev100Market = makeDecoded(
      "market",
      claimCreatedEvent({ id: makeCursor(100, 1), ledger: 100, claimId: 1 }),
      { transactionIndex: 0, operationIndex: 0 },
    );
    const ev105MarketTx2 = makeDecoded(
      "market",
      claimChallengedEvent({ id: makeCursor(105, 2), ledger: 105, claimId: 1, stake: 35_000_000n }),
      { transactionIndex: 2, operationIndex: 0 },
    );
    const ev110OverlapMarket = makeDecoded(
      "market",
      claimResolvedEvent({ id: makeCursor(110, 1), ledger: 110, claimId: 1 }),
      { transactionIndex: 1, operationIndex: 0 },
    );
    const ev102Squad = makeDecoded(
      "squad",
      squadMarketCreatedEvent({ id: makeCursor(102, 1), ledger: 102, marketId: 10 }),
      { transactionIndex: 0, operationIndex: 1 },
    );
    const ev110OverlapSquad = makeDecoded(
      "squad",
      squadDepositedEvent({ id: makeCursor(110, 2), ledger: 110, marketId: 10, amount: 50_000_000n }),
      { transactionIndex: 1, operationIndex: 1 },
    );

    // Chunk 2: overlaps at ledger 110 and continues through 120, including sub-ledger ordering
    const ev105MarketTx1 = makeDecoded(
      "market",
      claimChallengedEvent({ id: makeCursor(105, 1), ledger: 105, claimId: 1, stake: 15_000_000n }),
      { transactionIndex: 1, operationIndex: 0 },
    );
    const ev105MarketNullIdx = makeDecoded(
      "market",
      claimChallengedEvent({ id: makeCursor(105, 9), ledger: 105, claimId: 1, stake: 5_000_000n }),
      { transactionIndex: null, operationIndex: null },
    );
    const ev120Settled = makeDecoded(
      "market",
      marketSettledEvent({ id: makeCursor(120, 1), ledger: 120, claimId: 1, totalPaid: 90_000_000n }),
      { transactionIndex: 0, operationIndex: 0 },
    );

    const chunk1Path = path.join(tmpDir, "chunk-1.jsonl");
    const chunk2Path = path.join(tmpDir, "chunk-2.jsonl");
    const outForward = path.join(tmpDir, "merged-forward.jsonl");
    const outReverse = path.join(tmpDir, "merged-reverse.jsonl");

    await writeFile(
      chunk1Path,
      formatScanJsonl([
        ev100Market,
        ev105MarketTx2,
        ev110OverlapMarket,
        ev102Squad,
        ev110OverlapSquad,
      ]),
      "utf8",
    );
    await writeFile(
      chunk2Path,
      formatScanJsonl([
        ev105MarketTx1,
        ev105MarketNullIdx,
        ev110OverlapMarket, // boundary duplicate
        ev120Settled,
        ev110OverlapSquad, // boundary duplicate
      ]),
      "utf8",
    );

    const resForward = await runReplayCli({
      argv: ["node", "replay", "--merge-chunks", chunk1Path, chunk2Path, "--output", outForward],
      deps: { progress: () => {} },
    });
    assert.equal(resForward.exitCode, 0);
    assert.equal(resForward.mergeSummary?.chunksMerged, 2);
    assert.equal(resForward.mergeSummary?.eventCount, 8);
    assert.equal(resForward.mergeSummary?.duplicates, 2);
    assert.equal(resForward.mergeSummary?.firstLedger, 100);
    assert.equal(resForward.mergeSummary?.lastLedger, 120);

    const resReverse = await runReplayCli({
      argv: ["node", "replay", "--merge-chunks", chunk2Path, chunk1Path, "--output", outReverse],
      deps: { progress: () => {} },
    });
    assert.equal(resReverse.exitCode, 0);

    const forwardRaw = await readFile(outForward, "utf8");
    const reverseRaw = await readFile(outReverse, "utf8");
    assert.equal(
      forwardRaw,
      reverseRaw,
      "merged JSONL report must be byte-for-byte identical regardless of chunk order",
    );

    const lines = forwardRaw.trimEnd().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 9); // 8 events + 1 summary

    const eventLines = lines.slice(0, 8);
    assert.deepEqual(
      eventLines.map((e) => [
        e.ledger,
        e.transactionIndex,
        e.operationIndex,
        e.source,
        e.payload.name,
      ]),
      [
        [100, 0, 0, "market", "claim_created"],
        [102, 0, 1, "squad", "market_created"],
        [105, 1, 0, "market", "claim_challenged"],
        [105, 2, 0, "market", "claim_challenged"],
        [105, null, null, "market", "claim_challenged"],
        [110, 1, 0, "market", "claim_resolved"],
        [110, 1, 1, "squad", "deposited"],
        [120, 0, 0, "market", "market_settled"],
      ],
    );

    // Bigint amounts round-tripped cleanly as decimal strings
    assert.equal(eventLines[2].payload.stake, "15000000");
    assert.equal(eventLines[3].payload.stake, "35000000");
    assert.equal(eventLines[4].payload.stake, "5000000");
    assert.equal(eventLines[6].payload.amount, "50000000");
    assert.equal(eventLines[7].payload.totalPaid, "90000000");

    const summary = lines[8];
    assert.equal(summary.type, "summary");
    assert.equal(summary.eventCount, 8);
    assert.equal(summary.duplicates, 2);
    assert.equal(summary.chunksMerged, 2);
    assert.deepEqual(summary.histogram, {
      claim_challenged: 3,
      claim_created: 1,
      claim_resolved: 1,
      deposited: 1,
      market_created: 1,
      market_settled: 1,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("duplicate policy preserves unidentifiable events without inventing synthetic IDs and honors dedupWindow=0", async () => {
  const unidentifiableA = makeDecoded(
    "market",
    claimCreatedEvent({ id: "", ledger: 300, claimId: 7 }),
    { eventId: "", txHash: "a".repeat(64) },
  );
  const unidentifiableB = makeDecoded(
    "market",
    claimCreatedEvent({ id: "", ledger: 300, claimId: 7 }),
    { eventId: "", txHash: "a".repeat(64) },
  );
  const identifiable = makeDecoded(
    "market",
    claimCreatedEvent({ id: makeCursor(301, 0), ledger: 301, claimId: 8 }),
  );

  // Default dedupWindow: unidentifiable events kept, identifiable duplicate suppressed
  const outDefault = new PassThrough();
  let defaultRaw = "";
  outDefault.setEncoding("utf8");
  outDefault.on("data", (c) => {
    defaultRaw += c;
  });

  const summaryDefault = await mergeReplayScanChunks(
    [[unidentifiableA, identifiable], [unidentifiableB, identifiable]],
    { output: outDefault },
  );
  outDefault.end();

  assert.equal(summaryDefault.eventCount, 3);
  assert.equal(summaryDefault.duplicates, 1);
  const parsedDefault = defaultRaw.trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.equal(parsedDefault.length, 4);

  // dedupWindow=0 disables deduplication completely
  const summaryDisabled = await mergeReplayScanChunks(
    [[identifiable], [identifiable]],
    { dedupWindow: 0 },
  );
  assert.equal(summaryDisabled.eventCount, 2);
  assert.equal(summaryDisabled.duplicates, 0);
});

test("mergeReplayScanChunks streams long histories in strictly bounded O(K) head memory with backpressure", async () => {
  const numChunks = 4;
  const eventsPerChunk = 2500; // 10,000 events total across 4 chunks
  const baseEvent = makeDecoded(
    "market",
    claimCreatedEvent({ id: makeCursor(1, 0), ledger: 1, claimId: 1 }),
  );

  let activeInFlight = 0;
  let peakInFlight = 0;
  let drainPausesObserved = 0;
  let writtenLines = 0;

  function makeStreamingChunk(chunkIdx) {
    return {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < eventsPerChunk; i++) {
          const ledger = 1000 + i * numChunks + chunkIdx;
          activeInFlight += 1;
          if (activeInFlight > peakInFlight) {
            peakInFlight = activeInFlight;
          }
          yield {
            ...baseEvent,
            ledger,
            eventId: makeCursor(ledger, chunkIdx),
            payload: { ...baseEvent.payload, claimId: ledger },
          };
        }
      },
    };
  }

  // Slow writable with tiny highWaterMark to trigger real backpressure drains
  const slowSink = new Writable({
    highWaterMark: 256,
    write(chunk, _encoding, callback) {
      const str = chunk.toString("utf8");
      const newlines = str.split("\n").length - 1;
      writtenLines += newlines;
      // Each emitted event line consumes one pulled head item (except the final summary line)
      if (activeInFlight > 0) {
        activeInFlight -= 1;
      }
      if (writtenLines % 500 === 0) {
        drainPausesObserved += 1;
        setImmediate(callback);
      } else {
        callback();
      }
    },
  });

  const chunks = Array.from({ length: numChunks }, (_, k) => makeStreamingChunk(k));
  const result = await mergeReplayScanChunks(chunks, {
    output: slowSink,
    dedupWindow: 64,
  });

  assert.equal(result.eventCount, numChunks * eventsPerChunk);
  assert.equal(result.duplicates, 0);
  assert.equal(result.firstLedger, 1000);
  assert.equal(result.lastLedger, 1000 + (eventsPerChunk - 1) * numChunks + (numChunks - 1));
  assert.equal(writtenLines, numChunks * eventsPerChunk + 1);
  assert.ok(drainPausesObserved > 0, "backpressure pauses must be exercised");
  // At most K head items + 1 chosen item awaiting sink write can ever be live simultaneously
  assert.ok(
    peakInFlight <= numChunks + 1,
    `expected O(K) bounded head items (<= ${numChunks + 1}), observed peak=${peakInFlight}`,
  );
});

test("mergeReplayChunkFiles supports mimir-scan-v1 JSON chunks alongside JSONL chunks and CLI range/contract filters", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimir-merge-scanv1-"));
  try {
    const ev200 = makeDecoded(
      "market",
      claimCreatedEvent({ id: makeCursor(200, 0), ledger: 200, claimId: 20 }),
    );
    const ev210 = makeDecoded(
      "squad",
      squadMarketCreatedEvent({ id: makeCursor(210, 0), ledger: 210, marketId: 21 }),
    );
    const ev220 = makeDecoded(
      "market",
      claimResolvedEvent({ id: makeCursor(220, 0), ledger: 220, claimId: 20 }),
    );

    const scanReport = buildScanJsonReport({
      network: "mock",
      rpcUrl: "http://127.0.0.1:8420",
      oldestLedger: 190,
      latestLedger: 215,
      targets: [
        buildScanJsonTarget(
          {
            source: "market",
            contractId: MARKET_CONTRACT,
            events: [ev200],
            pages: 1,
            emptyPages: 0,
            duplicates: 0,
            truncated: false,
            lastEventLedger: 200,
            cursor: makeCursor(200, 0),
            startLedger: 190,
            startClamped: false,
          },
          10,
        ),
        buildScanJsonTarget(
          {
            source: "squad",
            contractId: SQUAD_CONTRACT,
            events: [ev210],
            pages: 1,
            emptyPages: 0,
            duplicates: 0,
            truncated: false,
            lastEventLedger: 210,
            cursor: makeCursor(210, 0),
            startLedger: 190,
            startClamped: false,
          },
          10,
        ),
      ],
    });

    const scanChunkPath = path.join(tmpDir, "scan-chunk.json");
    const jsonlChunkPath = path.join(tmpDir, "tail-chunk.jsonl");
    await writeFile(scanChunkPath, JSON.stringify(scanReport, null, 2), "utf8");
    await writeFile(jsonlChunkPath, formatScanJsonl([ev220]), "utf8");

    const stdoutCapture = new PassThrough();
    let streamed = "";
    stdoutCapture.setEncoding("utf8");
    stdoutCapture.on("data", (d) => {
      streamed += d;
    });

    const { exitCode, mergeSummary } = await runReplayCli({
      argv: [
        "node",
        "replay",
        "--chunk",
        scanChunkPath,
        "--chunk",
        jsonlChunkPath,
        "--contract",
        "market",
        "--from",
        "205",
        "--to",
        "225",
      ],
      deps: { stdout: stdoutCapture, progress: () => {} },
    });
    stdoutCapture.end();

    assert.equal(exitCode, 0);
    assert.equal(mergeSummary?.eventCount, 1);
    assert.equal(mergeSummary?.firstLedger, 220);
    assert.equal(mergeSummary?.lastLedger, 220);

    const lines = streamed.trimEnd().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].ledger, 220);
    assert.equal(lines[0].source, "market");
    assert.equal(lines[1].type, "summary");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("rejects out-of-order chunks, oversized lines, and malformed JSON without leaving partial --output files", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "mimir-merge-errors-"));
  try {
    const ev500 = makeDecoded(
      "market",
      claimCreatedEvent({ id: makeCursor(500, 0), ledger: 500, claimId: 1 }),
    );
    const ev400 = makeDecoded(
      "market",
      claimCreatedEvent({ id: makeCursor(400, 0), ledger: 400, claimId: 2 }),
    );

    // 1. Out-of-order chunk
    const unsortedPath = path.join(tmpDir, "unsorted.jsonl");
    const outPath = path.join(tmpDir, "should-not-exist.jsonl");
    await writeFile(unsortedPath, formatScanJsonl([ev500, ev400]), "utf8");

    await assert.rejects(
      () => mergeReplayChunkFiles([unsortedPath], { outputFile: outPath }),
      (err) => err instanceof ReplayChunkMergeError && err.code === "OUT_OF_ORDER_CHUNK",
    );

    await assert.rejects(() => access(outPath), { code: "ENOENT" });

    const cliOutOfOrder = await runReplayCli({
      argv: ["node", "replay", "--merge-chunks", unsortedPath, "--output", outPath],
      deps: { progress: () => {} },
    });
    assert.equal(cliOutOfOrder.exitCode, 1);
    await assert.rejects(() => access(outPath), { code: "ENOENT" });

    // 2. Oversized line rejected before unbounded JSON parse
    const oversizedPath = path.join(tmpDir, "oversized.jsonl");
    await writeFile(oversizedPath, `{"type":"event","pad":"${"x".repeat(2048)}"}\n`, "utf8");
    await assert.rejects(
      () => mergeReplayChunkFiles([oversizedPath], { maxLineBytes: 512 }),
      (err) => err instanceof ReplayChunkMergeError && err.code === "OVERSIZED_CHUNK_LINE",
    );

    // 3. Empty chunk produces valid summary line
    const emptyChunkPath = path.join(tmpDir, "empty.jsonl");
    const emptyOutPath = path.join(tmpDir, "empty-merged.jsonl");
    await writeFile(emptyChunkPath, formatScanJsonl([]), "utf8");
    const emptyRes = await mergeReplayChunkFiles([emptyChunkPath], { outputFile: emptyOutPath });
    assert.equal(emptyRes.eventCount, 0);
    assert.equal(emptyRes.firstLedger, null);
    assert.equal(emptyRes.lastLedger, null);
    assert.deepEqual(emptyRes.histogram, {});

    // 4. Usage error when --merge-chunks has no paths
    const missingPaths = await runReplayCli({
      argv: ["node", "replay", "--merge-chunks"],
      deps: { progress: () => {} },
    });
    assert.equal(missingPaths.exitCode, 2);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
