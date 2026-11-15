/**
 * Focused tests for atomic bulk acknowledgement of inspected dead-letter entries (#769).
 */

import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import test from "node:test";

import {
  createDeadLetterQueue,
  DEAD_LETTER_MAX_ACK_IDS,
  DeadLetterAckLimitError,
} from "../dist/deadLetter.js";
import { acknowledgeDeadLetters, runDlqCli } from "../dist/dlq-cli.js";
import { redactChatId } from "../dist/status.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const RAW_CHAT_ID = "-1009876543210";
const REDACTED_CHAT_ID = redactChatId(RAW_CHAT_ID);

test("acknowledge atomically removes valid IDs, preserves unmatched metadata, and reports notFoundIds", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    let clock = 1_700_000_000_000;
    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 50,
      maxAttempts: 10,
      now: () => clock,
      quiet: true,
    });

    const first = await queue.enqueue({
      source: "market",
      ledger: 101,
      eventName: "claim_created",
      text: "Claim #1",
      error: "429 retry after 5",
    });
    clock += 5_000;
    const second = await queue.enqueue({
      source: "squad",
      ledger: 102,
      eventName: "market_resolved",
      text: "Squad #2",
      error: "502 bad gateway",
    });
    // Bump attempts on `second` so we verify unmatched attempt metadata stays untouched.
    await queue.enqueue({
      source: "squad",
      ledger: 102,
      eventName: "market_resolved",
      text: "Squad #2",
      error: "503 unavailable",
    });
    clock += 5_000;
    const third = await queue.enqueue({
      source: "market",
      ledger: 103,
      eventName: "market_settled",
      text: "Settled #3",
      error: "timeout",
    });

    const beforeSecond = queue.snapshot().find((e) => e.id === second.id);
    assert.equal(beforeSecond?.attempts, 2);

    // Dry-run leaves disk and memory untouched.
    const beforeRaw = await readFile(filePath, "utf8");
    const dryRes = await queue.acknowledge(
      [third.id, first.id, first.id, "market:999:missing:deadbeef"],
      { dryRun: true },
    );
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.acknowledged, 2);
    assert.deepEqual(dryRes.acknowledgedIds, [third.id, first.id]);
    assert.deepEqual(dryRes.notFoundIds, ["market:999:missing:deadbeef"]);
    assert.equal(dryRes.remaining, 1);
    assert.equal(await readFile(filePath, "utf8"), beforeRaw);
    assert.equal(queue.snapshot().length, 3);

    // Atomic commit removes matched entries, leaves no .tmp file, and preserves `second` unchanged.
    clock += 10_000;
    const res = await queue.acknowledge([
      `  ${first.id}  `,
      "market:999:missing:deadbeef",
      third.id,
    ]);
    assert.equal(res.dryRun, false);
    assert.equal(res.acknowledged, 2);
    assert.deepEqual(res.acknowledgedIds, [first.id, third.id]);
    assert.deepEqual(res.notFoundIds, ["market:999:missing:deadbeef"]);
    assert.equal(res.remaining, 1);
    await assert.rejects(() => stat(`${filePath}.tmp`));

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.entries.length, 1);
    assert.deepEqual(persisted.entries[0], beforeSecond);
  }, "mimir-dlq-ack-");
});

test("acknowledge enforces explicit ID bounds and rolls back in-memory state if atomic write fails", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 10,
      quiet: true,
    });
    const entry = await queue.enqueue({
      source: "market",
      ledger: 201,
      eventName: "claim_created",
      text: "Claim #201",
      error: "network error",
    });

    await assert.rejects(
      () => queue.acknowledge([]),
      (err) => err instanceof DeadLetterAckLimitError && /at least one/.test(err.message),
    );
    await assert.rejects(
      () => queue.acknowledge(["   ", ""]),
      (err) => err instanceof DeadLetterAckLimitError,
    );

    const tooManyIds = Array.from(
      { length: DEAD_LETTER_MAX_ACK_IDS + 1 },
      (_, idx) => `market:${idx}:evt:00000000`,
    );
    await assert.rejects(
      () => queue.acknowledge(tooManyIds),
      (err) =>
        err instanceof DeadLetterAckLimitError &&
        err.message.includes(`at most ${DEAD_LETTER_MAX_ACK_IDS}`),
    );

    // Block `${filePath}.tmp` with a directory so writeAtomicSnapshot fails mid-flight.
    const originalRaw = await readFile(filePath, "utf8");
    await mkdir(`${filePath}.tmp`);

    await assert.rejects(() => queue.acknowledge([entry.id]));
    assert.equal(
      await readFile(filePath, "utf8"),
      originalRaw,
      "failed atomic write must leave original dead-letter file intact",
    );
    assert.equal(
      queue.snapshot().length,
      1,
      "failed atomic write must not drop entry from in-memory queue",
    );
  }, "mimir-dlq-ack-bounds-");
});

test("dlq CLI ack subcommand supports --dry-run, --json, redaction, and exit code 2 on bound violations", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 10,
      quiet: true,
    });
    const a = await queue.enqueue({
      source: "market",
      ledger: 301,
      eventName: "claim_created",
      text: `Alert A for ${RAW_CHAT_ID}`,
      error: "429",
    });
    const b = await queue.enqueue({
      source: "squad",
      ledger: 302,
      eventName: "deposited",
      text: "Alert B",
      error: "500",
    });

    const stdout = [];
    const stderr = [];
    const dryCli = await runDlqCli({
      argv: [
        "ack",
        a.id,
        "unknown:1:evt:00000000",
        "--dry-run",
        "--json",
        "--file",
        filePath,
        "--chat-id",
        RAW_CHAT_ID,
      ],
      stdout: (l) => stdout.push(l),
      stderr: (l) => stderr.push(l),
    });
    assert.equal(dryCli.exitCode, 0);
    assert.equal(stderr.length, 0);
    const dryJson = stdout.join("\n");
    assert.equal(dryJson.includes(RAW_CHAT_ID), false);
    const parsedDry = JSON.parse(dryJson);
    assert.equal(parsedDry.dryRun, true);
    assert.equal(parsedDry.acknowledged, 1);
    assert.equal(parsedDry.remaining, 1);
    assert.equal(parsedDry.chatId, REDACTED_CHAT_ID);

    // Commit via CLI
    const commitOut = [];
    const commitCli = await runDlqCli({
      argv: ["ack", a.id, "--file", filePath, "--chat-id", RAW_CHAT_ID],
      stdout: (l) => commitOut.push(l),
      stderr: (l) => stderr.push(l),
    });
    assert.equal(commitCli.exitCode, 0);
    assert.match(commitOut.join("\n"), /acknowledged 1 entry\(s\), 1 remaining/);

    const after = await acknowledgeDeadLetters({
      filePath,
      ids: [b.id],
      dryRun: true,
      chatId: RAW_CHAT_ID,
    });
    assert.equal(after.acknowledged, 1);
    assert.equal(after.remaining, 0);

    // Missing IDs and oversized ID lists exit 2
    const errOut = [];
    const missingCli = await runDlqCli({
      argv: ["ack", "--file", filePath],
      stdout: () => {},
      stderr: (l) => errOut.push(l),
    });
    assert.equal(missingCli.exitCode, 2);

    const overBoundIds = Array.from(
      { length: DEAD_LETTER_MAX_ACK_IDS + 1 },
      (_, idx) => `id-${idx}`,
    );
    const overBoundCli = await runDlqCli({
      argv: ["ack", ...overBoundIds, "--file", filePath],
      stdout: () => {},
      stderr: (l) => errOut.push(l),
    });
    assert.equal(overBoundCli.exitCode, 2);
  }, "mimir-dlq-ack-cli-");
});
