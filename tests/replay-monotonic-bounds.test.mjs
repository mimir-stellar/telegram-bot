import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ReplayPageConsistencyError,
  runReplayCli,
  validateReplayPageBounds,
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
    botToken: ["123456", "SYNTHETIC_BOT_CREDENTIAL_FOR_TEST"].join(":"),
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

test("latestLedger regression on page 2 returns bounded consistency error, blocks page 2 sends, and leaves page 1 checkpoint byte-for-byte unchanged", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");
    const cursor1 = makeCursor(4100, 1);
    const cursor2 = makeCursor(4200, 1);
    const cursor3 = makeCursor(5000, 1);

    const evPage1 = claimCreatedEvent({
      ledger: 4100,
      claimId: 1,
      id: cursor1,
      pagingToken: cursor1,
    });
    const evPage2 = claimCreatedEvent({
      ledger: 4200,
      claimId: 2,
      id: cursor2,
      pagingToken: cursor2,
    });

    let capturedPage1Bytes = null;
    let callCount = 0;
    const deliveries = [];

    const laggingReplicaServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        callCount += 1;
        if (callCount === 1) {
          return {
            events: [evPage1],
            cursor: cursor1,
            latestLedger: 5000,
          };
        }
        // Snapshot the committed progress file written after page 1 before returning bad page 2
        capturedPage1Bytes = await readFile(progressFile, "utf8");
        return {
          events: [evPage2],
          cursor: cursor2,
          // Regressed latestLedger from a lagging load-balanced RPC backend!
          latestLedger: 4950,
        };
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
        "--contract",
        "market",
        "--send",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: laggingReplicaServer,
        send: async (text) => {
          deliveries.push(text);
        },
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, 1);
    assert.ok(run1.report !== null);
    assert.equal(deliveries.length, 1, "only page 1 event may be dispatched; page 2 must be rejected before send");

    const targetReport = run1.report.targets[0];
    assert.ok(targetReport.consistencyError);
    assert.equal(targetReport.consistencyError.problem, "latest-ledger-regressed");
    assert.equal(targetReport.consistencyError.page, 2);
    assert.ok(targetReport.consistencyError.message.length <= 200);

    // Checkpoint file on disk must be byte-for-byte identical to the page 1 snapshot
    assert.ok(capturedPage1Bytes !== null, "page 1 checkpoint must have been written");
    const afterFailureBytes = await readFile(progressFile, "utf8");
    assert.equal(
      afterFailureBytes,
      capturedPage1Bytes,
      "committed checkpoint file must remain byte-for-byte unchanged after page 2 consistency failure",
    );

    const saved = JSON.parse(afterFailureBytes);
    assert.equal(saved.targets.market.pagesProcessed, 1);
    assert.equal(saved.targets.market.eventsSent, 1);
    assert.equal(saved.targets.market.cursor, cursor1);
    assert.equal(saved.targets.market.completed, false);

    // Resuming against a consistent RPC completes cleanly from the preserved checkpoint
    let resumeCalls = 0;
    const healthyResumeServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5005 };
      },
      async getEvents(req) {
        resumeCalls += 1;
        if (resumeCalls === 1) {
          assert.equal(req.cursor, cursor1);
          return {
            events: [evPage1, evPage2],
            cursor: cursor3,
            latestLedger: 5005,
          };
        }
        return { events: [], cursor: cursor3, latestLedger: 5005 };
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
      deps: {
        config: fakeBotConfig(),
        server: healthyResumeServer,
        send: async (text) => {
          deliveries.push(text);
        },
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(deliveries.length, 2, "resumed run sends evPage2 once without duplicating evPage1");
  });
});

test("cursor regression and cursor-after-latest on resumed run keep existing checkpoint untouched", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");
    const cursor1 = makeCursor(4200, 3, 1);

    const seedServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        return {
          events: [
            claimCreatedEvent({
              ledger: 4200,
              claimId: 10,
              id: cursor1,
              pagingToken: cursor1,
            }),
          ],
          cursor: cursor1,
          latestLedger: 5000,
        };
      },
    };

    // Commit 1 page via --pages 1
    const seeded = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--pages",
        "1",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: seedServer, progress: () => {} },
    });
    assert.equal(seeded.exitCode, 0);
    const committedBefore = await readFile(progressFile, "utf8");

    // 1. Intra-ledger TOID cursor regression (4200 txIndex=1 < 4200 txIndex=3)
    const regressedCursorServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        return {
          events: [],
          cursor: makeCursor(4200, 1, 0),
          latestLedger: 5000,
        };
      },
    };

    const failRegressed = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: regressedCursorServer, progress: () => {} },
    });
    assert.equal(failRegressed.exitCode, 1);
    assert.equal(failRegressed.report.targets[0].consistencyError?.problem, "cursor-regressed");
    assert.equal(await readFile(progressFile, "utf8"), committedBefore);

    // 2. Cursor ahead of page latestLedger (5200 > 5000)
    const futureCursorServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        return {
          events: [],
          cursor: makeCursor(5200, 1, 0),
          latestLedger: 5000,
        };
      },
    };

    const failFuture = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: futureCursorServer, progress: () => {} },
    });
    assert.equal(failFuture.exitCode, 1);
    assert.equal(failFuture.report.targets[0].consistencyError?.problem, "cursor-after-latest");
    assert.equal(await readFile(progressFile, "utf8"), committedBefore);
  });
});

test("page 1 consistency failure writes no checkpoint file when none existed", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("unwritten-progress.json");
    const badPage1Server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        return {
          events: [
            claimCreatedEvent({ ledger: 4300, claimId: 1, id: makeCursor(4300, 1) }),
            claimCreatedEvent({ ledger: 4250, claimId: 2, id: makeCursor(4250, 1) }),
          ],
          cursor: makeCursor(4300, 1),
          latestLedger: 5000,
        };
      },
    };

    const res = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeBotConfig(), server: badPage1Server, progress: () => {} },
    });

    assert.equal(res.exitCode, 1);
    assert.equal(res.report.targets[0].consistencyError?.problem, "event-ledger-regressed");
    assert.equal(existsSync(progressFile), false, "failed page 1 must never create a progress file");
  });
});

test("validateReplayPageBounds enforces all monotonic invariants with bounded secret-free error messages", () => {
  const baseState = {
    source: "market",
    pageNumber: 2,
    minLatestLedger: 5000,
    minOldestLedger: 3000,
    requestStartLedger: null,
    previousCursor: makeCursor(4200, 1, 0),
    minEventLedger: 4200,
  };

  // Valid advancing page with inclusive boundary event at 4200 and advancing oldest/latest ledgers
  const ok = validateReplayPageBounds(
    {
      events: [{ ledger: 4200 }, { ledger: 4350 }],
      cursor: makeCursor(4350, 2, 0),
      oldestLedger: 3010,
      latestLedger: 5020,
    },
    baseState,
  );
  assert.deepEqual(ok, {
    latestLedger: 5020,
    oldestLedger: 3010,
    maxEventLedger: 4350,
  });

  // Inverted page window (oldestLedger > latestLedger)
  assert.throws(
    () =>
      validateReplayPageBounds(
        { events: [], cursor: "", oldestLedger: 5100, latestLedger: 5050 },
        baseState,
      ),
    (err) =>
      err instanceof ReplayPageConsistencyError &&
      err.problem === "inverted-page-window" &&
      err.message.length <= 200,
  );

  // Regressed oldestLedger
  assert.throws(
    () =>
      validateReplayPageBounds(
        { events: [], cursor: "", oldestLedger: 2999, latestLedger: 5020 },
        baseState,
      ),
    (err) =>
      err instanceof ReplayPageConsistencyError &&
      err.problem === "oldest-ledger-regressed",
  );

  // Event ledger above page latestLedger
  assert.throws(
    () =>
      validateReplayPageBounds(
        {
          events: [{ ledger: 5025 }],
          cursor: makeCursor(5020, 1, 0),
          latestLedger: 5020,
        },
        baseState,
      ),
    (err) =>
      err instanceof ReplayPageConsistencyError &&
      err.problem === "event-outside-page-window",
  );

  // Cursor regressed behind page's own max event ledger
  assert.throws(
    () =>
      validateReplayPageBounds(
        {
          events: [{ ledger: 4400 }],
          cursor: makeCursor(4300, 1, 0),
          latestLedger: 5020,
        },
        baseState,
      ),
    (err) =>
      err instanceof ReplayPageConsistencyError &&
      err.problem === "cursor-regressed",
  );

  // Hostile/oversized payload fields never leak into bounded error text
  const hostileMarker = "UNTRUSTED_RPC_MARKER_" + "X".repeat(500);
  assert.throws(
    () =>
      validateReplayPageBounds(
        {
          events: [{ ledger: -5, txHash: hostileMarker }],
          cursor: hostileMarker,
          latestLedger: 5020,
        },
        baseState,
      ),
    (err) =>
      err instanceof ReplayPageConsistencyError &&
      err.problem === "event-ledger-invalid" &&
      err.message.length <= 200 &&
      !err.message.includes("UNTRUSTED_RPC_MARKER_"),
  );
});
