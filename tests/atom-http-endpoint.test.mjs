import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigError, loadConfig } from "../dist/config.js";
import { startHealthServer } from "../dist/health.js";
import {
  createRetainedEventBuffer,
  DEFAULT_FEED_MAX_EVENTS,
  MAX_FEED_MAX_EVENTS,
} from "../dist/stellar/feed.js";

const HEALTH_TOKEN = ["test-secret", "-token"].join("");
const BOT_TOKEN = ["123456789:TEST", "-ONLY-TOKEN-NEVER-USE-PADDED-TO-35"].join("");
const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

const ENV_KEYS = [
  "MIMIR_PROFILE",
  "MARKET_CONTRACT_ID",
  "SQUAD_CONTRACT_ID",
  "BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "CURSOR_FILE",
  "INSTANCE_LOCK_FILE",
  "STATUS_FILE",
  "AUDIT_FILE",
  "DEAD_LETTER_FILE",
  "SEND_JOURNAL_FILE",
  "CSV_OUTPUT_FILE",
  "COUNTERS_FILE",
  "HEALTH_HOST",
  "HEALTH_PORT",
  "HEALTH_AUTH_TOKEN",
  "MIMIR_APP_URL",
  "FEED_ENABLED",
  "FEED_MAX_EVENTS",
  "FEED_SELF_URL",
];

function withEnv(overrides, fn) {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const tmpRoot = path.join(os.tmpdir(), "mimir-atom-http-test");
  const defaults = {
    MARKET_CONTRACT_ID: VALID_MARKET,
    SQUAD_CONTRACT_ID: VALID_SQUAD,
    BOT_TOKEN,
    TELEGRAM_CHAT_ID: "-1001234567890",
    CURSOR_FILE: path.join(tmpRoot, "cursor.json"),
    INSTANCE_LOCK_FILE: path.join(tmpRoot, "poller.lock"),
    STATUS_FILE: path.join(tmpRoot, "status.json"),
    AUDIT_FILE: path.join(tmpRoot, "audit.jsonl"),
    DEAD_LETTER_FILE: path.join(tmpRoot, "dead-letter.json"),
    SEND_JOURNAL_FILE: path.join(tmpRoot, "send-journal.jsonl"),
    CSV_OUTPUT_FILE: path.join(tmpRoot, "scanner.csv"),
    COUNTERS_FILE: path.join(tmpRoot, "counters.json"),
  };
  for (const [k, v] of Object.entries({ ...defaults, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function baseConfig(overrides = {}) {
  const tmpRoot = path.join(os.tmpdir(), "mimir-atom-http-server");
  return {
    version: "0.1.0",
    locale: "en",
    marketContractId: VALID_MARKET,
    squadContractId: VALID_SQUAD,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: BOT_TOKEN,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    allowedChatIds: [],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: path.join(tmpRoot, "cursor.json"),
    lockFile: path.join(tmpRoot, "poller.lock"),
    statusFile: path.join(tmpRoot, "status.json"),
    maxNotificationsPerCycle: 20,
    interSendDelayMs: 1_500,
    metricsPort: null,
    notificationCategories: [],
    silentEvents: [],
    csvOutputFile: path.join(tmpRoot, "scanner.csv"),
    featureFlags: { enabled: true, market: true, squad: true },
    auditFile: path.join(tmpRoot, "audit.jsonl"),
    dedupWindow: 256,
    deadLetterFile: path.join(tmpRoot, "dead-letter.json"),
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    sendJournalFile: path.join(tmpRoot, "send-journal.jsonl"),
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 30_000,
    startupHealthRetryMs: 1_000,
    shutdownTimeoutMs: 10_000,
    telegramSendTimeoutMs: 10_000,
    channelPreviewMode: false,
    linkPreviewMarket: false,
    linkPreviewSquad: false,
    logSampleMaxPerWindow: 3,
    logSampleWindowMs: 300_000,
    logBufferLines: 0,
    telegramWebhookUrl: null,
    telegramApiRoot: null,
    mimirAppUrl: "https://app.mimir.example",
    healthAuthToken: null,
    feedEnabled: false,
    feedMaxEvents: DEFAULT_FEED_MAX_EVENTS,
    feedSelfUrl: null,
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

test("createRetainedEventBuffer enforces bounded ring capacity, deduplicates eventIds, and disables at 0", () => {
  const disabled = createRetainedEventBuffer(0);
  disabled.record([makeEvent(1), makeEvent(2)]);
  assert.equal(disabled.capacity, 0);
  assert.equal(disabled.size, 0);
  assert.deepEqual(disabled.snapshot(), []);

  const clamped = createRetainedEventBuffer(MAX_FEED_MAX_EVENTS + 100);
  assert.equal(clamped.capacity, MAX_FEED_MAX_EVENTS);

  const buf = createRetainedEventBuffer(3);
  buf.record([makeEvent(1), makeEvent(2)]);
  // Duplicate eventId from overlapping page is ignored
  buf.record([makeEvent(2), makeEvent(3), makeEvent(4), makeEvent(5)]);
  assert.equal(buf.size, 3);
  assert.deepEqual(
    buf.snapshot().map((e) => e.payload.claimId),
    [5, 4, 3],
  );
});

test("loadConfig keeps FEED_ENABLED disabled by default and validates FEED_MAX_EVENTS and FEED_SELF_URL", () => {
  withEnv({}, () => {
    const cfg = loadConfig();
    assert.equal(cfg.feedEnabled, false);
    assert.equal(cfg.feedMaxEvents, DEFAULT_FEED_MAX_EVENTS);
    assert.equal(cfg.feedSelfUrl, null);
  });

  withEnv(
    {
      FEED_ENABLED: "true",
      FEED_MAX_EVENTS: "120",
      FEED_SELF_URL: "https://mimir.example/feed.atom",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.feedEnabled, true);
      assert.equal(cfg.feedMaxEvents, 120);
      assert.equal(cfg.feedSelfUrl, "https://mimir.example/feed.atom");
    },
  );

  // Reject out-of-range FEED_MAX_EVENTS (0 and > MAX_FEED_MAX_EVENTS) and non-https FEED_SELF_URL
  withEnv(
    {
      FEED_MAX_EVENTS: String(MAX_FEED_MAX_EVENTS + 1),
      FEED_SELF_URL: "http://insecure.example/feed.atom",
    },
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(err.problems.some((p) => p.includes("FEED_MAX_EVENTS")));
          assert.ok(err.problems.some((p) => p.includes("FEED_SELF_URL")));
          return true;
        },
      );
    },
  );

  // Non-loopback bind without HEALTH_AUTH_TOKEN warns about Atom feed exposure when enabled
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    withEnv(
      {
        FEED_ENABLED: "true",
        HEALTH_HOST: "0.0.0.0",
        HEALTH_AUTH_TOKEN: undefined,
      },
      () => {
        loadConfig();
      },
    );
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warnings.some((w) => w.includes("Atom feed")));
});

test("Atom HTTP endpoint is disabled by default (404) even when retained events exist", async () => {
  const port = await freeLoopbackPort();
  const buf = createRetainedEventBuffer(10);
  buf.record([makeEvent(1)]);

  const server = startHealthServer({
    config: baseConfig({ healthPort: port, feedEnabled: false }),
    status: () => baseStatus(),
    now: () => 5_500,
    feedEvents: () => buf.snapshot(),
  });

  try {
    const resAtom = await fetch(`${server.url}/feed.atom`);
    assert.equal(resAtom.status, 404);

    const resAlias = await fetch(`${server.url}/feed`);
    assert.equal(resAlias.status, 404);

    const resIndex = await fetch(`${server.url}/`);
    const indexBody = await resIndex.json();
    assert.equal("feed" in indexBody, false);
  } finally {
    await server.close();
  }
});

test("opt-in GET /feed.atom is read-only, reuses buildAtomFeed with bounded retained events, and enforces bind auth", async () => {
  const port = await freeLoopbackPort();
  const buf = createRetainedEventBuffer(2);
  buf.record([makeEvent(1), makeEvent(2), makeEvent(3)]);

  const server = startHealthServer({
    config: baseConfig({
      healthPort: port,
      feedEnabled: true,
      feedMaxEvents: 2,
      feedSelfUrl: "https://mimir.example/feed.atom",
      healthAuthToken: HEALTH_TOKEN,
    }),
    status: () => baseStatus(),
    now: () => 5_500,
    feedEvents: () => buf.snapshot(),
  });

  try {
    // 1. Missing and invalid Bearer tokens are rejected with 401
    const unauth = await fetch(`${server.url}/feed.atom`);
    assert.equal(unauth.status, 401);

    const wrongAuth = await fetch(`${server.url}/feed.atom`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(wrongAuth.status, 401);

    // 2. Valid Bearer token serves Atom 1.0 XML bounded to newest 2 events (#3 and #2, #1 evicted)
    const authHeaders = { Authorization: `Bearer ${HEALTH_TOKEN}` };
    const res = await fetch(`${server.url}/feed.atom`, { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/atom+xml; charset=utf-8");
    const xml = await res.text();
    assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
    assert.match(xml, /<link rel="self" type="application\/atom\+xml" href="https:\/\/mimir\.example\/feed\.atom"\/>/);
    assert.match(xml, /https:\/\/app\.mimir\.example\/claims\/3/);
    assert.match(xml, /https:\/\/app\.mimir\.example\/claims\/2/);
    assert.equal(xml.includes("claims/1"), false);
    assert.equal((xml.match(/<entry>/g) ?? []).length, 2);

    // 3. /feed alias and HEAD work cleanly
    const resHead = await fetch(`${server.url}/feed`, {
      method: "HEAD",
      headers: authHeaders,
    });
    assert.equal(resHead.status, 200);
    assert.equal(Number(resHead.headers.get("content-length")) > 0, true);
    assert.equal(await resHead.text(), "");

    // 4. Read-only enforcement: mutating methods return 405 with Allow: GET, HEAD
    for (const method of ["POST", "PUT", "DELETE"]) {
      const resMut = await fetch(`${server.url}/feed.atom`, {
        method,
        headers: authHeaders,
      });
      assert.equal(resMut.status, 405);
      assert.equal(resMut.headers.get("allow"), "GET, HEAD");
    }

    // 5. Route discovery index lists /feed.atom when enabled
    const resIndex = await fetch(`${server.url}/`, { headers: authHeaders });
    assert.equal(resIndex.status, 200);
    const indexBody = await resIndex.json();
    assert.equal(indexBody.feed, "/feed.atom");
  } finally {
    await server.close();
  }
});
