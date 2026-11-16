import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COMMANDS,
  createFollowStore,
  registerCommandHandlers,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sub-preview-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeDeps(followStore, overrides = {}) {
  return {
    config: {
      marketContractId: "C" + "A".repeat(55),
      squadContractId: "C" + "B".repeat(55),
      rpcUrl: "https://example.invalid/rpc",
      horizonUrl: "https://example.invalid/horizon",
      networkPassphrase: "Test SDF Network ; September 2015",
      explorerBaseUrl: "https://example.invalid/explorer",
      botToken: "placeholder-token",
      chatId: "-100111",
      allowedChatIds: [],
      operatorTelegramUserId: "42",
      ...overrides,
    },
    status: () => ({ running: true }),
    pause: () => "paused",
    resume: () => "resumed",
    followStore,
  };
}

function makeHarness(deps) {
  const handlers = new Map();
  const outboundSends = [];
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
    api: {
      sendMessage: async (...args) => {
        outboundSends.push(args);
        return { message_id: 1 };
      },
    },
  };
  registerCommandHandlers(bot, deps);
  return { handlers, outboundSends };
}

function makeCtx({ userId, chatId = 42, text, match = "" }) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: userId },
      chat: { id: chatId, type: "private" },
      message: { text },
      match,
      update: { update_id: 10 },
      reply: async (replyText, options) => {
        replies.push({ text: replyText, options });
      },
    },
  };
}

test("operator /subpreview shows matching chat counts without exposing chat IDs or sending notifications", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath });
    store.follow("-100777001", "market:42");
    store.follow("-100777002", "market:42");
    store.follow("-100777002", "squad:9");
    const bytesBefore = await fs.readFile(filePath, "utf8");

    const { handlers, outboundSends } = makeHarness(makeDeps(store));
    const subPreview = handlers.get("subpreview");
    assert.equal(typeof subPreview, "function");
    assert.equal(
      COMMANDS.some((c) => c.command === "subpreview"),
      false,
      "operator preview stays hidden from public menu",
    );

    const opCall = makeCtx({
      userId: 42,
      text: "/subpreview market:42",
      match: "market:42",
    });
    await subPreview(opCall.ctx);

    assert.equal(opCall.replies.length, 1);
    const body = opCall.replies[0].text;
    assert.match(body, /Event reference: `market:42`/);
    assert.match(body, /Matching chats: \*2\*/);
    assert.match(body, /Tracked chats: 2 \\\(3 total subscriptions\\\)/);
    assert.match(body, /no notifications were sent/i);
    assert.equal(body.includes("-100777001"), false, "must never leak subscriber chat IDs");
    assert.equal(body.includes("-100777002"), false, "must never leak subscriber chat IDs");
    assert.equal(outboundSends.length, 0, "preview must send zero outbound notifications");

    // Whitespace-separated shorthand ("squad 99") with 0 matches also works cleanly.
    const zeroMatch = makeCtx({
      userId: 42,
      text: "/subpreview squad 99",
      match: "squad 99",
    });
    await subPreview(zeroMatch.ctx);
    assert.equal(zeroMatch.replies.length, 1);
    assert.match(zeroMatch.replies[0].text, /Event reference: `squad:99`/);
    assert.match(zeroMatch.replies[0].text, /Matching chats: \*0\*/);
    assert.equal(outboundSends.length, 0);

    const bytesAfter = await fs.readFile(filePath, "utf8");
    assert.equal(bytesAfter, bytesBefore, "preview must not mutate the store file");
  });
});

test("non-operators receive silence and zero chat identifiers; invalid refs show usage to operator", async () => {
  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: path.join(dir, "follows.json") });
    store.follow("-100888123", "market:42");

    const { handlers, outboundSends } = makeHarness(makeDeps(store));
    const subPreview = handlers.get("subpreview");

    const stranger = makeCtx({
      userId: 999,
      chatId: -100555,
      text: "/subpreview market:42",
      match: "market:42",
    });
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      await subPreview(stranger.ctx);
    } finally {
      console.warn = origWarn;
    }

    assert.deepEqual(stranger.replies, [], "non-operators must get complete silence");
    assert.equal(outboundSends.length, 0);

    // Operator passing malformed ref gets usage prompt without throwing.
    const badArg = makeCtx({
      userId: 42,
      text: "/subpreview bad-ref",
      match: "bad-ref",
    });
    await subPreview(badArg.ctx);
    assert.equal(badArg.replies.length, 1);
    assert.match(badArg.replies[0].text, /Usage:/);
  });
});
