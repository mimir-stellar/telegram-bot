import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FollowQuotaError,
  FollowStoreError,
  applyFollowWithFeedback,
  createFollowStore,
  formatFollowQuotaFeedback,
} from "../dist/bot.js";

const MDV2_RESERVED = new Set([
  "_", "*", "[", "]", "(", ")", "~", "`", ">",
  "#", "+", "-", "=", "|", "{", "}", ".", "!",
]);

function assertValidMarkdownV2(text) {
  let inBold = false;
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      assert.ok(i + 1 < text.length, "no trailing lone backslash");
      i++;
      continue;
    }
    if (inCode) {
      if (ch === "`") inCode = false;
      continue;
    }
    if (ch === "`") {
      inCode = true;
      continue;
    }
    if (ch === "*") {
      inBold = !inBold;
      continue;
    }
    assert.equal(
      MDV2_RESERVED.has(ch),
      false,
      `unescaped MarkdownV2 reserved character "${ch}" at index ${i} in: ${text}`,
    );
  }
  assert.equal(inBold, false, "bold entity must close");
  assert.equal(inCode, false, "code entity must close");
}

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "follow-quota-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function fakeCtx(chatId) {
  const replies = [];
  return {
    replies,
    ctx: {
      chat: { id: Number(chatId) || -100111 },
      reply: async (text, options) => {
        replies.push({ text, options });
      },
    },
  };
}

test("distinguishes per-chat quota exhaustion with actionable /following + /unfollow feedback and preserves store bytes", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath, maxPerChat: 2, maxTotal: 10 });

    store.follow("-100111", "market:1");
    store.follow("-100111", "market:2");
    const bytesBefore = await fs.readFile(filePath, "utf8");

    const { ctx, replies } = fakeCtx("-100111");
    const result = await applyFollowWithFeedback(ctx, store, "-100111", "market:3");

    assert.deepEqual(result, { ok: false, added: false, quotaScope: "per_chat" });
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /Follow limit reached for this chat/);
    assert.match(replies[0].text, /2\/2/);
    assert.match(replies[0].text, /\/following/);
    assert.match(replies[0].text, /\/unfollow/);
    assertValidMarkdownV2(replies[0].text);

    const bytesAfter = await fs.readFile(filePath, "utf8");
    assert.equal(bytesAfter, bytesBefore, "persisted store must remain byte-for-byte unchanged");
    assert.deepEqual(store.list("-100111"), ["market:1", "market:2"]);
  });
});

test("distinguishes global quota exhaustion without leaking other chats and preserves store bytes", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath, maxPerChat: 5, maxTotal: 3 });

    store.follow("-100999001", "market:10");
    store.follow("-100999001", "market:11");
    store.follow("-100222", "squad:7");
    const bytesBefore = await fs.readFile(filePath, "utf8");

    const { ctx, replies } = fakeCtx("-100222");
    const result = await applyFollowWithFeedback(ctx, store, "-100222", "squad:8");

    assert.deepEqual(result, { ok: false, added: false, quotaScope: "global" });
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /Global follow capacity reached/);
    assert.match(replies[0].text, /3 total subscriptions/);
    assert.match(replies[0].text, /operator/);
    assert.equal(
      replies[0].text.includes("-100999001"),
      false,
      "global quota feedback must never expose other chat IDs",
    );
    assertValidMarkdownV2(replies[0].text);

    const bytesAfter = await fs.readFile(filePath, "utf8");
    assert.equal(bytesAfter, bytesBefore, "persisted store must remain byte-for-byte unchanged");

    // Idempotent re-follow of an existing entry still succeeds at capacity.
    const repeat = await applyFollowWithFeedback(ctx, store, "-100222", "squad:7");
    assert.deepEqual(repeat, { ok: true, added: false });
  });
});

test("FollowQuotaError extends FollowStoreError and supports plain-text formatting", () => {
  const perChatErr = new FollowQuotaError("per_chat", 5, 5);
  const globalErr = new FollowQuotaError("global", 100, 100);

  assert.ok(perChatErr instanceof FollowStoreError);
  assert.ok(globalErr instanceof FollowStoreError);

  const plainPerChat = formatFollowQuotaFeedback(perChatErr, { markdownV2: false });
  const plainGlobal = formatFollowQuotaFeedback(globalErr, { markdownV2: false });
  assert.match(plainPerChat, /5\/5/);
  assert.match(plainGlobal, /100 total subscriptions/);
  assert.notEqual(plainPerChat, plainGlobal);
});
