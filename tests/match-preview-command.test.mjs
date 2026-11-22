/**
 * match-preview-command.test.mjs
 *
 * Verifies the /matchpreview operator command:
 *   - returns a subscriber count for a valid ref
 *   - rejects invalid refs with a usage hint
 *   - reports zero when no followStore is supplied
 *   - never includes chat identifiers in its reply
 *   - is silently ignored for non-operators
 *
 * Issue #744: feat(bot): add an operator preview of subscription delivery matches
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";

import {
  matchPreviewMessage,
  matchPreviewInvalidMessage,
  MATCH_PREVIEW_USAGE,
} from "../dist/commands/index.js";

import { createFollowStore } from "../dist/subscriptions/store.js";

// ── Message formatter unit tests ──────────────────────────────────────────────

test("matchPreviewMessage: singular count uses 'chat'", () => {
  const msg = matchPreviewMessage("market:abc", 1);
  assert.ok(msg.includes("1"), "should include the count");
  assert.ok(msg.includes("chat"), "should use singular 'chat'");
  assert.ok(!msg.includes("chats"), "should not pluralise for 1");
});

test("matchPreviewMessage: plural count uses 'chats'", () => {
  const msg = matchPreviewMessage("market:abc", 3);
  assert.ok(msg.includes("3"));
  assert.ok(msg.includes("chats"));
});

test("matchPreviewMessage: zero is a valid count", () => {
  const msg = matchPreviewMessage("squad:m1", 0);
  assert.ok(msg.includes("0"));
  assert.ok(msg.includes("chats"));
});

test("matchPreviewMessage: ref appears in the reply", () => {
  const msg = matchPreviewMessage("market:123", 5);
  // The ref is code-formatted (backtick) in MarkdownV2.
  assert.ok(msg.includes("market"), "ref kind should appear");
  assert.ok(msg.includes("123"), "ref id should appear");
});

test("matchPreviewMessage: does not contain any chat id", () => {
  const msg = matchPreviewMessage("market:abc", 7);
  // The message must only contain the count and the ref — never a chat id.
  assert.ok(!/-\d{10,}/.test(msg), "chat ids must not appear in the reply");
});

test("matchPreviewInvalidMessage: includes the input (truncated)", () => {
  const msg = matchPreviewInvalidMessage("not-valid");
  assert.ok(msg.includes("not\\-valid") || msg.includes("not-valid"), "input should appear");
});

test("matchPreviewInvalidMessage: truncates very long inputs", () => {
  const long = "x".repeat(200);
  const msg = matchPreviewInvalidMessage(long);
  // Result must not reproduce the full 200-char string.
  assert.ok(msg.length < 300, "message should not grow unboundedly with input length");
});

test("MATCH_PREVIEW_USAGE: mentions both market and squad ref shapes", () => {
  assert.ok(MATCH_PREVIEW_USAGE.includes("market"), "usage should mention market");
  assert.ok(MATCH_PREVIEW_USAGE.includes("squad"), "usage should mention squad");
});

// ── Integration: command handler with fake context ───────────────────────────

function makeCtx({ text = "/matchpreview", fromId = "999" } = {}) {
  const replies = [];
  return {
    replies,
    chat: { id: 12345, type: "private" },
    from: { id: Number(fromId) },
    message: { text },
    match: text.includes(" ") ? text.slice(text.indexOf(" ") + 1) : "",
    reply: async (msg, _opts) => {
      replies.push(msg);
      return {};
    },
    update: { update_id: 1 },
  };
}

function makeConfig(operatorId = "999") {
  return {
    botToken: "MOCK_UNLEAKED_SAMPLE",
    allowedChatIds: [],
    operatorTelegramUserId: operatorId,
    chatId: "-1001234567890",
  };
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(os.tmpdir() + "/match-preview-test-");
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test("handler: replies with count zero when followStore is absent", async () => {
  const { matchPreviewCommand } = await import("../dist/commands/index.js");
  const ctx = makeCtx({ text: "/matchpreview market:abc" });
  const deps = {
    config: makeConfig(),
    status: () => ({ state: "running" }),
    pause: () => "paused",
    resume: () => "resumed",
    // No followStore
  };

  await matchPreviewCommand.handler(ctx, deps);

  assert.strictEqual(ctx.replies.length, 1, "should send exactly one reply");
  const reply = ctx.replies[0];
  assert.ok(reply.includes("0"), "should report 0 matches when store is absent");
  assert.ok(!reply.includes("-1001234567890"), "must not expose the chat id");
});

test("handler: reports correct count from followStore", async () => {
  const { matchPreviewCommand } = await import("../dist/commands/index.js");

  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: dir + "/follows.json" });
    store.follow("chat:1", "market:abc");
    store.follow("chat:2", "market:abc");
    store.follow("chat:3", "squad:m1");

    const ctx = makeCtx({ text: "/matchpreview market:abc" });
    const deps = {
      config: makeConfig(),
      status: () => ({ state: "running" }),
      pause: () => "paused",
      resume: () => "resumed",
      followStore: store,
    };

    await matchPreviewCommand.handler(ctx, deps);

    assert.strictEqual(ctx.replies.length, 1);
    const reply = ctx.replies[0];
    assert.ok(reply.includes("2"), "should report 2 matches for market:abc");
    assert.ok(!reply.includes("chat:1"), "must not expose chat:1");
    assert.ok(!reply.includes("chat:2"), "must not expose chat:2");
  });
});

test("handler: reports 0 for a ref no one follows", async () => {
  const { matchPreviewCommand } = await import("../dist/commands/index.js");

  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: dir + "/follows.json" });
    store.follow("chat:1", "squad:other");

    const ctx = makeCtx({ text: "/matchpreview market:nobody" });
    const deps = {
      config: makeConfig(),
      status: () => ({ state: "running" }),
      pause: () => "paused",
      resume: () => "resumed",
      followStore: store,
    };

    await matchPreviewCommand.handler(ctx, deps);

    assert.strictEqual(ctx.replies.length, 1);
    assert.ok(ctx.replies[0].includes("0"), "should report 0 for unsubscribed ref");
  });
});

test("handler: replies with usage when no argument is given", async () => {
  const { matchPreviewCommand } = await import("../dist/commands/index.js");
  const ctx = makeCtx({ text: "/matchpreview" });
  const deps = {
    config: makeConfig(),
    status: () => ({ state: "running" }),
    pause: () => "paused",
    resume: () => "resumed",
  };

  await matchPreviewCommand.handler(ctx, deps);

  assert.strictEqual(ctx.replies.length, 1);
  const reply = ctx.replies[0];
  assert.ok(
    reply.includes("market") || reply.includes("squad"),
    "usage hint should mention valid ref shapes",
  );
});

test("handler: replies with invalid-ref message for a bad ref", async () => {
  const { matchPreviewCommand } = await import("../dist/commands/index.js");
  const ctx = makeCtx({ text: "/matchpreview notvalid" });
  const deps = {
    config: makeConfig(),
    status: () => ({ state: "running" }),
    pause: () => "paused",
    resume: () => "resumed",
  };

  await matchPreviewCommand.handler(ctx, deps);

  assert.strictEqual(ctx.replies.length, 1);
  const reply = ctx.replies[0];
  assert.ok(
    reply.toLowerCase().includes("invalid") || reply.toLowerCase().includes("expected"),
    "should indicate the ref is invalid",
  );
});

test("command is marked operatorOnly and hidden", async () => {
  const { matchPreviewCommand } = await import("../dist/commands/index.js");
  assert.strictEqual(matchPreviewCommand.operatorOnly, true, "must be operatorOnly");
  assert.strictEqual(matchPreviewCommand.hidden, true, "must be hidden from menu");
});

test("handler sends no notifications — only replies to the operator", async () => {
  // The handler must reply to the ctx, never call bot.api.sendMessage directly.
  const { matchPreviewCommand } = await import("../dist/commands/index.js");

  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: dir + "/follows.json" });
    store.follow("chat:5", "market:xyz");

    const sendCalls = [];
    const ctx = {
      ...makeCtx({ text: "/matchpreview market:xyz" }),
      // Fake a Telegram API surface; it must never be called.
      api: {
        sendMessage: async (...args) => {
          sendCalls.push(args);
          return {};
        },
      },
    };

    const deps = {
      config: makeConfig(),
      status: () => ({ state: "running" }),
      pause: () => "paused",
      resume: () => "resumed",
      followStore: store,
    };

    await matchPreviewCommand.handler(ctx, deps);

    assert.strictEqual(
      sendCalls.length,
      0,
      "handler must not call bot.api.sendMessage",
    );
    assert.strictEqual(ctx.replies.length, 1, "handler must reply exactly once");
  });
});
