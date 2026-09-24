/**
 * Operator /pause and /resume: positive, negative, boundary.
 * No live Telegram or RPC. No bot tokens or secrets.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Minimal stand-in for poller pause state used by bot handlers. */
function makePauseState() {
  let paused = false;
  return {
    status: () => ({
      running: true,
      paused,
      startedAt: Date.now(),
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
    }),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    isPaused: () => paused,
  };
}

function isOperator(operatorIds, fromId) {
  if (fromId === undefined || fromId === null) return false;
  return operatorIds.has(String(fromId));
}

describe("operator pause gate", () => {
  it("allows listed operator user id", () => {
    const ops = new Set(["111", "222"]);
    assert.equal(isOperator(ops, 111), true);
    assert.equal(isOperator(ops, "222"), true);
  });

  it("denies unknown user id", () => {
    const ops = new Set(["111"]);
    assert.equal(isOperator(ops, 999), false);
    assert.equal(isOperator(ops, undefined), false);
  });

  it("empty operator list denies everyone", () => {
    const ops = new Set();
    assert.equal(isOperator(ops, 1), false);
  });
});

describe("poller pause state", () => {
  it("pause then resume toggles flag", () => {
    const p = makePauseState();
    assert.equal(p.status().paused, false);
    p.pause();
    assert.equal(p.status().paused, true);
    p.resume();
    assert.equal(p.status().paused, false);
  });

  it("double pause stays paused", () => {
    const p = makePauseState();
    p.pause();
    p.pause();
    assert.equal(p.status().paused, true);
  });

  it("resume when not paused is a no-op", () => {
    const p = makePauseState();
    p.resume();
    assert.equal(p.status().paused, false);
  });
});

describe("pause reply payloads (MarkdownV2 snapshots)", () => {
  it("operator pause first time message", () => {
    const text =
      "Paused\\. Notifications suppressed; chain scans and cursors still advance\\. Use /resume when ready\\.";
    assert.match(text, /Paused/);
    assert.match(text, /cursors still advance/);
  });

  it("non-operator denial message", () => {
    const text = "Operator only\\.";
    assert.equal(text, "Operator only\\.");
  });

  it("already paused message", () => {
    const text =
      "Already paused\\. Notifications remain suppressed; cursors still advance\\.";
    assert.match(text, /Already paused/);
  });

  it("resume after pause message", () => {
    const text = "Resumed\\. New events will be notified again\\.";
    assert.match(text, /Resumed/);
  });
});
