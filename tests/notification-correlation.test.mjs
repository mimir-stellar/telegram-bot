import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { createDeadLetterQueue } from "../dist/deadLetter.js";
import { listDeadLetters } from "../dist/dlq-cli.js";
import {
  Logger,
  NOTIFICATION_CORRELATION_PREFIX,
  deriveNotificationCorrelationId,
  isNotificationCorrelationId,
  notificationCorrelationIdForEvent,
} from "../dist/logger.js";
import { createPoller } from "../dist/poller.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const BOT_SECRET = ["1234567890:AA", "p".repeat(33)].join("");
const SEED_SECRET = `S${"D".repeat(55)}`;
const CHAT_ID = "-1001234567890";
const MARKET_ID = `C${"A".repeat(55)}`;
const SQUAD_ID = `C${"B".repeat(55)}`;
const CREATOR_ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x24)).publicKey();

const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) =>
  Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const cursorFor = (ledger) => `${BigInt(ledger) << 32n}-0`;

test.afterEach(() => {
  Logger.reset();
});

test("derives a stable event-derived ntf-<16hex> identifier independent of message text", () => {
  const idA = deriveNotificationCorrelationId({
    source: "market",
    ledger: 8_100,
    eventId: "34789235097600-0000000001",
    eventName: "claim_created",
    transactionIndex: 0,
    operationIndex: 1,
  });
  const idB = deriveNotificationCorrelationId({
    source: "MARKET",
    ledger: 8_100,
    eventId: " 34789235097600-0000000001 ",
    eventName: "claim_created",
    transactionIndex: 0,
    operationIndex: 1,
  });
  const idDifferentEvent = deriveNotificationCorrelationId({
    source: "market",
    ledger: 8_100,
    eventId: "34789235097600-0000000002",
    eventName: "claim_created",
    transactionIndex: 0,
    operationIndex: 2,
  });

  assert.equal(idA, idB);
  assert.notEqual(idA, idDifferentEvent);
  assert.equal(idA.startsWith(NOTIFICATION_CORRELATION_PREFIX), true);
  assert.equal(isNotificationCorrelationId(idA), true);
  assert.equal(idA.length, 20);
});

test("omits raw message text and credentials even if hostile strings are passed", () => {
  const sensitiveQuestion = "Private merger announcement $50M";
  const dirtyId = deriveNotificationCorrelationId({
    source: `market-${BOT_SECRET}`,
    ledger: 500,
    eventId: `${sensitiveQuestion}:${SEED_SECRET}`,
    eventName: "claim_created?api_key=" + "abcdef1234567890",
  });

  assert.equal(isNotificationCorrelationId(dirtyId), true);
  assert.equal(dirtyId.includes(BOT_SECRET), false);
  assert.equal(dirtyId.includes(SEED_SECRET), false);
  assert.equal(dirtyId.includes("abcdef1234567890"), false);
  assert.equal(dirtyId.includes("merger"), false);

  const lines = [];
  Logger.configure({
    format: "json",
    level: "debug",
    secrets: [BOT_SECRET],
    sink: (_level, line) => lines.push(line),
  });
  const scoped = Logger.withNotificationCorrelation(`raw-body-${sensitiveQuestion}-${BOT_SECRET}`);
  assert.equal(isNotificationCorrelationId(scoped.notificationCorrelationId), true);
  scoped.info("poller", "lifecycle checkpoint");

  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(sensitiveQuestion), false);
  assert.equal(lines[0].includes(BOT_SECRET), false);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.notificationCorrelationId, scoped.notificationCorrelationId);
});

test("dead-letter load replaces missing or tampered notificationCorrelationId with clean event-derived ID", async () => {
  await withTempDataDir(async ({ file }) => {
    const dlqPath = file("dead-letter.json");
    await writeFile(
      dlqPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-15T10:00:00.000Z",
        entries: [
          {
            id: "market:700:claim_created:12345678",
            // Legacy entry: missing notificationCorrelationId
            enqueuedAt: "2026-11-15T10:00:00.000Z",
            source: "market",
            ledger: 700,
            eventName: "claim_created",
            text: "Sensitive notification body",
            attempts: 1,
            lastError: "Telegram 503",
          },
          {
            id: "squad:701:deposited:87654321",
            // Tampered entry trying to smuggle raw text & bot credentials inside correlation field
            notificationCorrelationId: `Sensitive notification body ${BOT_SECRET}`,
            enqueuedAt: "2026-11-15T10:00:01.000Z",
            source: "squad",
            ledger: 701,
            eventName: "deposited",
            text: "Another body",
            attempts: 1,
            lastError: "Telegram 429",
          },
        ],
      }),
      "utf8",
    );

    const queue = createDeadLetterQueue({
      filePath: dlqPath,
      maxEntries: 10,
      maxAttempts: 5,
      secrets: [BOT_SECRET],
    });
    await queue.load();

    const snap = queue.snapshot();
    assert.equal(snap.length, 2);
    for (const entry of snap) {
      assert.equal(isNotificationCorrelationId(entry.notificationCorrelationId), true);
      assert.equal(entry.notificationCorrelationId.includes(BOT_SECRET), false);
      assert.equal(entry.notificationCorrelationId.includes("Sensitive"), false);
    }
    assert.equal(
      snap[0].notificationCorrelationId,
      deriveNotificationCorrelationId({
        source: "market",
        ledger: 700,
        eventName: "claim_created",
      }),
    );
  });
});

test("carries one identical notificationCorrelationId from scan to failed send, dead-letter file, and replay", async () => {
  await withTempDataDir(async ({ root, file }) => {
    const jsonLines = [];
    Logger.configure({
      format: "json",
      level: "debug",
      secrets: [BOT_SECRET, CHAT_ID],
      sink: (_level, line) => jsonLines.push(line),
    });

    const uniqueCanaryCategory = "secret_canary_category_value";
    let emitted = false;
    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 8_900, latestLedger: 9_001 };
      },
      async getEvents(req) {
        const contractId = req.filters?.[0]?.contractIds?.[0];
        if (contractId === MARKET_ID && !emitted) {
          emitted = true;
          return {
            events: [
              {
                contractId: MARKET_ID,
                ledger: 9_001,
                txHash: "ab".repeat(32),
                ledgerClosedAt: "2026-11-15T12:00:00Z",
                id: "9001-0",
                topic: [scStr("claim_created"), scU64(42), scAddress(CREATOR_ADDR)],
                value: nativeToScVal({ category: uniqueCanaryCategory }),
              },
            ],
            cursor: cursorFor(9_001),
            latestLedger: 9_001,
          };
        }
        return { events: [], cursor: cursorFor(9_001), latestLedger: 9_001 };
      },
    };

    const expectedCorrelationId = notificationCorrelationIdForEvent({
      source: "market",
      ledger: 9_001,
      eventId: "9001-0",
      transactionIndex: null,
      operationIndex: null,
      payload: { name: "claim_created" },
    });

    let shouldFailSend = true;
    const sendAttempts = [];
    const dlqFile = file("dead-letter.json");

    const poller = createPoller({
      config: {
        botToken: BOT_SECRET,
        chatId: CHAT_ID,
        marketContractId: MARKET_ID,
        squadContractId: SQUAD_ID,
        rpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        pollIntervalMs: 1_000,
        startLookbackLedgers: 60,
        cursorFile: path.join(root, "cursor.json"),
        lockFile: path.join(root, "poller.lock"),
        statusFile: path.join(root, "status.json"),
        auditFile: path.join(root, "audit.jsonl"),
        countersFile: path.join(root, "counters.json"),
        deadLetterFile: dlqFile,
        deadLetterMax: 10,
        deadLetterMaxAttempts: 5,
        maxNotificationsPerCycle: 20,
        healthHost: "127.0.0.1",
        healthPort: 0,
        healthStaleMs: 90_000,
      },
      server,
      send: async (text, source, extra) => {
        sendAttempts.push({ text, source, extra });
        if (shouldFailSend) {
          throw new Error(`Telegram 502 via https://api.telegram.org/bot${BOT_SECRET}/sendMessage`);
        }
      },
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      sleep: async () => undefined,
    });

    // Cycle 1: Scan -> Delivery fails -> Enqueued to dead-letter.
    await poller.runCycle();
    const cycle1Correlation = poller.status().lastCorrelationId;

    assert.equal(sendAttempts.length, 1);
    assert.equal(sendAttempts[0].extra?.notificationCorrelationId, expectedCorrelationId);

    const persistedDlq = JSON.parse(await readFile(dlqFile, "utf8"));
    assert.equal(persistedDlq.entries.length, 1);
    assert.equal(persistedDlq.entries[0].notificationCorrelationId, expectedCorrelationId);

    const cliListed = await listDeadLetters({ filePath: dlqFile, chatId: CHAT_ID });
    assert.equal(cliListed[0].notificationCorrelationId, expectedCorrelationId);

    // Cycle 2: Telegram recovers -> Dead-letter replays the parked notification.
    shouldFailSend = false;
    await poller.runCycle();
    const cycle2Correlation = poller.status().lastCorrelationId;
    assert.notEqual(cycle1Correlation, cycle2Correlation);

    assert.equal(sendAttempts.length, 2);
    assert.equal(sendAttempts[1].extra?.notificationCorrelationId, expectedCorrelationId);

    const records = jsonLines.map((l) => JSON.parse(l));
    const scannedRec = records.find((r) => r.action === "event_scanned");
    const failedRec = records.find((r) => r.action === "notification_failed");
    const replayedRec = records.find((r) => r.action === "dead_letter_replayed");

    assert.ok(scannedRec, "expected event_scanned structured record");
    assert.ok(failedRec, "expected notification_failed structured record");
    assert.ok(replayedRec, "expected dead_letter_replayed structured record");

    assert.equal(scannedRec.notificationCorrelationId, expectedCorrelationId);
    assert.equal(failedRec.notificationCorrelationId, expectedCorrelationId);
    assert.equal(replayedRec.notificationCorrelationId, expectedCorrelationId);

    // Verify neither raw message text (canary category) nor credentials appear in structured logs.
    for (const rawLine of jsonLines) {
      assert.equal(rawLine.includes(uniqueCanaryCategory), false, `raw message payload leaked: ${rawLine}`);
      assert.equal(rawLine.includes(BOT_SECRET), false, `bot secret leaked: ${rawLine}`);
      assert.equal(rawLine.includes(CHAT_ID), false, `chat id leaked: ${rawLine}`);
    }
  });
});
