import test from "node:test";
import assert from "node:assert";
import {
  displayUsdc,
  displayUsdcMarkdownV2,
  escapeMarkdownV2,
} from "../dist/notifications/amount-display.js";

const UNIT = 10n ** 7n; // 1 USDC in 7-decimal units

test("displayUsdc: zero", () => {
  assert.strictEqual(displayUsdc("0"), "0");
  assert.strictEqual(displayUsdc(0n), "0");
  assert.strictEqual(displayUsdc("0", { minDecimals: 2 }), "0.00");
});

test("displayUsdc: whole amounts get thousands separators", () => {
  // 12,345.5 USDC = 123,455,000,000 units
  assert.strictEqual(displayUsdc(123455000000n.toString()), "12,345.5");
  assert.strictEqual(displayUsdc(1000n * UNIT), "1,000");
  assert.strictEqual(displayUsdc(100000n * UNIT), "100,000");
});

test("displayUsdc: trailing zeros trimmed", () => {
  // 12.3450000 -> 12.345 (the default maxDecimals of 2 would cap it at 12.34)
  assert.strictEqual(displayUsdc("123450000", { maxDecimals: 7 }), "12.345");
  // 12.3000000 -> 12.3
  assert.strictEqual(displayUsdc("123000000"), "12.3");
  // 12.0000000 -> 12
  assert.strictEqual(displayUsdc("120000000"), "12");
});

test("displayUsdc: minDecimals preserved", () => {
  // 12.0000000 -> 12.00
  assert.strictEqual(displayUsdc("120000000", { minDecimals: 2 }), "12.00");
  // 12.3450000 -> 12.345: minDecimals only pads, it never trims real digits
  assert.strictEqual(displayUsdc("123450000", { minDecimals: 2, maxDecimals: 7 }), "12.345");
});

test("displayUsdc: maxDecimals caps fraction", () => {
  // 12.3456789 -> 12.34
  assert.strictEqual(displayUsdc("123456789", { maxDecimals: 2 }), "12.34");
  // 12.3456789 -> 12.3456789
  assert.strictEqual(displayUsdc("123456789", { maxDecimals: 7 }), "12.3456789");
});

test("displayUsdc: sub-cent amounts", () => {
  // 0.0000001 USD0 -> 0.0000001 with maxDecimals 7
  assert.strictEqual(displayUsdc("1", { maxDecimals: 7 }), "0.0000001");
  // 0.0000001 -> 0 with default maxDecimals 2
  assert.strictEqual(displayUsdc("1"), "0");
  // 0.01 -> 0.01
  assert.strictEqual(displayUsdc("100000"), "0.01");
  // 0.1 -> 0.1
  assert.strictEqual(displayUsdc("1000000"), "0.1");
});

test("displayUsdc: large amounts beyond 2^63", () => {
  // 2 ** 63 + 1 = 9223372036854775809 units -> 922337203685.4775809 USDC
  const big = (1n << 63n) + 1n;
  const out = displayUsdc(big, { maxDecimals: 7 });
  assert.strictEqual(out, "922,337,203,685.4775809");
  // 2 ** 64 USDC, far past any number's safe integer range
  assert.strictEqual(displayUsdc((1n << 64n) * UNIT), "18,446,744,073,709,551,616");
});

test("displayUsdc: negative amounts", () => {
  // -12.3450000 -> -12.34 at the default maxDecimals of 2
  assert.strictEqual(displayUsdc("-123450000"), "-12.34");
  assert.strictEqual(displayUsdc("-123450000", { maxDecimals: 7 }), "-12.345");
  assert.strictEqual(displayUsdc(-1000n * UNIT), "-1,000");
});

test("displayUsdc: validates options", () => {
  assert.throws(() => displayUsdc("0", { minDecimals: 3, maxDecimals: 2 }));
  assert.throws(() => displayUsdc("0", { maxDecimals: 8 }));
  assert.throws(() => displayUsdc("0", { minDecimals: -1 }));
});

test("displayUsdc: rejects invalid input", () => {
  assert.throws(() => displayUsdc("abc"));
  assert.throws(() => displayUsdc(""));
  assert.throws(() => displayUsdc("1.5"));
  assert.throws(() => displayUsdc(Number.NaN));
});

test("escapeMarkdownV2: escapes reserved characters", () => {
  assert.strictEqual(escapeMarkdownV2("12.345"), "12\\.345");
  assert.strictEqual(escapeMarkdownV2("1,000"), "1,000");
  assert.strictEqual(escapeMarkdownV2("-12.3"), "\\-12\\.3");
  assert.strictEqual(
    escapeMarkdownV2("_*[]()~`>#+-=|{}.!"),
    "\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!",
  );
});

test("displayUsdcMarkdownV2: combines formatting and escaping", () => {
  assert.strictEqual(displayUsdcMarkdownV2("123450000", { maxDecimals: 7 }), "12\\.345");
  assert.strictEqual(displayUsdcMarkdownV2(1000n * UNIT), "1,000");
  assert.strictEqual(displayUsdcMarkdownV2("-123450000", { maxDecimals: 7 }), "\\-12\\.345");
});
