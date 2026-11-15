/**
 * Focused coverage for duplicate dead-letter identifier rejection (#772).
 *
 * Verifies:
 *   - `validateDeadLetterFile` detects conflicting entries sharing the same ID.
 *   - `createDeadLetterQueue` preserves the conflicting source file byte-for-byte
 *     on disk across `load`, `enqueue`, and `flush` rather than silently overwriting.
 *   - `dlq` CLI (`validate`, `list`, `show`, and `purge --yes`) rejects duplicate
 *     IDs with exit code 1 and leaves the source file untouched.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeadLetterQueue,
  DuplicateDeadLetterIdError,
  validateDeadLetterFile,
} from "../dist/deadLetter.js";
import { runDlqCli } from "../dist/dlq-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const DUPLICATE_ID = "market:500:claim_created:deadbeef";

function conflictingPayload() {
  return `${JSON.stringify(
    {
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          id: DUPLICATE_ID,
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          source: "market",
          ledger: 500,
          eventName: "claim_created",
          text: "first body",
          attempts: 1,
          lastError: "Telegram 429",
        },
        {
          id: DUPLICATE_ID,
          enqueuedAt: "2026-01-01T00:01:00.000Z",
          source: "squad",
          ledger: 501,
          eventName: "claim_cancelled",
          text: "conflicting second body",
          attempts: 3,
          lastError: "Telegram 503",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

test("validateDeadLetterFile rejects duplicate identifiers with DuplicateDeadLetterIdError", () => {
  const raw = conflictingPayload();
  assert.throws(
    () => validateDeadLetterFile(raw, { filePath: "dead-letter.json" }),
    (err) => {
      assert.equal(err instanceof DuplicateDeadLetterIdError, true);
      assert.deepEqual(err.duplicateIds, [DUPLICATE_ID]);
      assert.match(err.message, /duplicate dead-letter entry id\(s\)/);
      return true;
    },
  );
});

test("queue preserves conflicting source file across load, enqueue, and flush without overwriting", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const originalRaw = conflictingPayload();
    await writeFile(filePath, originalRaw, "utf8");

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
      quiet: true,
    });

    await queue.load();
    assert.ok(queue.validationConflict() instanceof DuplicateDeadLetterIdError);
    assert.equal(queue.stats().depth, 0);

    // Subsequent enqueues and flushes work in memory without crashing the poller,
    // while keeping the conflicting source file byte-for-byte intact on disk.
    await queue.enqueue({
      source: "market",
      ledger: 600,
      eventName: "claim_created",
      text: "in-memory park during conflict",
      error: new Error("Telegram 429"),
    });
    assert.equal(queue.stats().depth, 1);

    await queue.flush(async () => undefined, 5);
    assert.equal(queue.stats().depth, 0);

    const afterRaw = await readFile(filePath, "utf8");
    assert.equal(afterRaw, originalRaw, "conflicting source file must not be overwritten");
  }, "mimir-dlq-dup-");
});

test("dlq CLI validate, list, show, and purge --yes reject duplicate IDs and preserve source file", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const originalRaw = conflictingPayload();
    await writeFile(filePath, originalRaw, "utf8");

    for (const argv of [
      ["validate", "--file", filePath],
      ["list", "--file", filePath],
      ["show", DUPLICATE_ID, "--file", filePath],
      ["purge", "--yes", "--file", filePath],
    ]) {
      const stdout = [];
      const stderr = [];
      const { exitCode } = await runDlqCli({
        argv,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });
      assert.equal(exitCode, 1, `expected exit 1 for ${argv.join(" ")}`);
      assert.equal(stdout.length, 0);
      assert.match(stderr.join("\n"), /duplicate dead-letter entry id/);
      assert.equal(await readFile(filePath, "utf8"), originalRaw);
    }

    // Once resolved to unique IDs, `dlq validate --json` succeeds cleanly.
    const cleanPayload = JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      entries: [
        {
          id: DUPLICATE_ID,
          enqueuedAt: "2026-01-01T00:00:00.000Z",
          source: "market",
          ledger: 500,
          eventName: "claim_created",
          text: "unique body",
          attempts: 1,
          lastError: "Telegram 429",
        },
      ],
    });
    await writeFile(filePath, cleanPayload, "utf8");

    const okOut = [];
    const okErr = [];
    const okRes = await runDlqCli({
      argv: ["validate", "--file", filePath, "--json"],
      stdout: (line) => okOut.push(line),
      stderr: (line) => okErr.push(line),
    });
    assert.equal(okRes.exitCode, 0);
    assert.equal(okErr.length, 0);
    assert.deepEqual(JSON.parse(okOut.join("\n")), {
      valid: true,
      file: filePath,
      entries: 1,
    });
  }, "mimir-dlq-dup-cli-");
});
