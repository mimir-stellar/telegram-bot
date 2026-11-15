import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  formatDeliveryReconciliationReport,
  reconcileDeliveryState,
} from "../dist/bot.js";
import { createMessageIndex } from "../dist/notifications/message-index.js";
import { createSendJournal } from "../dist/notifications/send-journal.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const PRIVATE_MARKET_CHAT = "-1005551112223";
const PRIVATE_SQUAD_CHAT = "-1009998887776";

test("reconcileDeliveryState reports CONSISTENT when settled journal entries match message-index", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("send-journal.jsonl");
    const indexPath = dir.file("message-index.json");

    const journal = createSendJournal({ filePath: journalPath, now: () => 1_700_000_000_000 });
    await journal.recordIntent({
      id: "evt-100",
      source: "market",
      ledger: 6001,
      eventName: "claim_created",
      at: 1_700_000_000_000,
    });
    await journal.recordDone("evt-100", { messageId: 501 });

    const index = await createMessageIndex({ filePath: indexPath, now: () => 1_700_000_000_000 });
    await index.record(PRIVATE_MARKET_CHAT, "market:evt-100", 501);

    const report = await reconcileDeliveryState({
      journalFilePath: journalPath,
      indexFilePath: indexPath,
      config: {
        chatId: PRIVATE_MARKET_CHAT,
        marketChatId: PRIVATE_MARKET_CHAT,
        squadChatId: PRIVATE_SQUAD_CHAT,
      },
      now: () => 1_700_000_005_000,
    });

    assert.equal(report.consistent, true);
    assert.equal(report.consistentCount, 1);
    assert.equal(report.inconsistencies.length, 0);

    const formatted = formatDeliveryReconciliationReport(report);
    assert.match(formatted, /Status: CONSISTENT/);
    assert.ok(!formatted.includes(PRIVATE_MARKET_CHAT));
  }, "reconcile-consistent-");
});

test("reconcileDeliveryState classifies drift across journal and message-index without network or mutation", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("send-journal.jsonl");
    const indexPath = dir.file("message-index.json");

    const journalLines = [
      // 1. Consistent pair
      JSON.stringify({ kind: "intent", id: "ok-1", source: "market", ledger: 10, eventName: "claim_created", at: 100 }),
      JSON.stringify({ kind: "done", id: "ok-1", source: "", ledger: 0, eventName: "", messageId: 11, at: 101 }),
      // 2. Pending intent that ALREADY has an index record (crash after send + index write)
      JSON.stringify({ kind: "intent", id: "pend-indexed", source: "market", ledger: 11, eventName: "claim_created", at: 102 }),
      // 3. Pending intent with NO index record
      JSON.stringify({ kind: "intent", id: "pend-missing", source: "squad", ledger: 12, eventName: "squad_joined", at: 103 }),
      // 4. Done entry missing from message-index
      JSON.stringify({ kind: "intent", id: "done-no-idx", source: "market", ledger: 13, eventName: "claim_settled", at: 104 }),
      JSON.stringify({ kind: "done", id: "done-no-idx", source: "", ledger: 0, eventName: "", messageId: 14, at: 105 }),
      // 5. Message ID mismatch between journal done and message-index
      JSON.stringify({ kind: "intent", id: "msg-mismatch", source: "market", ledger: 14, eventName: "claim_created", at: 106 }),
      JSON.stringify({ kind: "done", id: "msg-mismatch", source: "", ledger: 0, eventName: "", messageId: 200, at: 107 }),
      // 6. Route chat mismatch (recorded under squad chat instead of market chat)
      JSON.stringify({ kind: "intent", id: "chat-mismatch", source: "market", ledger: 15, eventName: "claim_created", at: 108 }),
      JSON.stringify({ kind: "done", id: "chat-mismatch", source: "", ledger: 0, eventName: "", at: 109 }),
      // 7. Orphan done without intent
      JSON.stringify({ kind: "done", id: "orphan-done", source: "", ledger: 0, eventName: "", messageId: 300, at: 110 }),
    ].join("\n") + "\n";

    const indexPayload = JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        entries: [
          { chatId: PRIVATE_MARKET_CHAT, ref: "market:ok-1", messageId: 11 },
          { chatId: PRIVATE_MARKET_CHAT, ref: "market:pend-indexed", messageId: 12 },
          { chatId: PRIVATE_MARKET_CHAT, ref: "market:msg-mismatch", messageId: 299 },
          { chatId: PRIVATE_SQUAD_CHAT, ref: "market:chat-mismatch", messageId: 400 },
          // 8. Index record with no journal record
          { chatId: PRIVATE_SQUAD_CHAT, ref: "squad:compacted-old", messageId: 500 },
        ],
      },
      null,
      2,
    );

    await writeFile(journalPath, journalLines, "utf8");
    await writeFile(indexPath, indexPayload, "utf8");

    const beforeJournalBytes = await readFile(journalPath);
    const beforeIndexBytes = await readFile(indexPath);

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error("offline reconciliation must never invoke fetch");
    };

    let report;
    try {
      report = await reconcileDeliveryState({
        journalFilePath: journalPath,
        indexFilePath: indexPath,
        config: {
          chatId: PRIVATE_MARKET_CHAT,
          marketChatId: PRIVATE_MARKET_CHAT,
          squadChatId: PRIVATE_SQUAD_CHAT,
        },
        now: () => 1_700_000_010_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(fetchCalled, false);
    assert.deepEqual(await readFile(journalPath), beforeJournalBytes);
    assert.deepEqual(await readFile(indexPath), beforeIndexBytes);

    assert.equal(report.consistent, false);
    assert.equal(report.consistentCount, 1);
    assert.deepEqual(report.countsByKind, {
      pending_with_index_record: 1,
      pending_without_index_record: 1,
      done_missing_index_record: 1,
      orphan_done_without_intent: 1,
      message_id_mismatch: 1,
      route_chat_mismatch: 1,
      index_without_journal_record: 1,
    });

    const formatted = formatDeliveryReconciliationReport(report);
    assert.match(formatted, /Status: INCONSISTENT/);
    assert.match(formatted, /pending_with_index_record/);
    assert.match(formatted, /route_chat_mismatch/);
    assert.ok(!formatted.includes(PRIVATE_MARKET_CHAT));
    assert.ok(!formatted.includes(PRIVATE_SQUAD_CHAT));
  }, "reconcile-drift-");
});

test("reconcileDeliveryState surfaces corrupt journal lines and corrupt message-index without quarantining files", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("corrupt-journal.jsonl");
    const indexPath = dir.file("corrupt-index.json");

    const rawJournal =
      `${JSON.stringify({ kind: "intent", id: "evt-1", source: "market", ledger: 1, eventName: "claim_created", at: 1 })}\n` +
      `{torn-json-line\n`;
    const rawIndex = `{"version": 1, "entries": [truncated`;

    await writeFile(journalPath, rawJournal, "utf8");
    await writeFile(indexPath, rawIndex, "utf8");

    const report = await reconcileDeliveryState({
      journalFilePath: journalPath,
      indexFilePath: indexPath,
    });

    assert.equal(report.consistent, false);
    assert.equal(report.journal.corruptLines, 1);
    assert.equal(report.messageIndex.status, "corrupt");
    assert.match(report.messageIndex.error, /invalid JSON/);

    // Both files must remain untouched at their original paths (not renamed/quarantined).
    assert.equal(await readFile(journalPath, "utf8"), rawJournal);
    assert.equal(await readFile(indexPath, "utf8"), rawIndex);
  }, "reconcile-corrupt-");
});
