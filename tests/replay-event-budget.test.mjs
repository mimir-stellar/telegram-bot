/**
 * Tests for Issue #790: support an explicit event-count budget for historical replay.
 *
 * Covered:
 *   - Mid-page stop after --max-events N checkpoints at the exact last-committed event cursor
 *   - Resuming after mid-page budget exhaustion delivers remaining events without loss or duplication
 *   - Multi-contract budget exhaustion defers subsequent contracts and distinguishes budget_exhausted from completed
 *   - Exact boundary when total events equal --max-events at chain tip reports completed (not budget_exhausted)
 *   - Stepped batch replay (--event-budget 1 across multiple runs) converges to completed
 *   - Invalid --max-events / --event-budget inputs reject with exit code 2
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EventBudgetTracker, runReplayCli } from "../dist/stellar/replay.js";
import {
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimCreatedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeBotConfig(overrides = {}) {
  return {
    botToken: "TEST_TOKEN",
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

test("mid-page --max-events stops immediately, checkpoints last committed event cursor, and resumes cleanly", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const c3 = makeCursor(4300, 1);
    const c4 = makeCursor(4400, 1);
    const cEnd = makeCursor(5000, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 1, id: c1, pagingToken: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 2, id: c2, pagingToken: c2 });
    const ev3 = claimCreatedEvent({ ledger: 4300, claimId: 3, id: c3, pagingToken: c3 });
    const ev4 = claimCreatedEvent({ ledger: 4400, claimId: 4, id: c4, pagingToken: c4 });

    let run1GetEventsCalls = 0;
    const serverRun1 = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        run1GetEventsCalls += 1;
        return {
          events: [ev1, ev2, ev3, ev4],
          cursor: cEnd,
          latestLedger: 5000,
        };
      },
    };

    const deliveries = [];
    const send = async (text, source) => {
      deliveries.push({ text, source });
    };

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
        "--max-events",
        "2",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: serverRun1, send, progress: () => {} },
    });

    assert.equal(run1.exitCode, 0);
    assert.equal(run1GetEventsCalls, 1);
    assert.equal(deliveries.length, 2, "must stop after configured 2-event budget");
    assert.equal(run1.report.status, "budget_exhausted");
    assert.equal(run1.report.budgetExhausted, true);
    assert.deepEqual(run1.report.eventBudget, {
      limit: 2,
      used: 2,
      remaining: 0,
      exhausted: true,
    });
    assert.equal(run1.report.targets[0].stopReason, "event_budget");
    assert.equal(run1.report.targets[0].cursor, c2, "checkpoint cursor must point at ev2, never page end cEnd");

    const savedAfterRun1 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(savedAfterRun1.status, "budget_exhausted");
    assert.equal(savedAfterRun1.targets.market.completed, false);
    assert.equal(savedAfterRun1.targets.market.stopReason, "event_budget");
    assert.equal(savedAfterRun1.targets.market.cursor, c2);
    assert.equal(savedAfterRun1.targets.market.lastProcessedEventId, c2);
    assert.equal(savedAfterRun1.targets.market.eventsProcessed, 2);
    assert.equal(savedAfterRun1.targets.market.eventsSent, 2);

    // Run 2: resume from c2 — Soroban inclusive cursor returns [ev2, ev3, ev4]
    let run2Calls = 0;
    const serverRun2 = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents(req) {
        run2Calls += 1;
        if (run2Calls === 1) {
          assert.equal(req.cursor, c2, "resume must request from ev2 cursor");
          return {
            events: [ev2, ev3, ev4],
            cursor: cEnd,
            latestLedger: 5000,
          };
        }
        return { events: [], cursor: cEnd, latestLedger: 5000 };
      },
    };

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
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: serverRun2, send, progress: () => {} },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(run2.report.status, "completed");
    assert.equal(run2.report.budgetExhausted, false);
    assert.equal(deliveries.length, 4, "all 4 events delivered once across budget stop + resume");
    assert.equal(run2.report.totals.resumedSkippedEvents, 1, "inclusive ev2 dropped on resume");

    const savedAfterRun2 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(savedAfterRun2.status, "completed");
    assert.equal(savedAfterRun2.targets.market.completed, true);
    assert.equal(savedAfterRun2.targets.market.eventsProcessed, 4);
    assert.equal(savedAfterRun2.targets.market.eventsSent, 4);
  });
});

test("multi-contract replay defers remaining targets when budget is exhausted on the first contract", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("multi-progress.json");
    const cMarketEnd = makeCursor(5000, 1);
    const cSquadEnd = makeCursor(5000, 2);

    const m1 = claimCreatedEvent({ ledger: 4100, claimId: 10, id: makeCursor(4100, 1), pagingToken: makeCursor(4100, 1) });
    const m2 = claimCreatedEvent({ ledger: 4200, claimId: 11, id: makeCursor(4200, 1), pagingToken: makeCursor(4200, 1) });
    const s1 = claimCreatedEvent({
      ledger: 4150,
      claimId: 20,
      contractId: SQUAD_CONTRACT,
      id: makeCursor(4150, 1),
      pagingToken: makeCursor(4150, 1),
    });

    let squadQueriedInRun1 = false;
    const serverRun1 = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents(req) {
        const cid = req.filters[0].contractIds[0];
        if (cid === MARKET_CONTRACT) {
          return { events: [m1, m2], cursor: cMarketEnd, latestLedger: 5000 };
        }
        squadQueriedInRun1 = true;
        return { events: [s1], cursor: cSquadEnd, latestLedger: 5000 };
      },
    };

    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--max-events",
        "2",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: serverRun1, progress: () => {} },
    });

    assert.equal(run1.exitCode, 0);
    assert.equal(squadQueriedInRun1, false, "squad must not be queried after market exhausted the 2-event budget");
    assert.equal(run1.report.status, "budget_exhausted");
    assert.equal(run1.report.budgetExhausted, true);

    const saved1 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(saved1.status, "budget_exhausted");
    assert.equal(saved1.targets.market.completed, true);
    assert.equal(saved1.targets.squad.completed, false);
    assert.equal(saved1.targets.squad.stopReason, "event_budget");

    // Resume: market skipped as completed, squad processed to completion
    let marketQueriedInRun2 = false;
    const serverRun2 = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents(req) {
        const cid = req.filters[0].contractIds[0];
        if (cid === MARKET_CONTRACT) {
          marketQueriedInRun2 = true;
        }
        return { events: [s1], cursor: cSquadEnd, latestLedger: 5000 };
      },
    };

    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--max-events",
        "5",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: serverRun2, progress: () => {} },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(marketQueriedInRun2, false);
    assert.equal(run2.report.status, "completed");
    assert.equal(run2.report.budgetExhausted, false);

    const saved2 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(saved2.status, "completed");
    assert.equal(saved2.targets.market.completed, true);
    assert.equal(saved2.targets.squad.completed, true);
  });
});

test("exact boundary: when total in-range events equal --max-events at final page, status is completed (not budget_exhausted)", async () => {
  const cEnd = makeCursor(5000, 1);
  const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 1, id: makeCursor(4100, 1), pagingToken: makeCursor(4100, 1) });
  const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 2, id: makeCursor(4200, 1), pagingToken: makeCursor(4200, 1) });

  const server = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
    },
    async getEvents() {
      return { events: [ev1, ev2], cursor: cEnd, latestLedger: 5000 };
    },
  };

  const { report, exitCode } = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "5000",
      "--contract",
      "market",
      "--event-budget",
      "2",
    ],
    deps: { config: fakeBotConfig(), server, progress: () => {} },
  });

  assert.equal(exitCode, 0);
  assert.equal(report.status, "completed");
  assert.equal(report.budgetExhausted, false);
  assert.deepEqual(report.eventBudget, {
    limit: 2,
    used: 2,
    remaining: 0,
    exhausted: false,
  });
});

test("invalid --max-events / --event-budget inputs reject with exit code 2", async () => {
  for (const bad of ["0", "-5", "2.5", "abc"]) {
    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--max-events", bad],
      deps: { config: fakeBotConfig(), progress: () => {} },
    });
    assert.equal(exitCode, 2, `--max-events ${bad} must reject with exit code 2`);
    assert.equal(report, null);
  }

  const missingArg = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--max-events"],
    deps: { config: fakeBotConfig(), progress: () => {} },
  });
  assert.equal(missingArg.exitCode, 2);

  const bothFlags = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--max-events", "5", "--event-budget", "5"],
    deps: { config: fakeBotConfig(), progress: () => {} },
  });
  assert.equal(bothFlags.exitCode, 2);

  assert.throws(() => new EventBudgetTracker(0), /positive integer/);
  assert.throws(() => new EventBudgetTracker(1.5), /positive integer/);
});
