import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeadLetterQueue,
  defaultRecoveryCheckpointPath,
  loadRecoveryCheckpoint,
  saveRecoveryCheckpoint,
} from "../dist/deadLetter.js";
import { recoverDeadLetterSelection, runDlqCli } from "../dist/dlq-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

test("recoverSelection persists checkpoint on interruption and resumes selection without reprocessing acknowledged entries", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const checkpointFile = defaultRecoveryCheckpointPath(filePath);
    let clock = 1_700_000_000_000;

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 5,
      now: () => clock,
    });
    await queue.load();

    const e1 = await queue.enqueue({
      source: "market",
      ledger: 101,
      eventName: "claim_created",
      text: "msg-101",
      error: "Telegram 429",
    });
    const e2 = await queue.enqueue({
      source: "market",
      ledger: 102,
      eventName: "claim_challenged",
      text: "msg-102",
      error: "Telegram 429",
    });
    const e3 = await queue.enqueue({
      source: "squad",
      ledger: 103,
      eventName: "deposited",
      text: "msg-103",
      error: "Telegram 429",
    });
    const e4 = await queue.enqueue({
      source: "squad",
      ledger: 104,
      eventName: "withdrawn",
      text: "msg-104-unselected",
      error: "Telegram 429",
    });

    // Select only [e1, e2, e3]; interrupt via AbortController after e1 & e2 succeed.
    const abortController = new AbortController();
    const sentRun1 = [];
    const run1 = await queue.recoverSelection({
      ids: [e1.id, e2.id, e3.id],
      signal: abortController.signal,
      send: async (_text, entry) => {
        sentRun1.push(entry.id);
        clock += 1_000;
        if (sentRun1.length === 2) {
          abortController.abort();
        }
      },
    });

    assert.equal(run1.resumed, false);
    assert.equal(run1.interrupted, true);
    assert.equal(run1.acknowledged, 2);
    assert.equal(run1.remainingSelected, 1);
    assert.equal(run1.remainingQueue, 2); // e3 (pending selected) + e4 (unselected)
    assert.deepEqual(sentRun1, [e1.id, e2.id]);
    assert.equal(existsSync(checkpointFile), true);

    const cpOnDisk = await loadRecoveryCheckpoint(checkpointFile);
    assert.ok(cpOnDisk);
    assert.equal(cpOnDisk.interrupted, true);
    assert.deepEqual(cpOnDisk.acknowledgedIds, [e1.id, e2.id]);
    assert.deepEqual(cpOnDisk.selectedIds, [e1.id, e2.id, e3.id]);

    // CLI `checkpoint --json` inspects active recovery checkpoint offline
    const cliOut = [];
    const cliRes = await runDlqCli({
      argv: ["checkpoint", "--file", filePath, "--json"],
      stdout: (line) => cliOut.push(line),
      stderr: () => {},
    });
    assert.equal(cliRes.exitCode, 0);
    const parsedCli = JSON.parse(cliOut.join("\n"));
    assert.equal(parsedCli.checkpoint.acknowledgedIds.length, 2);

    // Resume on a fresh process/queue without re-specifying ids: sends ONLY e3, keeps e4 untouched, clears checkpoint!
    const sentRun2 = [];
    const run2 = await recoverDeadLetterSelection({
      filePath,
      now: () => clock,
      send: async (_text, entry) => {
        sentRun2.push(entry.id);
      },
    });

    assert.equal(run2.resumed, true);
    assert.equal(run2.interrupted, false);
    assert.equal(run2.acknowledged, 1);
    assert.deepEqual(sentRun2, [e3.id]);
    assert.equal(run2.remainingSelected, 0);
    assert.equal(run2.remainingQueue, 1);
    assert.equal(existsSync(checkpointFile), false);

    // Verify e4 (unselected) remained safely in queue
    const verifyQueue = createDeadLetterQueue({ filePath, maxEntries: 20, maxAttempts: 5 });
    await verifyQueue.load();
    assert.deepEqual(
      verifyQueue.snapshot().map((e) => e.id),
      [e4.id],
    );
  });
});

test("recoverSelection skips entries already recorded in acknowledgedIds after an unpersisted queue crash", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const checkpointFile = defaultRecoveryCheckpointPath(filePath);

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
    });
    await queue.load();
    const e1 = await queue.enqueue({
      source: "market",
      ledger: 201,
      eventName: "claim_created",
      text: "already-sent-before-crash",
      error: "Telegram 429",
    });
    const e2 = await queue.enqueue({
      source: "market",
      ledger: 202,
      eventName: "claim_created",
      text: "needs-send-after-crash",
      error: "Telegram 429",
    });

    // Simulate crash after e1 was sent & checkpointed, before dead-letter.json dropped e1
    await saveRecoveryCheckpoint(checkpointFile, {
      version: 1,
      updatedAt: "2026-10-18T15:00:00.000Z",
      selectedIds: [e1.id, e2.id],
      acknowledgedIds: [e1.id],
      lastProcessedId: e1.id,
      interrupted: true,
    });

    const resent = [];
    const resumedQueue = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_010_000,
    });
    await resumedQueue.load();
    const res = await resumedQueue.recoverSelection({
      send: async (_text, entry) => {
        resent.push(entry.id);
      },
    });

    assert.equal(res.resumed, true);
    assert.equal(res.skippedAcknowledged, 1);
    assert.equal(res.acknowledged, 1);
    assert.deepEqual(resent, [e2.id]);
    assert.equal(resumedQueue.stats().depth, 0);
    assert.equal(existsSync(checkpointFile), false);
  });
});

test("checkpoint enforces bounded ID limits, tolerates corrupt checkpoint files, and supports --clear", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const checkpointFile = defaultRecoveryCheckpointPath(filePath);

    await saveRecoveryCheckpoint(
      checkpointFile,
      {
        version: 1,
        updatedAt: "2026-10-18T15:00:00.000Z",
        selectedIds: Array.from({ length: 25 }, (_, i) => `id-${i}`),
        acknowledgedIds: Array.from({ length: 25 }, (_, i) => `ack-${i}`),
        lastProcessedId: "ack-24",
        interrupted: true,
      },
      10,
    );

    const bounded = await loadRecoveryCheckpoint(checkpointFile, 10);
    assert.ok(bounded);
    assert.equal(bounded.selectedIds.length, 10);
    assert.equal(bounded.acknowledgedIds.length, 10);
    assert.equal(bounded.selectedIds[9], "id-24");

    // Clear via CLI
    const clearOut = [];
    const clearRes = await runDlqCli({
      argv: ["checkpoint", "--file", filePath, "--clear"],
      stdout: (line) => clearOut.push(line),
      stderr: () => {},
    });
    assert.equal(clearRes.exitCode, 0);
    assert.equal(existsSync(checkpointFile), false);

    // Corrupt checkpoint file returns null instead of throwing
    await writeFile(checkpointFile, "{corrupt-checkpoint", "utf8");
    assert.equal(await loadRecoveryCheckpoint(checkpointFile), null);
  });
});
