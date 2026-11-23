/**
 * Focused tests for rejecting nonmonotonic ledger boundaries from a replay RPC page
 * while keeping the previously committed checkpoint unchanged.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ReplayConsistencyError,
  runReplayCli,
  validateReplayPageLedgerBoundaries,
} from "../dist/stellar/replay.js";
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

// ── Unit tests for validateReplayPageLedgerBoundaries ────────────────────────

test("validateReplayPageLedgerBoundaries accepts monotonic boundaries including inclusive overlap", () => {
  const cursor = makeCursor(4200, 2);
  const res = validateReplayPageLedgerBoundaries(
    {
      latestLedger: 5000,
      cursor,
      events: [{ ledger: 4200 }, { ledger: 4200 }],
    },
    {
      latestLedger: 5000,
      previousCursorLedger: 4200,
      lastEventLedger: 4200,
    },
  );
  assert.equal(res.nextCursorLedger, 4200);
});

test("validateReplayPageLedgerBoundaries rejects regressing latestLedger", () => {
  assert.throws(
    () =>
      validateReplayPageLedgerBoundaries(
        { latestLedger: 4999, cursor: makeCursor(4200, 1), events: [] },
        { latestLedger: 5000, previousCursorLedger: 4100, lastEventLedger: 4100 },
      ),
    (err) => {
      assert.ok(err instanceof ReplayConsistencyError);
      assert.equal(err.problem, "latest-ledger-regressed");
      assert.match(err.message, /latestLedger regressed from 5000 to 4999/);
      return true;
    },
  );
});

test("validateReplayPageLedgerBoundaries rejects regressing cursor ledger", () => {
  assert.throws(
    () =>
      validateReplayPageLedgerBoundaries(
        { latestLedger: 5000, cursor: makeCursor(4099, 1), events: [] },
        { latestLedger: 5000, previousCursorLedger: 4100, lastEventLedger: 4050 },
      ),
    (err) => {
      assert.ok(err instanceof ReplayConsistencyError);
      assert.equal(err.problem, "cursor-ledger-regressed");
      assert.match(err.message, /cursor ledger regressed from 4100 to 4099/);
      return true;
    },
  );
});

test("validateReplayPageLedgerBoundaries rejects event ledger behind committed boundary", () => {
  assert.throws(
    () =>
      validateReplayPageLedgerBoundaries(
        { latestLedger: 5000, cursor: makeCursor(4300, 1), events: [{ ledger: 4199 }] },
        { latestLedger: 5000, previousCursorLedger: 4200, lastEventLedger: 4200 },
      ),
    (err) => {
      assert.ok(err instanceof ReplayConsistencyError);
      assert.equal(err.problem, "event-ledger-regressed");
      assert.match(err.message, /event ledger 4199 regressed behind committed boundary 4200/);
      return true;
    },
  );
});

test("validateReplayPageLedgerBoundaries rejects nonmonotonic event ledgers within a page", () => {
  assert.throws(
    () =>
      validateReplayPageLedgerBoundaries(
        {
          latestLedger: 5000,
          cursor: makeCursor(4300, 1),
          events: [{ ledger: 4250 }, { ledger: 4210 }],
        },
        { latestLedger: 5000, previousCursorLedger: 4200, lastEventLedger: 4200 },
      ),
    (err) => {
      assert.ok(err instanceof ReplayConsistencyError);
      assert.equal(err.problem, "event-ledger-regressed");
      assert.match(err.message, /nonmonotonic \(4250 followed by 4210\)/);
      return true;
    },
  );
});

test("validateReplayPageLedgerBoundaries rejects cursor ledger behind page event ledger", () => {
  assert.throws(
    () =>
      validateReplayPageLedgerBoundaries(
        {
          latestLedger: 5000,
          cursor: makeCursor(4200, 1),
          events: [{ ledger: 4250 }],
        },
        { latestLedger: 5000, previousCursorLedger: 4100, lastEventLedger: 4100 },
      ),
    (err) => {
      assert.ok(err instanceof ReplayConsistencyError);
      assert.equal(err.problem, "cursor-behind-page-event");
      assert.match(err.message, /cursor ledger 4200 is behind page event ledger 4250/);
      return true;
    },
  );
});

// ── End-to-end checkpoint preservation tests ─────────────────────────────────

test("nonmonotonic page 2 cursor fails with bounded consistency error and preserves page 1 checkpoint", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");

    const cursor1 = makeCursor(4200, 1);
    const badCursor2 = makeCursor(4100, 1); // regresses behind page 1's cursor (4200)
    const ev1 = claimCreatedEvent({ ledger: 4200, claimId: 201, id: cursor1, pagingToken: cursor1 });
    const ev2 = claimCreatedEvent({
      ledger: 4250,
      claimId: 202,
      id: makeCursor(4250, 1),
      pagingToken: makeCursor(4250, 1),
    });

    const server = makeServer({ oldestLedger: 3000, latestLedger: 5000 }, {
      [MARKET_CONTRACT]: [
        { events: [ev1], cursor: cursor1, latestLedger: 5000 },
        { events: [ev2], cursor: badCursor2, latestLedger: 5000 },
      ],
    });

    const sent = [];
    const logs = [];
    const result = await runReplayCli({
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
      deps: {
        config: fakeBotConfig(),
        server,
        send: async (text, source) => {
          sent.push({ text, source });
        },
        progress: (...args) => logs.push(args.join(" ")),
      },
    });

    assert.equal(result.exitCode, 1, "nonmonotonic page must fail with exit code 1");
    assert.equal(sent.length, 1, "only page 1 event should be sent; page 2 must be rejected before dispatch");
    assert.ok(
      logs.some((line) => line.includes("scan failed:") && line.includes("cursor ledger regressed from 4200 to 4100")),
      `expected bounded consistency error in logs, got: ${logs.join("\n")}`,
    );

    const saved = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(saved.targets.market.pagesProcessed, 1);
    assert.equal(saved.targets.market.cursor, cursor1);
    assert.equal(saved.targets.market.lastEventLedger, 4200);
    assert.equal(saved.targets.market.eventsSent, 1);
    assert.equal(saved.targets.market.completed, false);
  });
});

test("resume rejects regressing latestLedger and leaves previously committed checkpoint byte-for-byte unchanged", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");

    const cursor1 = makeCursor(4200, 1);
    const ev1 = claimCreatedEvent({ ledger: 4200, claimId: 301, id: cursor1, pagingToken: cursor1 });

    // Run 1: commit page 1
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
        "--pages",
        "1",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer({ oldestLedger: 3000, latestLedger: 5000 }, {
          [MARKET_CONTRACT]: [{ events: [ev1], cursor: cursor1, latestLedger: 5000 }],
        }),
        send: async () => {},
        progress: () => {},
      },
    });
    assert.equal(run1.exitCode, 0);

    const committedRaw = await readFile(progressFile, "utf8");

    // Run 2: resume, but RPC page reports a regressing latestLedger (4900 < 5000)
    const sentRun2 = [];
    const logsRun2 = [];
    const ev2 = claimCreatedEvent({
      ledger: 4300,
      claimId: 302,
      id: makeCursor(4300, 1),
      pagingToken: makeCursor(4300, 1),
    });

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
      deps: {
        config: fakeBotConfig(),
        server: makeServer({ oldestLedger: 3000, latestLedger: 5000 }, {
          [MARKET_CONTRACT]: [{ events: [ev2], cursor: makeCursor(4300, 1), latestLedger: 4900 }],
        }),
        send: async (text, source) => {
          sentRun2.push({ text, source });
        },
        progress: (...args) => logsRun2.push(args.join(" ")),
      },
    });

    assert.equal(run2.exitCode, 1);
    assert.equal(sentRun2.length, 0, "no events should be sent when page boundary validation fails");
    assert.ok(
      logsRun2.some((line) => line.includes("latestLedger regressed from 5000 to 4900")),
      `expected latestLedger regression error, got: ${logsRun2.join("\n")}`,
    );

    const afterRun2Raw = await readFile(progressFile, "utf8");
    assert.equal(afterRun2Raw, committedRaw, "previously committed checkpoint must remain unchanged");
  });
});
