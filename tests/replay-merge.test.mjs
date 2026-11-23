/**
 * Tests for streaming JSONL replay chunk merging (`mergeReplayChunksToJsonl`,
 * `mergeReplayChunkFilesToJsonl`, `--jsonl`, and `--merge-chunks`).
 *
 * All I/O uses synthetic fixtures, fake transports, and temporary directories.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  compareReplayEvents,
  mergeReplayChunkFilesToJsonl,
  mergeReplayChunksToJsonl,
  runReplayCli,
} from "../dist/stellar/replay.js";
import { MARKET_CONTRACT, SQUAD_CONTRACT } from "./fixtures/events.mjs";
import { createTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent(overrides = {}) {
  return {
    ledger: 100,
    transactionIndex: 1,
    operationIndex: 0,
    txHash: "tx-aaa",
    eventId: "0000000100-0000000001",
    name: "claim_created",
    source: "market",
    sent: true,
    skipped: false,
    ...overrides,
  };
}

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function makeServer(health, pagesByContract = {}) {
  const indices = {};
  return {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: health.oldestLedger ?? 1,
        latestLedger: health.latestLedger ?? 5000,
      };
    },
    async getEvents(req) {
      const contractId = req?.filters?.[0]?.contractIds?.[0] ?? "";
      const pages = pagesByContract[contractId] ?? [];
      const idx = indices[contractId] ?? 0;
      const page = pages[idx] ?? { events: [], cursor: "", latestLedger: health.latestLedger ?? 5000 };
      indices[contractId] = idx + 1;
      return {
        events: Array.isArray(page.events) ? page.events : [],
        cursor: page.cursor ?? "",
        latestLedger: page.latestLedger ?? health.latestLedger ?? 5000,
      };
    },
  };
}

function rawEvent(ledger, contractId, txIndex = 1) {
  const cursor = makeCursor(ledger, txIndex, 0);
  return {
    id: cursor,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId,
    txHash: `tx-${ledger}-${txIndex}`,
    transactionIndex: txIndex,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [],
    value: undefined,
  };
}

// ── Canonical ordering & duplicate policy ────────────────────────────────────

test("mergeReplayChunksToJsonl preserves canonical ordering across interleaved chunks", async () => {
  const chunkA = [
    makeEvent({ ledger: 100, transactionIndex: 2, operationIndex: 0, eventId: "e-100-2", source: "market" }),
    makeEvent({ ledger: 102, transactionIndex: null, operationIndex: null, eventId: "e-102-null", source: "market" }),
    makeEvent({ ledger: 105, transactionIndex: 1, operationIndex: 0, eventId: "e-105-1", source: "market" }),
  ];
  const chunkB = [
    makeEvent({ ledger: 100, transactionIndex: 1, operationIndex: 0, eventId: "e-100-1", source: "squad", name: "deposited" }),
    makeEvent({ ledger: 102, transactionIndex: 0, operationIndex: 0, eventId: "e-102-0", source: "squad", name: "deposited" }),
    makeEvent({ ledger: 103, transactionIndex: 1, operationIndex: 0, eventId: "e-103-1", source: "squad", name: "resolved" }),
  ];

  const lines = [];
  const summary = await mergeReplayChunksToJsonl([chunkA, chunkB], (line) => {
    lines.push(line);
  });

  const records = lines.map((l) => JSON.parse(l));
  assert.equal(records[0].type, "header");
  assert.equal(records[0].format, "mimir-replay-jsonl-v1");
  assert.equal(records[0].chunkCount, 2);

  const events = records.filter((r) => r.type === "event");
  assert.deepEqual(
    events.map((e) => e.eventId),
    ["e-100-1", "e-100-2", "e-102-0", "e-102-null", "e-103-1", "e-105-1"],
  );

  // Verify strict canonical monotonicity
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(compareReplayEvents(events[i - 1], events[i]) <= 0);
  }

  const last = records[records.length - 1];
  assert.equal(last.type, "summary");
  assert.equal(summary.totals.events, 6);
  assert.equal(summary.totals.duplicates, 0);
});

test("mergeReplayChunksToJsonl applies canonical duplicate policy and never suppresses null keys", async () => {
  const dupEvent = makeEvent({ ledger: 200, eventId: "dup-200", sent: true });
  const nullKeyEventA = makeEvent({ ledger: 201, eventId: "", txHash: "", name: "unknown:a", sent: false, skipped: true, skipReason: "unknown" });
  const nullKeyEventB = makeEvent({ ledger: 201, eventId: "", txHash: "", name: "unknown:a", sent: false, skipped: true, skipReason: "unknown" });

  const chunkA = [dupEvent, nullKeyEventA];
  const chunkB = [
    makeEvent({ ledger: 200, eventId: "dup-200", sent: false, skipped: true, skipReason: "cap" }),
    nullKeyEventB,
  ];

  const lines = [];
  const summary = await mergeReplayChunksToJsonl([chunkA, chunkB], (line) => {
    lines.push(line);
  });

  const events = lines.map((l) => JSON.parse(l)).filter((r) => r.type === "event");
  // dup-200 emitted once (first occurrence wins: sent=true), both null-key events kept
  assert.equal(events.length, 3);
  assert.equal(events[0].eventId, "dup-200");
  assert.equal(events[0].sent, true);
  assert.equal(summary.totals.events, 3);
  assert.equal(summary.totals.duplicates, 1);
  assert.equal(summary.totals.sent, 1);
  assert.equal(summary.totals.skipped, 2);
});

// ── Bounded memory on long histories ─────────────────────────────────────────

test("mergeReplayChunksToJsonl streams long histories with bounded memory", async () => {
  const perChunk = 2_000;
  const numChunks = 3;
  let activeProduced = 0;
  let emittedCount = 0;
  let maxInFlight = 0;

  async function* makeChunk(chunkIdx) {
    for (let i = 0; i < perChunk; i += 1) {
      const ledger = i * numChunks + chunkIdx + 1;
      activeProduced += 1;
      maxInFlight = Math.max(maxInFlight, activeProduced - emittedCount);
      yield makeEvent({
        ledger,
        eventId: `ev-${String(ledger).padStart(8, "0")}`,
        txHash: `tx-${ledger}`,
      });
    }
  }

  let prevLedger = 0;
  const summary = await mergeReplayChunksToJsonl(
    [makeChunk(0), makeChunk(1), makeChunk(2)],
    (line) => {
      const rec = JSON.parse(line);
      if (rec.type === "event") {
        assert.ok(rec.ledger > prevLedger, `expected strictly increasing ledger, got ${rec.ledger} after ${prevLedger}`);
        prevLedger = rec.ledger;
        emittedCount += 1;
      }
    },
    { dedupWindow: 64 },
  );

  assert.equal(summary.totals.events, perChunk * numChunks);
  assert.equal(emittedCount, perChunk * numChunks);
  // k-way merge only buffers 1 head item per chunk (at most numChunks + 1 in-flight)
  assert.ok(maxInFlight <= numChunks + 1, `expected bounded in-flight <= ${numChunks + 1}, got ${maxInFlight}`);
});

// ── File merging & CLI integration ───────────────────────────────────────────

test("runReplayCli --merge-chunks merges JSONL and mimir-replay-v1 JSON chunk files to --out", async () => {
  const dir = await createTempDataDir("replay-merge-");
  try {
    const jsonlChunkPath = path.join(dir, "chunk1.jsonl");
    const jsonChunkPath = path.join(dir, "chunk2.json");
    const outPath = path.join(dir, "merged.jsonl");

    const jsonlContent = [
      JSON.stringify({ type: "header", format: "mimir-replay-jsonl-v1", version: 1 }),
      JSON.stringify({ type: "event", ...makeEvent({ ledger: 10, eventId: "e-10", source: "market" }) }),
      JSON.stringify({ type: "event", ...makeEvent({ ledger: 30, eventId: "e-30", source: "market" }) }),
      JSON.stringify({ type: "summary", format: "mimir-replay-jsonl-v1", version: 1, totals: { events: 2, sent: 2, skipped: 0, capped: 0, adminLogged: 0, duplicates: 0 } }),
    ].join("\n") + "\n";

    const jsonReport = {
      format: "mimir-replay-v1",
      network: "testnet",
      rpcUrl: "https://example.invalid",
      fromLedger: 1,
      toLedger: 50,
      dryRun: true,
      targets: [
        {
          source: "squad",
          contractId: SQUAD_CONTRACT,
          fromLedger: 1,
          toLedger: 50,
          startLedger: 1,
          startClamped: false,
          pages: 1,
          events: 2,
          sent: 2,
          skipped: 0,
          capped: 0,
          adminLogged: 0,
          duplicates: 0,
          truncated: false,
          lastEventLedger: 30,
          cursor: null,
          eventLog: [
            makeEvent({ ledger: 20, eventId: "e-20", source: "squad", name: "deposited" }),
            makeEvent({ ledger: 30, eventId: "e-30", source: "market" }), // duplicate across chunks
          ],
        },
      ],
      totals: { events: 2, sent: 2, skipped: 0, capped: 0, adminLogged: 0, duplicates: 0 },
    };

    await writeFile(jsonlChunkPath, jsonlContent, "utf8");
    await writeFile(jsonChunkPath, JSON.stringify(jsonReport, null, 2) + "\n", "utf8");

    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay", "--merge-chunks", `${jsonlChunkPath},${jsonChunkPath}`, "--out", outPath],
      deps: { progress: () => {} },
    });

    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.totals.events, 3);
    assert.equal(report.totals.duplicates, 1);

    const outLines = (await readFile(outPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(outLines[0].type, "header");
    assert.deepEqual(
      outLines.filter((r) => r.type === "event").map((r) => r.eventId),
      ["e-10", "e-20", "e-30"],
    );
    assert.equal(outLines[outLines.length - 1].type, "summary");
  } finally {
    await dir.cleanup?.().catch(() => {});
  }
});

test("runReplayCli --jsonl streams events without buffering eventLog in memory", async () => {
  const server = makeServer(
    { oldestLedger: 100, latestLedger: 200 },
    {
      [MARKET_CONTRACT]: [
        {
          events: [rawEvent(110, MARKET_CONTRACT, 1), rawEvent(112, MARKET_CONTRACT, 2)],
          cursor: makeCursor(112, 2, 0),
          latestLedger: 200,
        },
      ],
    },
  );

  const streamedLines = [];
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay", "--from", "100", "--to", "200", "--contract", "market", "--jsonl"],
    deps: {
      config: {
        rpcUrl: "https://example.invalid",
        networkPassphrase: "Test SDF Network ; September 2015",
        marketContractId: MARKET_CONTRACT,
        squadContractId: SQUAD_CONTRACT,
      },
      server,
      progress: () => {},
      writeJsonl: (line) => {
        streamedLines.push(line);
      },
    },
  });

  assert.equal(exitCode, 0);
  assert.ok(report);
  // Bounded memory: eventLog is not accumulated in memory when streaming JSONL
  assert.equal(report.targets[0].eventLog.length, 0);

  const records = streamedLines.map((l) => JSON.parse(l));
  assert.equal(records[0].type, "header");
  assert.equal(records.filter((r) => r.type === "event").length, 2);
  assert.equal(records[records.length - 1].type, "summary");
});

// ── Boundary & failure cases ─────────────────────────────────────────────────

test("mergeReplayChunksToJsonl handles empty chunk list cleanly", async () => {
  const lines = [];
  const summary = await mergeReplayChunksToJsonl([], (l) => lines.push(l));
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, "header");
  assert.equal(JSON.parse(lines[1]).type, "summary");
  assert.equal(summary.totals.events, 0);
});

test("mergeReplayChunkFilesToJsonl fails cleanly on malformed JSONL line", async () => {
  const dir = await createTempDataDir("replay-merge-bad-");
  try {
    const badPath = path.join(dir, "bad.jsonl");
    await writeFile(badPath, '{"type":"event","ledger":10,"name":"x","source":"market"}\n{not-json}\n', "utf8");

    await assert.rejects(
      () => mergeReplayChunkFilesToJsonl([badPath], () => {}),
      /malformed JSON in replay chunk/,
    );
  } finally {
    await dir.cleanup?.().catch(() => {});
  }
});

test("runReplayCli rejects invalid flag combinations for --jsonl and --merge-chunks", async () => {
  const r1 = await runReplayCli({
    argv: ["node", "replay", "--from", "100", "--json", "--jsonl"],
    deps: { progress: () => {} },
  });
  assert.equal(r1.exitCode, 2);

  const r2 = await runReplayCli({
    argv: ["node", "replay", "--merge-chunks", "a.jsonl", "--json"],
    deps: { progress: () => {} },
  });
  assert.equal(r2.exitCode, 2);

  const r3 = await runReplayCli({
    argv: ["node", "replay", "--merge-chunks", "a.jsonl", "--dedup-window", "-5"],
    deps: { progress: () => {} },
  });
  assert.equal(r3.exitCode, 2);
});
