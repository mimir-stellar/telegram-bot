import assert from "node:assert/strict";
import test from "node:test";

import {
  handleBroadcastCommand,
  handleBroadcastCallback,
  getConfiguredBroadcastChats,
  fingerprintDestinationSet,
  BroadcastStore,
  formatBroadcastPreview,
} from "../dist/commands/broadcast.js";
import {
  handleCallbackQuery,
} from "../dist/bot.js";

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

  const api = {
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
  return api;
}

// ── 1. Destination Set Fingerprinting ─────────────────────────────────────────

test("fingerprintDestinationSet produces a deterministic 64-character SHA-256 hex string", () => {
  const fp1 = fingerprintDestinationSet(["-100111", "-100222"]);
  const fp2 = fingerprintDestinationSet(["-100111", "-100222"]);
  assert.equal(fp1, fp2);
  assert.equal(typeof fp1, "string");
  assert.equal(fp1.length, 64);
  assert.match(fp1, /^[0-9a-f]{64}$/);
});

test("fingerprintDestinationSet is order-independent across permutations", () => {
  const orderA = ["-100111", "-100222", "-100333"];
  const orderB = ["-100333", "-100111", "-100222"];
  const orderC = ["-100222", "-100333", "-100111"];

  assert.equal(fingerprintDestinationSet(orderA), fingerprintDestinationSet(orderB));
  assert.equal(fingerprintDestinationSet(orderB), fingerprintDestinationSet(orderC));
});

test("fingerprintDestinationSet deduplicates destinations identically", () => {
  const unique = ["-100111", "-100222"];
  const duplicates = ["-100111", "-100222", "-100111", "-100222"];

  assert.equal(fingerprintDestinationSet(unique), fingerprintDestinationSet(duplicates));
});

test("fingerprintDestinationSet normalizes surrounding whitespace and blank entries", () => {
  const raw = ["  -100111\n", "\t-100222 ", "", "   "];
  const clean = ["-100111", "-100222"];

  assert.equal(fingerprintDestinationSet(raw), fingerprintDestinationSet(clean));
});

test("fingerprintDestinationSet detects added, removed, or modified destinations", () => {
  const base = fingerprintDestinationSet(["-100111", "-100222"]);
  const added = fingerprintDestinationSet(["-100111", "-100222", "-100333"]);
  const removed = fingerprintDestinationSet(["-100111"]);
  const modified = fingerprintDestinationSet(["-100111", "-100999"]);

  assert.notEqual(base, added, "Adding destination must change fingerprint");
  assert.notEqual(base, removed, "Removing destination must change fingerprint");
  assert.notEqual(base, modified, "Altering destination must change fingerprint");
});

test("getConfiguredBroadcastChats includes per-chat routes when configured", () => {
  const config = fakeConfig({
    chatIds: ["-100111"],
    marketChatId: undefined,
    squadChatId: undefined,
    routes: [
      { chatId: "-100888", channelPreviewMode: true },
      { chatId: "-100999", channelPreviewMode: false },
    ],
  });
  const chats = getConfiguredBroadcastChats(config);
  assert.deepEqual(chats, ["-100111", "-100888", "-100999"]);
});

// ── 2. Broadcast Preview and Creation ─────────────────────────────────────────

test("handleBroadcastCommand records destination fingerprint and includes it in preview", async () => {
  const config = fakeConfig();
  const store = new BroadcastStore();
  const replies = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 301 },
    message: { text: "/broadcast Important maintenance announcement" },
    reply: async (...args) => replies.push(args),
  };

  await handleBroadcastCommand(ctx, { config, broadcastStore: store });
  assert.equal(replies.length, 1);
  const [text, options] = replies[0];

  const expectedChats = getConfiguredBroadcastChats(config);
  const expectedFingerprint = fingerprintDestinationSet(expectedChats);

  assert.ok(text.includes(`Route fingerprint: \`${expectedFingerprint.slice(0, 12)}\``));
  assert.ok(text.includes(`Target chats (${expectedChats.length})`));

  // Verify store item holds destinationFingerprint
  assert.equal(store.size(), 1);
  const pending = Array.from(store["items"].values())[0];
  assert.equal(pending.destinationFingerprint, expectedFingerprint);
  assert.deepEqual(pending.chats, expectedChats);
});

// ── 3. Confirmation Route Safety Checks ──────────────────────────────────────

test("Confirmation succeeds when route configuration remains unchanged", async () => {
  const config = fakeConfig({ interSendDelayMs: 0 });
  const store = new BroadcastStore();
  const chats = getConfiguredBroadcastChats(config);
  const fingerprint = fingerprintDestinationSet(chats);
  const pending = store.create("42", "Unchanged route announcement", chats, undefined, fingerprint);

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 302 },
    api,
    callbackQuery: {
      id: "cb_302",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 201 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(api.sent.length, chats.length);
  assert.deepEqual(api.sent.map((s) => s.chatId), chats);
  assert.ok(edits[edits.length - 1].includes(`${chats.length}/${chats.length} succeeded`));
});

test("Confirmation succeeds when route configuration order changes (order-independent)", async () => {
  const previewConfig = fakeConfig({ chatIds: ["-100111", "-100222"], squadChatId: "-100333" });
  const store = new BroadcastStore();
  const chats = getConfiguredBroadcastChats(previewConfig);
  const fingerprint = fingerprintDestinationSet(chats);
  const pending = store.create("42", "Reordered route announcement", chats, undefined, fingerprint);

  // Configuration destinations are reordered at confirm time
  const confirmConfig = fakeConfig({ chatIds: ["-100222", "-100111"], squadChatId: "-100333" });

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 303 },
    api,
    callbackQuery: {
      id: "cb_303",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 202 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config: confirmConfig, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(api.sent.length, 3, "Reordered destinations must not trigger false invalidation");
});

test("Confirmation is cancelled and rejected when a destination is added to route configuration", async () => {
  const previewConfig = fakeConfig({ chatIds: ["-100111", "-100222"], squadChatId: undefined, marketChatId: undefined });
  const store = new BroadcastStore();
  const previewChats = getConfiguredBroadcastChats(previewConfig);
  const fingerprint = fingerprintDestinationSet(previewChats);
  const pending = store.create("42", "Stale announcement", previewChats, undefined, fingerprint);

  // New destination "-100333" added before confirmation
  const changedConfig = fakeConfig({ chatIds: ["-100111", "-100222"], squadChatId: "-100333" });

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 304 },
    api,
    callbackQuery: {
      id: "cb_304",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 203 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config: changedConfig, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  // Must not send to ANY chats
  assert.equal(api.sent.length, 0, "No messages should be sent when route configuration changed");

  // Pending item must be cancelled/removed from store
  assert.equal(store.get(pending.id), undefined, "Pending broadcast should be purged from store");

  // Operator is alerted that new preview is required
  assert.equal(api.answeredCallbacks.length, 1);
  assert.equal(api.answeredCallbacks[0].show_alert, true);
  assert.match(api.answeredCallbacks[0].text, /Route configuration changed/i);

  // Preview message is edited with warning
  assert.equal(edits.length, 1);
  assert.match(edits[0], /Route configuration changed since preview/i);
  assert.match(edits[0], /Run \/broadcast again/i);
});

test("Confirmation is cancelled and rejected when a destination is removed from route configuration", async () => {
  const previewConfig = fakeConfig({ chatIds: ["-100111", "-100222", "-100333"] });
  const store = new BroadcastStore();
  const previewChats = getConfiguredBroadcastChats(previewConfig);
  const fingerprint = fingerprintDestinationSet(previewChats);
  const pending = store.create("42", "Removed route announcement", previewChats, undefined, fingerprint);

  // Destination removed before confirmation
  const changedConfig = fakeConfig({ chatIds: ["-100111"], marketChatId: undefined, squadChatId: undefined });

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 305 },
    api,
    callbackQuery: {
      id: "cb_305",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 204 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config: changedConfig, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(api.sent.length, 0, "No messages should be sent when a destination was removed");
  assert.equal(store.get(pending.id), undefined);
  assert.match(api.answeredCallbacks[0].text, /Route configuration changed/i);
  assert.match(edits[0], /Route configuration changed since preview/i);
});

test("Confirmation is cancelled and rejected when per-chat routes change", async () => {
  const previewConfig = fakeConfig({
    chatIds: ["-100111"],
    marketChatId: undefined,
    squadChatId: undefined,
    routes: [{ chatId: "-100888", channelPreviewMode: false }],
  });
  const store = new BroadcastStore();
  const previewChats = getConfiguredBroadcastChats(previewConfig);
  const fingerprint = fingerprintDestinationSet(previewChats);
  const pending = store.create("42", "Per-chat route announcement", previewChats, undefined, fingerprint);

  // Route changed: new route added
  const changedConfig = fakeConfig({
    chatIds: ["-100111"],
    marketChatId: undefined,
    squadChatId: undefined,
    routes: [
      { chatId: "-100888", channelPreviewMode: false },
      { chatId: "-100999", channelPreviewMode: true },
    ],
  });

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 306 },
    api,
    callbackQuery: {
      id: "cb_306",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 205 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config: changedConfig, broadcastStore: store, sleep: async () => {} },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(api.sent.length, 0);
  assert.equal(store.get(pending.id), undefined);
  assert.match(api.answeredCallbacks[0].text, /Route configuration changed/i);
});

// ── 4. Cancellation Behavior ──────────────────────────────────────────────────

test("Clicking Cancel still works cleanly even if route configuration changed", async () => {
  const previewConfig = fakeConfig({ chatIds: ["-100111", "-100222"] });
  const store = new BroadcastStore();
  const previewChats = getConfiguredBroadcastChats(previewConfig);
  const fingerprint = fingerprintDestinationSet(previewChats);
  const pending = store.create("42", "To be cancelled", previewChats, undefined, fingerprint);

  // Route changed
  const changedConfig = fakeConfig({ chatIds: ["-100111", "-100333"] });

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 307 },
    api,
    callbackQuery: {
      id: "cb_307",
      data: `broadcast:cancel:${pending.id}`,
      message: { message_id: 206 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config: changedConfig, broadcastStore: store },
    `broadcast:cancel:${pending.id}`,
  );

  assert.equal(api.sent.length, 0);
  assert.equal(store.get(pending.id), undefined);
  assert.match(edits[0], /cancelled/i);
});

// ── 5. BroadcastStore Proactive Invalidation ───────────────────────────────────

test("BroadcastStore.cancelOnRouteChange purges mismatched items and preserves matching ones", () => {
  const store = new BroadcastStore();

  const routesA = ["-100111", "-100222"];
  const fpA = fingerprintDestinationSet(routesA);

  const routesB = ["-100333", "-100444"];
  const fpB = fingerprintDestinationSet(routesB);

  const item1 = store.create("42", "Msg 1", routesA, undefined, fpA);
  const item2 = store.create("42", "Msg 2", routesB, undefined, fpB);
  assert.equal(store.size(), 2);

  // New current routes match routesB
  const cancelled = store.cancelOnRouteChange(routesB);
  assert.deepEqual(cancelled, [item1.id]);
  assert.equal(store.size(), 1);
  assert.equal(store.get(item1.id), undefined);
  assert.ok(store.get(item2.id) !== undefined);
  assert.equal(store.getCancelReason(item1.id), "route-change");
});

test("Answering callback on broadcast cancelled proactively via cancelOnRouteChange informs operator", async () => {
  const store = new BroadcastStore();
  const oldRoutes = ["-100111"];
  const fpOld = fingerprintDestinationSet(oldRoutes);
  const pending = store.create("42", "Proactively cancelled", oldRoutes, undefined, fpOld);

  // Route change triggers proactive cancellation
  const newRoutes = ["-100222"];
  store.cancelOnRouteChange(newRoutes);
  assert.equal(store.get(pending.id), undefined);

  const config = fakeConfig({ chatIds: newRoutes, marketChatId: undefined, squadChatId: undefined });
  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 308 },
    api,
    callbackQuery: {
      id: "cb_308",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 207 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleBroadcastCallback(
    ctx,
    { config, broadcastStore: store },
    `broadcast:confirm:${pending.id}`,
  );

  assert.equal(api.sent.length, 0);
  assert.match(api.answeredCallbacks[0].text, /Route configuration changed/i);
  assert.match(edits[0], /Route configuration changed since preview/i);
});

// ── 6. Ingress Integration via handleCallbackQuery ────────────────────────────

test("handleCallbackQuery rejects broadcast confirmation when route configuration changed", async () => {
  const previewConfig = fakeConfig({ chatIds: ["-100111"] });
  const store = new BroadcastStore();
  const previewChats = getConfiguredBroadcastChats(previewConfig);
  const fp = fingerprintDestinationSet(previewChats);
  const pending = store.create("42", "Ingress route check", previewChats, undefined, fp);

  // Destination changed before ingress dispatch
  const currentConfig = fakeConfig({ chatIds: ["-100111", "-100222"] });

  const api = createFakeApi();
  const edits = [];
  const ctx = {
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    update: { update_id: 309 },
    api,
    callbackQuery: {
      id: "cb_309",
      data: `broadcast:confirm:${pending.id}`,
      message: { message_id: 208 },
    },
    editMessageText: async (t) => edits.push(t),
    answerCallbackQuery: async (opts) => api.answeredCallbacks.push(opts),
  };

  await handleCallbackQuery(ctx, {
    config: currentConfig,
    status: () => ({}),
    pause: () => "stopped",
    resume: () => "stopped",
    broadcastStore: store,
  });

  assert.equal(api.sent.length, 0, "Ingress dispatch must not send broadcast on route change");
  assert.equal(store.get(pending.id), undefined);
  assert.match(api.answeredCallbacks[0].text, /Route configuration changed/i);
  assert.match(edits[0], /Route configuration changed since preview/i);
});
