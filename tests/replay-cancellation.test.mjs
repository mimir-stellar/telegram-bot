import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REPLAY_EXIT_CANCELLED,
  REPLAY_EXIT_OK,
  runReplayCli,
} from "../dist/replay-cli.js";
import {
  claimCreatedEvent,
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeBotConfig(overrides = {}) {
  const tokenParts = ["123456", "SYNTHETIC_BOT_CREDENTIAL_FOR_TEST"];
  return {
    botToken: tokenParts.join(":"),
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

test("SIGINT mid-page exits with REPLAY_EXIT_CANCELLED (130), flushes only committed progress, and marks resumable", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");
    const signalEmitter = new EventEmitter();

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const c3 = makeCursor(4300, 1);
    const c4 = makeCursor(4400, 1);

    const evA = claimCreatedEvent({ ledger: 4100, claimId: 1, id: c1, pagingToken: c1 });
    const evB = claimCreatedEvent({ ledger: 4200, claimId: 2, id: c2, pagingToken: c2 });
    const evC = claimCreatedEvent({ ledger: 4300, claimId: 3, id: c3, pagingToken: c3 });
    const evD = claimCreatedEvent({ ledger: 4400, claimId: 4, id: c4, pagingToken: c4 });

    let marketCalls = 0;
    let squadCalls = 0;
    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents(req) {
        const cid = req?.filters?.[0]?.contractIds?.[0];
        if (cid === SQUAD_CONTRACT) {
          squadCalls += 1;
          return { events: [], cursor: makeCursor(5000), latestLedger: 5000 };
        }
        marketCalls += 1;
        if (marketCalls === 1) {
          // Page 1 completes cleanly and commits c2
          return { events: [evA, evB], cursor: c2, latestLedger: 5000 };
        }
        // Page 2 has two events [evC, evD] and next cursor c4, interrupted mid-page
        return { events: [evC, evD], cursor: c4, latestLedger: 5000 };
      },
    };

    const logs = [];
    const sent = [];
    const send = async (text, source) => {
      sent.push({ text, source });
      // After Page 1's 2 events committed, emit SIGINT right during evC on Page 2
      if (sent.length === 3) {
        signalEmitter.emit("SIGINT");
      }
    };

    const result = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--send",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server,
        send,
        signalSource: signalEmitter,
        now: () => 1_750_000_000_000,
        progress: (...args) => logs.push(args.join(" ")),
      },
    });

    assert.equal(result.exitCode, REPLAY_EXIT_CANCELLED);
    assert.equal(result.exitCode, 130);
    assert.notEqual(result.exitCode, REPLAY_EXIT_OK);

    // Must never report success ("[replay] done")
    assert.ok(!logs.some((line) => line.startsWith("[replay] done")));
    assert.ok(logs.some((line) => line.includes("cancelled (SIGINT)") && line.includes("resumable=true")));

    // evD on Page 2 and the entire squad target were never executed
    assert.equal(sent.length, 3);
    assert.equal(squadCalls, 0);
    assert.equal(signalEmitter.listenerCount("SIGINT"), 0);

    // Report exposes explicit cancellation & resumable status and committed-only totals
    assert.equal(result.report.status, "cancelled");
    assert.equal(result.report.cancelled, true);
    assert.equal(result.report.resumable, true);
    assert.equal(result.report.totals.events, 2, "report totals must reflect committed Page 1 only");
    assert.equal(result.report.totals.sent, 2, "uncommitted mid-page send must not be counted as committed");

    // Progress file on disk holds ONLY committed Page 1 state + explicit resumable status
    const saved = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.resumable, true);
    assert.equal(typeof saved.cancelledAt, "string");
    assert.equal(saved.targets.market.pagesProcessed, 1);
    assert.equal(saved.targets.market.eventsProcessed, 2);
    assert.equal(saved.targets.market.eventsSent, 2);
    assert.equal(saved.targets.market.cursor, c2, "uncommitted cursor c4 must not overwrite committed cursor c2");
    assert.equal(saved.targets.market.lastProcessedEventId, c2);
    assert.equal(saved.targets.market.completed, false);
    assert.equal(saved.targets.squad, undefined);
  });
});

test("cancelled progress file resumes cleanly from committed checkpoint and clears cancelled status", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("resume-after-cancel.json");
    const signalEmitter = new EventEmitter();

    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const cTip = makeCursor(5000, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 11, id: c1, pagingToken: c1 });
    const ev2 = claimCreatedEvent({ ledger: 4200, claimId: 12, id: c2, pagingToken: c2 });

    let page1Calls = 0;
    const serverRun1 = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        page1Calls += 1;
        if (page1Calls === 1) {
          return { events: [ev1], cursor: c1, latestLedger: 5000 };
        }
        // Cancel when RPC returns Page 2 before Page 2 commits
        signalEmitter.emit("SIGINT");
        return { events: [ev2], cursor: cTip, latestLedger: 5000 };
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
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: serverRun1,
        signalSource: signalEmitter,
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, REPLAY_EXIT_CANCELLED);
    const afterCancel = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(afterCancel.status, "cancelled");
    assert.equal(afterCancel.resumable, true);
    assert.equal(afterCancel.targets.market.cursor, c1);

    // Resume run 2 without SIGINT: must start from c1 and finish cleanly
    const requestedCursors = [];
    const serverRun2 = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents(req) {
        requestedCursors.push(req.cursor);
        return { events: [ev1, ev2], cursor: cTip, latestLedger: 5000 };
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
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: serverRun2,
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, REPLAY_EXIT_OK);
    assert.equal(run2.report.status, "completed");
    assert.equal(run2.report.cancelled, false);
    assert.equal(run2.report.resumable, false);
    assert.deepEqual(requestedCursors, [c1]);
    assert.equal(run2.report.totals.events, 2);

    const afterResume = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(afterResume.status, "completed");
    assert.equal(afterResume.resumable, false);
    assert.equal(afterResume.cancelledAt, null);
    assert.equal(afterResume.targets.market.completed, true);
  });
});

test("SIGINT on first page before any commit writes empty targets with status=cancelled and resumable=true", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("first-page-cancel.json");
    const signalEmitter = new EventEmitter();
    const c1 = makeCursor(4100, 1);
    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 99, id: c1, pagingToken: c1 });

    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        signalEmitter.emit("SIGINT");
        return { events: [ev1], cursor: c1, latestLedger: 5000 };
      },
    };

    const res = await runReplayCli({
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
      deps: {
        config: fakeBotConfig(),
        server,
        signalSource: signalEmitter,
        progress: () => {},
      },
    });

    assert.equal(res.exitCode, REPLAY_EXIT_CANCELLED);
    assert.equal(res.report.totals.events, 0);

    const saved = JSON.parse(await readFile(progressFile, "utf8"));
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.resumable, true);
    assert.deepEqual(saved.targets, {});
  });
});

test("SIGINT interrupts in-flight --rpm budget sleep immediately and cleans up listeners", async () => {
  const signalEmitter = new EventEmitter();
  let getEventsCalls = 0;

  const server = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
    },
    async getEvents() {
      getEventsCalls += 1;
      return { events: [], cursor: makeCursor(5000), latestLedger: 5000 };
    },
  };

  // Never-resolving sleep; SIGINT fires as soon as rate-limiter enters sleep
  const hangingSleep = () => {
    setImmediate(() => signalEmitter.emit("SIGINT"));
    return new Promise(() => {});
  };

  const res = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--contract", "market", "--rpm", "1"],
    deps: {
      config: fakeBotConfig(),
      server,
      sleep: hangingSleep,
      now: () => 10_000,
      signalSource: signalEmitter,
      progress: () => {},
    },
  });

  assert.equal(res.exitCode, REPLAY_EXIT_CANCELLED);
  assert.equal(getEventsCalls, 0, "getEvents must not run after budget sleep is cancelled");
  assert.equal(signalEmitter.listenerCount("SIGINT"), 0);
});

test("pre-aborted AbortSignal exits 130 immediately without calling getHealth or getEvents", async () => {
  const ac = new AbortController();
  ac.abort("SIGINT");

  let rpcTouched = false;
  const server = {
    async getHealth() {
      rpcTouched = true;
      return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
    },
    async getEvents() {
      rpcTouched = true;
      return { events: [], cursor: "", latestLedger: 5000 };
    },
  };

  const res = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--contract", "market"],
    deps: {
      config: fakeBotConfig(),
      server,
      signal: ac.signal,
      progress: () => {},
    },
  });

  assert.equal(res.exitCode, REPLAY_EXIT_CANCELLED);
  assert.equal(rpcTouched, false);
  assert.equal(res.report.status, "cancelled");
  assert.equal(res.report.resumable, true);
});
