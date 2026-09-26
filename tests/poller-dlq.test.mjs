import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller } from "../dist/poller.js";

const CONTRACT = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

function baseConfig(directory, overrides = {}) {
  return {
    marketContractId: CONTRACT,
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: path.join(directory, "cursor.json"),
    maxNotificationsPerCycle: 20,
    deadLetterFile: path.join(directory, "dead-letter.json"),
    deadLetterMax: 10,
    deadLetterMaxAttempts: 5,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function cancelledEvent(source, ledger) {
  return {
    source,
    contractId: source === "market" ? CONTRACT : "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    ledger,
    txHash: "abc",
    at: 0,
    eventId: `${ledger}-0`,
    payload: { name: "claim_cancelled", claimId: ledger },
  };
}

async function withPoller(readEvents, send, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-poller-dlq-"));
  let clock = 1_700_000_000_000;
  const poller = createPoller({
    config: baseConfig(directory, options.config),
    server: {},
    readEvents,
    send,
    sleep: async () => undefined,
    now: () => clock,
    sendSpacingMs: 0,
    maxSendRetries: options.maxSendRetries ?? 1,
  });

  try {
    await poller.pollOnce();
    return {
      poller,
      directory,
      tick: (ms = 1_000) => {
        clock += ms;
      },
      reread: async () => {
        await poller.pollOnce();
      },
    };
  } catch (err) {
    await rm(directory, { recursive: true, force: true });
    throw err;
  }
}

test("failed Telegram send enqueues DLQ and still advances the cursor", async () => {
  const ctx = await withPoller(
    async (_server, target) => ({
      events: target.source === "market" ? [cancelledEvent("market", 10)] : [],
      cursor: `${target.source}-cursor`,
      lastEventLedger: target.source === "market" ? 10 : null,
      latestLedger: 10,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async () => {
      throw new Error("Telegram rate limit");
    },
  );

  try {
    const status = ctx.poller.status();
    assert.equal(status.notificationsFailed, 1);
    assert.equal(status.deadLetter.depth, 1);
    assert.equal(status.deadLetter.enqueued, 1);

    const cursor = await readFile(path.join(ctx.directory, "cursor.json"), "utf8");
    assert.match(cursor, /"cursor": "market-cursor"/);

    const dlq = JSON.parse(
      await readFile(path.join(ctx.directory, "dead-letter.json"), "utf8"),
    );
    assert.equal(dlq.entries.length, 1);
    assert.equal(dlq.entries[0].eventName, "claim_cancelled");
    assert.equal(JSON.stringify(dlq).includes("SECRET-TOKEN"), false);
  } finally {
    ctx.poller.stop();
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test("next cycle replays the dead-letter entry after Telegram recovers", async () => {
  let fail = true;
  const sent = [];
  const ctx = await withPoller(
    async (_server, target) => ({
      events: target.source === "market" && fail ? [cancelledEvent("market", 11)] : [],
      cursor: `${target.source}-cursor-${fail ? 1 : 2}`,
      lastEventLedger: target.source === "market" ? 11 : null,
      latestLedger: 11,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async (text) => {
      if (fail) throw new Error("down");
      sent.push(text);
    },
  );

  try {
    assert.equal(ctx.poller.status().deadLetter.depth, 1);
    fail = false;
    ctx.tick();
    await ctx.reread();

    assert.equal(ctx.poller.status().deadLetter.depth, 0);
    assert.equal(ctx.poller.status().deadLetter.replayed, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /cancelled|Claim/i);
  } finally {
    ctx.poller.stop();
    await rm(ctx.directory, { recursive: true, force: true });
  }
});

test("DLQ depth survives a poller restart from the same file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-poller-dlq-restart-"));
  const readEvents = async (_server, target) => ({
    events: target.source === "market" ? [cancelledEvent("market", 20)] : [],
    cursor: `${target.source}-cursor`,
    lastEventLedger: target.source === "market" ? 20 : null,
    latestLedger: 20,
    oldestLedger: 1,
    truncated: false,
    pages: 1,
  });

  try {
    const first = createPoller({
      config: baseConfig(directory),
      server: {},
      readEvents,
      send: async () => {
        throw new Error("down");
      },
      sleep: async () => undefined,
      now: () => 1_700_000_000_000,
      sendSpacingMs: 0,
      maxSendRetries: 1,
    });
    await first.pollOnce();
    first.stop();
    assert.equal(first.status().deadLetter.depth, 1);

    const second = createPoller({
      config: baseConfig(directory),
      server: {},
      readEvents: async (_server, target) => ({
        events: [],
        cursor: `${target.source}-cursor`,
        lastEventLedger: null,
        latestLedger: 20,
        oldestLedger: 1,
        truncated: false,
        pages: 1,
      }),
      send: async () => {
        throw new Error("still down");
      },
      sleep: async () => undefined,
      now: () => 1_700_000_001_000,
      sendSpacingMs: 0,
      maxSendRetries: 1,
    });
    await second.pollOnce();
    assert.equal(second.status().deadLetter.depth, 1);
    second.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful sends never touch the dead-letter file", async () => {
  const ctx = await withPoller(
    async (_server, target) => ({
      events: target.source === "market" ? [cancelledEvent("market", 3)] : [],
      cursor: `${target.source}-ok`,
      lastEventLedger: target.source === "market" ? 3 : null,
      latestLedger: 3,
      oldestLedger: 1,
      truncated: false,
      pages: 1,
    }),
    async () => undefined,
  );

  try {
    assert.equal(ctx.poller.status().notificationsSent, 1);
    assert.equal(ctx.poller.status().deadLetter.depth, 0);
    assert.equal(ctx.poller.status().notificationsFailed, 0);
  } finally {
    ctx.poller.stop();
    await rm(ctx.directory, { recursive: true, force: true });
  }
});
