/**
 * Tests for Issue #790: explicit event-count budget (--max-events) for historical replay.
 *
 * Covered:
 *   - Stops after configured --max-events count (mid-page and across pages)
 *   - Persists resumable checkpoint with budgetExhausted=true and completed=false
 *   - Resuming from checkpoint processes remaining events without loss or duplicate delivery
 *   - Distinguishes budget exhaustion from completion (exact boundary when range also finishes)
 *   - Cross-target budget sharing (market exhausts budget, squad stops with 0 events)
 *   - Invalid --max-events values (0, negative, float, missing) reject with exit code 2
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runReplayCli } from "../dist/stellar/replay.js";
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
    botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
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
      const page = pages[idx] ?? {
        events: [],
        cursor: "",
        latestLedger: health.latestLedger ?? 5000,
      };
      indices[contractId] = idx + 1;
      return {
        events: Array.isArray(page.events) ? page.events : [],
        cursor: page.cursor ?? "",
        latestLedger: page.latestLedger ?? health.latestLedger ?? 5000,
      };
    },
  };
}

test("stops mid-page at --max-events, persists resumable checkpoint, and resumes cleanly", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const c3 = makeCursor(4300, 1);
    const c4 = makeCursor(4400, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 1, id: c1, pagingToken: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 2, id: c2, pagingToken: c2 });
    const ev3 = claimCreatedEvent({ ledger: 4300, claimId: 3, id: c3, pagingToken: c3 });
    const ev4 = claimCreatedEvent({ ledger: 4400, claimId: 4, id: c4, pagingToken: c4 });

    const health = { oldestLedger: 3000, latestLedger: 5000 };
    const delivered = [];
    const send = async (text) => {
      delivered.push(text);
    };

    // Run 1: --max-events 2 on a 4-event page
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
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [
            { events: [ev1, ev2, ev3, ev4], cursor: makeCursor(4500), latestLedger: 5000 },
          ],
        }),
        send,
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, 0);
    assert.equal(run1.report.maxEvents, 2);
    assert.equal(run1.report.budgetExhausted, true);
    assert.equal(run1.report.completed, false);
    assert.equal(run1.report.totals.events, 2);
    assert.equal(run1.report.totals.sent, 2);
    assert.equal(delivered.length, 2);

    const checkpoint1 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(checkpoint1.targets.market.completed, false);
    assert.equal(checkpoint1.targets.market.budgetExhausted, true);
    assert.equal(checkpoint1.targets.market.eventsProcessed, 2);
    assert.equal(checkpoint1.targets.market.cursor, c2);

    // Run 2: resume with --max-events 2; RPC returns remaining events starting from c2
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
        "--max-events",
        "2",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [
            { events: [ev2, ev3, ev4], cursor: makeCursor(5001), latestLedger: 5000 },
          ],
        }),
        send,
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(run2.report.budgetExhausted, false);
    assert.equal(run2.report.completed, true);
    assert.equal(run2.report.totals.events, 4);
    assert.equal(run2.report.totals.sent, 4);
    assert.equal(delivered.length, 4);

    const checkpoint2 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(checkpoint2.targets.market.completed, true);
    assert.equal(checkpoint2.targets.market.budgetExhausted, false);
  });
});

test("distinguishes budget exhaustion when more pages remain from completion on final page", async () => {
  const c1 = makeCursor(4100, 1);
  const c2 = makeCursor(4200, 1);
  const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 10, id: c1, pagingToken: c1 });
  const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 11, id: c2, pagingToken: c2 });
  const health = { oldestLedger: 3000, latestLedger: 5000 };

  // Case A: 2 events on page 1, cursor < toLedger (more pages remain) -> budgetExhausted=true, completed=false
  const partialRun = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "5000",
      "--contract",
      "market",
      "--max-events",
      "2",
    ],
    deps: {
      config: fakeBotConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [
          { events: [ev1, ev2], cursor: makeCursor(4300), latestLedger: 5000 },
          { events: [], cursor: makeCursor(5001), latestLedger: 5000 },
        ],
      }),
      progress: () => {},
    },
  });

  assert.equal(partialRun.exitCode, 0);
  assert.equal(partialRun.report.budgetExhausted, true);
  assert.equal(partialRun.report.completed, false);

  // Case B: 2 events on final page (cursor > toLedger) -> completed=true, budgetExhausted=false
  const finalRun = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "5000",
      "--contract",
      "market",
      "--max-events",
      "2",
    ],
    deps: {
      config: fakeBotConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [
          { events: [ev1, ev2], cursor: makeCursor(5001), latestLedger: 5000 },
        ],
      }),
      progress: () => {},
    },
  });

  assert.equal(finalRun.exitCode, 0);
  assert.equal(finalRun.report.budgetExhausted, false);
  assert.equal(finalRun.report.completed, true);
});

test("shares --max-events budget across market and squad targets", async () => {
  const c1 = makeCursor(4100, 1);
  const c2 = makeCursor(4200, 1);
  const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 21, id: c1, pagingToken: c1 });
  const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 22, id: c2, pagingToken: c2 });
  const health = { oldestLedger: 3000, latestLedger: 5000 };

  const { report, exitCode } = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "5000",
      "--max-events",
      "1",
    ],
    deps: {
      config: fakeBotConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [
          { events: [ev1, ev2], cursor: makeCursor(4300), latestLedger: 5000 },
        ],
        [SQUAD_CONTRACT]: [
          { events: [ev1], cursor: makeCursor(5001), latestLedger: 5000 },
        ],
      }),
      progress: () => {},
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(report.budgetExhausted, true);
  assert.equal(report.completed, false);
  assert.equal(report.totals.events, 1);
  assert.equal(report.targets[0].budgetExhausted, true);
  assert.equal(report.targets[1].events, 0);
  assert.equal(report.targets[1].budgetExhausted, true);
});

test("invalid --max-events values reject with exit code 2", async () => {
  for (const bad of ["0", "-5", "1.5", "abc"]) {
    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--max-events", bad],
      deps: {
        config: fakeBotConfig(),
        server: makeServer({ oldestLedger: 1, latestLedger: 5000 }),
        progress: () => {},
      },
    });
    assert.equal(exitCode, 2, `expected exit 2 for --max-events ${bad}`);
    assert.equal(report, null);
  }
});
