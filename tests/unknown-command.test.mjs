/**
 * Tests for the unknown-command hint system.
 *
 * Coverage:
 *   - unknownCommandReply: suggestion present / absent
 *   - closestCommand: exact, near-miss, too-far, empty list
 *   - levenshtein: basic distance cases
 *   - Bot fallback handler: private chat gets a hint
 *   - Bot fallback handler: group/supergroup/channel — silent
 *   - Bot fallback handler: command addressed to another bot — silent
 *   - Bot fallback handler: command addressed to this bot — hint sent
 *   - Bot fallback handler: rate-limit suppresses a second hint
 *   - Bot fallback handler: known commands are never caught by the fallback
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  closestCommand,
  levenshtein,
  unknownCommandReply,
  canSendHint,
  recordHint,
  clearHintState,
  HINT_COOLDOWN_MS,
} from "../dist/commands/unknown.js";

import { createBot, clearHintState as botClearHintState } from "../dist/bot.js";

// ---------------------------------------------------------------------------
// Helpers shared by integration cases
// ---------------------------------------------------------------------------

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeConfig(overrides = {}) {
  return {
    botToken: "0:fake-token",
    chatId: "-1001234567890",
    allowedChatIds: [],
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    ...overrides,
  };
}

function makeStatus() {
  return {
    running: true,
    paused: false,
    startedAt: Date.now(),
    lastSuccessAt: null,
    chainClockAt: null,
    cycles: 0,
    latestLedger: 1000,
    oldestLedger: 900,
    lastPollAt: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
  };
}

/**
 * Dispatch a raw update to the bot and collect sendMessage calls.
 * Uses the API transformer layer, same pattern as allowlist.test.mjs.
 */
async function dispatch(bot, update) {
  const replies = [];
  const transformer = async (prev, method, payload, signal) => {
    if (method === "sendMessage") {
      replies.push({ chatId: payload.chat_id, text: payload.text });
      return {
        ok: true,
        result: { message_id: 1, chat: { id: payload.chat_id, type: "private" }, date: 0 },
      };
    }
    return prev(method, payload, signal);
  };
  bot.api.config.use(transformer);
  await bot.handleUpdate(update);
  return replies;
}

/** Build a minimal message update for a bot_command entity. */
function makeCommandUpdate({
  chatId,
  chatType = "private",
  command,        // e.g. "hlep" — without the leading /
  botMention = null, // e.g. "other_bot" or "test_bot"
  updateId = 1,
}) {
  const cmdText = botMention ? `/${command}@${botMention}` : `/${command}`;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: chatType },
      from: { id: 999, is_bot: false, first_name: "Tester" },
      text: cmdText,
      entities: [
        { type: "bot_command", offset: 0, length: cmdText.length },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Unit: levenshtein
// ---------------------------------------------------------------------------

test("levenshtein: identical strings have distance 0", () => {
  assert.equal(levenshtein("status", "status"), 0);
});

test("levenshtein: empty string to non-empty equals the length", () => {
  assert.equal(levenshtein("", "help"), 4);
  assert.equal(levenshtein("help", ""), 4);
});

test("levenshtein: single substitution", () => {
  assert.equal(levenshtein("hlep", "help"), 2); // transpose → 2 subs
});

test("levenshtein: one deletion gives distance 1", () => {
  assert.equal(levenshtein("statuss", "status"), 1);
});

test("levenshtein: one insertion gives distance 1", () => {
  assert.equal(levenshtein("statu", "status"), 1);
});

test("levenshtein: completely different short strings", () => {
  assert.ok(levenshtein("abc", "xyz") > 0);
});

// ---------------------------------------------------------------------------
// Unit: closestCommand
// ---------------------------------------------------------------------------

const KNOWN = ["start", "help", "status", "contracts", "health", "preview", "pause", "resume"];

test("closestCommand: exact match returns that command", () => {
  assert.equal(closestCommand("status", KNOWN), "status");
});

test("closestCommand: one-char typo returns the closest command", () => {
  // "hlep" → help (distance 2, transposition)
  assert.equal(closestCommand("hlep", KNOWN), "help");
});

test("closestCommand: one-char truncation returns the closest command", () => {
  // "statu" → status (distance 1)
  assert.equal(closestCommand("statu", KNOWN), "status");
});

test("closestCommand: completely unrelated string returns null (distance > 3)", () => {
  // "xyzzy" has edit distance > 3 from every known command
  assert.equal(closestCommand("xyzzy", KNOWN), null);
});

test("closestCommand: empty known list returns null", () => {
  assert.equal(closestCommand("status", []), null);
});

test("closestCommand: input is case-insensitive", () => {
  assert.equal(closestCommand("STATUS", KNOWN), "status");
});

// ---------------------------------------------------------------------------
// Unit: unknownCommandReply
// ---------------------------------------------------------------------------

test("unknownCommandReply: with a suggestion names the closest command", () => {
  const reply = unknownCommandReply("hlep", "help");
  assert.ok(reply.includes("/hlep"), "should mention the typed command");
  assert.ok(reply.includes("/help"), "should suggest the closest command");
});

test("unknownCommandReply: without a suggestion falls back to /help hint", () => {
  const reply = unknownCommandReply("xyzzy", null);
  assert.ok(reply.includes("/xyzzy"), "should mention the typed command");
  assert.ok(reply.includes("/help"), "should point to /help");
  assert.ok(!reply.includes("Did you mean"), "must not claim a suggestion exists");
});

// ---------------------------------------------------------------------------
// Unit: canSendHint / recordHint / clearHintState
// ---------------------------------------------------------------------------

test("canSendHint: always true for a fresh chat id", () => {
  clearHintState();
  assert.equal(canSendHint(12345), true);
});

test("canSendHint: false immediately after recordHint", () => {
  clearHintState();
  const now = Date.now();
  recordHint(12345, now);
  assert.equal(canSendHint(12345, now + 1000), false);
});

test("canSendHint: true after the cooldown window elapses", () => {
  clearHintState();
  const now = Date.now();
  recordHint(12345, now);
  assert.equal(canSendHint(12345, now + HINT_COOLDOWN_MS), true);
});

test("clearHintState with a chatId only clears that chat", () => {
  clearHintState();
  const now = Date.now();
  recordHint(111, now);
  recordHint(222, now);
  clearHintState(111);
  assert.equal(canSendHint(111, now + 1000), true);   // cleared
  assert.equal(canSendHint(222, now + 1000), false);  // still throttled
  clearHintState();
});

// ---------------------------------------------------------------------------
// Integration: bot fallback handler
// ---------------------------------------------------------------------------

test("private chat receives a hint for an unknown command", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: 1001,
    chatType: "private",
    command: "hlep",
  }));

  assert.equal(replies.length, 1, "should reply once");
  assert.ok(replies[0].text.includes("/hlep"), "reply should mention the typed command");
  assert.ok(replies[0].text.includes("/help"), "reply should suggest /help");
});

test("group chat receives no reply for an unknown command", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: -100200300,
    chatType: "group",
    command: "hlep",
  }));

  assert.equal(replies.length, 0, "group chats must stay silent");
});

test("supergroup chat receives no reply for an unknown command", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: -100200301,
    chatType: "supergroup",
    command: "hlep",
  }));

  assert.equal(replies.length, 0, "supergroup chats must stay silent");
});

test("channel chat receives no reply for an unknown command", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: -100200302,
    chatType: "channel",
    command: "hlep",
  }));

  assert.equal(replies.length, 0, "channels must stay silent");
});

test("command addressed to another bot is ignored in private chat", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: 1002,
    chatType: "private",
    command: "hlep",
    botMention: "other_bot",   // not "test_bot"
  }));

  assert.equal(replies.length, 0, "command for another bot must be ignored");
});

test("command addressed to this bot is handled in private chat", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: 1003,
    chatType: "private",
    command: "hlep",
    botMention: "test_bot",    // matches FAKE_BOT_INFO.username
  }));

  assert.equal(replies.length, 1, "command for this bot should produce a hint");
  assert.ok(replies[0].text.includes("/help"), "should suggest /help");
});

test("rate-limit suppresses a second hint within the cooldown window", async () => {
  botClearHintState();
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  // First unknown command → hint sent.
  const first = await dispatch(bot, makeCommandUpdate({
    chatId: 1004,
    chatType: "private",
    command: "hlep",
    updateId: 10,
  }));
  assert.equal(first.length, 1, "first hint should be sent");

  // Immediately after → throttled, no reply.
  const second = await dispatch(bot, makeCommandUpdate({
    chatId: 1004,
    chatType: "private",
    command: "statu",
    updateId: 11,
  }));
  assert.equal(second.length, 0, "second hint within cooldown must be suppressed");
});

test("known commands are never intercepted by the unknown-command fallback", async () => {
  botClearHintState();
  // Only testing that the fallback does NOT fire for known commands;
  // the known-command handler itself may or may not reply depending on config,
  // but the reply should never be the unknown-command hint text.
  const bot = createBot({ config: makeConfig(), status: makeStatus, botInfo: FAKE_BOT_INFO });

  const replies = await dispatch(bot, makeCommandUpdate({
    chatId: 1005,
    chatType: "private",
    command: "start",
  }));

  // /start always replies; verify it is NOT the unknown-command hint.
  for (const reply of replies) {
    assert.ok(
      !reply.text.includes("Unknown command"),
      "/start must never trigger the unknown-command hint",
    );
  }
});
