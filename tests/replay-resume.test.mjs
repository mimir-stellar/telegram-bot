/**
 * Tests for resumable replay with progress file and RPC budget.
 * Closes #524.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { runReplayCli } from "../dist/stellar/replay.js";
import { MARKET_CONTRACT, SQUAD_CONTRACT, challengerPaidEvent } from "./fixtures/events.mjs";
import { createTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
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

function knownEvent(ledger, txIndex = 0) {
  const cursor = makeCursor(ledger, txIndex + 1, 0);
  return challengerPaidEvent({ ledger, id: cursor, claimId: ledger });
}

const mockConfig = {
  network: "mock",
  rpcUrl: "http://fake-rpc.invalid",
  marketContractId: MARKET_CONTRACT,
  squadContractId: SQUAD_CONTRACT,
  botToken: "fake:token",
  chatId: "12345",
  maxNotificationsPerCycle: 20,
  dedupWindow: 256,
};

test("interrupting and resuming yields each event exactly once in a fake notifier", async () => {
  const dir = await createTempDataDir("replay-resume-test-");
  const progressFile = dir.file("replay-progress.json");

  try {
    const page1Events = [
      knownEvent(4010, 0),
      knownEvent(4020, 1),
    ];
    const page2Events = [
      knownEvent(4030, 0),
      knownEvent(4040, 1),
    ];
    const page3Events = [
      knownEvent(4050, 0),
    ];

    const cursor1 = makeCursor(4020, 2, 0);
    const cursor2 = makeCursor(4040, 2, 0);
    const cursor3 = makeCursor(4050, 1, 0);

    const pages = [
      { events: page1Events, cursor: cursor1, latestLedger: 4500 },
      { events: page2Events, cursor: cursor2, latestLedger: 4500 },
      { events: page3Events, cursor: cursor3, latestLedger: 4500 },
    ];

    const server1 = makeServer({ oldestLedger: 1, latestLedger: 4500 }, { [MARKET_CONTRACT]: pages });

    const receivedEvents = [];
    const fakeSend = async (text) => {
      receivedEvents.push(text);
    };

    // Run 1: Interrupted after 1 page
    const run1 = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "4500",
        "--contract", "market",
        "--pages", "1",
        "--progress", progressFile,
        "--send",
      ],
      deps: {
        config: mockConfig,
        server: server1,
        send: fakeSend,
      },
    });

    assert.equal(run1.exitCode, 0);
    assert.equal(receivedEvents.length, 2);
    assert.equal(existsSync(progressFile), true);

    const progressData1 = JSON.parse(readFileSync(progressFile, "utf8"));
    assert.equal(progressData1.format, "mimir-replay-progress-v1");
    assert.equal(progressData1.targets.market.pages, 1);
    assert.equal(progressData1.targets.market.cursor, cursor1);

    // Run 2: Resume with remaining pages (interruption mid-range resumed)
    const server2 = makeServer({ oldestLedger: 1, latestLedger: 4500 }, {
      [MARKET_CONTRACT]: [
        { events: page2Events, cursor: cursor2, latestLedger: 4500 },
        { events: page3Events, cursor: cursor3, latestLedger: 4500 },
      ],
    });

    const run2 = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "4500",
        "--contract", "market",
        "--pages", "5",
        "--progress", progressFile,
        "--send",
      ],
      deps: {
        config: mockConfig,
        server: server2,
        send: fakeSend,
      },
    });

    assert.equal(run2.exitCode, 0);
    // 2 events from run1 + 3 events from run2 = 5 total events sent, each exactly once!
    assert.equal(receivedEvents.length, 5);

    const progressData2 = JSON.parse(readFileSync(progressFile, "utf8"));
    assert.equal(progressData2.targets.market.completed, true);
    assert.equal(progressData2.targets.market.eventsSent, 3); // sent in run2
  } finally {
    await dir.cleanup();
  }
});

test("a progress file for a different range is rejected", async () => {
  const dir = await createTempDataDir("replay-range-test-");
  const progressFile = dir.file("replay-progress.json");

  try {
    const server = makeServer({ oldestLedger: 1, latestLedger: 5000 }, { [MARKET_CONTRACT]: [] });

    // Initial run to create progress file for 4000..5000
    const run1 = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "5000",
        "--contract", "market",
        "--progress", progressFile,
      ],
      deps: { config: mockConfig, server },
    });
    assert.equal(run1.exitCode, 0);

    // Run with mismatched --from
    const runMismatchFrom = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4200",
        "--to", "5000",
        "--contract", "market",
        "--progress", progressFile,
      ],
      deps: { config: mockConfig, server },
    });
    assert.equal(runMismatchFrom.exitCode, 2);
    assert.equal(runMismatchFrom.report, null);

    // Run with mismatched --to
    const runMismatchTo = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "4800",
        "--contract", "market",
        "--progress", progressFile,
      ],
      deps: { config: mockConfig, server },
    });
    assert.equal(runMismatchTo.exitCode, 2);
    assert.equal(runMismatchTo.report, null);
  } finally {
    await dir.cleanup();
  }
});

test("a progress file for a different contract is rejected", async () => {
  const dir = await createTempDataDir("replay-contract-test-");
  const progressFile = dir.file("replay-progress.json");

  try {
    const server = makeServer({ oldestLedger: 1, latestLedger: 5000 }, { [MARKET_CONTRACT]: [] });

    // Initial run for market contract
    const run1 = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "5000",
        "--contract", "market",
        "--progress", progressFile,
      ],
      deps: { config: mockConfig, server },
    });
    assert.equal(run1.exitCode, 0);

    // Run with contract squad instead
    const runMismatchContract = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "5000",
        "--contract", "squad",
        "--progress", progressFile,
      ],
      deps: { config: mockConfig, server },
    });
    assert.equal(runMismatchContract.exitCode, 2);
    assert.equal(runMismatchContract.report, null);
  } finally {
    await dir.cleanup();
  }
});

test("request budget (max RPC calls per minute) throttles requests", async () => {
  const dir = await createTempDataDir("replay-budget-test-");
  const progressFile = dir.file("replay-progress.json");

  try {
    const pageEvents = [knownEvent(4010, 0)];
    const pages = [
      { events: pageEvents, cursor: makeCursor(4010, 1, 0), latestLedger: 4050 },
      { events: pageEvents, cursor: makeCursor(4020, 1, 0), latestLedger: 4050 },
    ];
    const server = makeServer({ oldestLedger: 1, latestLedger: 4050 }, { [MARKET_CONTRACT]: pages });

    const startTime = Date.now();
    const run = await runReplayCli({
      argv: [
        "node", "replay",
        "--from", "4000",
        "--to", "4050",
        "--contract", "market",
        "--pages", "2",
        "--rpc-budget", "1200", // 50ms delay between RPC calls
        "--progress", progressFile,
      ],
      deps: { config: mockConfig, server },
    });
    const elapsed = Date.now() - startTime;

    assert.equal(run.exitCode, 0);
    // At least 2 calls with 50ms pacing must take >= 40ms
    assert.ok(elapsed >= 40, `expected elapsed >= 40ms, got ${elapsed}ms`);
  } finally {
    await dir.cleanup();
  }
});
