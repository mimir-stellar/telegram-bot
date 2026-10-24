import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { Logger } from "../dist/logger.js";
import { createPoller } from "../dist/poller.js";
import { createRpcServer } from "../dist/stellar/client.js";
import {
  MOCK_MARKET_CONTRACT_ID,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";
import { malformedMockEvent, startMockRpc } from "../dist/stellar/mock-rpc.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const CHAT_ID = "-1009876543210";
const BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
const ALICE = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";
const BOB = "GC22MRUQSG6TWXMKANC7MDKBDOVZXB27774NYOINQKOCFUWIUBRTVNTV";

const marketEvent = (ledger, claimId) => ({
  source: "market",
  ledger,
  eventName: "claim_challenged",
  topics: [claimId, { address: ALICE }],
  fields: { stake: 20000000n },
});

const squadEvent = (ledger, marketId) => ({
  source: "squad",
  ledger,
  eventName: "deposited",
  topics: [marketId, 1, { address: BOB }],
  fields: { amount: 50000000n, shares: 49900000n },
});

function scenario(events, overrides = {}) {
  return {
    latestLedger: 1_000,
    oldestLedger: 900,
    ledgersPerPage: 50,
    events,
    ...overrides,
  };
}

function testConfig(dataDir, mock, overrides = {}) {
  return {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: mock.url,
    horizonUrl: "http://127.0.0.1:1/",
    networkPassphrase: "Local Mimir Mock ; Mimir Notifier",
    explorerBaseUrl: "http://127.0.0.1:1/",
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    chatIds: [CHAT_ID],
    routes: [{ chatId: CHAT_ID, channelPreviewMode: false }],
    operatorTelegramUserId: null,
    operatorTelegramUsername: null,
    pollIntervalMs: 1_000,
    interSendDelayMs: 0,
    startLookbackLedgers: 60,
    cursorFile: path.join(dataDir, "cursor.json"),
    statusFile: path.join(dataDir, "status.json"),
    auditFile: path.join(dataDir, "audit.jsonl"),
    countersFile: path.join(dataDir, "counters.json"),
    deadLetterFile: null,
    deadLetterMax: 100,
    deadLetterMaxAttempts: 5,
    lockFile: path.join(dataDir, "poller.lock"),
    maxNotificationsPerCycle: 20,
    shutdownTimeoutMs: 500,
    telegramSendTimeoutMs: 1_000,
    dedupWindow: 200,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 60_000,
    logSampleMaxPerWindow: 2,
    logSampleWindowMs: 60_000,
    ...overrides,
  };
}

function captureJsonLogs() {
  const lines = [];
  Logger.configure({
    format: "json",
    level: "info",
    sink: (_level, line) => lines.push(line),
  });
  return {
    lines,
    entries: () => lines.map((line) => JSON.parse(line)),
    clear: () => {
      lines.length = 0;
    },
  };
}

test("cycle summary: emits exactly one JSON Logger.info line per active cycle with per-target stats and cursorLedger", async () => {
  await withTempDataDir(async ({ root: dir }) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: scenario([
        marketEvent(980, 1),
        malformedMockEvent(985),
        squadEvent(990, 2),
      ]),
    });
    const cap = captureJsonLogs();
    let clockMs = 10_000;

    try {
      const cfg = testConfig(dir, mock);
      const sent = [];
      const poller = createPoller({
        config: cfg,
        server: createRpcServer(cfg),
        send: async (text, source) => {
          clockMs += 5;
          sent.push({ text, source });
        },
        now: () => {
          clockMs += 2;
          return clockMs;
        },
        sleep: async () => undefined,
      });

      await poller.runCycle();

      const entries = cap.entries();
      assert.equal(
        entries.length,
        1,
        `expected exactly 1 JSON Logger line for the cycle, got ${entries.length}: ${cap.lines.join("\n")}`,
      );

      const summary = entries[0];
      assert.equal(summary.level, "info");
      assert.equal(summary.component, "poller");
      assert.equal(summary.action, "cycle_summary");
      assert.equal(summary.cycle, 1);
      assert.equal(typeof summary.durationMs, "number");
      assert.ok(summary.durationMs >= 0);
      assert.equal(summary.suppressed, 0);

      assert.deepEqual(summary.targets.market, {
        source: "market",
        fetched: 2,
        decoded: 1,
        sent: 1,
        skipped: 1,
        cursorLedger: 1_000,
      });
      assert.deepEqual(summary.targets.squad, {
        source: "squad",
        fetched: 1,
        decoded: 1,
        sent: 1,
        skipped: 0,
        cursorLedger: 1_000,
      });

      const status = poller.status();
      const rawMarketCursor = status.targets.find((t) => t.source === "market")?.cursor;
      const rawSquadCursor = status.targets.find((t) => t.source === "squad")?.cursor;
      assert.ok(rawMarketCursor && rawMarketCursor.includes("-"));
      assert.ok(rawSquadCursor && rawSquadCursor.includes("-"));

      const rawLine = cap.lines[0];
      assert.equal(
        rawLine.includes(rawMarketCursor),
        false,
        "full market cursor value must never be logged",
      );
      assert.equal(
        rawLine.includes(rawSquadCursor),
        false,
        "full squad cursor value must never be logged",
      );
      assert.equal(
        rawLine.includes(CHAT_ID),
        false,
        "full chatId must never be logged in cycle summary",
      );
    } finally {
      Logger.reset();
      await mock.close();
    }
  });
});

test("cycle summary: idle cycles are sampled via LogSampler and report suppressed count on window rollover", async () => {
  await withTempDataDir(async ({ root: dir }) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: scenario([]),
    });
    const cap = captureJsonLogs();
    let clockMs = 1_000;

    try {
      const cfg = testConfig(dir, mock, {
        logSampleMaxPerWindow: 2,
        logSampleWindowMs: 60_000,
      });
      const poller = createPoller({
        config: cfg,
        server: createRpcServer(cfg),
        send: async () => undefined,
        now: () => clockMs,
        sleep: async () => undefined,
      });

      // Run 5 idle cycles within the same 60s sampling window.
      // Only the first 2 (logSampleMaxPerWindow = 2) should emit Logger.info lines;
      // cycles 3, 4, and 5 should be suppressed.
      for (let i = 0; i < 5; i += 1) {
        clockMs += 100;
        await poller.runCycle();
      }

      assert.equal(cap.entries().length, 2, "only maxPerWindow JSON lines logged in window");
      let summaries = cap.entries().filter((e) => e.action === "cycle_summary");
      assert.equal(summaries.length, 2);
      assert.equal(summaries[0].cycle, 1);
      assert.equal(summaries[0].suppressed, 0);
      assert.equal(summaries[1].cycle, 2);
      assert.equal(summaries[1].suppressed, 0);
      assert.equal(poller.status().suppressedLogs, 3);

      // Advance clock past the 60s sampling window and run cycle #6.
      clockMs += 60_000;
      await poller.runCycle();

      summaries = cap.entries().filter((e) => e.action === "cycle_summary");
      assert.equal(summaries.length, 3, "window rollover logs the next idle cycle summary");
      assert.equal(summaries[2].cycle, 6);
      assert.equal(
        summaries[2].suppressed,
        3,
        "reports the 3 suppressed idle cycles from previous window",
      );
      assert.match(summaries[2].msg, /suppressed 3 identical repeats in the previous 60s/);
    } finally {
      Logger.reset();
      await mock.close();
    }
  });
});

test("cycle summary: resume and cycle logs never expose full cursor strings or chatId", async () => {
  await withTempDataDir(async ({ root: dir }) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: scenario([marketEvent(992, 3)]),
    });
    const cap = captureJsonLogs();

    try {
      const cfg = testConfig(dir, mock);
      const firstPoller = createPoller({
        config: cfg,
        server: createRpcServer(cfg),
        send: async () => undefined,
        sleep: async () => undefined,
      });
      await firstPoller.runCycle();
      const savedCursor = firstPoller.status().targets.find((t) => t.source === "market")?.cursor;
      assert.ok(savedCursor, "first cycle persists a market cursor");

      cap.clear();
      const secondPoller = createPoller({
        config: cfg,
        server: createRpcServer(cfg),
        send: async () => undefined,
        sleep: async () => undefined,
      });
      await secondPoller.loadCursors();
      await secondPoller.runCycle();

      for (const line of cap.lines) {
        assert.equal(line.includes(savedCursor), false, `full cursor leaked in log line: ${line}`);
        assert.equal(line.includes(CHAT_ID), false, `full chatId leaked in log line: ${line}`);
      }

      const summary = cap.entries().find((e) => e.action === "cycle_summary");
      assert.ok(summary, "expected cycle_summary entry");
      assert.equal(summary.targets.market.cursorLedger, 1_000);
    } finally {
      Logger.reset();
      await mock.close();
    }
  });
});
