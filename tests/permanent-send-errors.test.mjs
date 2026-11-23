import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import { GrammyError } from "grammy";

import {
  classifyPermanentSendError as classifyFromBot,
  isBotBlockedError as isBotBlockedFromBot,
  isChatNotFoundError as isChatNotFoundFromBot,
  PERMANENT_SEND_ERROR_CODES as CODES_FROM_BOT,
} from "../dist/bot.js";
import {
  classifyPermanentSendError,
  isBotBlockedError,
  isChatNotFoundError,
  PERMANENT_SEND_ERROR_CODES,
} from "../dist/notifications/notifier.js";
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

test("permanent error codes and classifiers are re-exported from bot.js", () => {
  assert.strictEqual(CODES_FROM_BOT, PERMANENT_SEND_ERROR_CODES);
  assert.strictEqual(classifyFromBot, classifyPermanentSendError);
  assert.strictEqual(isBotBlockedFromBot, isBotBlockedError);
  assert.strictEqual(isChatNotFoundFromBot, isChatNotFoundError);
  assert.equal(PERMANENT_SEND_ERROR_CODES.BOT_BLOCKED, "BOT_BLOCKED");
  assert.equal(PERMANENT_SEND_ERROR_CODES.CHAT_NOT_FOUND, "CHAT_NOT_FOUND");
});

test("classifies bot-blocked (403) and chat-not-found (400) separately", () => {
  const blocked = new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    "sendMessage",
    {},
  );
  const notFound = new GrammyError(
    "Call to 'sendMessage' failed!",
    { ok: false, error_code: 400, description: "Bad Request: chat not found" },
    "sendMessage",
    {},
  );

  assert.equal(isBotBlockedError(blocked), true);
  assert.equal(isChatNotFoundError(blocked), false);
  assert.equal(classifyPermanentSendError(blocked), PERMANENT_SEND_ERROR_CODES.BOT_BLOCKED);

  assert.equal(isChatNotFoundError(notFound), true);
  assert.equal(isBotBlockedError(notFound), false);
  assert.equal(classifyPermanentSendError(notFound), PERMANENT_SEND_ERROR_CODES.CHAT_NOT_FOUND);
});

test("boundary cases: mismatched error_code, transient 429, and non-objects return null", () => {
  assert.equal(
    classifyPermanentSendError({ error_code: 500, description: "Forbidden: bot was blocked by the user" }),
    null,
  );
  assert.equal(
    classifyPermanentSendError({ error_code: 403, description: "Bad Request: chat not found" }),
    null,
  );
  assert.equal(
    classifyPermanentSendError({ error_code: 429, description: "Too Many Requests: retry after 5" }),
    null,
  );
  assert.equal(classifyPermanentSendError(null), null);
  assert.equal(classifyPermanentSendError("chat not found"), null);
});

test("poller does not retry BOT_BLOCKED or CHAT_NOT_FOUND errors", async () => {
  for (const permanentErr of [
    new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      {},
    ),
    new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 400, description: "Bad Request: chat not found" },
      "sendMessage",
      {},
    ),
  ]) {
    const dir = await createTempDataDir("mimir-perm-err-");
    let sendAttempts = 0;
    try {
      const server = {
        async getHealth() {
          return { status: "healthy", oldestLedger: 4_000, latestLedger: 5_001 };
        },
        async getEvents(req) {
          const id = req.filters?.[0]?.contractIds?.[0];
          if (id !== MARKET_ID) {
            return { events: [], cursor: `${5_001n << 32n}-0`, latestLedger: 5_001 };
          }
          return {
            events: [
              {
                contractId: MARKET_ID,
                ledger: 5001,
                txHash: "abc",
                ledgerClosedAt: "2026-01-01T00:00:00Z",
                id: "5001-0",
                topic: [scStr("claim_created"), scU64(5001), scAddress(ADDR)],
                value: nativeToScVal({ category: "crypto" }),
              },
            ],
            cursor: `${5_001n << 32n}-0`,
            latestLedger: 5_001,
          };
        },
      };

      const poller = createPoller({
        config: {
          botToken: BOT_TOKEN,
          chatId: "-1001234567890",
          marketContractId: MARKET_ID,
          squadContractId: SQUAD_ID,
          rpcUrl: "https://soroban-testnet.stellar.org",
          horizonUrl: "https://horizon-testnet.stellar.org",
          networkPassphrase: "Test SDF Network ; September 2015",
          pollIntervalMs: 60_000,
          startLookbackLedgers: 60,
          cursorFile: dir.file("cursor.json"),
          lockFile: dir.file("poller.lock"),
          maxNotificationsPerCycle: 20,
        },
        server,
        send: async () => {
          sendAttempts += 1;
          throw permanentErr;
        },
        sendOptions: {
          maxSendRetries: 3,
          initialBackoffMs: 1,
          maxBackoffMs: 1,
          sendSpacingMs: 0,
        },
      });

      await poller.runCycle();
      assert.equal(sendAttempts, 1, "permanent error must not enter transient retry loop");
    } finally {
      await dir.cleanup();
    }
  }
});
