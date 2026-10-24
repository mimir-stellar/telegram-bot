import assert from "node:assert/strict";
import test from "node:test";

import {
  AdminCache,
  canControl,
  clearAdminCache,
  DEFAULT_ADMIN_CACHE_MAX_SIZE,
  DEFAULT_ADMIN_CACHE_TTL_MS,
  isChatAdmin,
} from "../dist/commands/admin-check.js";
import { registerCommandHandlers } from "../dist/bot.js";

const GROUP_CHAT_ID = -1001234567890;
const PRIVATE_CHAT_ID = 42;
const ADMIN_USER_ID = 1001;
const CREATOR_USER_ID = 1002;
const MEMBER_USER_ID = 1003;
const OPERATOR_USER_ID = 42;
const BOT_TOKEN = "123456789:TEST-SECRET-BOT-TOKEN-XYZ";

function fakeApi(handler) {
  const calls = [];
  return {
    calls,
    api: {
      async getChatMember(chatId, userId) {
        calls.push({ chatId, userId });
        return handler(chatId, userId);
      },
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    operatorTelegramUserId: String(OPERATOR_USER_ID),
    botToken: BOT_TOKEN,
    chatId: String(GROUP_CHAT_ID),
    ...overrides,
  };
}

test("isChatAdmin returns true for administrator and creator statuses", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async (_chatId, userId) => ({
    status: userId === CREATOR_USER_ID ? "creator" : "administrator",
  }));

  const isAdmin = await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID);
  const isCreator = await isChatAdmin(api, GROUP_CHAT_ID, CREATOR_USER_ID);

  assert.equal(isAdmin, true);
  assert.equal(isCreator, true);
  assert.equal(calls.length, 2);
});

test("isChatAdmin returns false for non-admin member statuses", async () => {
  clearAdminCache();
  const statuses = ["member", "restricted", "left", "kicked"];
  let index = 0;
  const { api, calls } = fakeApi(async () => ({
    status: statuses[index++],
  }));

  for (let i = 0; i < statuses.length; i++) {
    const result = await isChatAdmin(api, GROUP_CHAT_ID, MEMBER_USER_ID + i);
    assert.equal(result, false, `status ${statuses[i]} must not be authorised`);
  }
  assert.equal(calls.length, statuses.length);
});

test("cache prevents more than one getChatMember call per user per TTL", async () => {
  clearAdminCache();
  let nowMs = 1_000_000;
  const { api, calls } = fakeApi(async (_chatId, userId) => ({
    status: userId === ADMIN_USER_ID ? "administrator" : "member",
  }));

  const opts = { ttlMs: 10_000, now: () => nowMs };

  // First call misses cache and queries API
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, opts), true);
  assert.equal(calls.length, 1);

  // Subsequent calls within TTL hit cache without calling getChatMember
  nowMs += 5_000;
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, opts), true);
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, opts), true);
  assert.equal(calls.length, 1);

  // Non-admin member is also cached within TTL
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, MEMBER_USER_ID, opts), false);
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, MEMBER_USER_ID, opts), false);
  assert.equal(calls.length, 2);
});

test("cache expiry triggers a fresh getChatMember call after TTL", async () => {
  clearAdminCache();
  let nowMs = 1_000_000;
  let currentStatus = "administrator";
  const { api, calls } = fakeApi(async () => ({
    status: currentStatus,
  }));

  const opts = { ttlMs: 10_000, now: () => nowMs };

  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, opts), true);
  assert.equal(calls.length, 1);

  // Just before TTL expiry: still cached
  nowMs += 9_999;
  currentStatus = "member";
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, opts), true);
  assert.equal(calls.length, 1);

  // At TTL expiry: refetches from API and observes demotion
  nowMs += 1;
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, opts), false);
  assert.equal(calls.length, 2);
});

test("concurrent calls for the same user coalesce into a single getChatMember call", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async () => {
    await new Promise((r) => setTimeout(r, 10));
    return { status: "administrator" };
  });

  const [r1, r2, r3] = await Promise.all([
    isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID),
    isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID),
    isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID),
  ]);

  assert.equal(r1, true);
  assert.equal(r2, true);
  assert.equal(r3, true);
  assert.equal(calls.length, 1);
});

test("cache enforces bounded maxSize and evicts oldest entries", async () => {
  let nowMs = 1_000_000;
  const cache = new AdminCache({ ttlMs: 60_000, maxSize: 2, now: () => nowMs });
  const { api, calls } = fakeApi(async () => ({ status: "administrator" }));
  const opts = { cache, ttlMs: 60_000, maxSize: 2, now: () => nowMs };

  await isChatAdmin(api, GROUP_CHAT_ID, 1, opts);
  await isChatAdmin(api, GROUP_CHAT_ID, 2, opts);
  assert.equal(cache.size, 2);
  assert.equal(calls.length, 2);

  // Adding a 3rd user evicts user 1 (oldest)
  await isChatAdmin(api, GROUP_CHAT_ID, 3, opts);
  assert.equal(cache.size, 2);
  assert.equal(calls.length, 3);

  // User 2 is still cached
  await isChatAdmin(api, GROUP_CHAT_ID, 2, opts);
  assert.equal(calls.length, 3);

  // User 1 was evicted, so querying user 1 calls API again
  await isChatAdmin(api, GROUP_CHAT_ID, 1, opts);
  assert.equal(calls.length, 4);
});

test("API errors fail closed (not authorised) and are logged with redaction", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async () => {
    throw new Error(`Telegram request failed at https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`);
  });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = await isChatAdmin(api, GROUP_CHAT_ID, ADMIN_USER_ID, {
      secrets: [BOT_TOKEN],
    });
    assert.equal(result, false);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(BOT_TOKEN), false, "bot token must be redacted in logs");
  assert.equal(warnings[0].includes("TEST-SECRET-BOT-TOKEN"), false);
  assert.match(warnings[0], /\[REDACTED]/);
});

test("anonymous admin (sender_chat equal to the chat itself) is treated as admin without API call", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async () => {
    throw new Error("getChatMember must not be called for anonymous admin");
  });

  // 1. Grammars with ctx.senderChat
  const ctxWithSenderChat = {
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    senderChat: { id: GROUP_CHAT_ID, type: "supergroup" },
    from: undefined,
  };
  assert.equal(
    await canControl(ctxWithSenderChat, baseConfig({ operatorTelegramUserId: null }), api),
    true,
  );

  // 2. Raw message with sender_chat
  const ctxWithMessageSenderChat = {
    chat: { id: GROUP_CHAT_ID, type: "group" },
    message: {
      chat: { id: GROUP_CHAT_ID, type: "group" },
      sender_chat: { id: GROUP_CHAT_ID, type: "group" },
    },
  };
  assert.equal(
    await canControl(ctxWithMessageSenderChat, baseConfig({ operatorTelegramUserId: null }), api),
    true,
  );

  // 3. Different sender_chat (e.g. linked channel post) is NOT treated as anonymous chat admin
  const ctxDifferentSenderChat = {
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    senderChat: { id: -1009999999999, type: "channel" },
    from: undefined,
  };
  assert.equal(
    await canControl(ctxDifferentSenderChat, baseConfig({ operatorTelegramUserId: null }), api),
    false,
  );

  assert.equal(calls.length, 0);
});

test("canControl authorises group admin and rejects group member", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async (_chatId, userId) => ({
    status: userId === ADMIN_USER_ID ? "administrator" : "member",
  }));

  const config = baseConfig({ operatorTelegramUserId: null });

  const adminCtx = {
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    from: { id: ADMIN_USER_ID },
  };
  const memberCtx = {
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    from: { id: MEMBER_USER_ID },
  };

  assert.equal(await canControl(adminCtx, config, api), true);
  assert.equal(await canControl(memberCtx, config, api), false);
  assert.equal(calls.length, 2);
});

test("canControl preserves private-chat authorization (only OPERATOR_TELEGRAM_USER_ID)", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async () => ({
    status: "administrator",
  }));

  const config = baseConfig({ operatorTelegramUserId: String(OPERATOR_USER_ID) });

  // Configured operator in private chat -> true
  assert.equal(
    await canControl(
      { chat: { id: PRIVATE_CHAT_ID, type: "private" }, from: { id: OPERATOR_USER_ID } },
      config,
      api,
    ),
    true,
  );

  // Non-operator in private chat -> false, without calling getChatMember
  assert.equal(
    await canControl(
      { chat: { id: PRIVATE_CHAT_ID, type: "private" }, from: { id: ADMIN_USER_ID } },
      config,
      api,
    ),
    false,
  );
  assert.equal(calls.length, 0);
});

test("bot /pause and /resume honour group admin and anonymous admin via canControl", async () => {
  clearAdminCache();
  const { api, calls } = fakeApi(async (_chatId, userId) => ({
    status: userId === ADMIN_USER_ID ? "administrator" : "member",
  }));

  let paused = 0;
  let resumed = 0;
  const handlers = new Map();
  const bot = {
    command(name, handler) {
      handlers.set(name, handler);
    },
  };

  registerCommandHandlers(bot, {
    config: baseConfig({ operatorTelegramUserId: null }),
    status: () => ({}),
    pause: () => {
      paused += 1;
      return "paused";
    },
    resume: () => {
      resumed += 1;
      return "resumed";
    },
  });

  // Group admin can /pause
  const adminReplies = [];
  await handlers.get("pause")({
    api,
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    from: { id: ADMIN_USER_ID },
    update: { update_id: 1 },
    reply: async (text) => adminReplies.push(text),
  });
  assert.equal(paused, 1);
  assert.equal(adminReplies.length, 1);

  // Anonymous group admin can /resume
  const anonReplies = [];
  await handlers.get("resume")({
    api,
    chat: { id: GROUP_CHAT_ID, type: "supergroup" },
    senderChat: { id: GROUP_CHAT_ID, type: "supergroup" },
    update: { update_id: 2 },
    reply: async (text) => anonReplies.push(text),
  });
  assert.equal(resumed, 1);
  assert.equal(anonReplies.length, 1);

  // Regular group member is rejected silently
  const memberReplies = [];
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    await handlers.get("pause")({
      api,
      chat: { id: GROUP_CHAT_ID, type: "supergroup" },
      from: { id: MEMBER_USER_ID },
      update: { update_id: 3 },
      reply: async (text) => memberReplies.push(text),
    });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(paused, 1);
  assert.equal(memberReplies.length, 0);
  assert.equal(calls.length, 2);
});

test("defaults export positive TTL and maxSize constants", () => {
  assert.equal(typeof DEFAULT_ADMIN_CACHE_TTL_MS, "number");
  assert.ok(DEFAULT_ADMIN_CACHE_TTL_MS > 0);
  assert.equal(typeof DEFAULT_ADMIN_CACHE_MAX_SIZE, "number");
  assert.ok(DEFAULT_ADMIN_CACHE_MAX_SIZE > 0);
});

test("boundary: invalid api, chatId, or userId inputs fail closed without throwing", async () => {
  const { api, calls } = fakeApi(async () => ({ status: "administrator" }));
  assert.equal(await isChatAdmin(null, GROUP_CHAT_ID, ADMIN_USER_ID), false);
  assert.equal(await isChatAdmin(api, "", ADMIN_USER_ID), false);
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, null), false);
  assert.equal(await isChatAdmin(api, GROUP_CHAT_ID, Number.NaN), false);
  assert.equal(calls.length, 0);

  // canControl with missing chat or missing userId in group
  const config = baseConfig({ operatorTelegramUserId: null });
  assert.equal(await canControl({}, config, api), false);
  assert.equal(
    await canControl({ chat: { id: GROUP_CHAT_ID, type: "supergroup" } }, config, api),
    false,
  );
  assert.equal(
    await canControl(
      { chat: { id: GROUP_CHAT_ID }, from: { id: ADMIN_USER_ID } },
      config,
      api,
    ),
    true,
  );
});

test("cache sweeps expired entries before evicting live entries when full", async () => {
  let nowMs = 1_000_000;
  const cache = new AdminCache({ ttlMs: 1_000, maxSize: 2, now: () => nowMs });
  const { api, calls } = fakeApi(async () => ({ status: "administrator" }));

  // User 1 cached with short TTL (1s)
  await isChatAdmin(api, GROUP_CHAT_ID, 1, { cache, ttlMs: 1_000, maxSize: 2, now: () => nowMs });
  // User 2 cached with longer TTL (10s)
  await isChatAdmin(api, GROUP_CHAT_ID, 2, { cache, ttlMs: 10_000, maxSize: 2, now: () => nowMs });

  // Advance past user 1's TTL
  nowMs += 2_000;

  // Adding user 3 sweeps expired user 1, keeping user 2 cached
  await isChatAdmin(api, GROUP_CHAT_ID, 3, { cache, ttlMs: 10_000, maxSize: 2, now: () => nowMs });
  assert.equal(cache.size, 2);
  assert.equal(calls.length, 3);

  // User 2 is still a cache hit
  await isChatAdmin(api, GROUP_CHAT_ID, 2, { cache, ttlMs: 10_000, maxSize: 2, now: () => nowMs });
  assert.equal(calls.length, 3);
});

