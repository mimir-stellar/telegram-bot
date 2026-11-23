/**
 * Tests for the `replay` subcommand of src/dlq-cli.ts (issue #767).
 *
 * Verifies:
 *   - Dry-run: no Telegram requests and no queue mutations.
 *   - Entry counts and eligibility reasons grouped by destination.
 *   - Ineligible entries (exhausted attempts) are classified separately.
 *   - An empty queue produces a zero-entry plan.
 *   - JSON output contains the expected structure.
 *   - `--yes` is rejected (replay is always a dry-run plan).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDeadLetterQueue } from "../dist/deadLetter.js";
import { makeEntryId } from "../dist/deadLetter.js";
import { planReplay, runDlqCli } from "../dist/dlq-cli.js";

const RAW_CHAT_ID = "-1001234567890";

async function withTempDlq(run, seedEntries = [], opts = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-replay-"));
  const filePath = path.join(directory, "dead-letter.json");
  let clock = 1_700_000_000_000;

  try {
    if (seedEntries.length > 0) {
      const queue = createDeadLetterQueue({
        filePath,
        maxEntries: opts.maxEntries ?? 50,
        maxAttempts: opts.maxAttempts ?? 5,
        now: () => clock,
      });
      await queue.load();
      for (const item of seedEntries) {
        if (typeof item.at === "number") clock = item.at;
        await queue.enqueue({
          source: item.source ?? "market",
          ledger: item.ledger,
          eventName: item.eventName ?? "claim_created",
          text: item.text ?? `Notification @ ledger ${item.ledger}`,
          error: item.error ?? `Telegram 429 for chat ${RAW_CHAT_ID}`,
        });
      }
    }
    return await run({ directory, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/**
 * Write a queue JSON file directly with hand-crafted entries, so we can
 * set arbitrary attempt counts without going through the flush/drop logic.
 */
async function withRawQueue(run, rawEntries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-replay-raw-"));
  const filePath = path.join(directory, "dead-letter.json");
  try {
    const entries = rawEntries.map((item) => ({
      id: makeEntryId(item.source ?? "market", item.ledger, item.eventName ?? "claim_created", item.text ?? `msg-${item.ledger}`),
      enqueuedAt: item.enqueuedAt ?? "2026-01-01T00:00:00.000Z",
      source: item.source ?? "market",
      ledger: item.ledger,
      eventName: item.eventName ?? "claim_created",
      text: item.text ?? `msg-${item.ledger}`,
      attempts: item.attempts ?? 1,
      lastError: item.lastError ?? "Telegram 429",
    }));
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", entries }, null, 2) + "\n",
      "utf8",
    );
    return await run({ directory, filePath });
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function captureIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

// ── Dry-run guarantee ─────────────────────────────────────────────────────────

test("replay plan: no queue mutations and no file changes", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const before = await readFile(filePath, "utf8");

      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["replay", "--file", filePath, "--chat-id", RAW_CHAT_ID],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      assert.equal(io.stderr.length, 0);

      // File must be byte-identical: replay never mutates the queue.
      const after = await readFile(filePath, "utf8");
      assert.equal(after, before, "replay must not modify the queue file");
    },
    [
      { ledger: 10, eventName: "claim_created" },
      { ledger: 20, eventName: "market_resolved", source: "squad" },
    ],
  );
});

// ── Eligibility counts ────────────────────────────────────────────────────────

test("replay plan: eligible entries have attempts < maxAttempts", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const plan = await planReplay({
        filePath,
        chatId: RAW_CHAT_ID,
        maxAttempts: 5,
      });

      assert.equal(plan.dryRun, true);
      assert.equal(plan.total, 2);
      // Both entries started at 1 attempt, well under maxAttempts=5.
      assert.equal(plan.eligibleCount, 2);
      assert.equal(plan.ineligibleCount, 0);

      for (const dest of plan.destinations) {
        for (const e of dest.eligible) {
          assert.ok(e.eligible, "eligible flag must be true");
          assert.match(e.reason, /remaining/);
        }
      }
    },
    [
      { ledger: 10, eventName: "claim_created", source: "market" },
      { ledger: 11, eventName: "market_resolved", source: "market" },
    ],
  );
});

test("replay plan: exhausted entries are classified as ineligible", async () => {
  // Write entries directly so we can set arbitrary attempt counts.
  // With maxAttempts=3: attempts < 3 → eligible, attempts >= 3 → ineligible.
  await withRawQueue(
    async ({ filePath }) => {
      const plan = await planReplay({
        filePath,
        chatId: RAW_CHAT_ID,
        maxAttempts: 3,
      });

      assert.equal(plan.total, 3);
      // ledger 10: 1 attempt (eligible), ledger 20: 3 attempts = maxAttempts (ineligible),
      // ledger 30: 2 attempts (eligible).
      assert.equal(plan.eligibleCount, 2);
      assert.equal(plan.ineligibleCount, 1);

      const allIneligible = plan.destinations.flatMap((d) => d.ineligible);
      assert.equal(allIneligible.length, 1);
      assert.equal(allIneligible[0].ledger, 20);
      assert.ok(!allIneligible[0].eligible);
      assert.match(allIneligible[0].reason, /exhausted/);

      const allEligible = plan.destinations.flatMap((d) => d.eligible);
      assert.equal(allEligible.length, 2);
      for (const e of allEligible) {
        assert.ok(e.eligible);
        assert.match(e.reason, /remaining/);
      }
    },
    [
      { ledger: 10, source: "market", eventName: "claim_created", attempts: 1 },
      { ledger: 20, source: "market", eventName: "market_resolved", attempts: 3 },
      { ledger: 30, source: "market", eventName: "claim_cancelled", attempts: 2 },
    ],
  );
});

// ── Grouping by destination ───────────────────────────────────────────────────

test("replay plan: entries grouped by destination (source-derived chat)", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const plan = await planReplay({
        filePath,
        chatId: RAW_CHAT_ID,
        maxAttempts: 10,
      });

      // All seeded entries use the same explicit chatId so they collapse into
      // one destination group.
      assert.equal(plan.destinations.length, 1);
      assert.equal(plan.destinations[0].eligible.length, 3);
    },
    [
      { ledger: 1, source: "market" },
      { ledger: 2, source: "market" },
      { ledger: 3, source: "market" },
    ],
  );
});

// ── Empty queue ───────────────────────────────────────────────────────────────

test("replay plan on empty queue produces zero counts", async () => {
  await withTempDlq(async ({ filePath }) => {
    const plan = await planReplay({ filePath, chatId: RAW_CHAT_ID });

    assert.equal(plan.dryRun, true);
    assert.equal(plan.total, 0);
    assert.equal(plan.eligibleCount, 0);
    assert.equal(plan.ineligibleCount, 0);
    assert.deepEqual(plan.destinations, []);

    const io = captureIo();
    const { exitCode } = await runDlqCli({
      argv: ["replay", "--file", filePath],
      stdout: io.out,
      stderr: io.err,
    });
    assert.equal(exitCode, 0);
    assert.match(io.stdout.join("\n"), /0 entries/);
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

test("replay plan --json emits valid JSON with destinations array", async () => {
  await withTempDlq(
    async ({ filePath }) => {
      const io = captureIo();
      const { exitCode } = await runDlqCli({
        argv: ["replay", "--file", filePath, "--json"],
        stdout: io.out,
        stderr: io.err,
      });

      assert.equal(exitCode, 0);
      const parsed = JSON.parse(io.stdout.join("\n"));
      assert.equal(parsed.dryRun, true);
      assert.equal(typeof parsed.total, "number");
      assert.equal(typeof parsed.eligibleCount, "number");
      assert.equal(typeof parsed.ineligibleCount, "number");
      assert.ok(Array.isArray(parsed.destinations));
      assert.equal(parsed.destinations.length, 1);
      assert.equal(typeof parsed.destinations[0].chatId, "string");
      assert.ok(Array.isArray(parsed.destinations[0].eligible));
    },
    [{ ledger: 42, eventName: "claim_created", source: "market" }],
  );
});

// ── Invalid flags ─────────────────────────────────────────────────────────────

test("replay rejects --yes and prints usage", async () => {
  await withTempDlq(async ({ filePath }) => {
    const io = captureIo();
    const { exitCode } = await runDlqCli({
      argv: ["replay", "--yes", "--file", filePath],
      stdout: io.out,
      stderr: io.err,
    });
    assert.equal(exitCode, 2);
    assert.ok(io.stderr.join("\n").includes("usage:"), "usage must appear in stderr");
  });
});

test("replay rejects --older-than and prints usage", async () => {
  await withTempDlq(async ({ filePath }) => {
    const io = captureIo();
    const { exitCode } = await runDlqCli({
      argv: ["replay", "--older-than", "1h", "--file", filePath],
      stdout: io.out,
      stderr: io.err,
    });
    assert.equal(exitCode, 2);
    assert.ok(io.stderr.join("\n").includes("usage:"));
  });
});
