/**
 * Focused coverage for oldest-retained-failure dead-letter age reporting (#770).
 *
 * Verifies:
 *   - Dead-letter age uses the oldest retained entry's original failed-at
 *     timestamp rather than file `mtime`, `updatedAt`, or later retry updates.
 *   - Legacy entries missing or containing unparseable timestamps are never
 *     silently stamped with the load time and are reported explicitly in
 *     `deadLetter.stats()`, `dlq list`/`show`, and `/status`.
 */

import assert from "node:assert/strict";
import { utimes, writeFile } from "node:fs/promises";
import test from "node:test";

import { statusMessage } from "../dist/commands/status.js";
import { createDeadLetterQueue } from "../dist/deadLetter.js";
import { runDlqCli } from "../dist/dlq-cli.js";
import { tokenize } from "./markdown-lint.test.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

test("dead-letter age uses original failed-at timestamp rather than file mtime or retry updatedAt", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const t0 = Date.parse("2026-10-18T10:00:00.000Z");
    let clock = t0;

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => clock,
      quiet: true,
    });
    await queue.load();

    // First failure at t0 (10:00:00Z)
    await queue.enqueue({
      source: "market",
      ledger: 801,
      eventName: "claim_created",
      text: "first failure",
      error: new Error("Telegram 429"),
    });

    // Second failure 30m later (10:30:00Z), plus retry of first failure at 10:45:00Z
    clock = t0 + 30 * 60_000;
    await queue.enqueue({
      source: "squad",
      ledger: 802,
      eventName: "market_resolved",
      text: "newer failure",
      error: new Error("Telegram 503"),
    });
    clock = t0 + 45 * 60_000;
    await queue.enqueue({
      source: "market",
      ledger: 801,
      eventName: "claim_created",
      text: "first failure",
      error: new Error("Telegram still 429"),
    });

    // Touch file mtime to right now (2 hours later) — must NOT affect reported age!
    const inspectNow = t0 + 2 * 3_600_000; // 12:00:00Z (2h after t0)
    const recentFileDate = new Date(inspectNow - 1_000);
    await utimes(filePath, recentFileDate, recentFileDate);

    clock = inspectNow;
    const stats = queue.stats();
    assert.equal(stats.oldestFailedAt, "2026-10-18T10:00:00.000Z");
    assert.equal(stats.oldestAgeMs, 2 * 3_600_000);
    assert.equal(stats.missingTimestamps, 0);

    const stdout = [];
    const stderr = [];
    const { exitCode } = await runDlqCli({
      argv: ["list", "--file", filePath, "--json"],
      now: () => inspectNow,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    const parsed = JSON.parse(stdout.join("\n"));
    assert.equal(parsed.oldestFailedAt, "2026-10-18T10:00:00.000Z");
    assert.equal(parsed.oldestAgeMs, 2 * 3_600_000);
    assert.equal(parsed.oldestAge, "2h");
    assert.equal(parsed.missingTimestamps, 0);
  }, "mimir-dlq-age-orig-");
});

test("legacy entries missing or corrupting timestamps are reported explicitly without fabricating load time", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const inspectNow = Date.parse("2026-10-18T15:00:00.000Z");

    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-18T14:59:59.000Z",
        entries: [
          {
            id: "market:901:claim_created:aaaa1111",
            source: "market",
            ledger: 901,
            eventName: "claim_created",
            text: "legacy entry without enqueuedAt",
            attempts: 2,
            lastError: "Telegram 429",
          },
          {
            id: "squad:902:claim_cancelled:bbbb2222",
            enqueuedAt: "not-a-timestamp",
            source: "squad",
            ledger: 902,
            eventName: "claim_cancelled",
            text: "legacy entry with unparseable timestamp",
            attempts: 1,
            lastError: "Telegram 503",
          },
        ],
      }),
      "utf8",
    );

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => inspectNow,
      quiet: true,
    });
    await queue.load();

    const stats = queue.stats();
    assert.equal(stats.depth, 2);
    assert.equal(stats.oldestFailedAt, null);
    assert.equal(stats.oldestAgeMs, null);
    assert.equal(stats.missingTimestamps, 2);

    const listOut = [];
    await runDlqCli({
      argv: ["list", "--file", filePath],
      now: () => inspectNow,
      stdout: (line) => listOut.push(line),
      stderr: () => undefined,
    });
    const listText = listOut.join("\n");
    assert.match(listText, /oldestAge=unknown \(missing timestamp\)/);
    assert.match(listText, /enqueued=unknown \(legacy\)/);

    const showOut = [];
    await runDlqCli({
      argv: ["show", "market:901:claim_created:aaaa1111", "--file", filePath],
      now: () => inspectNow,
      stdout: (line) => showOut.push(line),
      stderr: () => undefined,
    });
    const showText = showOut.join("\n");
    assert.match(showText, /enqueuedAt: unknown \(missing legacy timestamp\)/);
    assert.match(showText, /age:\s+unknown \(missing timestamp\)/);

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
        chainClockAt: inspectNow,
        startedAt: inspectNow - 60_000,
        cycles: 1,
        lastCorrelationId: null,
        lastPollAt: inspectNow,
        lastSuccessAt: inspectNow,
        latestLedger: 902,
        oldestLedger: 1,
        notificationsSent: 0,
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
        deadLetter: stats,
        targets: [],
        sbomDigest: null,
        circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
      },
      inspectNow,
    );
    assert.match(rendered, /oldest age unknown \\\(legacy\\\)/);
    assert.doesNotThrow(() => tokenize(rendered));
  }, "mimir-dlq-age-legacy-");
});
