/**
 * Send journal: crash-safe intent/done bookkeeping for Telegram sends.
 *
 * Covers the journal in isolation (append, crash recovery, bounded compaction)
 * and an integration case where the poller is killed mid-send.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { sanitizeTelegramError } from "../dist/notifications/notifier.js";
import { createSendJournal } from "../dist/notifications/send-journal.js";
import { createPoller } from "../dist/poller.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const BOT_TOKEN = "1234567890:" + "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) =>
  Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42)).publicKey();

const cursorFor = (ledger) => `${BigInt(ledger) << 32n}-0`;

async function waitFor(cond, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A claim_created event, which is notifiable, so it reaches the send path. */
function eventAt(ledger) {
  return [
    {
      contractId: MARKET_ID,
      ledger,
      txHash: "abc",
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      id: `${ledger}-0`,
      topic: [scStr("claim_created"), scU64(ledger), scAddress(ADDR)],
      value: nativeToScVal({ category: "crypto" }),
    },
  ];
}

/** Fake RPC: one fresh notifiable market event per scan, squad always empty. */
function makeServer() {
  let ledger = 5_000;
  return {
    async getHealth() {
      return { status: "healthy", oldestLedger: 4_000, latestLedger: ledger };
    },
    async getEvents(req) {
      const id = req.filters?.[0]?.contractIds?.[0];
      if (id !== MARKET_ID) {
        return { events: [], cursor: cursorFor(ledger), latestLedger: ledger };
      }
      ledger += 1;
      return { events: eventAt(ledger), cursor: cursorFor(ledger), latestLedger: ledger };
    },
  };
}

function baseConfig(dir, overrides = {}) {
  return {
    botToken: BOT_TOKEN,
    chatId: "-1001234567890",
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
    ...overrides,
  };
}

// Retries and spacing at 0 so a send reaches the journal path on the first try.
const FAST_SEND = {
  sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
};

// ── Journal in isolation ─────────────────────────────────────────────────────

test("send journal: intent then done leaves nothing pending", async () => {
  const dir = await createTempDataDir("mimir-journal-");
  try {
    const journal = createSendJournal({
      filePath: dir.file("journal.jsonl"),
      now: () => 1_700_000_000_000,
    });

    await journal.recordIntent({
      id: "evt-1",
      source: "market",
      ledger: 5001,
      eventName: "claim_created",
      textHash: "abcd1234",
      at: 1_700_000_000_000,
    });
    assert.equal((await journal.loadPending()).length, 1, "intent is pending before done");

    await journal.recordDone("evt-1");
    assert.deepEqual(await journal.loadPending(), [], "done clears the intent");
  } finally {
    await dir.cleanup();
  }
});

test("send journal: a crash (intent with no done) is recoverable on restart", async () => {
  const dir = await createTempDataDir("mimir-journal-crash-");
  const file = dir.file("journal.jsonl");
  try {
    const first = createSendJournal({ filePath: file, now: () => 1_700_000_000_000 });
    await first.recordIntent({
      id: "evt-9",
      source: "market",
      ledger: 5009,
      eventName: "claim_created",
      textHash: "deadbeef",
      at: 1_700_000_000_000,
    });
    // Simulate abrupt termination: done is never written.
    assert.deepEqual(
      (await first.loadPending()).map((e) => e.id),
      ["evt-9"],
      "the intent survives without a done",
    );

    // A fresh journal handle over the same file (a restarted process) sees it.
    const second = createSendJournal({ filePath: file });
    assert.deepEqual(
      (await second.loadPending()).map((e) => e.id),
      ["evt-9"],
      "recovery reports the maybe-sent event",
    );
    assert.equal((await second.stats()).entries, 1);
  } finally {
    await dir.cleanup();
  }
});

test("send journal: a missing file loads as empty, not an error", async () => {
  const dir = await createTempDataDir("mimir-journal-missing-");
  try {
    const journal = createSendJournal({ filePath: dir.file("does-not-exist.jsonl") });
    assert.deepEqual(await journal.loadPending(), []);
    assert.deepEqual(await journal.stats(), { entries: 0, bytes: 0 });
  } finally {
    await dir.cleanup();
  }
});

test("send journal: compaction keeps the file bounded and drops resolved pairs", async () => {
  const dir = await createTempDataDir("mimir-journal-compact-");
  const file = dir.file("journal.jsonl");
  try {
    const journal = createSendJournal({ filePath: file, maxEntries: 3, maxBytes: 10_000 });

    // Resolved pairs get compacted away once we pass the budget.
    for (const id of ["a", "b", "c"]) {
      await journal.recordIntent({
        id,
        source: "market",
        ledger: 1,
        eventName: "claim_created",
        textHash: "x",
        at: 1,
      });
      await journal.recordDone(id);
    }
    assert.deepEqual(await journal.loadPending(), []);
    assert.ok((await journal.stats()).entries <= 3, "file stays within the entry budget");

    // Unresolved intents are kept; a matching done settles just that intent.
    await journal.recordIntent({
      id: "d",
      source: "market",
      ledger: 2,
      eventName: "claim_created",
      textHash: "x",
      at: 2,
    });
    await journal.recordIntent({
      id: "e",
      source: "market",
      ledger: 3,
      eventName: "claim_created",
      textHash: "x",
      at: 3,
    });
    await journal.recordDone("d");
    const pending = (await journal.loadPending()).map((e) => e.id);
    assert.deepEqual(pending.sort(), ["e"], "only the unresolved intent remains");
  } finally {
    await dir.cleanup();
  }
});

// ── Poller: killed mid-send ──────────────────────────────────────────────────

test("poller: a crash mid-send leaves an intent without a done, recoverable on restart", async () => {
  const dir = await createTempDataDir("mimir-poller-mid-send-");
  const journalFile = dir.file("send-journal.jsonl");
  let sendResolve;
  const sendDeferred = new Promise((resolve) => {
    sendResolve = resolve;
  });
  let sendCalls = 0;

  const poller = createPoller({
    config: {
      ...baseConfig(dir),
      sendJournalFile: journalFile,
    },
    server: makeServer(),
    send: async (_text, _source, _extra) => {
      sendCalls += 1;
      // Hang forever: the process crashes between sendMessage and the cursor
      // commit, so done is never written.
      await sendDeferred;
    },
    ...FAST_SEND,
  });

  try {
    // Fire one cycle and do not await it: it suspends inside the send.
    void poller.runCycle().catch(() => {});

    // The intent must be durable before the send returns.
    await waitFor(async () => {
      if (sendCalls < 1) return false;
      const raw = await readFile(journalFile, "utf8").catch(() => "");
      return raw.includes('"kind":"intent"');
    });

    const raw = await readFile(journalFile, "utf8");
    assert.ok(raw.includes('"kind":"intent"'), "intent recorded before the send");
    assert.ok(!raw.includes('"kind":"done"'), "no done: crash mid-send");
    assert.equal(sendCalls, 1, "the send was attempted once");

    // Recovery: a fresh handle over the same journal reports the maybe-sent
    // event instead of guessing from the cursor.
    const journal = createSendJournal({ filePath: journalFile });
    const pending = await journal.loadPending();
    assert.equal(pending.length, 1, "recovery sees the uncommitted intent");
    assert.equal(pending[0].id, "5001-0", "the maybe-sent event id is recorded");
  } finally {
    // Unblock the dangling cycle so nothing lingers after the test.
    if (sendResolve) sendResolve();
    await dir.cleanup();
  }
});

// ── Error sanitization and journal persistence ───────────────────────────────

test("sanitizeTelegramError redacts secrets, bounds length, and retains stable errorCode", () => {
  const secretSeed = "S" + "A".repeat(55);
  const longSuffix = "x".repeat(300);
  const err = {
    error_code: 400,
    description:
      `Bad Request:\n  bot${BOT_TOKEN} https://user:pass@rpc.example.invalid/?token=abc ` +
      `seed=${secretSeed} ${longSuffix}`,
  };

  const sanitized = sanitizeTelegramError(err, [BOT_TOKEN]);
  assert.equal(sanitized.errorCode, 400);
  assert.ok(!sanitized.description.includes(BOT_TOKEN), "bot token must be redacted");
  assert.ok(!sanitized.description.includes(secretSeed), "secret seed must be redacted");
  assert.ok(!sanitized.description.includes("user:pass"), "URL userinfo must be redacted");
  assert.ok(!sanitized.description.includes("\n"), "newlines must be collapsed");
  assert.ok(sanitized.description.length <= 240, "description must be bounded to 240 chars");
  assert.ok(sanitized.description.endsWith("…"), "truncated description must end with ellipsis");
});

test("sanitizeTelegramError handles non-object and missing-description boundary cases", () => {
  const networkErr = Object.assign(new Error(`connect ETIMEDOUT https://u:p@host.invalid`), {
    code: "ETIMEDOUT",
  });
  const s1 = sanitizeTelegramError(networkErr);
  assert.equal(s1.errorCode, "ETIMEDOUT");
  assert.ok(!s1.description.includes("u:p"), "URL credentials in Error.message must be redacted");

  const emptyDesc = sanitizeTelegramError({ error_code: 429, description: "   " });
  assert.equal(emptyDesc.errorCode, 429);
  assert.equal(emptyDesc.description, "error code 429");

  const nullErr = sanitizeTelegramError(null);
  assert.equal(nullErr.errorCode, undefined);
  assert.equal(nullErr.description, "unknown error");
});

test("send journal: recordError persists sanitized description, settles intent, and bounds errors on compact", async () => {
  const dir = await createTempDataDir("mimir-journal-error-");
  const file = dir.file("journal.jsonl");
  try {
    const journal = createSendJournal({
      filePath: file,
      maxEntries: 2,
      maxBytes: 10_000,
      now: () => 1_700_000_000_000,
      secrets: [BOT_TOKEN],
    });

    await journal.recordIntent({
      id: "evt-fail-1",
      source: "market",
      ledger: 6001,
      eventName: "claim_created",
      textHash: "hash1",
      at: 1_700_000_000_000,
    });
    await journal.recordError({
      id: "evt-fail-1",
      source: "market",
      ledger: 6001,
      eventName: "claim_created",
      error: {
        error_code: 403,
        description: `Forbidden: bot${BOT_TOKEN} was blocked by the user ${"z".repeat(300)}`,
      },
    });

    // An errored send settles its intent so recovery does not treat it as maybe-sent.
    assert.deepEqual(await journal.loadPending(), []);

    const raw = await readFile(file, "utf8");
    assert.ok(!raw.includes(BOT_TOKEN), "raw bot token must never be persisted to journal");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const errEntry = lines.find((e) => e.kind === "error");
    assert.ok(errEntry, "error entry should be persisted");
    assert.equal(errEntry.errorCode, 403);
    assert.ok(errEntry.errorDescription.length <= 240);
    assert.ok(errEntry.errorDescription.includes("[REDACTED]"));

    // Additional errors compact within maxEntries.
    await journal.recordError({ id: "evt-fail-2", error: { error_code: 429, description: "Too Many Requests" } });
    await journal.recordError({ id: "evt-fail-3", error: { error_code: 500, description: "Internal Server Error" } });
    assert.ok((await journal.stats()).entries <= 2, "compaction bounds retained error entries");
  } finally {
    await dir.cleanup();
  }
});
