import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller } from "../src/poller.ts";

const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function config(cursorFile, maxNotificationsPerCycle = 20) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://rpc.example.test",
    horizonUrl: "https://horizon.example.test",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "token",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle,
  };
}

function event(source, ledger) {
  return {
    source,
    contractId: source,
    ledger,
    txHash: "",
    at: 0,
    eventId: `${ledger}-0`,
    payload: { name: "claim_created", claimId: ledger, creator: ADDRESS, category: "test" },
  };
}

function scan(source, events, cursor = `${events.at(-1)?.ledger ?? 0}-0`) {
  return {
    source,
    events,
    cursor,
    latestLedger: 100,
    oldestLedger: 1,
    lastEventLedger: events.at(-1)?.ledger ?? null,
    truncated: false,
    pages: 1,
  };
}

async function withPoller(setup, check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-bot-poller-"));
  try {
    const poller = createPoller({
      ...setup,
      config: config(path.join(directory, "cursor.json"), setup.maxNotificationsPerCycle ?? 20),
      server: {},
      sendSpacingMs: 0,
    });
    await poller.pollOnce();
    await check(poller);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("advances both cursors after a fully successful batch", async () => {
  const sent = [];
  await withPoller({
    send: async (text) => sent.push(text),
    readEvents: async (_server, target) => scan(target.source, [event(target.source, target.source === "market" ? 10 : 20)]),
  }, async (poller) => {
    const status = poller.status();
    assert.equal(sent.length, 2);
    assert.equal(status.notificationsSent, 2);
    assert.equal(status.notificationsFailed, 0);
    assert.deepEqual(status.targets.map((target) => target.cursor), ["10-0", "20-0"]);
  });
});

test("keeps the batch moving when Telegram rejects one message", async () => {
  const sent = [];
  let calls = 0;
  await withPoller({
    send: async (text) => {
      if (calls++ === 0) throw new Error("429: retry exhausted");
      sent.push(text);
    },
    readEvents: async (_server, target) => scan(target.source, [event(target.source, target.source === "market" ? 11 : 21)]),
  }, async (poller) => {
    const status = poller.status();
    assert.equal(sent.length, 1);
    assert.equal(status.notificationsSent, 1);
    assert.equal(status.notificationsFailed, 1);
    assert.deepEqual(status.targets.map((target) => target.cursor), ["11-0", "21-0"]);
  });
});

test("counts events beyond the notification cap as skipped", async () => {
  const sent = [];
  await withPoller({
    maxNotificationsPerCycle: 2,
    send: async (text) => sent.push(text),
    readEvents: async (_server, target) => scan(target.source, [
      event(target.source, 31),
      event(target.source, 32),
    ]),
  }, async (poller) => {
    const status = poller.status();
    assert.equal(sent.length, 2);
    assert.equal(status.notificationsSent, 2);
    assert.equal(status.eventsSkipped, 2);
    assert.deepEqual(status.targets.map((target) => target.cursor), ["32-0", "32-0"]);
  });
});
