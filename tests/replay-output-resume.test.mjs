/**
 * Tests for Issue #788: resume historical replay after an interrupted output write.
 *
 * Covered:
 *   - Checkpoints the last fully committed output record on mid-record write interruption
 *   - Repairs torn trailing bytes on resume without truncating or duplicating committed output
 *   - Reconciles complete committed output records written ahead of progress.json (crash window)
 *   - Preserves notification idempotency when --send succeeded right before output write failed
 *   - Rejects truncated/missing output files, unrecognized output files, mismatched --output paths,
 *     and --output === --progress-file collisions without clobbering existing bytes
 */

import assert from "node:assert/strict";
import { appendFile, readFile, unlink, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  inspectAndRecoverOutputFile,
  runReplayCli,
} from "../dist/stellar/replay.js";
import {
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimCreatedEvent,
  claimResolvedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeBotConfig(overrides = {}) {
  return {
    botToken: "fake-bot",
    telegramChatId: "-1001234567890",
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://fake-rpc.invalid",
    horizonUrl: "http://fake-horizon.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    maxNotificationsPerCycle: 20,
    dedupWindow: 256,
    ...overrides,
  };
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

function parseJsonl(raw) {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("resumes cleanly after a mid-record torn output write without truncating or duplicating committed records", async () => {
  await withTempDataDir(async (tmp) => {
    const outputFile = tmp.file("replay-out.jsonl");
    const progressFile = tmp.file("progress.json");

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4150, 1);
    const c3 = makeCursor(4200, 1);
    const c4 = makeCursor(4250, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 1, id: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4150, claimId: 2, id: c2 });
    const ev3 = claimResolvedEvent({ ledger: 4200, claimId: 1, id: c3 });
    const ev4 = claimResolvedEvent({ ledger: 4250, claimId: 2, id: c4 });

    const health = { oldestLedger: 4000, latestLedger: 5000 };
    let writeCalls = 0;

    // Run 1: commits ev1 & ev2, then writes a 42-byte torn fragment of ev3 (no newline) and throws EIO
    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1, ev2, ev3, ev4], cursor: c4, latestLedger: 5000 }],
        }),
        appendOutputRecord: async (filePath, serializedLine) => {
          writeCalls += 1;
          if (writeCalls === 3) {
            const tornFragment = serializedLine.slice(0, 42);
            await appendFile(filePath, tornFragment, "utf8");
            const ioErr = new Error("EIO: simulated disk write interruption");
            ioErr.code = "EIO";
            throw ioErr;
          }
          await appendFile(filePath, serializedLine, "utf8");
        },
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, 1);

    const savedAfterCrash = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(savedAfterCrash.output.committedRecords, 2);
    assert.equal(savedAfterCrash.output.lastCommittedSequence, 2);
    assert.equal(savedAfterCrash.output.lastCommittedEventId, c2);
    assert.equal(savedAfterCrash.targets.market.eventsProcessed, 2);
    assert.equal(savedAfterCrash.targets.market.completed, false);

    const rawAfterCrash = await readFile(outputFile);
    assert.equal(rawAfterCrash.length, savedAfterCrash.output.committedBytes + 42);
    const committedPrefixBeforeResume = rawAfterCrash.subarray(
      0,
      savedAfterCrash.output.committedBytes,
    );

    // Run 2: resume with normal writer — must repair ONLY the 42 torn bytes and append ev3 & ev4
    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1, ev2, ev3, ev4], cursor: "", latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(run2.report.output.repairedTrailingBytes, 42);
    assert.equal(run2.report.output.committedRecords, 4);
    assert.equal(run2.report.totals.events, 4);
    assert.equal(run2.report.totals.sent, 4);
    assert.equal(run2.report.totals.resumedSkippedEvents, 2);

    const finalRaw = await readFile(outputFile);
    assert.deepEqual(
      finalRaw.subarray(0, committedPrefixBeforeResume.length),
      committedPrefixBeforeResume,
      "already-committed output prefix must remain byte-for-byte identical",
    );

    const records = parseJsonl(finalRaw.toString("utf8"));
    assert.deepEqual(
      records.map((r) => ({ seq: r.sequence, id: r.eventId })),
      [
        { seq: 1, id: c1 },
        { seq: 2, id: c2 },
        { seq: 3, id: c3 },
        { seq: 4, id: c4 },
      ],
    );
  });
});

test("reconciles complete committed output records written ahead of progress.json before a hard crash", async () => {
  await withTempDataDir(async (tmp) => {
    const outputFile = tmp.file("ahead.jsonl");
    const progressFile = tmp.file("progress.json");

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const c3 = makeCursor(4300, 1);
    const c4 = makeCursor(4400, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 11, id: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 12, id: c2 });
    const ev3 = claimCreatedEvent({ ledger: 4300, claimId: 13, id: c3 });
    const ev4 = claimCreatedEvent({ ledger: 4400, claimId: 14, id: c4 });
    const health = { oldestLedger: 4000, latestLedger: 5000 };

    // Step 1: complete page 1 (ev1, ev2) cleanly via --pages 1
    const page1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--pages",
        "1",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1, ev2], cursor: c2, latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });
    assert.equal(page1.exitCode, 0);

    // Simulate a subsequent process that wrote ev3 completely (\n-terminated) plus a torn fragment of ev4
    // and received SIGKILL before progress.json could be updated beyond committedRecords=2.
    const committedEv3 = {
      format: "mimir-replay-output-v1",
      sequence: 3,
      source: "market",
      contractId: MARKET_CONTRACT,
      ledger: 4300,
      txHash: ev3.txHash,
      eventId: c3,
      dedupKey: c3,
      name: "claim_created",
      sent: true,
      skipped: false,
    };
    await appendFile(
      outputFile,
      `${JSON.stringify(committedEv3)}\n{"format":"mimir-replay-output-v1","sequence":4`,
      "utf8",
    );

    // Resume from page 2 ([ev2, ev3, ev4]): ev3 must NOT be truncated OR duplicated!
    const resumed = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev2, ev3, ev4], cursor: "", latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });

    assert.equal(resumed.exitCode, 0);
    assert.ok(resumed.report.output.repairedTrailingBytes > 0);
    assert.equal(resumed.report.output.committedRecords, 4);
    assert.equal(resumed.report.totals.events, 4);
    assert.equal(resumed.report.totals.sent, 4);

    const records = parseJsonl(await readFile(outputFile, "utf8"));
    assert.deepEqual(
      records.map((r) => ({ seq: r.sequence, id: r.eventId })),
      [
        { seq: 1, id: c1 },
        { seq: 2, id: c2 },
        { seq: 3, id: c3 },
        { seq: 4, id: c4 },
      ],
    );
  });
});

test("in --send mode, an output write failure after send() checkpoints delivery so resume commits output without re-sending", async () => {
  await withTempDataDir(async (tmp) => {
    const outputFile = tmp.file("send-out.jsonl");
    const progressFile = tmp.file("progress.json");

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const c3 = makeCursor(4300, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 21, id: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 22, id: c2 });
    const ev3 = claimCreatedEvent({ ledger: 4300, claimId: 23, id: c3 });
    const health = { oldestLedger: 4000, latestLedger: 5000 };

    const sentTexts = [];
    let writeAttempt = 0;

    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--send",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1, ev2, ev3], cursor: c3, latestLedger: 5000 }],
        }),
        send: async (text) => {
          sentTexts.push(text);
        },
        appendOutputRecord: async (filePath, serializedLine) => {
          writeAttempt += 1;
          if (writeAttempt === 2) {
            throw new Error("ENOSPC: no space left on device");
          }
          await appendFile(filePath, serializedLine, "utf8");
        },
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, 1);
    assert.equal(sentTexts.length, 2, "ev1 and ev2 were sent before ev2's output write failed");

    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--send",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1, ev2, ev3], cursor: "", latestLedger: 5000 }],
        }),
        send: async (text) => {
          sentTexts.push(text);
        },
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(sentTexts.length, 3, "ev2 must not be re-sent on resume; only ev3 is newly sent");

    const records = parseJsonl(await readFile(outputFile, "utf8"));
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((r) => r.eventId), [c1, c2, c3]);
  });
});

test("rejects missing, externally truncated, unrecognized, or colliding output files without destroying existing data", async () => {
  await withTempDataDir(async (tmp) => {
    const outputFile = tmp.file("out.jsonl");
    const progressFile = tmp.file("progress.json");
    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 31, id: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 32, id: c2 });
    const health = { oldestLedger: 4000, latestLedger: 5000 };

    // 1. Collision check (--output === --progress-file) preserves existing file bytes
    const sharedFile = tmp.file("shared.json");
    await writeFile(sharedFile, '{"keep":"me"}\n', "utf8");
    const collision = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--output",
        sharedFile,
        "--progress-file",
        sharedFile,
      ],
      deps: { config: fakeBotConfig(), progress: () => {} },
    });
    assert.equal(collision.exitCode, 2);
    assert.equal(await readFile(sharedFile, "utf8"), '{"keep":"me"}\n');

    // 2. Unrecognized existing content in --output when resuming with --progress-file is preserved
    const foreignOut = tmp.file("foreign.txt");
    await writeFile(foreignOut, "not jsonl content\n", "utf8");
    const foreignRun = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--output",
        foreignOut,
        "--progress-file",
        tmp.file("foreign-progress.json"),
      ],
      deps: { config: fakeBotConfig(), server: makeServer(health, {}), progress: () => {} },
    });
    assert.equal(foreignRun.exitCode, 2);
    assert.equal(await readFile(foreignOut, "utf8"), "not jsonl content\n");

    // 3. Create a valid 2-record checkpoint, then test missing --output flag and truncated/deleted output file
    const okRun = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--pages",
        "1",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1, ev2], cursor: c2, latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });
    assert.equal(okRun.exitCode, 0);

    // Missing --output flag when progress file tracks output
    const missingFlag = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "5000", "--contract", "market", "--progress-file", progressFile],
      deps: { config: fakeBotConfig(), server: makeServer(health, {}), progress: () => {} },
    });
    assert.equal(missingFlag.exitCode, 2);

    // Externally truncated output file (1 record instead of checkpointed 2)
    const lines = (await readFile(outputFile, "utf8")).trim().split("\n");
    await writeFile(outputFile, `${lines[0]}\n`, "utf8");
    const truncatedRun = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: makeServer(health, {}), progress: () => {} },
    });
    assert.equal(truncatedRun.exitCode, 2);
    assert.equal(await readFile(outputFile, "utf8"), `${lines[0]}\n`);

    // Deleted output file while checkpoint has committedRecords=2
    await unlink(outputFile);
    await assert.rejects(
      () =>
        inspectAndRecoverOutputFile(outputFile, {
          path: outputFile,
          committedRecords: 2,
          committedBytes: 200,
          lastCommittedSequence: 2,
          lastCommittedEventId: c2,
          lastCommittedSource: "market",
          lastCommittedLedger: 4200,
        }),
      /missing, expected 2 committed record/,
    );
  });
});
