import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { ConfigError, loadConfig } from "../dist/config.js";
import { parseDigestCheckpoint } from "../dist/notifications/digest-grouping.js";
import { createPoller } from "../dist/poller.js";
import {
  claimChallengedEvent,
  claimCreatedEvent,
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  squadDepositedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const FAKE_TOKEN = ["123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghi"].join("_");

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

function makeConfig(dir, overrides = {}) {
  return {
    botToken: FAKE_TOKEN,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: dir.file("cursor.json"),
    digestFile: dir.file("digest-checkpoint.json"),
    maxNotificationsPerCycle: 20,
    shutdownTimeoutMs: 2_000,
    ...overrides,
  };
}

function createSequencedServer(steps) {
  let stepIndex = 0;
  return {
    advance() {
      stepIndex = Math.min(stepIndex + 1, steps.length - 1);
    },
    async getHealth() {
      const current = steps[stepIndex];
      return {
        status: "healthy",
        oldestLedger: 4_900,
        latestLedger: current.tip,
      };
    },
    async getEvents(req) {
      const current = steps[stepIndex];
      const contractId = req.filters?.[0]?.contractIds?.[0];
      const events =
        contractId === MARKET_CONTRACT
          ? (current.market ?? [])
          : (current.squad ?? []);
      return {
        events,
        cursor: makeCursor(current.tip),
        latestLedger: current.tip,
      };
    },
  };
}

test("scheduled digest buffers decoded events across cycles and flushes grouped digest at scheduled UTC boundary", async () => {
  await withTempDataDir(async (dir) => {
    let clockNow = Date.UTC(2026, 10, 15, 7, 50, 0); // 10m before daily@08:00
    const sentMessages = [];
    const server = createSequencedServer([
      {
        tip: 5_001,
        market: [
          claimCreatedEvent({ id: makeCursor(5_001, 1), ledger: 5_001, claimId: 7 }),
          claimChallengedEvent({
            id: makeCursor(5_001, 2),
            ledger: 5_001,
            claimId: 7,
            stake: 25_000_000n,
          }),
        ],
        squad: [
          squadDepositedEvent({
            id: makeCursor(5_001, 3),
            ledger: 5_001,
            marketId: 12,
            amount: 50_000_000n,
          }),
        ],
      },
      {
        tip: 5_002,
        market: [],
        squad: [],
      },
    ]);

    const poller = createPoller({
      config: makeConfig(dir, { digestSchedule: "daily@08:00", digestMaxPending: 10 }),
      server,
      send: async (text) => {
        sentMessages.push(text);
      },
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });

    await poller.runCycle();
    assert.equal(sentMessages.length, 0, "no immediate Telegram sends before scheduled window");
    assert.equal(poller.digestStatus().pendingCount, 3);
    assert.equal(poller.digestStatus().nextFlushAt, Date.UTC(2026, 10, 15, 8, 0, 0));

    // Verify bounded checkpoint persisted on disk with stringified bigints revived cleanly
    const checkpointRaw = await readFile(dir.file("digest-checkpoint.json"), "utf8");
    const parsedCp = parseDigestCheckpoint(checkpointRaw, 10);
    assert.equal(parsedCp.pendingEvents.length, 3);
    assert.equal(parsedCp.pendingEvents[1].payload.stake, 25_000_000n);

    // Advance clock to 08:00:00 UTC and run next cycle
    server.advance();
    clockNow = Date.UTC(2026, 10, 15, 8, 0, 0);
    await poller.runCycle();

    assert.equal(sentMessages.length, 1, "expected one grouped digest message at 08:00 UTC");
    assert.match(sentMessages[0], /\*Mimir Digest\* — 3 events in this cycle/);
    // Multi-event market:7 group gets grouped header + indented lines
    assert.match(sentMessages[0], /market:7/);
    assert.match(sentMessages[0], /  · mimir\\-market `claim\\_created` at ledger 5001/);
    assert.match(sentMessages[0], /  · mimir\\-market `claim\\_challenged` at ledger 5001/);
    // Singleton squad event stays unindented
    assert.match(sentMessages[0], /^· mimir\\-squad `deposited` at ledger 5001$/m);

    assert.equal(poller.digestStatus().pendingCount, 0);
    assert.equal(poller.digestStatus().lastFlushAt, Date.UTC(2026, 10, 15, 8, 0, 0));
    assert.equal(poller.digestStatus().nextFlushAt, Date.UTC(2026, 10, 16, 8, 0, 0));
  });
});

test("scheduled digest enforces digestMaxPending cap and reports omitted count on flush", async () => {
  await withTempDataDir(async (dir) => {
    let clockNow = Date.UTC(2026, 10, 15, 7, 55, 0);
    const sentMessages = [];
    const burst = Array.from({ length: 5 }, (_, idx) =>
      claimCreatedEvent({
        id: makeCursor(5_010, idx + 1),
        ledger: 5_010,
        claimId: 100 + idx,
      }),
    );
    const server = createSequencedServer([
      { tip: 5_010, market: burst, squad: [] },
      { tip: 5_011, market: [], squad: [] },
    ]);

    const poller = createPoller({
      config: makeConfig(dir, { digestSchedule: "daily@08:00", digestMaxPending: 2 }),
      server,
      send: async (text) => {
        sentMessages.push(text);
      },
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });

    await poller.runCycle();
    assert.equal(poller.digestStatus().pendingCount, 2);
    assert.equal(poller.digestStatus().droppedCount, 3);

    const cp = parseDigestCheckpoint(await readFile(dir.file("digest-checkpoint.json"), "utf8"), 2);
    assert.equal(cp.pendingEvents.length, 2);
    assert.equal(cp.droppedCount, 3);

    server.advance();
    clockNow = Date.UTC(2026, 10, 15, 8, 0, 0);
    await poller.runCycle();

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0], /\*Mimir Digest\* — 2 events in this cycle/);
    assert.match(sentMessages[0], /\+3 additional event\\\(s\\\) omitted/);
    assert.equal(poller.digestStatus().pendingCount, 0);
    assert.equal(poller.digestStatus().droppedCount, 0);
  });
});

test("restart recovery preserves pending checkpoint before due time and flushes missed window once after outage", async () => {
  await withTempDataDir(async (dir) => {
    let clockNow = Date.UTC(2026, 10, 15, 7, 30, 0);
    const sentMessages = [];

    // Instance 1: buffers 1 event at 07:30 UTC (nextFlushAt = 08:00 UTC) and stops
    const poller1 = createPoller({
      config: makeConfig(dir, { digestSchedule: "daily@08:00" }),
      server: createSequencedServer([
        {
          tip: 5_020,
          market: [
            claimChallengedEvent({
              id: makeCursor(5_020, 1),
              ledger: 5_020,
              claimId: 55,
              stake: 15_000_000n,
            }),
          ],
          squad: [],
        },
      ]),
      send: async (text) => {
        sentMessages.push(text);
      },
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });
    await poller1.runCycle();
    await poller1.shutdown({ timeoutMs: 1_000 });
    assert.equal(sentMessages.length, 0);

    // Instance 2: restarts at 07:45 UTC (still before 08:00 UTC), adds 2nd event on same claimId 55
    clockNow = Date.UTC(2026, 10, 15, 7, 45, 0);
    const poller2 = createPoller({
      config: makeConfig(dir, { digestSchedule: "daily@08:00" }),
      server: createSequencedServer([
        {
          tip: 5_021,
          market: [
            claimCreatedEvent({
              id: makeCursor(5_021, 1),
              ledger: 5_021,
              claimId: 55,
            }),
          ],
          squad: [],
        },
      ]),
      send: async (text) => {
        sentMessages.push(text);
      },
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });
    await poller2.loadCursors();
    await poller2.runCycle();
    await poller2.shutdown({ timeoutMs: 1_000 });
    assert.equal(sentMessages.length, 0, "still before 08:00 UTC after pre-window restart");
    assert.equal(poller2.digestStatus().pendingCount, 2);

    // Instance 3: restarts at 09:15 UTC AFTER missing the 08:00 UTC window — flushes once on cycle 1!
    clockNow = Date.UTC(2026, 10, 15, 9, 15, 0);
    const server3 = createSequencedServer([
      { tip: 5_022, market: [], squad: [] },
      { tip: 5_023, market: [], squad: [] },
    ]);
    const poller3 = createPoller({
      config: makeConfig(dir, { digestSchedule: "daily@08:00" }),
      server: server3,
      send: async (text) => {
        sentMessages.push(text);
      },
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });
    await poller3.loadCursors();
    await poller3.runCycle();

    assert.equal(sentMessages.length, 1, "missed window flushed once on restart recovery");
    assert.match(sentMessages[0], /\*Mimir Digest\* — 2 events in this cycle/);
    assert.match(sentMessages[0], /market:55/);

    // Subsequent cycle at 09:16 UTC must NOT duplicate the digest
    server3.advance();
    clockNow = Date.UTC(2026, 10, 15, 9, 16, 0);
    await poller3.runCycle();
    assert.equal(sentMessages.length, 1, "must not resend after missed-window recovery");
    assert.equal(poller3.digestStatus().nextFlushAt, Date.UTC(2026, 10, 16, 8, 0, 0));
  });
});

test("corrupt digest checkpoint is quarantined without wedging poller, and unset schedule keeps immediate sends", async () => {
  await withTempDataDir(async (dir) => {
    const digestPath = dir.file("digest-checkpoint.json");
    await writeFile(digestPath, "{not-valid-json", "utf8");

    const clockNow = Date.UTC(2026, 10, 15, 7, 0, 0);
    const poller = createPoller({
      config: makeConfig(dir, { digestSchedule: "daily@08:00" }),
      server: createSequencedServer([{ tip: 5_030, market: [], squad: [] }]),
      send: async () => undefined,
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });

    await poller.runCycle();
    const files = await readdir(dir.root);
    assert.ok(
      files.some((name) => name.startsWith("digest-checkpoint.json.corrupt.")),
      `expected quarantined corrupt checkpoint in ${files.join(", ")}`,
    );
    assert.equal(poller.digestStatus().pendingCount, 0);

    // Default mode (no digestSchedule): immediate send, zero checkpoint file created
    const immediateDigestPath = dir.file("unused-digest.json");
    const immediateSent = [];
    const livePoller = createPoller({
      config: makeConfig(dir, {
        cursorFile: dir.file("live-cursor.json"),
        digestFile: immediateDigestPath,
      }),
      server: createSequencedServer([
        {
          tip: 5_031,
          market: [claimCreatedEvent({ id: makeCursor(5_031, 1), ledger: 5_031, claimId: 99 })],
          squad: [],
        },
      ]),
      send: async (text) => {
        immediateSent.push(text);
      },
      now: () => clockNow,
      sleep: async () => undefined,
      persistAudit: false,
    });

    await livePoller.runCycle();
    assert.equal(immediateSent.length, 1);
    assert.equal(existsSync(immediateDigestPath), false);
  });
});

test("loadConfig validates DIGEST_SCHEDULE and rejects malformed schedule expressions", () => {
  const prev = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    MARKET_CONTRACT_ID: process.env.MARKET_CONTRACT_ID,
    SQUAD_CONTRACT_ID: process.env.SQUAD_CONTRACT_ID,
    DIGEST_SCHEDULE: process.env.DIGEST_SCHEDULE,
  };
  try {
    process.env.BOT_TOKEN = FAKE_TOKEN;
    process.env.TELEGRAM_CHAT_ID = "-1001234567890";
    process.env.MARKET_CONTRACT_ID = MARKET_CONTRACT;
    process.env.SQUAD_CONTRACT_ID = SQUAD_CONTRACT;
    process.env.DIGEST_SCHEDULE = "hourly@99:99";
    assert.throws(() => loadConfig(), ConfigError);

    process.env.DIGEST_SCHEDULE = "Weekly@Mon 09:30";
    const cfg = loadConfig();
    assert.equal(cfg.digestSchedule, "weekly@mon 09:30");
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
