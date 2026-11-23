/**
 * Tests for src/notifications/delivery-report.ts (issue #764).
 *
 * Verifies:
 *   - Report is always read-only (no file mutations).
 *   - UNRESOLVED_INTENT: pending journal intent with no matching index record.
 *   - ORPHANED_INDEX: index record with no pending intent.
 *   - Clean state: settled intents (intent + done) produce no inconsistency.
 *   - Both files missing or empty produces a zero-entry report.
 *   - Inconsistency kind values and reason strings are correct.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { buildDeliveryReport } from "../dist/notifications/delivery-report.js";
import { createSendJournal } from "../dist/notifications/send-journal.js";
import { createMessageIndex } from "../dist/notifications/message-index.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIntent(overrides = {}) {
  return {
    id: overrides.id ?? "5001-0",
    source: overrides.source ?? "market",
    ledger: overrides.ledger ?? 5001,
    eventName: overrides.eventName ?? "claim_created",
    textHash: "abcd1234",
    at: overrides.at ?? 1_700_000_000_000,
  };
}

// ── Read-only guarantee ───────────────────────────────────────────────────────

test("delivery report: does not mutate the journal or the index file", async () => {
  await withTempDataDir(async (dir) => {
    const journalFile = dir.file("send-journal.jsonl");
    const indexFile = dir.file("message-index.json");

    const journal = createSendJournal({ filePath: journalFile, now: () => 1_700_000_000_000 });
    await journal.recordIntent(makeIntent());

    const index = await createMessageIndex({ filePath: indexFile });
    await index.record(12345, "market:5001", 999);

    const beforeJournal = await readFile(journalFile, "utf8");
    const beforeIndex = await readFile(indexFile, "utf8");

    await buildDeliveryReport({ journalFile, indexFile });

    assert.equal(await readFile(journalFile, "utf8"), beforeJournal, "journal must not be modified");
    assert.equal(await readFile(indexFile, "utf8"), beforeIndex, "index must not be modified");
  });
});

// ── UNRESOLVED_INTENT ─────────────────────────────────────────────────────────

test("delivery report: unresolved intent when journal has pending entry with no index match", async () => {
  await withTempDataDir(async (dir) => {
    const journalFile = dir.file("send-journal.jsonl");
    const indexFile = dir.file("message-index.json");

    // Write a pending intent (no done).
    const journal = createSendJournal({ filePath: journalFile, now: () => 1_700_000_000_000 });
    await journal.recordIntent(makeIntent({ id: "5001-0", source: "market", ledger: 5001 }));

    // Message index is empty.
    await createMessageIndex({ filePath: indexFile });

    const report = await buildDeliveryReport({ journalFile, indexFile });

    assert.equal(report.readOnly, true);
    assert.equal(report.pendingIntents, 1);
    assert.equal(report.indexedMessages, 0);
    assert.equal(report.unresolvedIntents, 1);
    assert.equal(report.orphanedIndexEntries, 0);
    assert.equal(report.inconsistencies.length, 1);

    const inc = report.inconsistencies[0];
    assert.equal(inc.kind, "UNRESOLVED_INTENT");
    assert.ok(inc.reason.includes("5001"));
    assert.ok(inc.journalEntry !== undefined);
    assert.equal(inc.journalEntry.id, "5001-0");
  });
});

test("delivery report: settled intent (intent + done) produces no inconsistency", async () => {
  await withTempDataDir(async (dir) => {
    const journalFile = dir.file("send-journal.jsonl");
    const indexFile = dir.file("message-index.json");

    const journal = createSendJournal({ filePath: journalFile, now: () => 1_700_000_000_000 });
    await journal.recordIntent(makeIntent({ id: "5002-0" }));
    await journal.recordDone("5002-0");

    // Index has a matching record.
    const index = await createMessageIndex({ filePath: indexFile });
    await index.record(12345, "market:5002", 1001);

    const report = await buildDeliveryReport({ journalFile, indexFile });

    assert.equal(report.unresolvedIntents, 0);
    // The done settled the intent; pending is 0.
    assert.equal(report.pendingIntents, 0);
  });
});

// ── ORPHANED_INDEX ────────────────────────────────────────────────────────────

test("delivery report: orphaned index entry when index has record with no pending intent", async () => {
  await withTempDataDir(async (dir) => {
    const journalFile = dir.file("send-journal.jsonl");
    const indexFile = dir.file("message-index.json");

    // Journal is empty.
    createSendJournal({ filePath: journalFile, now: () => 1_700_000_000_000 });

    // Index has a record for an event the journal does not know about.
    const index = await createMessageIndex({ filePath: indexFile });
    await index.record(12345, "squad:99", 500);

    const report = await buildDeliveryReport({ journalFile, indexFile });

    assert.equal(report.readOnly, true);
    assert.equal(report.pendingIntents, 0);
    assert.equal(report.indexedMessages, 1);
    assert.equal(report.unresolvedIntents, 0);
    assert.equal(report.orphanedIndexEntries, 1);

    const inc = report.inconsistencies[0];
    assert.equal(inc.kind, "ORPHANED_INDEX");
    assert.ok(inc.reason.includes("squad:99"));
    assert.ok(inc.indexEntry !== undefined);
    assert.equal(inc.indexEntry.ref, "squad:99");
    assert.equal(inc.indexEntry.messageId, 500);
  });
});

// ── Mixed: unresolved + orphaned ──────────────────────────────────────────────

test("delivery report: mixed inconsistencies — both kinds present", async () => {
  await withTempDataDir(async (dir) => {
    const journalFile = dir.file("send-journal.jsonl");
    const indexFile = dir.file("message-index.json");

    const journal = createSendJournal({ filePath: journalFile, now: () => 1_700_000_000_000 });
    // Pending intent for ledger 5010 (no index record).
    await journal.recordIntent(makeIntent({ id: "5010-0", source: "market", ledger: 5010 }));

    const index = await createMessageIndex({ filePath: indexFile });
    // Index has a record for squad:200 (no pending intent).
    await index.record(-100987654321, "squad:200", 777);

    const report = await buildDeliveryReport({ journalFile, indexFile });

    assert.equal(report.unresolvedIntents, 1);
    assert.equal(report.orphanedIndexEntries, 1);
    assert.equal(report.inconsistencies.length, 2);

    const kinds = report.inconsistencies.map((i) => i.kind).sort();
    assert.deepEqual(kinds, ["ORPHANED_INDEX", "UNRESOLVED_INTENT"]);
  });
});

// ── Empty / missing files ─────────────────────────────────────────────────────

test("delivery report: both files absent produces zero-entry report", async () => {
  await withTempDataDir(async (dir) => {
    const report = await buildDeliveryReport({
      journalFile: dir.file("does-not-exist.jsonl"),
      indexFile: dir.file("also-missing.json"),
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.pendingIntents, 0);
    assert.equal(report.indexedMessages, 0);
    assert.equal(report.inconsistencies.length, 0);
    assert.equal(report.unresolvedIntents, 0);
    assert.equal(report.orphanedIndexEntries, 0);
  });
});

test("delivery report: journal absent but index populated produces only orphaned entries", async () => {
  await withTempDataDir(async (dir) => {
    const indexFile = dir.file("message-index.json");
    const index = await createMessageIndex({ filePath: indexFile });
    await index.record(12345, "market:1", 101);
    await index.record(12345, "market:2", 102);

    const report = await buildDeliveryReport({
      journalFile: dir.file("no-journal.jsonl"),
      indexFile,
    });

    assert.equal(report.pendingIntents, 0);
    assert.equal(report.indexedMessages, 2);
    assert.equal(report.orphanedIndexEntries, 2);
    assert.equal(report.unresolvedIntents, 0);
  });
});
