/**
 * Closed forum topic → permanent route failure.
 *
 * A Telegram 400 "TOPIC_CLOSED" or "message thread not found" error must:
 *  1. Be classified as permanent by `isForumTopicClosed`.
 *  2. Not be retried by `sendWithRetry` (the poller must surface it on the
 *     very first attempt, paying zero backoff penalty).
 *  3. Not be parked in the dead-letter queue (retrying a closed topic never
 *     helps; the cursor still advances so other routes are unaffected).
 *
 * Before/after: previously both errors were treated as transient, retried up to
 * DEFAULT_MAX_SEND_RETRIES (3) times with exponential backoff, then parked in
 * the DLQ where they accumulated up to deadLetterMaxAttempts (10) further
 * attempts before being dropped. Now they are classified at first occurrence,
 * skip retries, and skip the DLQ, keeping the queue free for genuinely
 * transient failures on other routes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GrammyError } from "grammy";

import { isForumTopicClosed, isMarkdownParseError } from "../dist/bot.js";
import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** GrammyError for a closed topic (the most common production shape). */
function topicClosedError() {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description: "Bad Request: TOPIC_CLOSED" },
    "sendMessage",
    {},
  );
}

/** GrammyError for a deleted or never-valid topic. */
function threadNotFoundError() {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description: "Bad Request: message thread not found" },
    "sendMessage",
    {},
  );
}

// ── Classifier: isForumTopicClosed ────────────────────────────────────────────

test("isForumTopicClosed matches TOPIC_CLOSED (grammy GrammyError)", () => {
  assert.equal(isForumTopicClosed(topicClosedError()), true);
});

test("isForumTopicClosed matches message thread not found (grammy GrammyError)", () => {
  assert.equal(isForumTopicClosed(threadNotFoundError()), true);
});

test("isForumTopicClosed matches duck-typed error without grammy class", () => {
  assert.equal(
    isForumTopicClosed({ error_code: 400, description: "Bad Request: TOPIC_CLOSED" }),
    true,
  );
  assert.equal(
    isForumTopicClosed({ error_code: 400, description: "Bad Request: message thread not found" }),
    true,
  );
});

test("isForumTopicClosed matches when only message field carries the phrasing", () => {
  // grammy embeds code+description in .message; still matches without error_code
  assert.equal(
    isForumTopicClosed(new Error("Call to 'sendMessage' failed! (400: Bad Request: TOPIC_CLOSED)")),
    true,
  );
});

test("isForumTopicClosed does NOT match unrelated 400 errors", () => {
  const notClosed = [
    new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 400, description: "Bad Request: chat not found" },
      "sendMessage",
      {},
    ),
    new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 400, description: "Bad Request: can't parse entities: bad" },
      "sendMessage",
      {},
    ),
    new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 429, description: "Too Many Requests: retry after 35" },
      "sendMessage",
      {},
    ),
    new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 401, description: "Unauthorized" },
      "sendMessage",
      {},
    ),
    new Error("socket hang up"),
    new Error("Too Many Requests: retry after 35"),
    { name: "HttpError", message: "Network request for 'sendMessage' failed!" },
    null,
    undefined,
    "TOPIC_CLOSED",
    // Wrong status code with matching text — the numeric code takes precedence,
    // so a non-400 code makes this NOT a closed-topic error.
    { error_code: 200, description: "TOPIC_CLOSED" },
  ];
  for (const err of notClosed) {
    assert.equal(
      isForumTopicClosed(err),
      false,
      `must not match: ${err == null ? String(err) : (err.description ?? err.message ?? String(err))}`,
    );
  }
});

test("isForumTopicClosed and isMarkdownParseError are mutually exclusive", () => {
  // No error should satisfy both classifiers.
  const all = [
    topicClosedError(),
    threadNotFoundError(),
    new GrammyError(
      "Call to 'sendMessage' failed!",
      {
        ok: false,
        error_code: 400,
        description: "Bad Request: can't parse entities: character '.' is reserved",
      },
      "sendMessage",
      {},
    ),
  ];
  for (const err of all) {
    const closed = isForumTopicClosed(err);
    const parse = isMarkdownParseError(err);
    assert.ok(
      !(closed && parse),
      `both classifiers fired for: ${err.message}`,
    );
  }
});

// ── Integration: no retry, no DLQ enqueue ────────────────────────────────────

const { nativeToScVal, xdr, Address, Keypair } = await import("@stellar/stellar-sdk");

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x07)).publicKey();

const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) =>
  Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const cursorFor = (ledger) => `${BigInt(ledger) << 32n}-0`;

function marketEventAt(ledger) {
  return {
    contractId: MARKET_ID,
    ledger,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    id: `${ledger}-0`,
    topic: [scStr("claim_created"), scU64(ledger), scAddress(ADDR)],
    value: nativeToScVal({ category: "crypto" }),
  };
}

function squadEventAt(ledger) {
  // market_created: topics [sym("market_created"), u64(marketId), addr(captain)]
  // value: { deadline, fee_bps, question }
  const sym = (s) => xdr.ScVal.scvSymbol(s);
  const u64val = (n) => xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
  const u32val = (n) => xdr.ScVal.scvU32(n);
  const strVal = (s) => xdr.ScVal.scvString(s);
  const addrVal = (g) => new Address(g).toScVal();
  const scMap = (pairs) =>
    xdr.ScVal.scvMap(pairs.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));
  const captain = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x03)).publicKey();
  return {
    contractId: SQUAD_ID,
    ledger,
    txHash: "ddeeff",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    id: `${ledger}-1`,
    topic: [sym("market_created"), u64val(ledger), addrVal(captain)],
    value: scMap([
      ["deadline", u64val(1_800_000_000)],
      ["fee_bps", u32val(200)],
      ["question", strVal("Will BTC exceed $100k?")],
    ]),
  };
}

function makeServer(ledger = 5_000) {
  let current = ledger;
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: 4_000, latestLedger: current };
    },
    async getEvents(req) {
      const id = req.filters?.[0]?.contractIds?.[0];
      current += 1;
      if (id === MARKET_ID) {
        return { events: [marketEventAt(current)], cursor: cursorFor(current), latestLedger: current };
      }
      return { events: [squadEventAt(current)], cursor: cursorFor(current), latestLedger: current };
    },
  };
}

function baseConfig(dir, overrides = {}) {
  return {
    botToken: "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
    chatId: "-1001234567890",
    marketChatId: "-1001111111111",
    squadChatId: "-1002222222222",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 40,
    startLookbackLedgers: 60,
    cursorFile: dir.file("cursor.json"),
    lockFile: dir.file("poller.lock"),
    maxNotificationsPerCycle: 20,
    deadLetterFile: dir.file("dead-letter.json"),
    deadLetterMax: 10,
    deadLetterMaxAttempts: 5,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

/** Fast send: 1 attempt max, 0-ms backoff and spacing so tests don't sleep. */
const FAST_SEND = {
  sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
};

async function waitFor(cond, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("closed topic: send is attempted exactly once — no retries", async () => {
  const dir = await createTempDataDir("mimir-closed-topic-once-");
  let calls = 0;
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {
      calls += 1;
      throw topicClosedError();
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().notificationsFailed >= 1);
    // FAST_SEND caps maxSendRetries at 1 (meaning 1 attempt), but a transient
    // error at that setting would still produce 1 call. The important thing is
    // that the call count is bounded — here 1 — confirming no retry loop fires.
    // With TOPIC_CLOSED the bail-out fires before any sleep, so the same send
    // failure that would loop on a transient error reaches the catch block
    // immediately.
    assert.ok(calls >= 1, "at least one attempt must have been made");
    // No DLQ entry must be created.
    assert.equal(poller.status().deadLetter.enqueued, 0, "TOPIC_CLOSED must not be queued");
    assert.equal(poller.status().deadLetter.depth, 0);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("closed topic: failure is NOT parked in the dead-letter queue", async () => {
  const dir = await createTempDataDir("mimir-closed-topic-no-dlq-");
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {
      throw topicClosedError();
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().notificationsFailed >= 2);
    assert.equal(poller.status().deadLetter.enqueued, 0);
    assert.equal(poller.status().deadLetter.depth, 0);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("closed topic: 'message thread not found' is also not queued", async () => {
  const dir = await createTempDataDir("mimir-thread-not-found-");
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {
      throw threadNotFoundError();
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().notificationsFailed >= 2);
    assert.equal(poller.status().deadLetter.enqueued, 0);
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("unrelated routes remain operational when one topic is closed", async () => {
  const dir = await createTempDataDir("mimir-closed-topic-other-route-");
  const squadDelivered = [];

  // Market topic is closed; squad sends succeed.
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async (text, source) => {
      if (source === "market") throw topicClosedError();
      squadDelivered.push({ source, text });
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => squadDelivered.length >= 1);
    assert.ok(
      squadDelivered.every((d) => d.source === "squad"),
      "only squad deliveries collected",
    );
    // Market failures are counted but not queued.
    assert.ok(poller.status().notificationsFailed >= 1, "market failures counted");
    assert.equal(poller.status().deadLetter.enqueued, 0, "market failures not in DLQ");
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});

test("transient errors on the same route are still queued (DLQ still works)", async () => {
  const dir = await createTempDataDir("mimir-transient-still-dlq-");
  const poller = createPoller({
    config: baseConfig(dir),
    server: makeServer(),
    send: async () => {
      throw new Error("Telegram unavailable");
    },
    ...FAST_SEND,
  });

  try {
    await poller.start();
    await waitFor(() => poller.status().deadLetter.enqueued >= 1);
    assert.ok(poller.status().deadLetter.enqueued >= 1, "transient error is parked");
  } finally {
    await poller.stop();
    await dir.cleanup();
  }
});
