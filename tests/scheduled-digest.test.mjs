/**
 * Focused tests for scheduled digests wired into the live poller:
 * - Buffering & grouped digest delivery on schedule (using digest-grouping + schedule)
 * - Bounded pending state (FIFO eviction when DIGEST_MAX_PENDING is exceeded)
 * - Persisted checkpoint & restart behavior (missed-window flush + BigInt round-trip)
 * - Failure handling (failed Telegram send retains pending events for next run)
 * - Corrupt checkpoint quarantine & clean cold start
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPoller } from "../dist/poller.js";
import { createDigestCheckpoint } from "../dist/notifications/digest-checkpoint.js";
import {
  claimChallengedEvent,
  claimCreatedEvent,
  CREATOR,
  MARKET_CONTRACT as MARKET_ID,
  SQUAD_CONTRACT as SQUAD_ID,
} from "./fixtures/events.mjs";

async function waitUntil(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("fake clock: timed out waiting for condition");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fakeClock(startMs) {
  let now = startMs;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimeout(cb, delay) {
      const id = nextId++;
      timers.set(id, { cb, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advanceTo(target) {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, t] = due[0];
        timers.delete(id);
        now = t.at;
        t.cb();
        await waitUntil(() => timers.size > 0);
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}

function rawClaimCreated(id, ledger, claimId, category = "crypto") {
  return claimCreatedEvent({
    id,
    pagingToken: `${String(ledger).padStart(10, "0")}-0000000001`,
    ledger,
    claimId,
    category,
  });
}

function rawClaimChallenged(id, ledger, claimId, stake = 50_000_000n) {
  return claimChallengedEvent({
    id,
    pagingToken: `${String(ledger).padStart(10, "0")}-0000000002`,
    ledger,
    claimId,
    stake,
  });
}

function makeFakeServer(marketEvents = [], squadEvents = []) {
  let marketServed = false;
  let squadServed = false;
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: 1, latestLedger: 200 };
    },
    async getEvents(req) {
      const contractId = req.filters?.[0]?.contractIds?.[0];
      if (contractId === MARKET_ID && !marketServed) {
        marketServed = true;
        return { events: marketEvents, latestLedger: 200, cursor: "0000000200-0000000001" };
      }
      if (contractId === SQUAD_ID && !squadServed) {
        squadServed = true;
        return { events: squadEvents, latestLedger: 200, cursor: "0000000200-0000000001" };
      }
      return { events: [], latestLedger: 200, cursor: "0000000200-0000000001" };
    },
  };
}

function makeConfig(dir, overrides = {}) {
  return {
    locale: "en",
    version: "0.1.0",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: null,
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "http://127.0.0.1:8420",
    horizonUrl: "http://127.0.0.1:8421",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    pollIntervalMs: 60_000,
    startLookbackLedgers: 10,
    cursorFile: path.join(dir, "cursor.json"),
    countersFile: path.join(dir, "counters.json"),
    lockFile: path.join(dir, "poller.lock"),
    statusFile: path.join(dir, "status.json"),
    maxNotificationsPerCycle: 20,
    interSendDelayMs: 0,
    metricsPort: null,
    notificationCategories: [],
    silentEvents: [],
    csvOutputFile: path.join(dir, "scanner.csv"),
    featureFlags: { enabled: true, market: true, squad: true },
    auditFile: "",
    dedupWindow: 256,
    deadLetterFile: "",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    sendJournalFile: "",
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 0,
    startupHealthDeadlineMs: 0,
    startupHealthRetryMs: 0,
    shutdownTimeoutMs: 2_000,
    telegramSendTimeoutMs: 5_000,
    logBufferLines: 0,
    logSampleMaxPerWindow: 3,
    logSampleWindowMs: 300_000,
    channelPreviewMode: false,
    linkPreviewMarket: false,
    linkPreviewSquad: false,
    ...overrides,
  };
}

test("poller buffers events and delivers a grouped digest on schedule", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-digest-poller-"));
  try {
    const checkpointFile = path.join(dir, "digest-checkpoint.json");
    const clock = fakeClock(Date.UTC(2024, 0, 1, 8, 30, 0));
    const sent = [];

    const poller = createPoller({
      config: makeConfig(dir, {
        digestSchedule: "daily@09:00",
        digestCheckpointFile: checkpointFile,
        digestMaxPending: 50,
      }),
      server: makeFakeServer([
        rawClaimCreated("ev-1", 101, 42),
        rawClaimChallenged("ev-2", 102, 42, 25_000_000n),
      ]),
      send: async (text) => {
        sent.push(text);
      },
      persistAudit: false,
      now: () => clock.now(),
      sleep: async () => {},
      schedulerClock: clock,
    });

    await poller.start();
    try {
      // Wait for the first poll cycle to complete.
      await waitUntil(() => poller.status().lastSuccessAt !== null);

      // Events are buffered, NOT sent immediately.
      assert.equal(sent.length, 0);
      const saved = JSON.parse(await readFile(checkpointFile, "utf8"));
      assert.equal(saved.version, 1);
      assert.equal(saved.pending.length, 2);

      // Advance clock to the 09:00 UTC boundary: grouped digest fires once.
      await clock.advanceTo(Date.UTC(2024, 0, 1, 9, 0, 0));
      assert.equal(sent.length, 1);
      assert.match(sent[0], /\*Mimir Digest\* — 2 events in this cycle/);
      assert.match(sent[0], /market:42/);
      assert.match(sent[0], /claim\\_created/);
      assert.match(sent[0], /claim\\_challenged/);

      // Checkpoint is cleared and lastRunMs is persisted.
      const after = JSON.parse(await readFile(checkpointFile, "utf8"));
      assert.equal(after.pending.length, 0);
      assert.equal(after.lastRunMs, Date.UTC(2024, 0, 1, 9, 0, 0));
    } finally {
      await poller.shutdown();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("digest checkpoint enforces DIGEST_MAX_PENDING bound with FIFO eviction", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-digest-bound-"));
  try {
    const checkpointFile = path.join(dir, "digest-checkpoint.json");
    const cp = createDigestCheckpoint({ filePath: checkpointFile, maxPending: 2 });
    await cp.load();

    for (let i = 1; i <= 4; i++) {
      cp.enqueue({
        source: "market",
        ledger: 100 + i,
        txHash: `tx-${i}`,
        txIndex: 0,
        opIndex: 0,
        eventId: `ev-${i}`,
        pagingToken: `000000010${i}-0000000001`,
        payload: { name: "claim_challenged", claimId: i, challenger: CREATOR, stake: BigInt(i) * 10n },
      });
    }
    await cp.flush();

    assert.deepEqual(cp.stats(), {
      pending: 2,
      dropped: 2,
      lastRunMs: null,
      maxPending: 2,
    });
    assert.deepEqual(
      cp.snapshotPending().map((e) => e.eventId),
      ["ev-3", "ev-4"],
    );

    // Reload from disk and verify BigInt payload survived JSON round-trip.
    const reloaded = createDigestCheckpoint({ filePath: checkpointFile, maxPending: 2 });
    await reloaded.load();
    const pending = reloaded.snapshotPending();
    assert.equal(pending.length, 2);
    assert.equal(pending[0].payload.stake, 30n);
    assert.equal(pending[1].payload.stake, 40n);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restart after missed scheduled boundary flushes persisted pending digest once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-digest-restart-"));
  try {
    const checkpointFile = path.join(dir, "digest-checkpoint.json");

    // Simulate a previous run that completed at 09:00 on Jan 1 and buffered
    // one event before shutting down.
    const cp = createDigestCheckpoint({ filePath: checkpointFile, maxPending: 10 });
    await cp.load();
    await cp.write(Date.UTC(2024, 0, 1, 9, 0, 0));
    cp.enqueue({
      source: "market",
      ledger: 150,
      txHash: "tx-restart",
      txIndex: 0,
      opIndex: 0,
      eventId: "ev-restart-1",
      pagingToken: "0000000150-0000000001",
      payload: { name: "claim_created", claimId: 7, creator: CREATOR, category: "sports" },
    });
    await cp.flush();

    // New poller starts on Jan 2 at 11:00 UTC (missed Jan 2 09:00 boundary).
    const clock = fakeClock(Date.UTC(2024, 0, 2, 11, 0, 0));
    const sent = [];
    const poller = createPoller({
      config: makeConfig(dir, {
        digestSchedule: "daily@09:00",
        digestCheckpointFile: checkpointFile,
      }),
      server: makeFakeServer([], []),
      send: async (text) => {
        sent.push(text);
      },
      persistAudit: false,
      now: () => clock.now(),
      sleep: async () => {},
      schedulerClock: clock,
    });

    await poller.start();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /\*Mimir Digest\* — 1 events in this cycle/);
    assert.match(sent[0], /claim\\_created/);

    const after = JSON.parse(await readFile(checkpointFile, "utf8"));
    assert.equal(after.pending.length, 0);
    assert.equal(after.lastRunMs, Date.UTC(2024, 0, 2, 11, 0, 0));

    await poller.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed scheduled digest send keeps pending events for the next boundary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-digest-fail-"));
  try {
    const checkpointFile = path.join(dir, "digest-checkpoint.json");
    const clock = fakeClock(Date.UTC(2024, 0, 1, 8, 30, 0));
    let shouldFail = true;
    const sent = [];

    const poller = createPoller({
      config: makeConfig(dir, {
        digestSchedule: "daily@09:00",
        digestCheckpointFile: checkpointFile,
      }),
      server: makeFakeServer([rawClaimCreated("ev-fail-1", 110, 99)]),
      send: async (text) => {
        if (shouldFail) throw new Error("telegram 503");
        sent.push(text);
      },
      sendOptions: { maxSendRetries: 1 },
      persistAudit: false,
      now: () => clock.now(),
      sleep: async () => {},
      schedulerClock: clock,
    });

    await poller.start();
    try {
      await waitUntil(() => poller.status().lastSuccessAt !== null);

      // First boundary fails: pending event is preserved, lastRunMs stays null.
      await clock.advanceTo(Date.UTC(2024, 0, 1, 9, 0, 0));
      assert.equal(sent.length, 0);
      const afterFail = JSON.parse(await readFile(checkpointFile, "utf8"));
      assert.equal(afterFail.pending.length, 1);
      assert.equal(afterFail.lastRunMs, null);

      // Next boundary succeeds: preserved event is delivered.
      shouldFail = false;
      await clock.advanceTo(Date.UTC(2024, 0, 2, 9, 0, 0));
      assert.equal(sent.length, 1);
      assert.match(sent[0], /claim\\_created/);

      const afterSuccess = JSON.parse(await readFile(checkpointFile, "utf8"));
      assert.equal(afterSuccess.pending.length, 0);
      assert.equal(afterSuccess.lastRunMs, Date.UTC(2024, 0, 2, 9, 0, 0));
    } finally {
      await poller.shutdown();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt digest checkpoint is quarantined and treated as a clean cold start", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-digest-corrupt-"));
  try {
    const checkpointFile = path.join(dir, "digest-checkpoint.json");
    await writeFile(checkpointFile, "{not-valid-json", "utf8");

    const cp = createDigestCheckpoint({ filePath: checkpointFile, maxPending: 10 });
    await cp.load();

    assert.deepEqual(cp.stats(), {
      pending: 0,
      dropped: 0,
      lastRunMs: null,
      maxPending: 10,
    });

    const files = await readdir(dir);
    assert.ok(
      files.some((f) => f.startsWith("digest-checkpoint.json.corrupt.")),
      `expected corrupt file quarantine in ${files.join(", ")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
