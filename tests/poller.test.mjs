import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller } from "../dist/poller.js";

const baseConfig = {
  chatId: "-1001234567890",
  marketContractId: "market",
  squadContractId: "squad",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  pollIntervalMs: 30_000,
  startLookbackLedgers: 60,
  maxNotificationsPerCycle: 20,
};

function event(source, ledger) {
  return {
    source,
    contractId: source,
    ledger,
    txHash: "",
    at: 0,
    eventId: `${ledger}-0`,
    payload: { name: "claim_cancelled", claimId: ledger },
  };
}

async function withPoller(readEvents, send, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-telegram-poller-"));
  const poller = createPoller({
    config: {
      ...baseConfig,
      cursorFile: path.join(directory, "cursor.json"),
      ...options,
    },
    server: {},
    readEvents,
    send,
    sendSpacingMs: 0,
  });

  try {
    await poller.pollOnce();
    return { poller, cursor: await readFile(path.join(directory, "cursor.json"), "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("poller sends every event and commits both cursors after a successful batch", async () => {
  const sent = [];
  const result = await withPoller(
    async (_server, target) => ({
      events: [event(target.source, target.source === "market" ? 10 : 20)],
      cursor: `${target.source}-cursor`,
      lastEventLedger: target.source === "market" ? 10 : 20,
      latestLedger: 20,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async (text) => sent.push(text),
  );

  assert.equal(sent.length, 2);
  assert.equal(result.poller.status().notificationsSent, 2);
  assert.match(result.cursor, /"cursor": "market-cursor"/);
  assert.match(result.cursor, /"cursor": "squad-cursor"/);
});

test("one failed Telegram send does not prevent later events or cursor advancement", async () => {
  const sent = [];
  let attempts = 0;
  const result = await withPoller(
    async (_server, target) => ({
      events: target.source === "market" ? [event("market", 10), event("market", 11)] : [],
      cursor: `${target.source}-cursor`,
      lastEventLedger: target.source === "market" ? 11 : null,
      latestLedger: 11,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async (text) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Telegram rate limit");
      sent.push(text);
    },
  );

  assert.equal(sent.length, 1);
  assert.equal(result.poller.status().notificationsFailed, 1);
  assert.match(result.cursor, /"cursor": "market-cursor"/);
});

test("notification cap skips the remainder of a burst without changing the scan cursor", async () => {
  const sent = [];
  const result = await withPoller(
    async (_server, target) => ({
      events: target.source === "market" ? [event("market", 1), event("market", 2), event("market", 3)] : [],
      cursor: `${target.source}-cursor`,
      lastEventLedger: target.source === "market" ? 3 : null,
      latestLedger: 3,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async (text) => sent.push(text),
    { maxNotificationsPerCycle: 1 },
  );

  assert.equal(sent.length, 1);
  assert.equal(result.poller.status().eventsSkipped, 2);
  assert.match(result.cursor, /"cursor": "market-cursor"/);
});

test("repeated send failures remain observable while the poller completes the cycle", async () => {
  const result = await withPoller(
    async (_server, target) => ({
      events: target.source === "market" ? [event("market", 1), event("market", 2)] : [],
      cursor: `${target.source}-cursor`,
      lastEventLedger: target.source === "market" ? 2 : null,
      latestLedger: 2,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async () => {
      throw new Error("Telegram unavailable");
    },
  );

  assert.equal(result.poller.status().notificationsSent, 0);
  assert.equal(result.poller.status().notificationsFailed, 2);
  assert.match(result.cursor, /"cursor": "market-cursor"/);
});

test("notification cap applies across both watched contracts", async () => {
  const sent = [];
  const result = await withPoller(
    async (_server, target) => ({
      events: [
        event(target.source, target.source === "market" ? 31 : 41),
        event(target.source, target.source === "market" ? 32 : 42),
      ],
      cursor: `${target.source}-cursor`,
      lastEventLedger: target.source === "market" ? 32 : 42,
      latestLedger: 42,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async (text) => sent.push(text),
    { maxNotificationsPerCycle: 2 },
  );

  assert.equal(sent.length, 2);
  assert.equal(result.poller.status().eventsSkipped, 2);
});
