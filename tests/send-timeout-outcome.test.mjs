/**
 * Tests for issue #758: reconcile ambiguous Telegram send timeouts as unknown
 * outcomes in src/notifications/send-journal.ts and
 * src/notifications/notifier.ts.
 *
 * Verifies:
 *   - recordTimeout writes a "timeout" journal line.
 *   - loadUnknownOutcomes returns pending intents that have a matching timeout.
 *   - loadUnknownOutcomes excludes settled intents (intent + done) even if
 *     they also have a timeout line.
 *   - loadUnknownOutcomes excludes pending intents that have no timeout line.
 *   - compact preserves timeout lines for unresolved intents.
 *   - compact drops timeout lines for settled (done) intents.
 *   - notifier fires onTimeout callback when a timeout error is thrown.
 *   - notifier does not fire onTimeout for non-timeout errors.
 *   - onTimeout errors do not suppress the original error.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createSendJournal } from "../dist/notifications/send-journal.js";
import { createNotifier, isTimeoutError } from "../dist/notifications/notifier.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

// ── send-journal: recordTimeout ───────────────────────────────────────────────

test("recordTimeout appends a timeout line to the journal", async () => {
  const dir = await createTempDataDir("mimir-timeout-");
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
      at: 1_700_000_000_000,
    });
    await journal.recordTimeout("evt-1", "Telegram send timed out after 15000ms");

    const raw = await readFile(dir.file("journal.jsonl"), "utf8");
    assert.ok(raw.includes('"kind":"intent"'), "intent line present");
    assert.ok(raw.includes('"kind":"timeout"'), "timeout line present");
    assert.ok(raw.includes("timed out"), "timeout reason preserved");
  } finally {
    await dir.cleanup();
  }
});

test("recordTimeout without reason writes a timeout line with no timeoutReason field", async () => {
  const dir = await createTempDataDir("mimir-timeout-noreason-");
  try {
    const journal = createSendJournal({ filePath: dir.file("j.jsonl") });
    await journal.recordIntent({
      id: "x",
      source: "squad",
      ledger: 1,
      eventName: "claim_cancelled",
      at: 1,
    });
    await journal.recordTimeout("x");

    const raw = await readFile(dir.file("j.jsonl"), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const timeoutLine = lines.find((l) => l.kind === "timeout");
    assert.ok(timeoutLine, "timeout line present");
    assert.equal(timeoutLine.timeoutReason, undefined, "no timeoutReason field");
  } finally {
    await dir.cleanup();
  }
});

// ── send-journal: loadUnknownOutcomes ─────────────────────────────────────────

test("loadUnknownOutcomes returns pending intents that also have a timeout line", async () => {
  const dir = await createTempDataDir("mimir-unknown-outcomes-");
  try {
    const journal = createSendJournal({
      filePath: dir.file("journal.jsonl"),
      now: () => 1_700_000_000_000,
    });

    await journal.recordIntent({ id: "evt-1", source: "market", ledger: 5001, eventName: "claim_created", at: 1 });
    await journal.recordTimeout("evt-1", "timed out");

    const outcomes = await journal.loadUnknownOutcomes();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].id, "evt-1");
    assert.equal(outcomes[0].kind, "intent");
  } finally {
    await dir.cleanup();
  }
});

test("loadUnknownOutcomes excludes pending intents with no timeout line", async () => {
  const dir = await createTempDataDir("mimir-unknown-no-timeout-");
  try {
    const journal = createSendJournal({ filePath: dir.file("j.jsonl") });
    // Plain crash-recovery intent: no timeout, no done.
    await journal.recordIntent({ id: "crash-1", source: "market", ledger: 1, eventName: "claim_created", at: 1 });

    const outcomes = await journal.loadUnknownOutcomes();
    assert.deepEqual(outcomes, [], "plain pending intent without timeout is not an unknown outcome");
  } finally {
    await dir.cleanup();
  }
});

test("loadUnknownOutcomes excludes settled intents (intent + timeout + done)", async () => {
  const dir = await createTempDataDir("mimir-unknown-settled-");
  try {
    const journal = createSendJournal({ filePath: dir.file("j.jsonl") });
    await journal.recordIntent({ id: "evt-2", source: "squad", ledger: 2, eventName: "claim_cancelled", at: 2 });
    await journal.recordTimeout("evt-2", "timed out");
    await journal.recordDone("evt-2");

    const outcomes = await journal.loadUnknownOutcomes();
    assert.deepEqual(outcomes, [], "done settles the intent even if it had a timeout");
  } finally {
    await dir.cleanup();
  }
});

test("loadUnknownOutcomes and loadPending see the same pending intent set", async () => {
  const dir = await createTempDataDir("mimir-unknown-vs-pending-");
  try {
    const journal = createSendJournal({ filePath: dir.file("j.jsonl") });
    // Two intents: one with timeout, one without.
    await journal.recordIntent({ id: "a", source: "market", ledger: 1, eventName: "claim_created", at: 1 });
    await journal.recordTimeout("a", "timed out");
    await journal.recordIntent({ id: "b", source: "market", ledger: 2, eventName: "claim_created", at: 2 });

    const pending = await journal.loadPending();
    const outcomes = await journal.loadUnknownOutcomes();

    assert.equal(pending.length, 2, "both intents are pending");
    assert.equal(outcomes.length, 1, "only the timed-out intent is an unknown outcome");
    assert.equal(outcomes[0].id, "a");
  } finally {
    await dir.cleanup();
  }
});

// ── compact: preserves / drops timeout lines ──────────────────────────────────

test("compact preserves timeout lines for unresolved intents", async () => {
  const dir = await createTempDataDir("mimir-compact-timeout-");
  try {
    const journal = createSendJournal({ filePath: dir.file("j.jsonl"), maxEntries: 2, maxBytes: 10_000 });
    await journal.recordIntent({ id: "p", source: "market", ledger: 1, eventName: "claim_created", at: 1 });
    await journal.recordTimeout("p", "timed out");
    // Trigger compaction by settling a different intent to push over maxEntries.
    await journal.recordIntent({ id: "q", source: "market", ledger: 2, eventName: "claim_created", at: 2 });
    await journal.recordDone("q"); // This compacts when entries > maxEntries.

    const raw = await readFile(dir.file("j.jsonl"), "utf8");
    assert.ok(raw.includes('"kind":"intent"'), "unresolved intent preserved after compact");
    assert.ok(raw.includes('"kind":"timeout"'), "timeout line preserved after compact");
    assert.ok(!raw.includes('"id":"q"'), "settled intent q dropped by compact");
  } finally {
    await dir.cleanup();
  }
});

test("compact drops timeout lines for settled intents", async () => {
  const dir = await createTempDataDir("mimir-compact-settled-timeout-");
  try {
    // maxEntries=1 so the first done triggers a compact.
    const journal = createSendJournal({ filePath: dir.file("j.jsonl"), maxEntries: 1, maxBytes: 10_000 });
    await journal.recordIntent({ id: "s", source: "market", ledger: 1, eventName: "claim_created", at: 1 });
    await journal.recordTimeout("s", "timed out");
    await journal.recordDone("s"); // Compact fires: entries (3) > maxEntries (1).

    const raw = await readFile(dir.file("j.jsonl"), "utf8").catch(() => "");
    assert.ok(!raw.includes('"id":"s"'), "settled entry and its timeout line removed by compact");
  } finally {
    await dir.cleanup();
  }
});

// ── notifier: onTimeout callback ──────────────────────────────────────────────

test("notifier fires onTimeout when a timeout error is thrown by sendMessage", async () => {
  const timeoutErr = Object.assign(new Error("Telegram send timed out after 15000ms"), { name: "TimeoutError" });
  const fakeBot = { api: { sendMessage: async () => { throw timeoutErr; } } };
  const notifier = createNotifier(fakeBot, { chatId: "-1001234567890" });

  const timeoutCalls = [];
  await assert.rejects(
    () => notifier("hello", "market", { onTimeout: (err) => timeoutCalls.push(err) }),
    (err) => err === timeoutErr,
  );

  assert.equal(timeoutCalls.length, 1, "onTimeout called once");
  assert.equal(timeoutCalls[0], timeoutErr, "original error passed to onTimeout");
});

test("notifier does not fire onTimeout for a non-timeout Telegram error", async () => {
  const rejection = Object.assign(new Error("Bad Request"), { error_code: 400 });
  const fakeBot = { api: { sendMessage: async () => { throw rejection; } } };
  const notifier = createNotifier(fakeBot, { chatId: "-1001234567890" });

  const timeoutCalls = [];
  await assert.rejects(
    () => notifier("hello", "market", { onTimeout: (err) => timeoutCalls.push(err) }),
    (err) => err === rejection,
  );

  assert.equal(timeoutCalls.length, 0, "onTimeout must not be called for non-timeout errors");
});

test("notifier does not suppress the original error when onTimeout throws", async () => {
  const timeoutErr = Object.assign(new Error("timed out"), { name: "AbortError" });
  const fakeBot = { api: { sendMessage: async () => { throw timeoutErr; } } };
  const notifier = createNotifier(fakeBot, { chatId: "-1001234567890" });

  await assert.rejects(
    () =>
      notifier("hello", "market", {
        onTimeout: () => {
          throw new Error("callback threw");
        },
      }),
    (err) => err === timeoutErr,
    "original timeout error must propagate even if onTimeout throws",
  );
});

// ── isTimeoutError re-export ──────────────────────────────────────────────────

test("isTimeoutError is re-exported from notifier.ts", () => {
  assert.equal(typeof isTimeoutError, "function");
  assert.equal(isTimeoutError(Object.assign(new Error("op"), { name: "AbortError" })), true);
  assert.equal(isTimeoutError(new Error("some 400 error")), false);
});
