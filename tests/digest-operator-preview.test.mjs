import assert from "node:assert/strict";
import test from "node:test";

import { COMMANDS, registerCommandHandlers } from "../dist/bot.js";
import { visibleCommandMetadata } from "../dist/commands/index.js";
import {
  createPendingDigestWindow,
  renderOperatorDigestPreview,
} from "../dist/notifications/digest-grouping.js";
import { formatDigest } from "../dist/notifications/format.js";

function makeConfig(overrides = {}) {
  return {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: ["123456:fake", "secret"].join("-"),
    chatId: "-1001234567890",
    allowedChatIds: [],
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

function makeEvent({ source = "market", ledger = 500, name = "claim_created", id = 11n } = {}) {
  return {
    source,
    contractId: "C" + "A".repeat(55),
    version: "v1",
    ledger,
    txHash: "e".repeat(64),
    at: 1_763_193_600 + ledger,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: source === "squad" ? { name, marketId: id } : { name, claimId: id },
  };
}

function makeBotRecorder(config, pendingDigest) {
  const handlers = new Map();
  const bot = {
    command: (name, handler) => handlers.set(name, handler),
    callbackQuery: () => {},
  };
  registerCommandHandlers(bot, {
    config,
    status: () => ({ targets: [] }),
    pause: () => "paused",
    resume: () => "resumed",
    pendingDigest,
  });
  return handlers;
}

function makeCtx({ userId = 42, chatId = -1001234567890, text = "/preview digest", match = "" } = {}) {
  const replies = [];
  return {
    replies,
    ctx: {
      from: { id: userId },
      chat: { id: chatId },
      match,
      message: { text },
      update: { update_id: 1 },
      reply: async (body, opts) => replies.push({ body, opts }),
    },
  };
}

test("operator digest preview renders via live digest builder without consuming pending events", async () => {
  const pending = createPendingDigestWindow({
    schedule: "daily@08:00",
    maxEvents: 3,
    now: () => Date.parse("2026-11-15T06:00:00Z"),
  });

  const ev1 = makeEvent({ source: "market", ledger: 501, name: "claim_created", id: 77n });
  const ev2 = makeEvent({ source: "market", ledger: 502, name: "claim_challenged", id: 77n });
  const ev3 = makeEvent({ source: "squad", ledger: 503, name: "market_created", id: 9n });
  const ev4Overflow = makeEvent({ source: "squad", ledger: 504, name: "deposited", id: 9n });
  pending.append([ev1, ev2, ev3, ev4Overflow]);

  const handlers = makeBotRecorder(makeConfig(), pending);
  const previewHandler = handlers.get("preview");
  const hiddenDigestHandler = handlers.get("digest_preview");
  assert.ok(previewHandler);
  assert.ok(hiddenDigestHandler);

  // Run preview twice across both entrypoints; pending events must remain unconsumed!
  const firstCall = makeCtx({ userId: 42, text: "/preview digest", match: "digest" });
  await previewHandler(firstCall.ctx);
  assert.equal(firstCall.replies.length, 1);

  const secondCall = makeCtx({ userId: 42, text: "/digest_preview" });
  await hiddenDigestHandler(secondCall.ctx);
  assert.equal(secondCall.replies.length, 1);
  assert.equal(firstCall.replies[0].body, secondCall.replies[0].body);

  const liveExpected = formatDigest([ev1, ev2, ev3], { grouped: true });
  assert.ok(firstCall.replies[0].body.includes(liveExpected));
  assert.ok(firstCall.replies[0].body.includes("\\[PREVIEW MODE\\]"));
  assert.ok(firstCall.replies[0].body.includes("Pending events: 3 \\(2 groups\\)"));
  assert.ok(firstCall.replies[0].body.includes("Overflow omitted from pending window: 1"));

  // Verify the live scheduled flush still receives all 3 buffered events unchanged.
  assert.equal(pending.size(), 3);
  const drained = pending.drain(Date.parse("2026-11-15T08:00:00Z"));
  assert.deepEqual(
    drained.events.map((e) => e.ledger),
    [501, 502, 503],
  );
  assert.equal(pending.size(), 0);
});

test("non-operators and unset operator configs are silently blocked from digest preview while standard /preview stays intact", async () => {
  const pending = createPendingDigestWindow({ schedule: "daily@08:00" });
  pending.append(makeEvent({ ledger: 600 }));

  const handlers = makeBotRecorder(makeConfig({ operatorTelegramUserId: "42" }), pending);
  const previewHandler = handlers.get("preview");
  const hiddenDigestHandler = handlers.get("digest_preview");

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const strangerDigest = makeCtx({ userId: 999, text: "/preview digest", match: "digest" });
    await previewHandler(strangerDigest.ctx);
    assert.deepEqual(strangerDigest.replies, []);

    const strangerHidden = makeCtx({ userId: 999, text: "/digest_preview" });
    await hiddenDigestHandler(strangerHidden.ctx);
    assert.deepEqual(strangerHidden.replies, []);

    // Even user 42 is denied when OPERATOR_TELEGRAM_USER_ID is unset (null).
    const noOperatorHandlers = makeBotRecorder(
      makeConfig({ operatorTelegramUserId: null }),
      pending,
    );
    const unsetAttempt = makeCtx({ userId: 42, text: "/preview digest", match: "digest" });
    await noOperatorHandlers.get("preview")(unsetAttempt.ctx);
    assert.deepEqual(unsetAttempt.replies, []);
  } finally {
    console.warn = originalWarn;
  }

  // Standard /preview market still works for non-operators in allowed chats.
  const regularPreview = makeCtx({ userId: 999, text: "/preview market", match: "market" });
  await previewHandler(regularPreview.ctx);
  assert.equal(regularPreview.replies.length, 1);
  assert.ok(regularPreview.replies[0].body.includes("Channel Preview — mimir\\-market"));
  assert.equal(pending.size(), 1);
});

test("empty or unconfigured pending window renders bounded message and hidden command stays unadvertised", async () => {
  const previewText = renderOperatorDigestPreview(
    { events: [], schedule: "weekly@mon 09:00", windowStartedAtMs: Date.parse("2026-11-10T09:00:00Z") },
    { nowMs: Date.parse("2026-11-15T12:00:00Z") },
  );
  assert.ok(previewText.includes("Pending events: 0 \\(0 groups\\)"));
  assert.match(previewText, /No pending events in the current digest window/);

  const handlers = makeBotRecorder(makeConfig(), undefined);
  const opEmpty = makeCtx({ userId: 42, text: "/digest_preview" });
  await handlers.get("digest_preview")(opEmpty.ctx);
  assert.equal(opEmpty.replies.length, 1);
  assert.match(opEmpty.replies[0].body, /No pending events in the current digest window/);

  assert.equal(COMMANDS.some((c) => c.command === "digest_preview"), false);
  assert.equal(
    visibleCommandMetadata(makeConfig()).some((c) => c.command === "digest_preview"),
    false,
  );
});
