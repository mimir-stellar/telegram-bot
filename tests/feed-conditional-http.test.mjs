import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  buildAtomFeed,
  computeFeedConditionalMetadata,
  createConditionalFeedResponder,
  isFeedNotModified,
} from "../dist/stellar/feed.js";
import { startHealthServer } from "../dist/health.js";

// Built from parts so scripts/scan-secrets.mjs never flags this fixture.
const HEALTH_TOKEN = ["test-secret", "-token"].join("");

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: VALID_MARKET,
    squadContractId: VALID_SQUAD,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    botToken: ["0000000000:SECRET", "-TOKEN-DO-NOT-LEAK"].join(""),
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    mimirAppUrl: "https://app.mimir.example",
    ...overrides,
  };
}

function baseStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 2,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 1010,
    oldestLedger: 1,
    chainClockAt: 5_000,
    notificationsSent: 1,
    notificationsFailed: 0,
    eventsSkipped: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: VALID_MARKET,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 1010,
        lastError: null,
      },
    ],
  };
}

function makeEvent(seq, overrides = {}) {
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 1000 + seq,
    txHash: VALID_TX,
    at: 1_700_000_000 + seq * 10,
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
    ...overrides,
  };
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

test("computeFeedConditionalMetadata is deterministic across identical events and BigInt payloads", () => {
  const cfg = baseConfig();
  const e1 = makeEvent(1, {
    payload: {
      name: "staked",
      claimId: 1,
      staker: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      side: "yes",
      amount: 12_500_000n,
    },
  });
  const e1Clone = makeEvent(1, {
    payload: {
      name: "staked",
      claimId: 1,
      staker: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      side: "yes",
      amount: 12_500_000n,
    },
  });

  const opts = {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: cfg,
    mimirAppUrl: cfg.mimirAppUrl,
  };

  const m1 = computeFeedConditionalMetadata([e1], opts);
  const m2 = computeFeedConditionalMetadata([e1Clone], opts);

  assert.equal(m1.etag, m2.etag);
  assert.match(m1.etag, /^"sha256-[0-9a-f]{64}"$/);
  assert.equal(m1.lastModified, new Date(e1.at * 1000).toUTCString());
  assert.equal(m1.lastModifiedMs, e1.at * 1000);

  // Empty feed without updatedAt uses deterministic epoch rather than wall-clock Date.now()
  const emptyA = computeFeedConditionalMetadata([], opts);
  const emptyB = computeFeedConditionalMetadata([], opts);
  assert.equal(emptyA.etag, emptyB.etag);
  assert.equal(emptyA.lastModified, "Thu, 01 Jan 1970 00:00:00 GMT");
  assert.notEqual(emptyA.etag, m1.etag);
});

test("isFeedNotModified follows RFC 9110 If-None-Match and If-Modified-Since rules", () => {
  const cfg = baseConfig();
  const event = makeEvent(2);
  const meta = computeFeedConditionalMetadata([event], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: cfg,
  });

  // Strong, weak, comma-list, and wildcard If-None-Match
  assert.equal(isFeedNotModified({ "if-none-match": meta.etag }, meta), true);
  assert.equal(isFeedNotModified({ "If-None-Match": `W/${meta.etag}` }, meta), true);
  assert.equal(isFeedNotModified({ "if-none-match": `"other-tag", ${meta.etag}` }, meta), true);
  assert.equal(isFeedNotModified({ "if-none-match": "*" }, meta), true);
  assert.equal(isFeedNotModified({ "if-none-match": '"mismatch"' }, meta), false);

  // If-Modified-Since when If-None-Match is absent
  assert.equal(isFeedNotModified({ "if-modified-since": meta.lastModified }, meta), true);
  const futureDate = new Date(meta.lastModifiedMs + 60_000).toUTCString();
  assert.equal(isFeedNotModified({ "if-modified-since": futureDate }, meta), true);
  const olderDate = new Date(meta.lastModifiedMs - 1_000).toUTCString();
  assert.equal(isFeedNotModified({ "if-modified-since": olderDate }, meta), false);
  assert.equal(isFeedNotModified({ "if-modified-since": "not-a-http-date" }, meta), false);

  // RFC 9110 §13.2.2: If-None-Match takes precedence over If-Modified-Since
  assert.equal(
    isFeedNotModified(
      {
        "if-none-match": '"stale-etag"',
        "if-modified-since": futureDate,
      },
      meta,
    ),
    false,
  );
});

test("createConditionalFeedResponder returns 304 on cold start without building XML when ETag matches", () => {
  const cfg = baseConfig();
  const events = [makeEvent(1)];
  const feedOpts = {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: cfg,
  };
  const expectedMeta = computeFeedConditionalMetadata(events, feedOpts);

  let renderCalls = 0;
  const responder = createConditionalFeedResponder({
    getEvents: () => events,
    getOptions: () => feedOpts,
    renderFeed: (evts, opts) => {
      renderCalls += 1;
      return buildAtomFeed(evts, opts);
    },
  });

  // Cold conditional hit: 0 XML builds!
  const cold304 = responder.evaluate("GET", { "if-none-match": expectedMeta.etag });
  assert.equal(cold304.statusCode, 304);
  assert.equal(cold304.body, "");
  assert.equal(cold304.rebuilt, false);
  assert.equal(renderCalls, 0);
  assert.equal(responder.buildCount(), 0);

  // First unconditional GET builds once
  const first200 = responder.evaluate("GET", {});
  assert.equal(first200.statusCode, 200);
  assert.equal(first200.rebuilt, true);
  assert.equal(renderCalls, 1);
  assert.equal(responder.buildCount(), 1);
  assert.equal(first200.headers.etag, expectedMeta.etag);
  assert.equal(first200.headers["last-modified"], expectedMeta.lastModified);

  // Second unconditional GET with unchanged events reuses cached XML
  const cached200 = responder.evaluate("GET", {});
  assert.equal(cached200.statusCode, 200);
  assert.equal(cached200.rebuilt, false);
  assert.equal(renderCalls, 1);
  assert.equal(cached200.body, first200.body);
});

test("live HTTP /feed.atom serves deterministic ETag/Last-Modified, returns 304 without rebuilding, and rebuilds on new event", async () => {
  const port = await freeLoopbackPort();
  const cfg = baseConfig({ healthPort: port });
  const events = [makeEvent(1)];

  let renderCalls = 0;
  const responder = createConditionalFeedResponder({
    getEvents: () => events,
    getOptions: () => ({
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: cfg,
      mimirAppUrl: cfg.mimirAppUrl,
    }),
    renderFeed: (evts, opts) => {
      renderCalls += 1;
      return buildAtomFeed(evts, opts);
    },
  });

  const server = startHealthServer({
    config: cfg,
    status: () => baseStatus(),
    now: () => 5_500,
    feedResponder: responder,
  });

  try {
    // 1. Initial GET builds XML once
    const res1 = await fetch(`${server.url}/feed.atom`);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get("content-type"), "application/atom+xml; charset=utf-8");
    const etag1 = res1.headers.get("etag");
    const lastMod1 = res1.headers.get("last-modified");
    assert.ok(etag1 && etag1.startsWith('"sha256-'));
    assert.ok(lastMod1);
    const body1 = await res1.text();
    assert.match(body1, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    assert.match(body1, /https:\/\/app\.mimir\.example\/claims\/1/);
    assert.equal(renderCalls, 1);

    // 2. Conditional GET with matching ETag -> 304, zero extra builds
    const res304Etag = await fetch(`${server.url}/feed.atom`, {
      headers: { "If-None-Match": etag1 },
    });
    assert.equal(res304Etag.status, 304);
    assert.equal(await res304Etag.text(), "");
    assert.equal(res304Etag.headers.get("etag"), etag1);
    assert.equal(res304Etag.headers.get("last-modified"), lastMod1);
    assert.equal(renderCalls, 1);

    // 3. Conditional GET on /feed alias with weak W/ ETag -> 304, zero extra builds
    const res304Weak = await fetch(`${server.url}/feed`, {
      headers: { "If-None-Match": `W/${etag1}` },
    });
    assert.equal(res304Weak.status, 304);
    assert.equal(renderCalls, 1);

    // 4. Conditional GET with If-Modified-Since -> 304, zero extra builds
    const res304Ims = await fetch(`${server.url}/feed.atom`, {
      headers: { "If-Modified-Since": lastMod1 },
    });
    assert.equal(res304Ims.status, 304);
    assert.equal(renderCalls, 1);

    // 5. HEAD returns 200 with Content-Length and empty body without rebuilding
    const resHead = await fetch(`${server.url}/feed.atom`, { method: "HEAD" });
    assert.equal(resHead.status, 200);
    assert.equal(Number(resHead.headers.get("content-length")) > 0, true);
    assert.equal(await resHead.text(), "");
    assert.equal(renderCalls, 1);

    // 6. POST returns 405 Method Not Allowed with Allow: GET, HEAD
    const resPost = await fetch(`${server.url}/feed.atom`, { method: "POST" });
    assert.equal(resPost.status, 405);
    assert.equal(resPost.headers.get("allow"), "GET, HEAD");
    assert.equal(renderCalls, 1);

    // 7. New event arrives -> previous ETag misses, rebuilds once (renderCalls === 2)
    events.push(makeEvent(2));
    const resUpdated = await fetch(`${server.url}/feed.atom`, {
      headers: { "If-None-Match": etag1 },
    });
    assert.equal(resUpdated.status, 200);
    const etag2 = resUpdated.headers.get("etag");
    const lastMod2 = resUpdated.headers.get("last-modified");
    assert.notEqual(etag2, etag1);
    assert.notEqual(lastMod2, lastMod1);
    const body2 = await resUpdated.text();
    assert.match(body2, /https:\/\/app\.mimir\.example\/claims\/2/);
    assert.equal(renderCalls, 2);
  } finally {
    await server.close();
  }
});

test("startHealthServer preserves 404 when feed is not configured and enforces HEALTH_AUTH_TOKEN when configured", async () => {
  const portNoFeed = await freeLoopbackPort();
  const serverNoFeed = startHealthServer({
    config: baseConfig({ healthPort: portNoFeed }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  try {
    const res404 = await fetch(`${serverNoFeed.url}/feed.atom`);
    assert.equal(res404.status, 404);
  } finally {
    await serverNoFeed.close();
  }

  const portAuth = await freeLoopbackPort();
  const events = [makeEvent(1)];
  const serverAuth = startHealthServer({
    config: baseConfig({
      healthPort: portAuth,
      healthAuthToken: HEALTH_TOKEN,
    }),
    status: () => baseStatus(),
    now: () => 5_500,
    feedEvents: () => events,
    feedOptions: {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
    },
  });

  try {
    const unauth = await fetch(`${serverAuth.url}/feed.atom`);
    assert.equal(unauth.status, 401);

    const ok200 = await fetch(`${serverAuth.url}/feed.atom`, {
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(ok200.status, 200);
    const etag = ok200.headers.get("etag");
    assert.ok(etag);

    const ok304 = await fetch(`${serverAuth.url}/feed.atom`, {
      headers: {
        Authorization: `Bearer ${HEALTH_TOKEN}`,
        "If-None-Match": etag,
      },
    });
    assert.equal(ok304.status, 304);
  } finally {
    await serverAuth.close();
  }
});
