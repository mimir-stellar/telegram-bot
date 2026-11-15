/**
 * Focused coverage for age-bounded dead-letter retention (#773).
 *
 * Verifies:
 *   - Configurable bounded `maxAgeMs` clamping (`DEAD_LETTER_MIN_AGE_MS` ..
 *     `DEAD_LETTER_MAX_AGE_MS`) and `0`/`null` opt-out compatibility.
 *   - Eviction of expired entries on `load`, `enqueue`, and `flush`, incrementing
 *     `stats().expired` while preserving newly failed entries without count drops.
 *   - CLI `--max-age <dur>` validation and `expired` counter reporting in `--json`
 *     and operator `/status` output.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { statusMessage } from "../dist/commands/status.js";
import {
  createDeadLetterQueue,
  DEAD_LETTER_MAX_AGE_MS,
  DEAD_LETTER_MIN_AGE_MS,
  resolveDeadLetterMaxAgeMs,
} from "../dist/deadLetter.js";
import { parseBoundedMaxAgeMs, runDlqCli } from "../dist/dlq-cli.js";
import { tokenize } from "./markdown-lint.test.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

test("resolveDeadLetterMaxAgeMs enforces configurable bounds and preserves 0/null opt-out", () => {
  assert.equal(resolveDeadLetterMaxAgeMs(undefined), null);
  assert.equal(resolveDeadLetterMaxAgeMs(null), null);
  assert.equal(resolveDeadLetterMaxAgeMs(0), null);
  assert.equal(resolveDeadLetterMaxAgeMs(-50), null);
  assert.equal(resolveDeadLetterMaxAgeMs(250), DEAD_LETTER_MIN_AGE_MS);
  assert.equal(resolveDeadLetterMaxAgeMs(60_000), 60_000);
  assert.equal(
    resolveDeadLetterMaxAgeMs(DEAD_LETTER_MAX_AGE_MS + 86_400_000),
    DEAD_LETTER_MAX_AGE_MS,
  );

  assert.equal(parseBoundedMaxAgeMs("0s"), 0);
  assert.equal(parseBoundedMaxAgeMs("30m"), 1_800_000);
  assert.throws(() => parseBoundedMaxAgeMs("500ms"), /--max-age must be 0 or between/);
  assert.throws(() => parseBoundedMaxAgeMs("120d"), /--max-age must be 0 or between/);
});

test("age retention evicts expired entries before count bounds and preserves newly failed entries", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    let clock = 1_700_000_000_000;

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 2,
      maxAttempts: 5,
      maxAgeMs: 10_000,
      now: () => clock,
      quiet: true,
    });
    await queue.load();

    // Park two entries within capacity: one at t=0, one at t=6s.
    await queue.enqueue({
      source: "market",
      ledger: 100,
      eventName: "claim_created",
      text: "stale failure",
      error: new Error("Telegram 429"),
    });
    clock += 6_000;
    await queue.enqueue({
      source: "squad",
      ledger: 101,
      eventName: "market_resolved",
      text: "recent failure",
      error: new Error("Telegram 429"),
    });
    assert.equal(queue.stats().depth, 2);
    assert.equal(queue.stats().expired, 0);
    assert.equal(queue.stats().dropped, 0);

    // Advance to t=12s: ledger 100 is 12s old (> 10s maxAgeMs), ledger 101 is 6s old.
    // Enqueuing ledger 102 must evict expired ledger 100 first (expired=1, dropped=0)
    // and preserve both ledger 101 and newly failed ledger 102.
    clock += 6_000;
    await queue.enqueue({
      source: "market",
      ledger: 102,
      eventName: "claim_cancelled",
      text: "newly failed entry",
      error: new Error("Telegram 503"),
    });

    assert.equal(queue.stats().expired, 1);
    assert.equal(queue.stats().dropped, 0);
    assert.deepEqual(
      queue.snapshot().map((e) => e.ledger),
      [101, 102],
    );

    // Advance another 5s (t=17s): ledger 101 is now 11s old (> 10s), ledger 102 is 5s old.
    // Flushing must expire ledger 101 rather than replaying it, and replay only ledger 102.
    clock += 5_000;
    const replayedLedgers = [];
    const flushed = await queue.flush(async (_text, entry) => {
      replayedLedgers.push(entry.ledger);
    }, 10);

    assert.equal(flushed.expired, 1);
    assert.equal(flushed.sent, 1);
    assert.equal(flushed.remaining, 0);
    assert.deepEqual(replayedLedgers, [102]);
    assert.equal(queue.stats().expired, 2);
    assert.equal(queue.stats().replayed, 1);
  }, "mimir-dlq-age-");
});

test("dlq CLI --max-age and /status surface expired dead-letter counts cleanly", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const baseClock = 1_700_000_000_000;

    const seed = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => baseClock,
      quiet: true,
    });
    await seed.load();
    await seed.enqueue({
      source: "market",
      ledger: 201,
      eventName: "claim_created",
      text: "old item",
      error: new Error("Telegram 429"),
    });

    const seedRecent = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => baseClock + 50_000,
      quiet: true,
    });
    await seedRecent.load();
    await seedRecent.enqueue({
      source: "squad",
      ledger: 202,
      eventName: "claim_cancelled",
      text: "fresh item",
      error: new Error("Telegram 429"),
    });

    const stdout = [];
    const stderr = [];
    const { exitCode } = await runDlqCli({
      argv: ["list", "--file", filePath, "--max-age", "30s", "--json"],
      now: () => baseClock + 60_000,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.depth, 1);
    assert.equal(parsed.expired, 1);
    assert.equal(parsed.entries[0].ledger, 202);

    // Operator /status renders valid MarkdownV2 when expired > 0.
    const config = {
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
      pollIntervalMs: 30_000,
      maxNotificationsPerCycle: 20,
    };
    const rendered = statusMessage(
      config,
      {
        running: true,
        paused: false,
        stopping: false,
        chainClockAt: baseClock,
        startedAt: baseClock - 10_000,
        cycles: 3,
        lastCorrelationId: null,
        lastPollAt: baseClock,
        lastSuccessAt: baseClock,
        latestLedger: 202,
        oldestLedger: 1,
        notificationsSent: 1,
        notificationsFailed: 2,
        eventsSkipped: 0,
        emptyPages: 0,
        pagesScanned: 1,
        lastCycleEmptyPages: 0,
        lastCyclePages: 1,
        notificationsDropped: 0,
        eventsDeduplicated: 0,
        cursorRewinds: 0,
        restartGaps: 0,
        lastRestartGap: null,
        consecutiveFailures: 0,
        lastError: null,
        ledgerCache: { hits: 0, misses: 0 },
        lockFile: null,
        lockPid: null,
        pendingFlush: false,
        lastFlushAt: null,
        suppressedLogs: 0,
        deadLetter: { depth: 1, enqueued: 2, replayed: 0, dropped: 0, expired: 1 },
        targets: [],
        sbomDigest: null,
        circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
      },
      baseClock + 60_000,
    );
    assert.match(rendered, /Parked sends: 1 waiting · 0 replayed · 0 dropped · 1 expired/);
    assert.doesNotThrow(() => tokenize(rendered));
  }, "mimir-dlq-age-cli-");
});
