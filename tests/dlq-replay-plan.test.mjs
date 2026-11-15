/**
 * Focused tests for dry-run dead-letter replay plan grouped by destination (#767).
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  buildDeadLetterReplayPlan,
  createDeadLetterQueue,
} from "../dist/deadLetter.js";
import { planDeadLetterReplay, runDlqCli } from "../dist/dlq-cli.js";
import { redactChatId } from "../dist/status.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const RAW_MARKET_CHAT = "-1001111112222";
const RAW_SQUAD_CHAT = "@mimir_squad_alerts";
const REDACTED_MARKET_CHAT = redactChatId(RAW_MARKET_CHAT);
const REDACTED_SQUAD_CHAT = redactChatId(RAW_SQUAD_CHAT);

test("planDeadLetterReplay groups by redacted destination with selected counts, reasons, and zero queue mutations", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");

    // Seed mixed entries across two destinations, including poison (attempts >= maxAttempts),
    // empty message body, eligible entries, and over-budget entries.
    const entries = [
      {
        id: "market:101:claim_created:11111111",
        enqueuedAt: "2026-01-01T00:00:00.000Z",
        source: "market",
        ledger: 101,
        eventName: "claim_created",
        text: "Market #101",
        attempts: 1,
        lastError: "429",
      },
      {
        id: "market:102:claim_created:22222222",
        enqueuedAt: "2026-01-01T00:01:00.000Z",
        source: "market",
        ledger: 102,
        eventName: "claim_created",
        text: "Poison market #102",
        attempts: 5, // >= maxAttempts (5)
        lastError: "400 bad markdown",
      },
      {
        id: "squad:103:deposited:33333333",
        enqueuedAt: "2026-01-01T00:02:00.000Z",
        source: "squad",
        ledger: 103,
        eventName: "deposited",
        text: "   ", // empty message body
        attempts: 1,
        lastError: "400 empty",
      },
      {
        id: "squad:104:deposited:44444444",
        enqueuedAt: "2026-01-01T00:03:00.000Z",
        source: "squad",
        ledger: 104,
        eventName: "deposited",
        text: "Squad #104",
        attempts: 2,
        lastError: "503",
      },
      {
        id: "market:105:market_settled:55555555",
        enqueuedAt: "2026-01-01T00:04:00.000Z",
        source: "market",
        ledger: 105,
        eventName: "market_settled",
        text: "Market #105",
        attempts: 1,
        lastError: "timeout",
      },
    ];

    await writeFile(
      filePath,
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:05:00.000Z", entries }, null, 2),
      "utf8",
    );
    const beforeRaw = await readFile(filePath, "utf8");

    const plan = await planDeadLetterReplay({
      filePath,
      budget: 2,
      maxAttempts: 5,
      marketChatId: RAW_MARKET_CHAT,
      squadChatId: RAW_SQUAD_CHAT,
    });

    assert.equal(plan.dryRun, true);
    assert.equal(plan.totalEntries, 5);
    assert.equal(plan.selectedCount, 2);
    assert.equal(plan.excludedCount, 3);
    assert.deepEqual(plan.reasonCounts, {
      eligible: 2,
      max_attempts_exhausted: 1,
      empty_message_body: 1,
      deferred_over_budget: 1,
    });

    assert.equal(plan.destinations.length, 2);
    const marketGroup = plan.destinations.find((g) => g.destination === REDACTED_MARKET_CHAT);
    const squadGroup = plan.destinations.find((g) => g.destination === REDACTED_SQUAD_CHAT);
    assert.ok(marketGroup);
    assert.ok(squadGroup);

    assert.equal(marketGroup.totalCount, 3);
    assert.equal(marketGroup.selectedCount, 1);
    assert.equal(marketGroup.excludedCount, 2);
    assert.deepEqual(marketGroup.reasonCounts, {
      eligible: 1,
      max_attempts_exhausted: 1,
      deferred_over_budget: 1,
    });

    assert.equal(squadGroup.totalCount, 2);
    assert.equal(squadGroup.selectedCount, 1);
    assert.equal(squadGroup.excludedCount, 1);
    assert.deepEqual(squadGroup.reasonCounts, {
      empty_message_body: 1,
      eligible: 1,
    });

    // Zero raw chat IDs in serialized output and zero disk mutations
    assert.equal(JSON.stringify(plan).includes(RAW_MARKET_CHAT), false);
    assert.equal(JSON.stringify(plan).includes(RAW_SQUAD_CHAT), false);
    assert.equal(await readFile(filePath, "utf8"), beforeRaw);
  }, "mimir-dlq-plan-");
});

test("dlq CLI plan subcommand handles shared destination, zero budget, source filter, and bad budget error", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 5,
      quiet: true,
    });
    await queue.enqueue({
      source: "market",
      ledger: 201,
      eventName: "claim_created",
      text: "Market #201",
      error: "429",
    });
    await queue.enqueue({
      source: "squad",
      ledger: 202,
      eventName: "deposited",
      text: "Squad #202",
      error: "429",
    });

    const beforeRaw = await readFile(filePath, "utf8");

    // Shared destination via --chat-id with --budget 0 -> deferred_zero_budget
    const zeroOut = [];
    const zeroCli = await runDlqCli({
      argv: [
        "plan",
        "--budget",
        "0",
        "--dry-run",
        "--chat-id",
        RAW_MARKET_CHAT,
        "--json",
        "--file",
        filePath,
      ],
      stdout: (l) => zeroOut.push(l),
      stderr: () => {},
    });
    assert.equal(zeroCli.exitCode, 0);
    const parsedZero = JSON.parse(zeroOut.join("\n"));
    assert.equal(parsedZero.selectedCount, 0);
    assert.equal(parsedZero.excludedCount, 2);
    assert.equal(parsedZero.destinations.length, 1);
    assert.equal(parsedZero.destinations[0].destination, REDACTED_MARKET_CHAT);
    assert.deepEqual(parsedZero.destinations[0].sources, ["market", "squad"]);
    assert.deepEqual(parsedZero.reasonCounts, { deferred_zero_budget: 2 });

    // Source filter via --source squad (human-readable output)
    const humanOut = [];
    const humanCli = await runDlqCli({
      argv: ["plan", "--source", "squad", "--chat-id", RAW_MARKET_CHAT, "--file", filePath],
      stdout: (l) => humanOut.push(l),
      stderr: () => {},
    });
    assert.equal(humanCli.exitCode, 0);
    const rendered = humanOut.join("\n");
    assert.match(rendered, /dry-run replay plan: 1\/2 selected, 1 excluded/);
    assert.match(rendered, /filtered_source=1/);
    assert.equal(rendered.includes(RAW_MARKET_CHAT), false);

    // Invalid negative budget exits 2
    const errOut = [];
    const badCli = await runDlqCli({
      argv: ["plan", "--budget", "-5", "--file", filePath],
      stdout: () => {},
      stderr: (l) => errOut.push(l),
    });
    assert.equal(badCli.exitCode, 2);

    // Direct pure helper check on empty queue
    const emptyPlan = buildDeadLetterReplayPlan([], { budget: 10 });
    assert.equal(emptyPlan.totalEntries, 0);
    assert.deepEqual(emptyPlan.destinations, []);

    assert.equal(await readFile(filePath, "utf8"), beforeRaw);
  }, "mimir-dlq-plan-cli-");
});
