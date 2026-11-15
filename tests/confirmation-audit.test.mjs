import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIRMATION_OUTCOMES,
  appendAuditFile,
  confirmationAuditEntry,
  createAuditLog,
  readAuditFile,
} from "../dist/audit.js";
import { checkAuditFile } from "../dist/audit-check-cli.js";
import {
  BroadcastStore,
  CALLBACK_PAUSE_CANCEL,
  CALLBACK_PAUSE_CONFIRM,
  PAUSE_CONFIRM_TTL_MS,
  createBot,
  handleBroadcastCallback,
  handleCallbackQuery,
  handlePauseConfirmCallback,
} from "../dist/bot.js";

const TEST_BOT_TOKEN = ["123456789:", "A".repeat(35)].join("");
const OPERATOR_ID = "424242";

function baseConfig(overrides = {}) {
  return {
    botToken: TEST_BOT_TOKEN,
    chatId: "-100111222333",
    chatIds: ["-100111222333", "-100444555666"],
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    operatorTelegramUserId: OPERATOR_ID,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    auditFile: "/tmp/unused-audit.jsonl",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    interSendDelayMs: 0,
    ...overrides,
  };
}

function richUserProfile(id, label = "PrivateOperator") {
  return {
    id: Number(id),
    is_bot: false,
    first_name: `${label}FirstName`,
    last_name: `${label}LastName`,
    username: `${label.toLowerCase()}_secret_handle`,
    language_code: "en",
  };
}

function assertNoProfileOrBodyLeak(entries, forbiddenSubstrings) {
  const serialized = JSON.stringify(entries);
  for (const needle of forbiddenSubstrings) {
    assert.equal(
      serialized.includes(needle),
      false,
      `audit entry leaked sensitive substring "${needle}" in ${serialized}`,
    );
  }
}

test("CONFIRMATION_OUTCOMES exposes accepted, rejected, expired, and cancelled", () => {
  assert.deepEqual(CONFIRMATION_OUTCOMES, ["accepted", "rejected", "expired", "cancelled"]);
  assert.throws(
    () => confirmationAuditEntry({ action: "pause", outcome: "unknown" }),
    TypeError,
  );
});

test("pause confirmation callbacks record accepted, cancelled, expired, and rejected outcomes without Telegram profiles", async () => {
  const audit = createAuditLog();
  const config = baseConfig();
  const baseSec = 1_700_000_000;
  let pauseCalls = 0;

  const makeCtx = (userId, data, messageDateSec = baseSec) => ({
    from: richUserProfile(userId, userId === Number(OPERATOR_ID) ? "Operator" : "Intruder"),
    chat: { id: -100999888777, type: "supergroup", title: "Private Ops Room" },
    update: { update_id: 10 },
    callbackQuery: {
      id: "cq_pause",
      data,
      message: {
        message_id: 77,
        date: messageDateSec,
        chat: { id: -100999888777, type: "supergroup" },
      },
    },
    answerCallbackQuery: async () => true,
    editMessageText: async () => true,
  });

  const deps = {
    config,
    audit,
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
  };

  // 1. Accepted
  await handlePauseConfirmCallback(
    makeCtx(Number(OPERATOR_ID), CALLBACK_PAUSE_CONFIRM),
    deps,
    baseSec * 1000 + 500,
  );
  // 2. Cancelled
  await handlePauseConfirmCallback(
    makeCtx(Number(OPERATOR_ID), CALLBACK_PAUSE_CANCEL),
    deps,
    baseSec * 1000 + 1000,
  );
  // 3. Expired
  await handlePauseConfirmCallback(
    makeCtx(Number(OPERATOR_ID), CALLBACK_PAUSE_CONFIRM, baseSec),
    deps,
    baseSec * 1000 + PAUSE_CONFIRM_TTL_MS + 1,
  );
  // 4. Rejected (unauthorized non-operator)
  await handlePauseConfirmCallback(
    makeCtx(987654321, CALLBACK_PAUSE_CONFIRM),
    deps,
    baseSec * 1000 + 1500,
  );

  assert.equal(pauseCalls, 1);
  const entries = audit.entries();
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.equal(entry.kind, "operator_confirmation");
  }

  assert.match(entries[0].detail, /action=pause outcome=accepted result=paused/);
  assert.match(entries[1].detail, /action=pause outcome=cancelled/);
  assert.match(entries[2].detail, /action=pause outcome=expired reason=ttl_exceeded/);
  assert.match(entries[3].detail, /action=pause outcome=rejected reason=unauthorized/);

  assertNoProfileOrBodyLeak(entries, [
    OPERATOR_ID,
    "987654321",
    "-100999888777",
    "OperatorFirstName",
    "OperatorLastName",
    "operator_secret_handle",
    "IntruderFirstName",
    "intruder_secret_handle",
    "Private Ops Room",
  ]);
});

test("broadcast confirmation callbacks record accepted, cancelled, expired, and rejected outcomes without storing broadcast bodies or profiles", async () => {
  const audit = createAuditLog();
  const config = baseConfig();
  const store = new BroadcastStore();
  const announcementBody = "PRIVATE_INTERNAL_MAINTENANCE_BODY_991122_NEVER_STORE_IN_AUDIT";
  const destChats = ["-100777111222", "-100888333444"];

  const makeApi = () => {
    const sent = [];
    return {
      sent,
      sendMessage: async (chatId, text, options) => {
        sent.push({ chatId: String(chatId), text, options });
        return { message_id: sent.length };
      },
    };
  };

  const makeBroadcastCtx = ({ userId = Number(OPERATOR_ID), chatType = "private", data, api }) => ({
    from: richUserProfile(userId, "BroadcastActor"),
    chat: { id: userId, type: chatType, username: "private_dm_username" },
    update: { update_id: 500 },
    api,
    callbackQuery: {
      id: "cq_bcast",
      data,
      message: { message_id: 88, chat: { id: userId, type: chatType } },
    },
    editMessageText: async () => true,
    answerCallbackQuery: async () => true,
    reply: async () => true,
  });

  // 1. Accepted confirmation
  const pAccepted = store.create(OPERATOR_ID, announcementBody, destChats, 60_000);
  const apiAccepted = makeApi();
  await handleBroadcastCallback(
    makeBroadcastCtx({ data: `broadcast:confirm:${pAccepted.id}`, api: apiAccepted }),
    { config, audit, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pAccepted.id}`,
    pAccepted.createdAt + 100,
  );
  assert.equal(apiAccepted.sent.length, 2);

  // 2. Replay of already-accepted confirmation -> rejected
  await handleBroadcastCallback(
    makeBroadcastCtx({ data: `broadcast:confirm:${pAccepted.id}`, api: apiAccepted }),
    { config, audit, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pAccepted.id}`,
    pAccepted.createdAt + 200,
  );
  assert.equal(apiAccepted.sent.length, 2, "replay must not resend");

  // 3. Cancelled confirmation
  const pCancelled = store.create(OPERATOR_ID, announcementBody, destChats, 60_000);
  const apiCancelled = makeApi();
  await handleBroadcastCallback(
    makeBroadcastCtx({ data: `broadcast:cancel:${pCancelled.id}`, api: apiCancelled }),
    { config, audit, broadcastStore: store, sleep: async () => {} },
    `broadcast:cancel:${pCancelled.id}`,
    pCancelled.createdAt + 100,
  );
  assert.equal(apiCancelled.sent.length, 0);

  // 4. Expired confirmation (direct TTL expiry before cleanup)
  const pExpiredDirect = store.create(OPERATOR_ID, announcementBody, destChats, 1000);
  const apiExpired = makeApi();
  await handleBroadcastCallback(
    makeBroadcastCtx({ data: `broadcast:confirm:${pExpiredDirect.id}`, api: apiExpired }),
    { config, audit, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pExpiredDirect.id}`,
    pExpiredDirect.expiresAt + 50,
  );
  assert.equal(apiExpired.sent.length, 0);

  // 5. Expired confirmation after store.cleanup() has already evicted the pending body
  const pExpiredEvicted = store.create(OPERATOR_ID, announcementBody, destChats, 500);
  store.cleanup(pExpiredEvicted.expiresAt + 10);
  await handleBroadcastCallback(
    makeBroadcastCtx({ data: `broadcast:confirm:${pExpiredEvicted.id}`, api: apiExpired }),
    { config, audit, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pExpiredEvicted.id}`,
    pExpiredEvicted.expiresAt + 20,
  );
  assert.equal(apiExpired.sent.length, 0);

  // 6. Rejected confirmation (operator tapping in non-private group chat)
  await withoutWarnings(async () => {
    await handleBroadcastCallback(
      makeBroadcastCtx({
        chatType: "supergroup",
        data: `broadcast:confirm:${pAccepted.id}`,
        api: apiExpired,
      }),
      { config, audit, broadcastStore: store, sleep: async () => {} },
      `broadcast:confirm:${pAccepted.id}`,
    );
  });

  // 7. Rejected confirmation via handleCallbackQuery (non-operator)
  await withoutWarnings(async () => {
    await handleCallbackQuery(
      makeBroadcastCtx({
        userId: 777888999,
        data: "broadcast:confirm:any_id",
        api: apiExpired,
      }),
      {
        config,
        audit,
        status: () => ({}),
        pause: () => "stopped",
        resume: () => "stopped",
        broadcastStore: store,
      },
    );
  });

  const entries = audit.entries();
  assert.equal(entries.length, 7);
  const expectedByteLen = Buffer.byteLength(announcementBody, "utf8");

  assert.equal(
    entries[0].detail,
    `action=broadcast outcome=accepted targets=2 bytes=${expectedByteLen} sent=2`,
  );
  assert.equal(entries[1].detail, "action=broadcast outcome=rejected reason=unknown_or_processed");
  assert.equal(
    entries[2].detail,
    `action=broadcast outcome=cancelled targets=2 bytes=${expectedByteLen}`,
  );
  assert.equal(
    entries[3].detail,
    `action=broadcast outcome=expired reason=ttl_exceeded targets=2 bytes=${expectedByteLen}`,
  );
  assert.equal(
    entries[4].detail,
    `action=broadcast outcome=expired reason=ttl_exceeded targets=2 bytes=${expectedByteLen}`,
  );
  assert.equal(entries[5].detail, "action=broadcast outcome=rejected reason=non_private_chat");
  assert.equal(entries[6].detail, "action=broadcast outcome=rejected reason=unauthorized");

  assertNoProfileOrBodyLeak(entries, [
    announcementBody,
    "PRIVATE_INTERNAL_MAINTENANCE_BODY",
    ...destChats,
    OPERATOR_ID,
    "777888999",
    "BroadcastActorFirstName",
    "BroadcastActorLastName",
    "broadcastactor_secret_handle",
    "private_dm_username",
  ]);
});

test("createBot wires audit into pause confirmation callbacks and persists valid JSONL for audit:check", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "mimir-confirm-audit-"));
  const file = path.join(dir, "audit.jsonl");
  try {
    const audit = createAuditLog();
    const config = baseConfig({ auditFile: file });
    const bot = createBot({
      config,
      audit,
      status: () => ({}),
      pause: () => "paused",
      resume: () => "resumed",
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "Mimir",
        username: "mimir_test_bot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
      },
    });

    bot.api.config.use(async (_prev, method) => {
      if (method === "answerCallbackQuery" || method === "editMessageText") {
        return { ok: true, result: true };
      }
      return { ok: true, result: { message_id: 1 } };
    });

    const nowSec = Math.floor(Date.now() / 1000);
    await bot.handleUpdate({
      update_id: 901,
      callback_query: {
        id: "cq_live_1",
        from: richUserProfile(Number(OPERATOR_ID), "LiveOp"),
        message: {
          message_id: 12,
          date: nowSec,
          chat: { id: -100111222333, type: "supergroup" },
          text: "Pause polling?",
        },
        data: CALLBACK_PAUSE_CONFIRM,
      },
    });

    await bot.handleUpdate({
      update_id: 902,
      callback_query: {
        id: "cq_live_2",
        from: richUserProfile(Number(OPERATOR_ID), "LiveOp"),
        message: {
          message_id: 13,
          date: nowSec,
          chat: { id: -100111222333, type: "supergroup" },
          text: "Status",
        },
        data: "resume",
      },
    });

    const flushed = audit.flush();
    assert.equal(flushed.length, 2);
    assert.match(flushed[0].detail, /action=pause outcome=accepted result=paused/);
    assert.match(flushed[1].detail, /action=resume outcome=accepted result=resumed/);

    await appendAuditFile(file, flushed);
    const readBack = await readAuditFile(file);
    assert.equal(readBack.entries.length, 2);
    assert.equal(readBack.unreadableLines, 0);

    const check = await checkAuditFile(file);
    assert.equal(check.validEntries, 2);
    assert.equal(check.issues.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function withoutWarnings(fn) {
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
  }
}
