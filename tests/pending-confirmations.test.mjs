/**
 * Focused automated coverage for the bounded operator list of pending
 * confirmations and explicit cancellation without exposing other chats.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BroadcastStore,
  PendingBroadcastStore,
  MAX_PENDING_CONFIRMATIONS,
  BROADCAST_NO_PENDING_MESSAGE,
  formatPendingConfirmations,
  pendingConfirmationsKeyboard,
  handleBroadcastCommand,
  handleBroadcastCallback,
  handleConfirmationsCommand,
  handleConfirmationsCallback,
  registerBroadcastCommand,
  registerBroadcastHandlers,
} from "../dist/commands/broadcast.js";
import {
  handleCallbackQuery,
  validateCallbackData,
  CALLBACK_UNAUTHORIZED_FEEDBACK,
} from "../dist/callbacks.js";

function fakeConfig(overrides = {}) {
  return {
    botToken: "TEST_TOKEN_123456789:ABCDEF",
    chatId: "-100111",
    chatIds: ["-100111", "-100222"],
    marketChatId: "-100111",
    squadChatId: "-100333",
    operatorTelegramUserId: "42",
    interSendDelayMs: 0,
    ...overrides,
  };
}

function createFakeApi() {
  const sent = [];
  const edits = [];
  const answeredCallbacks = [];

  return {
    sent,
    edits,
    answeredCallbacks,
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId: String(chatId), text, options });
      return { message_id: sent.length };
    },
    editMessageText: async (text, options) => {
      edits.push({ text, options });
      return true;
    },
    answerCallbackQuery: async (options) => {
      answeredCallbacks.push(options);
      return true;
    },
  };
}

// ── 1. Operator Scoping & Expiry in BroadcastStore ──────────────────────────

test("listPendingForOperator returns only the current operator's unexpired actions with expiry", () => {
  let now = 1_700_000_000_000;
  const store = new BroadcastStore({ now: () => now, defaultTtlMs: 300_000 });

  const op1Item1 = store.create("42", "Op 42 maintenance window", ["-100111", "-100222"], 120_000, "42");
  const op2Item = store.create("99", "Op 99 private broadcast", ["-100999"], 120_000, "99");
  const op1Expired = store.create("42", "Op 42 short ttl", ["-100111"], 30_000, "42");
  const op1Item2 = store.create("42", "Op 42 upgrade notice", ["-100333"], 240_000, "42");

  // Advance clock by 45s so op1Expired is expired
  now += 45_000;

  const list42 = store.listPendingForOperator("42");
  assert.equal(list42.length, 2);
  assert.deepEqual(
    list42.map((i) => i.id),
    [op1Item1.id, op1Item2.id],
  );
  assert.equal(list42.some((i) => i.id === op2Item.id), false, "Must not include other operator's items");
  assert.equal(list42.some((i) => i.id === op1Expired.id), false, "Must not include expired items");

  // Check expiry and remainingMs calculation
  assert.equal(list42[0].operatorId, "42");
  assert.equal(list42[0].expiresAt, op1Item1.expiresAt);
  assert.equal(list42[0].remainingMs, 120_000 - 45_000);
  assert.equal(list42[0].targetCount, 2);
  assert.equal("chats" in list42[0], false, "Summary object must not expose raw target chat IDs");

  // Operator 99 sees only their own item
  const list99 = store.listPendingForOperator("99");
  assert.equal(list99.length, 1);
  assert.equal(list99[0].id, op2Item.id);
});

test("listPendingForOperator filters by chatId when specified and excludes confirmed items", () => {
  const now = 1_700_000_000_000;
  const store = new BroadcastStore({ now: () => now });

  const itemA = store.create("42", "From chat 42", ["-100111"], 60_000, "42");
  store.create("42", "From chat 100", ["-100111"], 60_000, "100");
  const itemConfirmed = store.create("42", "Already confirmed", ["-100111"], 60_000, "42");
  store.consume(itemConfirmed.id, "confirm");

  const scoped = store.listPendingForOperator("42", { chatId: "42" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].id, itemA.id);
});

// ── 2. Bounded Capacity & Listing Limits ────────────────────────────────────

test("BroadcastStore bounds pending confirmations to capacity and evicts oldest entries", () => {
  let now = 1_700_000_000_000;
  const store = new BroadcastStore({ capacity: 5, now: () => now });

  const created = [];
  for (let i = 1; i <= 8; i++) {
    now += 100;
    created.push(store.create("42", `Broadcast #${i}`, ["-100111"], 300_000, "42"));
  }

  assert.equal(store.size(), 5, "Store size must be bounded by capacity");
  const listed = store.listPendingForOperator("42");
  assert.equal(listed.length, 5);
  // Oldest 3 (#1, #2, #3) were evicted; #4..#8 remain
  assert.deepEqual(
    listed.map((i) => i.id),
    created.slice(3).map((i) => i.id),
  );
  assert.equal(store.get(created[0].id), undefined);
  assert.equal(store.get(created[2].id), undefined);
  assert.ok(store.get(created[3].id) !== undefined);
});

test("MAX_PENDING_CONFIRMATIONS is 20 and listPendingForOperator honours custom limit", () => {
  assert.equal(MAX_PENDING_CONFIRMATIONS, 20);
  const store = new BroadcastStore();
  for (let i = 0; i < 25; i++) {
    store.create("42", `Msg ${i}`, ["-100111"]);
  }
  assert.equal(store.size(), MAX_PENDING_CONFIRMATIONS);
  const allForOp = store.listPendingForOperator("42");
  assert.equal(allForOp.length, MAX_PENDING_CONFIRMATIONS);

  const limited = store.listPendingForOperator("42", { limit: 3 });
  assert.equal(limited.length, 3);
});

// ── 3. Privacy & Non-Exposure of Target Chats ───────────────────────────────

test("formatPendingConfirmations shows expiry and target count without exposing target chat IDs", () => {
  const now = 1_700_000_000_000;
  const store = new BroadcastStore({ now: () => now });
  const secretChats = ["-100987654321", "@private_alpha_channel", "-1001122334455"];
  const item = store.create("42", "Scheduled maintenance at 03:00 UTC", secretChats, 90_000, "42");

  const summaries = store.listPendingForOperator("42");
  const rendered = formatPendingConfirmations(summaries, now);

  assert.ok(rendered.includes("Pending confirmations (1)"));
  assert.ok(rendered.includes(item.id));
  assert.ok(rendered.includes("3 destinations"));
  assert.ok(rendered.includes("expires in 1m 30s"));
  assert.ok(rendered.includes(new Date(item.expiresAt).toISOString()));
  assert.ok(rendered.includes("Scheduled maintenance at 03:00 UTC"));

  for (const chatId of secretChats) {
    assert.equal(
      rendered.includes(chatId),
      false,
      `Rendered list must not expose target chat ID "${chatId}"`,
    );
  }
});

test("formatPendingConfirmations returns empty message when list is empty", () => {
  assert.equal(formatPendingConfirmations([]), BROADCAST_NO_PENDING_MESSAGE);
});

// ── 4. Explicit Cancellation & Boundary Cases ───────────────────────────────

test("cancelForOperator cancels own pending confirmation and rejects replay or cross-operator cancellation", () => {
  let now = 1_700_000_000_000;
  const store = new BroadcastStore({ now: () => now });

  const item42 = store.create("42", "Op 42 broadcast", ["-100111", "-100222"], 60_000, "42");
  const item99 = store.create("99", "Op 99 broadcast", ["-100999"], 60_000, "99");

  // 1. Cross-operator cancellation attempt is rejected and leaves item99 intact
  const crossCancel = store.cancelForOperator(item99.id, "42", "42");
  assert.equal(crossCancel.ok, false);
  assert.equal(crossCancel.reason, "actor_mismatch");
  assert.ok(store.get(item99.id) !== undefined, "Other operator's confirmation must remain intact");

  // 2. Cross-chat cancellation attempt is rejected
  const wrongChat = store.cancelForOperator(item42.id, "42", "99999");
  assert.equal(wrongChat.ok, false);
  assert.equal(wrongChat.reason, "chat_mismatch");
  assert.ok(store.get(item42.id) !== undefined);

  // 3. Noncanonical numeric ID is rejected
  assert.equal(store.cancelForOperator("+123", "42", "42").ok, false);
  assert.equal(store.cancelForOperator("0123", "42", "42").ok, false);

  // 4. Valid cancellation by owner succeeds
  const validCancel = store.cancelForOperator(item42.id, "42", "42");
  assert.equal(validCancel.ok, true);
  assert.equal(store.get(item42.id), undefined);
  assert.equal(store.getCancelReason(item42.id), "user-cancelled");

  // 5. Re-cancelling or confirming the cancelled ID is rejected as replayed
  const secondCancel = store.cancelForOperator(item42.id, "42", "42");
  assert.equal(secondCancel.ok, false);
  assert.equal(secondCancel.reason, "replayed");
  const checkAfterCancel = store.check(item42.id, {
    operatorId: "42",
    chatId: "42",
    action: "confirm",
  });
  assert.equal(checkAfterCancel.ok, false);
  assert.equal(checkAfterCancel.reason, "replayed");
});

test("cancelForOperator rejects expired confirmation with reason 'expired'", () => {
  let now = 1_700_000_000_000;
  const store = new BroadcastStore({ now: () => now });
  const item = store.create("42", "Expiring broadcast", ["-100111"], 10_000, "42");

  now += 15_000;
  const res = store.cancelForOperator(item.id, "42", "42");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "expired");
});

test("cancelAllForOperator cancels only the current operator's items in the current chat", () => {
  const now = 1_700_000_000_000;
  const store = new BroadcastStore({ now: () => now });

  const own1 = store.create("42", "Own 1", ["-100111"], 60_000, "42");
  const own2 = store.create("42", "Own 2", ["-100222"], 60_000, "42");
  const otherOp = store.create("99", "Other op", ["-100333"], 60_000, "99");
  const otherChat = store.create("42", "Other chat", ["-100444"], 60_000, "777");

  const cancelled = store.cancelAllForOperator("42", "42");
  assert.deepEqual(cancelled, [own1.id, own2.id]);
  assert.equal(store.listPendingForOperator("42", { chatId: "42" }).length, 0);
  assert.equal(store.listPendingForOperator("99").length, 1);
  assert.equal(store.listPendingForOperator("99")[0].id, otherOp.id);
  assert.equal(store.listPendingForOperator("42", { chatId: "777" }).length, 1);
  assert.equal(store.listPendingForOperator("42", { chatId: "777" })[0].id, otherChat.id);
});

// ── 5. Command & Callback Flows (/broadcast list, /broadcast cancel, /confirmations) ──

test("/broadcast list and /confirmations show operator's pending actions with inline cancel buttons and no chat IDs", async () => {
  const config = fakeConfig({
    chatIds: ["-100555666", "-100777888"],
    marketChatId: "-100555666",
    squadChatId: "-100999000",
  });
  const store = new BroadcastStore();
  const own = store.create("42", "Deploy notice", ["-100555666", "-100777888"], 180_000, "42");
  store.create("99", "Other operator secret notice", ["-100123123"], 180_000, "99");

  const replies = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 501 },
    message: { text: "/broadcast list" },
    reply: async (text, opts) => replies.push({ text, opts }),
  };

  await handleBroadcastCommand(ctx, { config, broadcastStore: store });
  assert.equal(replies.length, 1);
  const { text, opts } = replies[0];

  assert.ok(text.includes(own.id));
  assert.ok(text.includes("Deploy notice"));
  assert.ok(text.includes("2 destinations"));
  assert.ok(text.includes("expires in"));
  assert.equal(text.includes("-100555666"), false, "Must not leak target chat ID");
  assert.equal(text.includes("-100777888"), false, "Must not leak target chat ID");
  assert.equal(text.includes("-100123123"), false, "Must not leak other operator's chat ID");
  assert.equal(text.includes("Other operator"), false, "Must not leak other operator's action");

  // Inline keyboard contains cancel button fitting 64-byte limit
  const kb = opts.reply_markup.inline_keyboard.flat();
  assert.equal(kb.length, 1);
  assert.equal(kb[0].callback_data, `broadcast:cancel:${own.id}`);
  assert.ok(Buffer.byteLength(kb[0].callback_data, "utf8") <= 64);
  assert.equal(validateCallbackData(kb[0].callback_data).ok, true);
});

test("/broadcast cancel <id> and /confirmations cancel <id> cancel only the operator's action", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  const own = store.create("42", "Cancel via command", ["-100111"], 180_000, "42");
  const other = store.create("99", "Other op action", ["-100999"], 180_000, "99");

  // Attempt to cancel other operator's item fails without revealing it exists
  const replies = [];
  const ctxOther = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 502 },
    message: { text: `/broadcast cancel ${other.id}` },
    reply: async (text) => replies.push(text),
  };
  await handleBroadcastCommand(ctxOther, { config, broadcastStore: store });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /not found, expired, or already processed/i);
  assert.equal(replies[0].includes("-100999"), false);
  assert.ok(store.get(other.id) !== undefined);

  // Cancel own item succeeds
  replies.length = 0;
  const ctxOwn = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 503 },
    message: { text: `/confirmations cancel ${own.id}` },
    reply: async (text) => replies.push(text),
  };
  await handleConfirmationsCommand(ctxOwn, { config, broadcastStore: store });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /cancelled/i);
  assert.equal(store.get(own.id), undefined);

  // Subsequent confirm callback for cancelled item is rejected and sends nothing
  const api = createFakeApi();
  const cbCtx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 504 },
    api,
    callbackQuery: {
      id: "cb_after_cmd_cancel",
      data: `broadcast:confirm:${own.id}`,
      message: { message_id: 300 },
    },
    editMessageText: async (t) => api.edits.push(t),
    answerCallbackQuery: async (o) => api.answeredCallbacks.push(o),
  };
  await handleBroadcastCallback(
    cbCtx,
    { config, broadcastStore: store },
    `broadcast:confirm:${own.id}`,
  );
  assert.equal(api.sent.length, 0, "Cancelled confirmation must never send");
  assert.match(api.answeredCallbacks[0].text, /expired or already processed/i);
});

test("confirmations:cancel_all callback cancels all pending actions for operator via handleCallbackQuery", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  store.create("42", "First pending", ["-100111"], 180_000, "42");
  store.create("42", "Second pending", ["-100222"], 180_000, "42");
  const other = store.create("99", "Other op pending", ["-100333"], 180_000, "99");

  const api = createFakeApi();
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 505 },
    api,
    callbackQuery: {
      id: "cb_cancel_all",
      data: "confirmations:cancel_all",
      message: { message_id: 301, chat: { id: 42, type: "private" } },
    },
    editMessageText: async (t) => api.edits.push(t),
    answerCallbackQuery: async (o) => api.answeredCallbacks.push(o),
  };

  await handleCallbackQuery(ctx, {
    config,
    status: () => ({}),
    pause: () => "stopped",
    resume: () => "stopped",
    broadcastStore: store,
  });

  assert.equal(store.listPendingForOperator("42").length, 0);
  assert.equal(store.listPendingForOperator("99").length, 1);
  assert.equal(store.get(other.id)?.id, other.id);
  assert.match(api.edits[0], /Cancelled 2 pending confirmation\(s\)/);
});

test("Non-operator or group chat is denied access to /confirmations and confirmations callbacks", async () => {
  const config = fakeConfig({ operatorTelegramUserId: "42" });
  const store = new BroadcastStore();
  store.create("42", "Op broadcast", ["-100111"], 180_000, "42");

  // 1. Non-operator command in private chat -> silent ignore
  const replies = [];
  await handleConfirmationsCommand(
    {
      from: { id: 999 },
      chat: { id: 999, type: "private" },
      update: { update_id: 506 },
      message: { text: "/confirmations" },
      reply: async (t) => replies.push(t),
    },
    { config, broadcastStore: store },
  );
  assert.equal(replies.length, 0);

  // 2. Operator command in group chat -> silent ignore (prevents exposing pending actions to group)
  await handleConfirmationsCommand(
    {
      from: { id: 42 },
      chat: { id: -100111, type: "supergroup" },
      update: { update_id: 507 },
      message: { text: "/confirmations" },
      reply: async (t) => replies.push(t),
    },
    { config, broadcastStore: store },
  );
  assert.equal(replies.length, 0);

  // 3. Non-operator callback -> unauthorized alert
  const alerts = [];
  await handleCallbackQuery(
    {
      from: { id: 999 },
      chat: { id: 999, type: "private" },
      update: { update_id: 508 },
      callbackQuery: { id: "cb_unauth", data: "confirmations:list" },
      answerCallbackQuery: async (o) => alerts.push(o),
    },
    {
      config,
      status: () => ({}),
      pause: () => "stopped",
      resume: () => "stopped",
      broadcastStore: store,
    },
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].text, CALLBACK_UNAUTHORIZED_FEEDBACK);
  assert.equal(alerts[0].show_alert, true);
  assert.equal(store.size(), 1, "Pending item must remain untouched");
});

// ── 6. PendingBroadcastStore & registerBroadcastCommand Compatibility ────────

test("PendingBroadcastStore supports operator-scoped listing with expiry and explicit cancellation", async () => {
  let now = 1_700_000_000_000;
  const store = new PendingBroadcastStore(3, { defaultTtlMs: 60_000, now: () => now });

  store.add({ token: "t1", text: "Op 42 msg 1", chatIds: ["-100111", "-100222"], operatorChatId: 42 });
  store.add({ token: "t2", text: "Op 99 msg", chatIds: ["-100999"], operatorChatId: 99 });
  store.add({ token: "t3", text: "Op 42 short", chatIds: ["-100111"], operatorChatId: 42 }, 10_000);

  now += 20_000; // t3 expires

  const list42 = store.listForOperator(42, now);
  assert.equal(list42.length, 1);
  assert.equal(list42[0].id, "t1");
  assert.equal(list42[0].targetCount, 2);
  assert.equal(list42[0].remainingMs, 40_000);
  assert.equal("chatIds" in list42[0], false);

  // Operator 42 cannot cancel operator 99's token
  assert.equal(store.cancelForOperator("t2", 42, now), false);
  assert.equal(store.listForOperator(99, now).length, 1);

  // Operator 42 can cancel their own token
  assert.equal(store.cancelForOperator("t1", 42, now), true);
  assert.equal(store.listForOperator(42, now).length, 0);
  assert.equal(store.consume("t1", now), undefined);
});

test("registerBroadcastCommand supports /broadcast list and /broadcast cancel <token>", async () => {
  const handlers = new Map();
  const bot = {
    command: (name, fn) => handlers.set(`cmd:${name}`, fn),
    on: (event, fn) => handlers.set(`on:${event}`, fn),
  };
  const store = new PendingBroadcastStore();
  registerBroadcastCommand(bot, {
    config: fakeConfig(),
    store,
    targetChatIds: ["-100111", "-100222"],
  });

  const replies = [];
  const makeCtx = (text) => ({
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    message: { text },
    update: { update_id: 1 },
    reply: async (t, opts) => replies.push({ text: t, opts }),
  });

  await handlers.get("cmd:broadcast")(makeCtx("/broadcast First announcement"));
  assert.equal(replies.length, 1);
  const confirmBtn = replies[0].opts.reply_markup.inline_keyboard[0][0];
  const token = confirmBtn.callback_data.slice("broadcast:confirm:".length);

  // List pending
  replies.length = 0;
  await handlers.get("cmd:broadcast")(makeCtx("/broadcast list"));
  assert.equal(replies.length, 1);
  assert.ok(replies[0].text.includes(token));
  assert.ok(replies[0].text.includes("2 destinations"));
  assert.equal(replies[0].text.includes("-100111"), false);
  assert.equal(replies[0].text.includes("-100222"), false);

  // Cancel by token
  replies.length = 0;
  await handlers.get("cmd:broadcast")(makeCtx(`/broadcast cancel ${token}`));
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Broadcast cancelled/);
  assert.equal(store.size(), 0);
});
