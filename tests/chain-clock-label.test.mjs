import test from "node:test";
import assert from "node:assert";
import { chainClockLabel } from "../dist/health.js";

// Pins the wording /status and /health have used since #288 (see
// tests/chain-clock.test.mjs): the label names which clock is ahead, reads
// "in sync" under one second, and rounds hours (2h30m -> 3h).

const NOW = Date.parse("2024-01-01T00:00:00Z");

test("chainClockLabel returns exact label for null", () => {
  assert.strictEqual(chainClockLabel(null, NOW), "unknown");
});

test("chainClockLabel returns exact label for undefined", () => {
  assert.strictEqual(chainClockLabel(undefined, NOW), "unknown");
});

test("chainClockLabel returns exact label for zero skew", () => {
  assert.strictEqual(chainClockLabel(NOW, NOW), "in sync");
});

test("chainClockLabel returns exact label for small positive skew", () => {
  assert.strictEqual(chainClockLabel(NOW - 5_000, NOW), "local clock 5.0s ahead of chain");
});

test("chainClockLabel returns exact label for small negative skew", () => {
  assert.strictEqual(chainClockLabel(NOW + 5_000, NOW), "chain clock 5.0s ahead of local");
});

test("chainClockLabel returns exact label for multi-hour positive skew", () => {
  const twoAndHalf = (2 * 60 + 30) * 60 * 1000;
  assert.strictEqual(chainClockLabel(NOW - twoAndHalf, NOW), "local clock 3h ahead of chain");
});

test("chainClockLabel returns exact label for multi-hour negative skew", () => {
  const twoAndHalf = (2 * 60 + 30) * 60 * 1000;
  assert.strictEqual(chainClockLabel(NOW + twoAndHalf, NOW), "chain clock 3h ahead of local");
});
