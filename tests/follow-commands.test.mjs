import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  COMMANDS,
  createFollowStore,
  registerCommandHandlers,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimir-follow-cmds-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: ["123456789", "T".repeat(35)].join(":"),
    chatId: "-100111",
    allowedChatIds: ["-100111", "-100222"],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
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
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

function setupBot(followStore, configOverrides = {}, extraDeps = {}) {
  const handlers = new Map();
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
    callbackQuery: () => undefined,
  };
  registerCommandHandlers(bot, {
    config: makeConfig(configOverrides),
    status: () => makeStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    followStore,
    ...extraDeps,
  });
  return handlers;
}

function makeCtx({ chatId, userId = 100, text, match = "" }) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: userId },
      chat: { id: chatId, type: "supergroup" },
      message: { text },
      match,
      update: { update_id: 1 },
      reply: async (body, opts) => {
        replies.push({ text: body, opts });
      },
    },
  };
}

test("/follow, /unfollow, and /following are registered in COMMANDS and persist isolated subscriptions per authenticated chat", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath });
    let nowMs = 1_000_000;
    const handlers = setupBot(store, {}, { now: () => nowMs });

    const names = COMMANDS.map((c) => c.command);
    assert.equal(names.includes("follow"), true);
    assert.equal(names.includes("unfollow"), true);
    assert.equal(names.includes("following"), true);

    const follow = handlers.get("follow");
    const unfollow = handlers.get("unfollow");
    const following = handlers.get("following");

    // Chat -100111 follows market:42 and squad:7 (shorthand "squad 7").
    const c1Follow1 = makeCtx({ chatId: -100111, text: "/follow market:42", match: "market:42" });
    await follow(c1Follow1.ctx);
    assert.match(c1Follow1.replies[0].text, /\*Subscribed\* to `market:42`/);
    assert.match(c1Follow1.replies[0].text, /Active follows in this chat: \*1\*/);

    const c1Follow2 = makeCtx({ chatId: -100111, text: "/follow squad 7", match: "squad 7" });
    await follow(c1Follow2.ctx);
    assert.match(c1Follow2.replies[0].text, /\*Subscribed\* to `squad:7`/);
    assert.match(c1Follow2.replies[0].text, /Active follows in this chat: \*2\*/);

    // Chat -100222 follows market:99 — isolated from -100111!
    const c2Follow = makeCtx({ chatId: -100222, text: "/follow market:99", match: "market:99" });
    await follow(c2Follow.ctx);
    assert.match(c2Follow.replies[0].text, /Active follows in this chat: \*1\*/);

    // /following in -100111 lists ONLY -100111's subscriptions, never market:99.
    const c1List = makeCtx({ chatId: -100111, text: "/following" });
    await following(c1List.ctx);
    assert.match(c1List.replies[0].text, /Followed markets & squads \\\(2\\\)/);
    assert.match(c1List.replies[0].text, /`market:42`/);
    assert.match(c1List.replies[0].text, /`squad:7`/);
    assert.equal(c1List.replies[0].text.includes("market:99"), false);

    // Cross-chat snooping or unfollowing attempts cannot cross chat boundaries.
    const snoopAttempt = makeCtx({
      chatId: -100111,
      text: "/following -100222",
      match: "-100222",
    });
    await following(snoopAttempt.ctx);
    assert.match(snoopAttempt.replies[0].text, /\*Usage:\* `\/following`/);
    assert.equal(snoopAttempt.replies[0].text.includes("market:99"), false);

    const crossUnfollow = makeCtx({
      chatId: -100111,
      text: "/unfollow market:99",
      match: "market:99",
    });
    await unfollow(crossUnfollow.ctx);
    assert.match(crossUnfollow.replies[0].text, /Not currently following `market:99`/);
    assert.deepEqual(store.list("-100222"), ["market:99"], "chat -100222 untouched");

    // Advance simulated clock so per-chat command token bucket refills cleanly.
    nowMs += 60_000;

    // Chat -100111 unfollows market:42; persistence survives across a fresh FollowStore instance.
    const c1Unfollow = makeCtx({
      chatId: -100111,
      text: "/unfollow market:42",
      match: "market:42",
    });
    await unfollow(c1Unfollow.ctx);
    assert.match(c1Unfollow.replies[0].text, /\*Unsubscribed\* from `market:42`/);

    const reopened = createFollowStore({ filePath });
    assert.deepEqual(reopened.list("-100111"), ["squad:7"]);
    assert.deepEqual(reopened.list("-100222"), ["market:99"]);
  });
});

test("unauthenticated chats outside ALLOWED_CHAT_IDS are silently ignored and store quotas are enforced", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({
      filePath,
      maxPerChat: 2,
      maxTotal: 3,
    });
    const handlers = setupBot(store);
    const follow = handlers.get("follow");
    const unfollow = handlers.get("unfollow");
    const following = handlers.get("following");

    // Stranger chat (-100999 not in ALLOWED_CHAT_IDS) gets silence and cannot mutate state.
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const outsiderFollow = makeCtx({
        chatId: -100999,
        userId: 555,
        text: "/follow market:1",
        match: "market:1",
      });
      const outsiderList = makeCtx({ chatId: -100999, userId: 555, text: "/following" });
      const outsiderUnfollow = makeCtx({
        chatId: -100999,
        userId: 555,
        text: "/unfollow market:1",
        match: "market:1",
      });
      await follow(outsiderFollow.ctx);
      await following(outsiderList.ctx);
      await unfollow(outsiderUnfollow.ctx);

      assert.equal(outsiderFollow.replies.length, 0);
      assert.equal(outsiderList.replies.length, 0);
      assert.equal(outsiderUnfollow.replies.length, 0);
      assert.deepEqual(store.list("-100999"), []);
    } finally {
      console.warn = originalWarn;
    }

    // Enforce maxPerChat (2) in chat -100111.
    await follow(makeCtx({ chatId: -100111, text: "/follow market:1", match: "market:1" }).ctx);
    await follow(makeCtx({ chatId: -100111, text: "/follow market:2", match: "market:2" }).ctx);
    const bytesAtCap = await fs.readFile(filePath, "utf8");

    const overPerChat = makeCtx({ chatId: -100111, text: "/follow market:3", match: "market:3" });
    await follow(overPerChat.ctx);
    assert.match(overPerChat.replies[0].text, /\*Chat follow limit reached\*/);
    assert.equal(await fs.readFile(filePath, "utf8"), bytesAtCap);

    // Enforce maxTotal (3): chat -100222 can add 1 entry (bringing total to 3), then hits global cap.
    await follow(makeCtx({ chatId: -100222, text: "/follow squad:10", match: "squad:10" }).ctx);
    const bytesAtGlobalCap = await fs.readFile(filePath, "utf8");

    const overTotal = makeCtx({ chatId: -100222, text: "/follow squad:11", match: "squad:11" });
    await follow(overTotal.ctx);
    assert.match(overTotal.replies[0].text, /\*Global follow limit reached\*/);
    assert.equal(await fs.readFile(filePath, "utf8"), bytesAtGlobalCap);
  });
});
