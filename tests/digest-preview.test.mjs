/**
 * Focused automated coverage for operator digest preview of the current pending
 * window:
 *   - Renders via the live `formatDigest` builder (flat & grouped)
 *   - Non-consuming: repeated previews leave `DeferredQueue` / pending buffer intact
 *   - Preserves period completeness metadata (`rpc_gap`, `restart`) and schedule `nextRun`
 *   - Boundary cases: empty complete window, empty incomplete window, missing `digestWindow`
 *   - Operator authorization: protected by existing `operatorOnly` / `operatorAllowed` gate
 *   - Read-only: never calls channel `sendMessage`
 */

import assert from "node:assert/strict";
import test from "node:test";

import { previewPendingDigest } from "../dist/notifications/digest-preview.js";
import { formatDigest } from "../dist/notifications/format.js";
import { DeferredQueue } from "../dist/notifications/quiet-hours.js";
import { nextRun, parseSchedule } from "../dist/notifications/schedule.js";
import {
  digestPreviewCommand,
  DIGEST_PREVIEW_UNAVAILABLE,
} from "../dist/commands/digest-preview.js";
import { operatorAllowed, TELEGRAM_OPTIONS } from "../dist/commands/runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextEventId = 1;

function makeEvent(overrides = {}) {
  const id = nextEventId++;
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 2000 + id,
    txHash: "",
    at: 1700000000 + id,
    eventId: `evt-${id}`,
    eventType: "contract",
    transactionIndex: id,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 10,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
    ...overrides,
  };
}

function makeConfig(operatorTelegramUserId = "42") {
  return {
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId,
  };
}

function makeCtx({ text = "/digestpreview", fromId = 42, updateId = 1 } = {}) {
  const replies = [];
  const sendCalls = [];
  return {
    replies,
    sendCalls,
    ctx: {
      from: { id: fromId },
      chat: { id: 12345, type: "private" },
      message: { text },
      match: text.includes(" ") ? text.slice(text.indexOf(" ") + 1) : "",
      update: { update_id: updateId },
      reply: async (...args) => {
        replies.push(args);
        return {};
      },
      api: {
        sendMessage: async (...args) => {
          sendCalls.push(args);
          return {};
        },
      },
    },
  };
}

function baseDeps(overrides = {}) {
  return {
    config: makeConfig(),
    status: () => ({ running: true }),
    pause: () => "paused",
    resume: () => "resumed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// previewPendingDigest: live builder + non-consuming behavior
// ---------------------------------------------------------------------------

test("previewPendingDigest renders using the live formatDigest builder without consuming DeferredQueue", () => {
  const queue = new DeferredQueue({ maxSize: 10 });
  const e1 = makeEvent({
    ledger: 3001,
    payload: {
      name: "claim_created",
      claimId: 7,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const e2 = makeEvent({
    ledger: 3002,
    payload: {
      name: "claim_challenged",
      claimId: 7,
      challenger: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      stake: 10_000_000n,
    },
  });
  queue.enqueue(e1);
  queue.enqueue(e2);

  const expectedLiveDigest = formatDigest([e1, e2]);
  const first = previewPendingDigest(queue);
  const second = previewPendingDigest(queue);

  assert.equal(first.pendingCount, 2);
  assert.equal(first.digest, expectedLiveDigest);
  assert.equal(second.digest, first.digest);
  assert.equal(second.message, first.message);
  assert.ok(first.message.includes("Digest Preview"));
  assert.ok(first.message.includes(expectedLiveDigest));

  // Events must NOT have been consumed by either preview.
  assert.equal(queue.size, 2);
  assert.equal(queue.peek().length, 2);

  // A subsequent live flush still receives all pending events.
  const flushed = queue.flushDigest();
  assert.equal(flushed, expectedLiveDigest);
  assert.equal(queue.size, 0);
});

test("previewPendingDigest supports grouped mode, completeness metadata, and next scheduled run", () => {
  const e1 = makeEvent({
    ledger: 4001,
    payload: {
      name: "claim_created",
      claimId: 42,
      category: "sports",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const e2 = makeEvent({
    ledger: 4002,
    payload: {
      name: "claim_challenged",
      claimId: 42,
      challenger: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      stake: 5_000_000n,
    },
  });

  const schedule = parseSchedule("daily@09:00");
  const nowMs = Date.UTC(2026, 10, 21, 8, 15, 0);
  const scheduledAt = nextRun(schedule, nowMs);

  const window = {
    peek: () => [e1, e2],
    completeness: () => ({ complete: false, reasons: ["rpc_gap"] }),
    formatOptions: { grouped: true },
    nextRunAtMs: () => scheduledAt,
  };

  const result = previewPendingDigest(window);
  const expectedDigest = formatDigest([e1, e2], {
    grouped: true,
    completeness: { complete: false, reasons: ["rpc_gap"] },
  });

  assert.equal(result.pendingCount, 2);
  assert.deepEqual(result.completeness, { complete: false, reasons: ["rpc_gap"] });
  assert.equal(result.nextRunAtMs, scheduledAt);
  assert.equal(result.digest, expectedDigest);
  assert.ok(result.message.includes("2026\\-11\\-21T09:00:00\\.000Z"));
  assert.ok(result.message.includes("Incomplete period \\(RPC gap\\)"));
  assert.ok(result.message.includes("market:42"));
});

test("previewPendingDigest boundary cases: empty complete window vs empty incomplete window", () => {
  const emptyComplete = previewPendingDigest({ peek: () => [] });
  assert.equal(emptyComplete.pendingCount, 0);
  assert.equal(emptyComplete.digest, null);
  assert.deepEqual(emptyComplete.completeness, { complete: true, reasons: [] });
  assert.ok(emptyComplete.message.includes("No pending events in the current digest window"));

  const emptyIncomplete = previewPendingDigest({
    peek: () => [],
    completeness: () => ({ complete: false, reasons: ["restart"] }),
  });
  assert.equal(emptyIncomplete.pendingCount, 0);
  assert.ok(emptyIncomplete.digest !== null);
  assert.ok(emptyIncomplete.digest.includes("Incomplete period \\(restart\\)"));
  assert.ok(emptyIncomplete.message.includes("0 observed events, partial"));
});

// ---------------------------------------------------------------------------
// /digestpreview command metadata, handler & operator authorization
// ---------------------------------------------------------------------------

test("digestPreviewCommand is marked operatorOnly and hidden", () => {
  assert.equal(digestPreviewCommand.command, "digestpreview");
  assert.equal(digestPreviewCommand.operatorOnly, true);
  assert.equal(digestPreviewCommand.hidden, true);
});

test("/digestpreview replies with live digest preview without consuming events or sending channel notifications", async () => {
  const queue = new DeferredQueue({ maxSize: 10 });
  const e1 = makeEvent({ ledger: 5001 });
  const e2 = makeEvent({ ledger: 5002 });
  queue.enqueue(e1);
  queue.enqueue(e2);

  const { ctx, replies, sendCalls } = makeCtx({
    text: "/digestpreview grouped",
    fromId: 42,
  });
  const deps = baseDeps({ digestWindow: queue });

  await digestPreviewCommand.handler(ctx, deps);

  assert.equal(sendCalls.length, 0, "must never call bot.api.sendMessage");
  assert.equal(replies.length, 1, "must reply once to the operator");
  assert.deepEqual(replies[0][1], TELEGRAM_OPTIONS);
  assert.ok(replies[0][0].includes(formatDigest([e1, e2], { grouped: true })));
  assert.equal(queue.size, 2, "pending queue must remain unconsumed");
});

test("/digestpreview reports unavailable when no digestWindow is configured", async () => {
  const { ctx, replies } = makeCtx({ text: "/digestpreview", fromId: 42 });
  await digestPreviewCommand.handler(ctx, baseDeps());

  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], DIGEST_PREVIEW_UNAVAILABLE);
  assert.deepEqual(replies[0][1], TELEGRAM_OPTIONS);
});

test("operator authorization gate blocks non-operators and disabled operator config without peeking", async () => {
  let peekCalls = 0;
  const window = {
    peek: () => {
      peekCalls += 1;
      return [makeEvent({ ledger: 6001 })];
    },
  };

  // Simulate central dispatch from src/bot.ts: check operatorAllowed before handler.
  const dispatchDigestPreview = async (ctx, deps) => {
    if (
      digestPreviewCommand.operatorOnly === true &&
      !operatorAllowed(ctx, deps.config, digestPreviewCommand.command)
    ) {
      return;
    }
    await digestPreviewCommand.handler(ctx, deps);
  };

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    // 1. Non-operator user id -> silently ignored, peek never called.
    const stranger = makeCtx({ fromId: 99, updateId: 10 });
    await dispatchDigestPreview(stranger.ctx, baseDeps({ digestWindow: window }));
    assert.deepEqual(stranger.replies, []);
    assert.equal(peekCalls, 0);

    // 2. Operator controls disabled (operatorTelegramUserId: null) -> silently ignored even for id 42.
    const disabled = makeCtx({ fromId: 42, updateId: 11 });
    await dispatchDigestPreview(
      disabled.ctx,
      baseDeps({ config: makeConfig(null), digestWindow: window }),
    );
    assert.deepEqual(disabled.replies, []);
    assert.equal(peekCalls, 0);

    // 3. Configured operator -> allowed and receives preview.
    const operator = makeCtx({ fromId: 42, updateId: 12 });
    await dispatchDigestPreview(operator.ctx, baseDeps({ digestWindow: window }));
    assert.equal(operator.replies.length, 1);
    assert.equal(peekCalls, 1);
  } finally {
    console.warn = originalWarn;
  }
});
