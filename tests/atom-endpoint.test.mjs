import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { startHealthServer } from "../dist/health.js";

const AUTH_TOKEN = ["atom-feed", "-token"].join("");

const MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const SQUAD = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";
const TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

function baseConfig(overrides = {}) {
  return {
    marketContractId: MARKET,
    squadContractId: SQUAD,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-atom-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    atomFeedEnabled: false,
    atomFeedMaxEntries: 50,
    atomFeedSelfUrl: null,
    ...overrides,
  };
}

function baseStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 1,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

function makeEvent(seq) {
  return {
    source: "market",
    contractId: MARKET,
    version: "v1",
    ledger: 1000 + seq,
    txHash: TX,
    at: 1_700_000_000 + seq,
    eventId: `${1000 + seq}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: seq,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

async function withServer(configOverrides, extraDeps, fn) {
  const config = baseConfig({ healthPort: await freePort(), ...configOverrides });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    ...extraDeps,
  });
  try {
    return await fn(server, config);
  } finally {
    await server.close();
  }
}

function entryCount(xml) {
  return xml.match(/<entry>/g)?.length ?? 0;
}

test("GET /atom is disabled by default and absent from the discovery index", async () => {
  await withServer({}, {}, async (server) => {
    const feed = await fetch(`${server.url}/atom`);
    assert.equal(feed.status, 404);
    assert.deepEqual(await feed.json(), { ok: false, error: "not_found" });

    const index = await fetch(`${server.url}/`);
    const body = await index.json();
    assert.equal(body.atom, undefined);
  });
});

test("GET /atom serves a bounded Atom feed from retained events when enabled", async () => {
  const events = [makeEvent(1), makeEvent(2), makeEvent(3)];
  await withServer(
    { atomFeedEnabled: true, atomFeedMaxEntries: 2 },
    { atomEvents: () => events },
    async (server) => {
      const feed = await fetch(`${server.url}/atom`);
      assert.equal(feed.status, 200);
      assert.match(feed.headers.get("content-type") ?? "", /application\/atom\+xml/);
      assert.equal(feed.headers.get("cache-control"), "no-store");

      const xml = await feed.text();
      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.ok(xml.includes('<feed xmlns="http://www.w3.org/2005/Atom">'));
      assert.equal(entryCount(xml), 2);
      assert.ok(xml.includes("1002-0"), "newest retained event should be present");
      assert.ok(xml.includes("1003-0"), "newest retained event should be present");
      assert.ok(!xml.includes("1001-0"), "event beyond the cap must not be served");
    },
  );
});

test("GET /atom requires the health bearer token when configured", async () => {
  const events = [makeEvent(1)];
  await withServer(
    { atomFeedEnabled: true, healthAuthToken: AUTH_TOKEN },
    { atomEvents: () => events },
    async (server) => {
      const missing = await fetch(`${server.url}/atom`);
      assert.equal(missing.status, 401);
      assert.equal(await missing.text(), "");

      const wrong = await fetch(`${server.url}/atom`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(wrong.status, 401);

      const valid = await fetch(`${server.url}/atom`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      assert.equal(valid.status, 200);
      assert.equal(entryCount(await valid.text()), 1);
    },
  );
});

test("GET /atom is read-only: non-GET methods are rejected with Allow: GET", async () => {
  let reads = 0;
  await withServer(
    { atomFeedEnabled: true },
    {
      atomEvents: () => {
        reads += 1;
        return [makeEvent(1)];
      },
    },
    async (server) => {
      const post = await fetch(`${server.url}/atom`, { method: "POST" });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET");
      assert.equal(reads, 0, "a non-GET request must not read retained events");

      const get = await fetch(`${server.url}/atom`);
      assert.equal(get.status, 200);
      assert.equal(reads, 1);
    },
  );
});

test("GET /atom renders an empty feed before any event is retained", async () => {
  await withServer({ atomFeedEnabled: true }, {}, async (server) => {
    const feed = await fetch(`${server.url}/atom`);
    assert.equal(feed.status, 200);
    const xml = await feed.text();
    assert.equal(entryCount(xml), 0);
    assert.ok(xml.includes("<updated>"));
  });
});

test("GET /atom only emits a self link for an https ATOM_FEED_SELF_URL", async () => {
  await withServer({ atomFeedEnabled: true }, {}, async (server) => {
    const derived = await (await fetch(`${server.url}/atom`)).text();
    assert.ok(!derived.includes('rel="self"'));
    assert.ok(derived.includes(`http://127.0.0.1:${server.port}/atom`));
  });

  await withServer(
    { atomFeedEnabled: true, atomFeedSelfUrl: "https://example.invalid/atom" },
    {},
    async (server) => {
      const xml = await (await fetch(`${server.url}/atom`)).text();
      assert.ok(xml.includes('rel="self"'));
      assert.ok(xml.includes("https://example.invalid/atom"));
    },
  );
});
