import assert from "node:assert/strict";
import test from "node:test";

import { GrammyError } from "grammy";

import {
  createNotifier,
  InvalidTelegramDeliveryResultError,
  isValidTelegramDeliveryResult,
  MAX_JOURNAL_DIAGNOSTIC_CHARS,
} from "../dist/bot.js";
import { createSendJournal } from "../dist/notifications/send-journal.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const BOT_CREDENTIAL = ["123456789", `AA${"FakeTestValue".repeat(3)}`].join(":");

function baseConfig(overrides = {}) {
  return {
    chatId: "-1001234567890",
    marketChatId: "-1001234567890",
    squadChatId: "-1009876543210",
    botToken: BOT_CREDENTIAL,
    ...overrides,
  };
}

test("isValidTelegramDeliveryResult accepts only positive safe integer message_id", () => {
  assert.equal(isValidTelegramDeliveryResult({ message_id: 1 }), true);
  assert.equal(isValidTelegramDeliveryResult({ message_id: 987654, chat: { id: -1001 } }), true);

  for (const invalid of [
    undefined,
    null,
    {},
    [],
    "ok",
    42,
    { ok: true },
    { chat: { id: -1001234567890 } },
    { message_id: undefined },
    { message_id: null },
    { message_id: 0 },
    { message_id: -7 },
    { message_id: 1.5 },
    { message_id: Number.NaN },
    { message_id: "123" },
  ]) {
    assert.equal(isValidTelegramDeliveryResult(invalid), false);
  }
});

test("notifier rejects responses missing message_id and retains a bounded recoverable journal entry", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("send-journal.jsonl");
    const journal = createSendJournal({
      filePath: journalPath,
      secrets: [BOT_CREDENTIAL],
      now: () => 1_700_000_000_000,
    });

    await journal.recordIntent({
      id: "evt-missing-1",
      source: "market",
      ledger: 5100,
      eventName: "claim_created",
      textHash: "0123456789abcdef",
      at: 1_700_000_000_000,
    });

    const responses = [
      {},
      undefined,
      { ok: true, chat: { id: -1001234567890 } },
      { message_id: 0 },
      { message_id: "99" },
    ];
    let idx = 0;
    const fakeBot = {
      api: {
        sendMessage: async () => responses[idx++],
      },
    };

    const notify = createNotifier(fakeBot, baseConfig(), { sendJournal: journal });

    for (let i = 0; i < responses.length; i += 1) {
      await assert.rejects(
        notify("hello world", "market", {
          eventRef: { eventId: "evt-missing-1", ledger: 5100, source: "market" },
        }),
        (err) => err instanceof InvalidTelegramDeliveryResultError,
      );
    }

    // Never marked confirmed/done: intent remains pending with bounded diagnostic.
    const pendingBeforeCompact = await journal.loadPending();
    assert.equal(pendingBeforeCompact.length, 1);
    assert.equal(pendingBeforeCompact[0].id, "evt-missing-1");
    assert.equal(typeof pendingBeforeCompact[0].diagnostic, "string");
    assert.ok(pendingBeforeCompact[0].diagnostic.length <= MAX_JOURNAL_DIAGNOSTIC_CHARS);
    assert.match(pendingBeforeCompact[0].diagnostic, /invalid_message_id|missing_message_id/);

    // Compaction preserves the unresolved intent and its bounded diagnostic.
    await journal.compact();
    const pendingAfterCompact = await journal.loadPending();
    assert.equal(pendingAfterCompact.length, 1);
    assert.equal(pendingAfterCompact[0].id, "evt-missing-1");
    assert.equal(pendingAfterCompact[0].diagnostic, pendingBeforeCompact[0].diagnostic);

    // Oversized or credential-bearing diagnostics are redacted and length-bounded.
    await journal.recordDiagnostic({
      id: "evt-missing-1",
      diagnostic: `upstream https://api.telegram.org/bot${BOT_CREDENTIAL}/sendMessage ${"x".repeat(500)}`,
    });
    const [redactedPending] = await journal.loadPending();
    assert.ok(!redactedPending.diagnostic.includes(BOT_CREDENTIAL));
    assert.ok(redactedPending.diagnostic.length <= MAX_JOURNAL_DIAGNOSTIC_CHARS);

    // Explicit confirmDelivery / recordDone with valid message_id finally settles the entry.
    const outcome = await journal.confirmDelivery("evt-missing-1", { message_id: 404 });
    assert.deepEqual(outcome, { confirmed: true, messageId: 404 });
    assert.deepEqual(await journal.loadPending(), []);
  }, "missing-msg-id-");
});

test("chunked sends and plain-text fallback retries also reject responses missing message_id", async () => {
  await withTempDataDir(async (dir) => {
    const journal = createSendJournal({ filePath: dir.file("chunk-journal.jsonl") });
    await journal.recordIntent({
      id: "evt-chunk-2",
      source: "market",
      ledger: 5101,
      eventName: "claim_challenged",
      at: 1_700_000_001_000,
    });

    // First chunk returns valid message_id, second chunk omits message_id.
    let call = 0;
    const chunkBot = {
      api: {
        sendMessage: async () => {
          call += 1;
          return call === 1 ? { message_id: 10 } : { chat: { id: -1001234567890 } };
        },
      },
    };
    const notifyChunked = createNotifier(chunkBot, baseConfig(), { sendJournal: journal });
    const oversized = `${"a".repeat(3000)}\n${"b".repeat(3000)}`;

    await assert.rejects(
      notifyChunked(oversized, "market", {
        eventRef: { eventId: "evt-chunk-2", ledger: 5101, source: "market" },
      }),
      (err) =>
        err instanceof InvalidTelegramDeliveryResultError &&
        err.diagnostic.includes("chunk 2/2"),
    );

    const pendingChunk = await journal.loadPending();
    assert.equal(pendingChunk.length, 1);
    assert.match(pendingChunk[0].diagnostic, /chunk 2\/2/);

    // Plain-text fallback after MarkdownV2 parse error also validates message_id.
    await journal.recordIntent({
      id: "evt-fallback-3",
      source: "market",
      ledger: 5102,
      eventName: "claim_settled",
      at: 1_700_000_002_000,
    });
    let fallbackCall = 0;
    const fallbackBot = {
      api: {
        sendMessage: async () => {
          fallbackCall += 1;
          if (fallbackCall === 1) {
            throw new GrammyError(
              "Call to 'sendMessage' failed!",
              {
                ok: false,
                error_code: 400,
                description: "Bad Request: can't parse entities: unescaped '.'",
              },
              "sendMessage",
              {},
            );
          }
          return {};
        },
      },
    };
    const notifyFallback = createNotifier(fallbackBot, baseConfig(), { sendJournal: journal });
    await assert.rejects(
      notifyFallback("bad.md", "market", {
        plainText: "safe plain text",
        eventRef: { eventId: "evt-fallback-3", ledger: 5102, source: "market" },
      }),
      (err) => err instanceof InvalidTelegramDeliveryResultError,
    );
    assert.equal(fallbackCall, 2);

    const allPending = await journal.loadPending();
    assert.deepEqual(
      allPending.map((e) => e.id),
      ["evt-chunk-2", "evt-fallback-3"],
    );
  }, "missing-msg-id-edge-");
});
