import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CALLBACK_PAUSE_CONFIRM,
  ConfirmationIdentityStore,
  PAUSE_CONFIRM_TTL_MS,
  createBot,
} from "../dist/bot.js";

const BOT_CREDENTIAL = ["123456789:", "A".repeat(35)].join("");
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Mimir",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function makeConfig(overrides = {}) {
  return {
    botToken: BOT_CREDENTIAL,
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    allowedChatIds: [],
    operatorTelegramUserId: "424242",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    interSendDelayMs: 0,
    ...overrides,
  };
}

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1,
    cycles: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    eventsDeduplicated: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

function buildBotHarness({ stateFile, nowFn, broadcastExpiryMs }) {
  let pauseCalls = 0;
  const apiCalls = [];
  let nextMsgId = 700;

  const config = makeConfig({ confirmationStateFile: stateFile });
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    now: nowFn,
    status: () => makeStatus(),
    pause: () => {
      pauseCalls += 1;
      return "paused";
    },
    resume: () => "resumed",
    ...(broadcastExpiryMs !== undefined ? { broadcastExpiryMs } : {}),
  });

  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      nextMsgId += 1;
      return {
        ok: true,
        result: {
          message_id: nextMsgId,
          date: Math.floor(nowFn() / 1000),
          chat: { id: payload.chat_id, type: "private" },
        },
      };
    }
    return { ok: true, result: true };
  });

  return {
    bot,
    apiCalls,
    getPauseCalls: () => pauseCalls,
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-confirm-persist-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function silenceWarnings(fn) {
  const prevWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = prevWarn;
  }
}

test("ConfirmationIdentityStore binds confirmation identity to actor, chat, and action without storing raw IDs", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "confirmations.json");
    let now = 1_700_000_000_000;

    const store1 = new ConfirmationIdentityStore({
      filePath: stateFile,
      now: () => now,
    });
    store1.issue({
      id: "conf_shared_1",
      actorId: "424242",
      chatId: "-100777888",
      action: "pause",
      ttlMs: 60_000,
    });

    // Verify raw actor/chat IDs never appear in persisted file
    const rawDisk = await readFile(stateFile, "utf8");
    assert.equal(rawDisk.includes("424242"), false, "raw actorId must not be written to disk");
    assert.equal(rawDisk.includes("-100777888"), false, "raw chatId must not be written to disk");

    // Simulate process restart by opening a fresh store instance from disk
    const store2 = new ConfirmationIdentityStore({
      filePath: stateFile,
      now: () => now,
    });

    // Wrong actor -> rejected, stays pending
    const wrongActor = store2.verifyAndSettle({
      id: "conf_shared_1",
      actorId: "999999",
      chatId: "-100777888",
      action: "pause",
      targetStatus: "consumed",
    });
    assert.equal(wrongActor.ok, false);
    assert.equal(wrongActor.reason, "binding-mismatch");

    // Wrong chat -> rejected, stays pending
    const wrongChat = store2.verifyAndSettle({
      id: "conf_shared_1",
      actorId: "424242",
      chatId: "-100111222",
      action: "pause",
      targetStatus: "consumed",
    });
    assert.equal(wrongChat.ok, false);
    assert.equal(wrongChat.reason, "binding-mismatch");

    // Wrong action ("broadcast" instead of "pause") -> rejected, stays pending
    const wrongAction = store2.verifyAndSettle({
      id: "conf_shared_1",
      actorId: "424242",
      chatId: "-100777888",
      action: "broadcast",
      targetStatus: "consumed",
    });
    assert.equal(wrongAction.ok, false);
    assert.equal(wrongAction.reason, "binding-mismatch");
    assert.equal(store2.getRecord("conf_shared_1")?.status, "pending");

    // Exact matching (actor, chat, action) consumes once
    const accepted = store2.verifyAndSettle({
      id: "conf_shared_1",
      actorId: "424242",
      chatId: "-100777888",
      action: "pause",
      targetStatus: "consumed",
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.record.status, "consumed");

    // Simulate another restart: replay is rejected
    now += 1_000;
    const store3 = new ConfirmationIdentityStore({
      filePath: stateFile,
      now: () => now,
    });
    const replayed = store3.verifyAndSettle({
      id: "conf_shared_1",
      actorId: "424242",
      chatId: "-100777888",
      action: "pause",
      targetStatus: "consumed",
    });
    assert.equal(replayed.ok, false);
    assert.equal(replayed.reason, "replayed");
  });
});

test("broadcast confirmations reject replayed and expired callbacks after a process restart", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "confirmations.json");
    let now = 1_700_000_000_000;

    // Process 1: create two broadcast previews (one confirmed before restart, one left to expire)
    const proc1 = buildBotHarness({
      stateFile,
      nowFn: () => now,
      broadcastExpiryMs: 10_000,
    });

    const sensitiveAnnouncement = "SENSITIVE_MAINTENANCE_NOTICE_PAYLOAD_DO_NOT_PERSIST";
    await proc1.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: Math.floor(now / 1000),
        chat: { id: 424242, type: "private" },
        from: { id: 424242, is_bot: false, first_name: "Op" },
        text: `/broadcast ${sensitiveAnnouncement}`,
        entities: [{ offset: 0, length: 10, type: "bot_command" }],
      },
    });

    await proc1.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 11,
        date: Math.floor(now / 1000),
        chat: { id: 424242, type: "private" },
        from: { id: 424242, is_bot: false, first_name: "Op" },
        text: "/broadcast Expiring maintenance notice",
        entities: [{ offset: 0, length: 10, type: "bot_command" }],
      },
    });

    const previewSends = proc1.apiCalls.filter((c) => c.method === "sendMessage");
    assert.equal(previewSends.length, 2);
    const firstConfirmData = previewSends[0].payload.reply_markup.inline_keyboard[0][0].callback_data;
    const secondConfirmData = previewSends[1].payload.reply_markup.inline_keyboard[0][0].callback_data;

    // Confirm first broadcast in Process 1
    now += 1_000;
    await proc1.bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb_proc1_confirm",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 701,
          date: Math.floor(now / 1000),
          chat: { id: 424242, type: "private" },
          text: "preview 1",
        },
        data: firstConfirmData,
      },
    });

    // Verify broadcast body was never persisted to disk
    const persistedJson = await readFile(stateFile, "utf8");
    assert.equal(persistedJson.includes(sensitiveAnnouncement), false);

    // Advance past second broadcast's 10s TTL and start Process 2 (simulated restart)
    now += 15_000;
    const proc2 = buildBotHarness({
      stateFile,
      nowFn: () => now,
      broadcastExpiryMs: 10_000,
    });

    // 1. Replay already-confirmed broadcast callback in Process 2 -> rejected as replayed
    await proc2.bot.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "cb_proc2_replay",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 701,
          date: Math.floor(now / 1000),
          chat: { id: 424242, type: "private" },
          text: "preview 1",
        },
        data: firstConfirmData,
      },
    });

    // 2. Tap expired broadcast callback in Process 2 -> rejected as expired
    await proc2.bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "cb_proc2_expired",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 702,
          date: Math.floor(now / 1000),
          chat: { id: 424242, type: "private" },
          text: "preview 2",
        },
        data: secondConfirmData,
      },
    });

    // Zero outbound broadcast sends occurred in Process 2
    assert.equal(
      proc2.apiCalls.filter((c) => c.method === "sendMessage").length,
      0,
      "neither replayed nor expired broadcast may send messages after restart",
    );

    const answers = proc2.apiCalls.filter((c) => c.method === "answerCallbackQuery");
    assert.equal(answers.length, 2);
    assert.match(answers[0].payload.text, /already processed/i);
    assert.equal(answers[0].payload.show_alert, true);
    assert.match(answers[1].payload.text, /expired/i);
    assert.equal(answers[1].payload.show_alert, true);
  });
});

test("pause confirmations persist across restarts: preserve binding, consume once, and block replays/expiry", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "confirmations.json");
    let now = 1_700_000_000_000;

    // Process 1 issues two /pause prompts (msg 701 and msg 702)
    const proc1 = buildBotHarness({ stateFile, nowFn: () => now });
    await proc1.bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 20,
        date: Math.floor(now / 1000),
        chat: { id: -100111, type: "supergroup" },
        from: { id: 424242, is_bot: false, first_name: "Op" },
        text: "/pause",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });
    await proc1.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 21,
        date: Math.floor(now / 1000),
        chat: { id: -100111, type: "supergroup" },
        from: { id: 424242, is_bot: false, first_name: "Op" },
        text: "/pause",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });
    assert.equal(proc1.getPauseCalls(), 0);

    // Restart into Process 2 while prompts are still within TTL (+5s)
    now += 5_000;
    const proc2 = buildBotHarness({ stateFile, nowFn: () => now });
    const promptDateSec = Math.floor((now - 5_000) / 1000);

    // Cross-chat callback for msg 701 is rejected without consuming
    await proc2.bot.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "cq_wrong_chat",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 701,
          date: promptDateSec,
          chat: { id: -100999, type: "supergroup" },
          text: "Pause polling?",
        },
        data: CALLBACK_PAUSE_CONFIRM,
      },
    });
    assert.equal(proc2.getPauseCalls(), 0);

    // Valid callback from originating chat (-100111) for msg 701 succeeds once
    await proc2.bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "cq_valid_once",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 701,
          date: promptDateSec,
          chat: { id: -100111, type: "supergroup" },
          text: "Pause polling?",
        },
        data: CALLBACK_PAUSE_CONFIRM,
      },
    });
    assert.equal(proc2.getPauseCalls(), 1);

    // Restart into Process 3 (+2s, still within 60s TTL): replay of msg 701 is blocked!
    now += 2_000;
    const proc3 = buildBotHarness({ stateFile, nowFn: () => now });
    await proc3.bot.handleUpdate({
      update_id: 20,
      callback_query: {
        id: "cq_replay_after_restart",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 701,
          date: promptDateSec,
          chat: { id: -100111, type: "supergroup" },
          text: "Pause polling?",
        },
        data: CALLBACK_PAUSE_CONFIRM,
      },
    });
    assert.equal(proc3.getPauseCalls(), 0, "replayed pause confirmation after restart must not pause");
    const replayAnswer = proc3.apiCalls.find((c) => c.method === "answerCallbackQuery");
    assert.match(replayAnswer.payload.text, /already used/i);

    // Advance past PAUSE_CONFIRM_TTL_MS and restart into Process 4: msg 702 is rejected as expired
    // even if a tampered callback claims a fresh message.date!
    now += PAUSE_CONFIRM_TTL_MS + 5_000;
    const proc4 = buildBotHarness({ stateFile, nowFn: () => now });
    await proc4.bot.handleUpdate({
      update_id: 30,
      callback_query: {
        id: "cq_expired_after_restart",
        from: { id: 424242, is_bot: false, first_name: "Op" },
        message: {
          message_id: 702,
          date: Math.floor(now / 1000),
          chat: { id: -100111, type: "supergroup" },
          text: "Pause polling?",
        },
        data: CALLBACK_PAUSE_CONFIRM,
      },
    });
    assert.equal(proc4.getPauseCalls(), 0, "expired persisted confirmation must be rejected");
    const expAnswer = proc4.apiCalls.find((c) => c.method === "answerCallbackQuery");
    assert.match(expAnswer.payload.text, /expired/i);
  });
});

test("boundary: corrupt confirmation state file and bounded maxRecords cap behave safely", async () => {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "confirmations.json");
    await writeFile(stateFile, "{not-valid-json", "utf8");

    const store = await silenceWarnings(
      async () =>
        new ConfirmationIdentityStore({
          filePath: stateFile,
          maxRecords: 3,
          now: () => 1_700_000_000_000,
        }),
    );
    assert.equal(store.size(), 0);

    // Issue 2 settled tombstones and 2 active pending records under maxRecords=3
    store.issue({ id: "settled_1", actorId: "1", chatId: "1", action: "pause", ttlMs: 60_000 });
    store.verifyAndSettle({
      id: "settled_1",
      actorId: "1",
      chatId: "1",
      action: "pause",
      targetStatus: "consumed",
    });

    store.issue({ id: "pending_1", actorId: "1", chatId: "1", action: "pause", ttlMs: 60_000 });
    store.issue({ id: "pending_2", actorId: "1", chatId: "1", action: "pause", ttlMs: 60_000 });
    store.issue({ id: "pending_3", actorId: "1", chatId: "1", action: "pause", ttlMs: 60_000 });

    assert.equal(store.size(), 3, "store stays bounded to maxRecords");
    assert.equal(store.getRecord("settled_1"), undefined, "settled tombstone evicted before active pending");
    assert.equal(store.getRecord("pending_1")?.status, "pending");
    assert.equal(store.getRecord("pending_2")?.status, "pending");
    assert.equal(store.getRecord("pending_3")?.status, "pending");
  });
});
