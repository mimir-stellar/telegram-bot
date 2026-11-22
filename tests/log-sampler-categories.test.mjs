/**
 * Focused tests for issue #886: distinguish sampled repeats from suppressed
 * error categories in logs, and prevent reset boundaries from reporting
 * negative counts.
 *
 * Before this change:
 *  - `LogSample` had no `kind` field — a windowed repeat and a category
 *    suppression were indistinguishable to the caller.
 *  - There was no `recordCategory` / `clearCategory` API.
 *  - The carried count at a window reset used `current?.suppressed ?? 0`
 *    without a `Math.max(0, ...)` guard.
 *  - There was no `formatSuppressedCategory` helper.
 *
 * After this change:
 *  - `record()` always returns `kind: "repeat"`.
 *  - `recordCategory()` / `clearCategory()` manage a category-suppression
 *    state independently and always return `kind: "category"`.
 *  - `formatSuppressedCategory()` renders a distinct human-readable suffix.
 *  - The carried count is guarded with `Math.max(0, ...)`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSuppressedCategory,
  formatSuppressedRepeats,
  LogSampler,
} from "../dist/log-sampler.js";

function clock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

// ── kind field on record() ────────────────────────────────────────────────────

test("record() always returns kind: repeat", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 2, windowMs: 1_000, now: time.now });

  const first = sampler.record("k");
  assert.equal(first.kind, "repeat");
  assert.equal(first.log, true);
  assert.equal(first.suppressed, 0);

  const second = sampler.record("k");
  assert.equal(second.kind, "repeat");
  assert.equal(second.log, true);

  // This one is suppressed — still kind: repeat.
  const third = sampler.record("k");
  assert.equal(third.kind, "repeat");
  assert.equal(third.log, false);
  assert.equal(third.suppressed, 0);

  // Window rolls: carried suppressed count, still kind: repeat.
  time.advance(1_000);
  const rollover = sampler.record("k");
  assert.equal(rollover.kind, "repeat");
  assert.equal(rollover.log, true);
  assert.equal(rollover.suppressed, 1);
});

// ── recordCategory() first occurrence ────────────────────────────────────────

test("recordCategory() logs the first occurrence and marks the category active", () => {
  const sampler = new LogSampler();

  const first = sampler.recordCategory("flag:market_disabled");
  assert.equal(first.log, true);
  assert.equal(first.suppressed, 0);
  assert.equal(first.kind, "category");
});

// ── recordCategory() subsequent occurrences ───────────────────────────────────

test("recordCategory() suppresses subsequent occurrences in the same active period", () => {
  const sampler = new LogSampler();
  sampler.recordCategory("flag:market_disabled");

  const second = sampler.recordCategory("flag:market_disabled");
  assert.equal(second.log, false);
  assert.equal(second.kind, "category");

  const third = sampler.recordCategory("flag:market_disabled");
  assert.equal(third.log, false);
  assert.equal(third.suppressed, 0);

  assert.equal(sampler.pendingCategory("flag:market_disabled"), 2);
  assert.equal(sampler.suppressedTotal(), 2);
});

// ── clearCategory() re-enables logging ───────────────────────────────────────

test("clearCategory() lets the next recordCategory() log and carry suppressed count", () => {
  const sampler = new LogSampler();
  sampler.recordCategory("flag:market_disabled");
  sampler.recordCategory("flag:market_disabled"); // suppressed
  sampler.recordCategory("flag:market_disabled"); // suppressed
  assert.equal(sampler.pendingCategory("flag:market_disabled"), 2);

  sampler.clearCategory("flag:market_disabled");
  assert.equal(sampler.pendingCategory("flag:market_disabled"), 2, "clear does not reset pending");

  // Re-activation: logs, carries the 2 suppressed occurrences, then resets.
  const reactivated = sampler.recordCategory("flag:market_disabled");
  assert.equal(reactivated.log, true);
  assert.equal(reactivated.suppressed, 2);
  assert.equal(reactivated.kind, "category");
  assert.equal(sampler.pendingCategory("flag:market_disabled"), 0);

  // Now active again: next call is suppressed.
  const next = sampler.recordCategory("flag:market_disabled");
  assert.equal(next.log, false);
  assert.equal(next.kind, "category");
});

// ── clearCategory() on unknown key is a no-op ─────────────────────────────────

test("clearCategory() on an unknown key is a no-op", () => {
  const sampler = new LogSampler();
  assert.doesNotThrow(() => sampler.clearCategory("does-not-exist"));
  assert.equal(sampler.pendingCategory("does-not-exist"), 0);
});

// ── categories and repeats are independent ────────────────────────────────────

test("category and repeat keys are tracked independently and do not cross-contaminate", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 1, windowMs: 1_000, now: time.now });

  // Repeat key: first OK, then suppressed.
  assert.equal(sampler.record("scan:market").log, true);
  assert.equal(sampler.record("scan:market").log, false);

  // Category key: first OK, then suppressed.
  assert.equal(sampler.recordCategory("flag:squad_disabled").log, true);
  assert.equal(sampler.recordCategory("flag:squad_disabled").log, false);

  // The repeat suppression must not affect category pending and vice versa.
  assert.equal(sampler.pending("scan:market"), 1);
  assert.equal(sampler.pendingCategory("flag:squad_disabled"), 1);
  assert.equal(sampler.suppressedTotal(), 2);

  // Rolling the repeat window does not affect the category.
  time.advance(1_000);
  const rolled = sampler.record("scan:market");
  assert.equal(rolled.log, true);
  assert.equal(rolled.suppressed, 1);
  assert.equal(rolled.kind, "repeat");
  assert.equal(sampler.pendingCategory("flag:squad_disabled"), 1, "category unaffected by repeat rollover");
});

// ── suppressedTotal counts both kinds ─────────────────────────────────────────

test("suppressedTotal counts suppressed repeats and suppressed categories together", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 1, windowMs: 1_000, now: time.now });

  sampler.record("scan:market");        // log — not counted
  sampler.record("scan:market");        // suppressed repeat — counted
  sampler.record("scan:market");        // suppressed repeat — counted

  sampler.recordCategory("flag:a");     // log — not counted
  sampler.recordCategory("flag:a");     // suppressed category — counted

  assert.equal(sampler.suppressedTotal(), 3);
});

// ── negative-count guard at window reset ──────────────────────────────────────

test("carried count at window reset is always >= 0, never negative", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 3, windowMs: 1_000, now: time.now });

  // Open a first window and log some lines (no suppression yet).
  sampler.record("k"); // window opens, emitted=1
  sampler.record("k"); // emitted=2
  sampler.record("k"); // emitted=3

  // Roll into a fresh window without any suppressed entries in the old one.
  time.advance(1_000);
  const rolloverClean = sampler.record("k");
  assert.equal(rolloverClean.log, true);
  assert.equal(rolloverClean.suppressed, 0, "no negative carry when window had no suppressions");
  assert.ok(rolloverClean.suppressed >= 0, "suppressed count must never be negative");
});

test("carried count is non-negative even after a window with exactly 0 suppressions", () => {
  const time = clock();
  const sampler = new LogSampler({ maxPerWindow: 10, windowMs: 500, now: time.now });

  // Record fewer than maxPerWindow so suppressed stays 0.
  sampler.record("k");
  sampler.record("k");

  time.advance(500);
  const result = sampler.record("k");
  assert.equal(result.suppressed, 0);
  assert.ok(result.suppressed >= 0);
});

// ── formatSuppressedCategory helper ──────────────────────────────────────────

test("formatSuppressedCategory renders nothing for 0, singular for 1, plural for many", () => {
  assert.equal(formatSuppressedCategory(0), "");
  assert.equal(
    formatSuppressedCategory(1),
    " (1 occurrence of this error category suppressed since it was last seen)",
  );
  assert.equal(
    formatSuppressedCategory(5),
    " (5 occurrences of this error category suppressed since it was last seen)",
  );
});

// ── formatSuppressedRepeats is unchanged ──────────────────────────────────────

test("formatSuppressedRepeats is not affected by the new category API", () => {
  assert.equal(formatSuppressedRepeats(0, 300_000), "");
  assert.equal(
    formatSuppressedRepeats(3, 300_000),
    " (suppressed 3 identical repeats in the previous 300s)",
  );
});

// ── distinct log messages ─────────────────────────────────────────────────────

test("the two format helpers produce clearly distinct messages", () => {
  const repeatMsg = formatSuppressedRepeats(4, 60_000);
  const categoryMsg = formatSuppressedCategory(4);

  assert.notEqual(repeatMsg, categoryMsg, "repeat and category suffixes must differ");
  assert.match(repeatMsg, /identical repeat/);
  assert.match(categoryMsg, /error category/);
});

// ── pendingCategory for unknown key ──────────────────────────────────────────

test("pendingCategory returns 0 for an unknown key", () => {
  const sampler = new LogSampler();
  assert.equal(sampler.pendingCategory("never-seen"), 0);
});

// ── re-activation without prior suppression ───────────────────────────────────

test("re-activating a just-cleared category with 0 pending carries suppressed=0", () => {
  const sampler = new LogSampler();
  sampler.recordCategory("x");  // first log
  sampler.clearCategory("x");   // clear immediately — no suppressions yet

  const reactivated = sampler.recordCategory("x");
  assert.equal(reactivated.log, true);
  assert.equal(reactivated.suppressed, 0);
  assert.equal(reactivated.kind, "category");
});
