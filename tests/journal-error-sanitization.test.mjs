import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { GrammyError } from "grammy";

import {
  createNotifier,
  MAX_JOURNAL_ERROR_DESCRIPTION_CHARS,
  sanitizeTelegramJournalError,
} from "../dist/bot.js";
import { createSendJournal } from "../dist/notifications/send-journal.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const BOT_CREDENTIAL = ["987654321", `AA${"FakeTestValue".repeat(3)}`].join(":");
const SEED_STRKEY = `S${"A".repeat(55)}`;
const CUSTOM_AUTH = `custom-bearer-${"z".repeat(24)}`;

test("sanitizeTelegramJournalError redacts credentials, bounds remote descriptions, and retains stable triage codes", () => {
  const rateLimitErr = new GrammyError(
    "Call to 'sendMessage' failed!",
    {
      ok: false,
      error_code: 429,
      description:
        `Too Many Requests: retry after 45 at https://api.telegram.org/bot${BOT_CREDENTIAL}/sendMessage ` +
        `seed=${SEED_STRKEY} auth=${CUSTOM_AUTH}\n${"x".repeat(600)}`,
      parameters: { retry_after: 45 },
    },
    "sendMessage",
    {},
  );

  const sanitized429 = sanitizeTelegramJournalError(rateLimitErr, {
    secrets: [BOT_CREDENTIAL, CUSTOM_AUTH],
  });
  assert.equal(sanitized429.errorCode, "TG_RATE_LIMITED");
  assert.equal(sanitized429.telegramErrorCode, 429);
  assert.equal(sanitized429.retryAfterSeconds, 45);
  assert.ok(sanitized429.description.length <= MAX_JOURNAL_ERROR_DESCRIPTION_CHARS);
  assert.ok(!sanitized429.description.includes(BOT_CREDENTIAL));
  assert.ok(!sanitized429.description.includes(SEED_STRKEY));
  assert.ok(!sanitized429.description.includes(CUSTOM_AUTH));
  assert.ok(!sanitized429.description.includes("\n"));

  const cases = [
    [
      new GrammyError("fail", { ok: false, error_code: 401, description: "Unauthorized" }, "sendMessage", {}),
      "TG_UNAUTHORIZED",
      401,
    ],
    [
      new GrammyError("fail", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {}),
      "TG_FORBIDDEN",
      403,
    ],
    [
      new GrammyError("fail", { ok: false, error_code: 404, description: "Not Found" }, "sendMessage", {}),
      "TG_NOT_FOUND",
      404,
    ],
    [
      new GrammyError("fail", { ok: false, error_code: 400, description: "Bad Request: can't parse entities: bad '*'" }, "sendMessage", {}),
      "TG_ENTITY_PARSE_ERROR",
      400,
    ],
    [
      new GrammyError("fail", { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "sendMessage", {}),
      "TG_BAD_REQUEST",
      400,
    ],
    [
      new GrammyError("fail", { ok: false, error_code: 502, description: "Bad Gateway" }, "sendMessage", {}),
      "TG_SERVER_ERROR",
      502,
    ],
    [
      Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
      "SEND_TIMEOUT",
      undefined,
    ],
    [
      Object.assign(new Error("Network request for 'sendMessage' failed!"), { name: "HttpError" }),
      "NETWORK_ERROR",
      undefined,
    ],
  ];

  for (const [err, expectedCode, expectedHttp] of cases) {
    const out = sanitizeTelegramJournalError(err);
    assert.equal(out.errorCode, expectedCode);
    assert.equal(out.telegramErrorCode, expectedHttp);
  }
});

test("SendJournal.recordFailure and createNotifier sanitize remote errors before disk persistence", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("send-journal.jsonl");
    const journal = createSendJournal({
      filePath: journalPath,
      secrets: [BOT_CREDENTIAL, CUSTOM_AUTH],
      now: () => 1_700_000_000_000,
    });

    await journal.recordIntent({
      id: "evt-fail-1",
      source: "market",
      ledger: 7001,
      eventName: "claim_created",
      textHash: "0123456789abcdef",
      at: 1_700_000_000_000,
    });

    const hostileDescription =
      `Forbidden: kicked from chat https://user:hunter2pass@rpc.example?key=superkey999 ` +
      `https://api.telegram.org/bot${BOT_CREDENTIAL}/sendMessage\r\n` +
      `{"kind":"done","id":"evt-fail-1"}\n` +
      `seed=${SEED_STRKEY} custom=${CUSTOM_AUTH} ${"Z".repeat(800)}`;

    const fakeBot = {
      api: {
        sendMessage: async () => {
          throw new GrammyError(
            "Call to 'sendMessage' failed!",
            { ok: false, error_code: 403, description: hostileDescription },
            "sendMessage",
            {},
          );
        },
      },
    };

    const notify = createNotifier(
      fakeBot,
      {
        chatId: "-1001234567890",
        marketChatId: "-1001234567890",
        squadChatId: "-1009876543210",
        botToken: BOT_CREDENTIAL,
      },
      { sendJournal: journal },
    );

    await assert.rejects(
      notify("hello world", "market", {
        eventName: "claim_created",
        eventRef: { eventId: "evt-fail-1", ledger: 7001, source: "market" },
      }),
    );

    // Raw on-disk JSONL must never contain leaked credentials, injected lines, or unbounded payloads.
    const rawDisk = await readFile(journalPath, "utf8");
    const nonEmptyLines = rawDisk.trim().split("\n");
    assert.equal(nonEmptyLines.length, 2, "must contain exactly intent + failed JSONL lines");
    assert.ok(!rawDisk.includes(BOT_CREDENTIAL));
    assert.ok(!rawDisk.includes(SEED_STRKEY));
    assert.ok(!rawDisk.includes(CUSTOM_AUTH));
    assert.ok(!rawDisk.includes("hunter2pass"));
    assert.ok(!rawDisk.includes("superkey999"));

    const pending = await journal.loadPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "evt-fail-1");
    assert.equal(pending[0].errorCode, "TG_FORBIDDEN");
    assert.equal(pending[0].telegramErrorCode, 403);
    assert.ok(pending[0].errorDescription.length <= MAX_JOURNAL_ERROR_DESCRIPTION_CHARS);

    const failures = await journal.loadFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].errorCode, "TG_FORBIDDEN");

    // Compaction preserves sanitized failure metadata on unresolved intents, and done settles it.
    await journal.compact();
    const afterCompact = await journal.loadPending();
    assert.equal(afterCompact.length, 1);
    assert.equal(afterCompact[0].errorCode, "TG_FORBIDDEN");

    await journal.recordDone("evt-fail-1");
    assert.deepEqual(await journal.loadPending(), []);
    assert.deepEqual(await journal.loadFailures(), []);
  }, "journal-err-sanitize-");
});
