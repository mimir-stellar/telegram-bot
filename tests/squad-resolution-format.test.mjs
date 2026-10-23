/**
 * Squad `resolved` rendering (issue #334): both pool totals, the winning side,
 * and the gross payout per 1 USDC staked, identical in MarkdownV2 and plain
 * text.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeMd,
  formatEvent,
  formatPlainTextEvent,
} from "../dist/notifications/format.js";
import {
  formatSquadResolution,
  payoutPerUsdcUnits,
  renderSquadResolution,
} from "../dist/notifications/squad-resolution.js";
import { ES_MESSAGES, NOTIFICATION_MD, NOTIFICATION_PLAIN } from "../dist/i18n.js";
import { squadEvent } from "./helpers/events.mjs";

const config = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  marketContractId: "CMARKET",
  squadContractId: "CSQUAD",
};

const USDC = 10_000_000n;

function resolvedPayload(overrides = {}) {
  return { name: "resolved", marketId: 7, result: 1, poolA: 30n * USDC, poolB: 15n * USDC, ...overrides };
}

function resolvedEvent(overrides = {}) {
  return squadEvent("resolved", { payload: resolvedPayload(overrides), txHash: "" });
}

/** Strip MarkdownV2 escapes and emphasis so the two renderings can be compared. */
function unMarkdown(text) {
  return text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1").replace(/\*/g, "");
}

/** Every decimal number in a message, in order. */
function numbers(text) {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

test("side A win: both pools, winner and gross payout per 1 USDC", () => {
  const r = formatSquadResolution(resolvedPayload());
  assert.deepEqual(r, {
    marketId: "7",
    result: "Side A",
    poolA: "30.0000000 USDC",
    poolB: "15.0000000 USDC",
    payoutPerUsdc: "1.5000000 USDC",
    emptyWinningPool: false,
  });

  const md = formatEvent(config, resolvedEvent());
  assert.match(md, /🏁 \*Squad \\#7 resolved\* — \*Side A\*/);
  assert.match(md, /Pools: A 30\\\.0000000 USDC · B 15\\\.0000000 USDC/);
  assert.match(md, /Payout: 1\\\.5000000 USDC per 1 USDC staked \\\(gross\\\)/);

  const plain = formatPlainTextEvent(config, resolvedEvent());
  assert.match(plain, /Squad #7 resolved — Side A/);
  assert.match(plain, /Pools: A 30\.0000000 USDC · B 15\.0000000 USDC/);
  assert.match(plain, /Payout: 1\.5000000 USDC per 1 USDC staked \(gross\)/);
});

test("side B win: ratio uses pool B as the denominator", () => {
  const r = formatSquadResolution(resolvedPayload({ result: 2 }));
  assert.equal(r.result, "Side B");
  assert.equal(r.payoutPerUsdc, "3.0000000 USDC");

  const md = formatEvent(config, resolvedEvent({ result: 2 }));
  assert.match(md, /\*Side B\*/);
  assert.match(md, /Payout: 3\\\.0000000 USDC per 1 USDC staked/);
  const plain = formatPlainTextEvent(config, resolvedEvent({ result: 2 }));
  assert.match(plain, /Payout: 3\.0000000 USDC per 1 USDC staked \(gross\)/);
});

test("payout is bigint fixed-point and rounds down, never through a float", () => {
  // 10 / 3 = 3.3333333… -> truncated at 7 decimals.
  const r = formatSquadResolution(resolvedPayload({ poolA: 3n, poolB: 7n }));
  assert.equal(r.payoutPerUsdc, "3.3333333 USDC");

  // Amounts far beyond Number.MAX_SAFE_INTEGER stay exact.
  const huge = 123_456_789_012_345_678_901_234_567n;
  const big = formatSquadResolution(resolvedPayload({ poolA: huge, poolB: huge }));
  assert.equal(big.payoutPerUsdc, "2.0000000 USDC");
  assert.equal(big.poolA, "12345678901234567890.1234567 USDC");

  assert.equal(payoutPerUsdcUnits(4n * USDC, 10n * USDC), 25_000_000n);
  assert.equal(payoutPerUsdcUnits(0n, 10n * USDC), null);
  assert.equal(payoutPerUsdcUnits(-1n, 10n * USDC), null);
});

test("cancelled result shows both pools but no payout ratio", () => {
  const r = formatSquadResolution(resolvedPayload({ result: 3 }));
  assert.equal(r.result, "cancelled");
  assert.equal(r.payoutPerUsdc, null);
  assert.equal(r.emptyWinningPool, false);

  const md = formatEvent(config, resolvedEvent({ result: 3 }));
  const plain = formatPlainTextEvent(config, resolvedEvent({ result: 3 }));
  for (const text of [md, plain]) {
    assert.match(text, /cancelled/);
    assert.match(text, /Pools: A 30\\?\.0000000 USDC · B 15\\?\.0000000 USDC/);
    assert.doesNotMatch(text, /Payout/);
  }
});

test("pending or unknown result shows no payout ratio", () => {
  for (const result of [0, 9]) {
    const r = formatSquadResolution(resolvedPayload({ result }));
    assert.equal(r.payoutPerUsdc, null);
    assert.equal(r.emptyWinningPool, false);
    assert.doesNotMatch(formatPlainTextEvent(config, resolvedEvent({ result })), /Payout/);
  }
});

test("empty winning pool is reported without dividing by zero", () => {
  const r = formatSquadResolution(resolvedPayload({ result: 1, poolA: 0n, poolB: 15n * USDC }));
  assert.equal(r.payoutPerUsdc, null);
  assert.equal(r.emptyWinningPool, true);

  const md = formatEvent(config, resolvedEvent({ result: 1, poolA: 0n }));
  assert.match(md, /Pools: A 0\\\.0000000 USDC/);
  assert.match(md, /Payout: none — no stake on Side A/);
  assert.doesNotMatch(md, /malformed|fallback/i);

  const plain = formatPlainTextEvent(config, resolvedEvent({ result: 2, poolA: 0n, poolB: 0n }));
  assert.match(plain, /Pools: A 0\.0000000 USDC · B 0\.0000000 USDC/);
  assert.match(plain, /Payout: none — no stake on Side B/);
});

test("MarkdownV2 and plain text carry the same numbers", () => {
  const cases = [
    { result: 1 },
    { result: 2 },
    { result: 3 },
    { result: 1, poolA: 0n },
    { result: 2, poolA: 3n, poolB: 7n },
  ];
  for (const overrides of cases) {
    const event = resolvedEvent(overrides);
    const md = formatEvent(config, event);
    const plain = formatPlainTextEvent(config, event);
    const mdHead = unMarkdown(md.split("\n").slice(0, -1).join("\n")).replace(/^🏁 /, "");
    const plainHead = plain.split("\n").slice(0, -1).join("\n");
    assert.equal(mdHead, plainHead, JSON.stringify(overrides, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
    assert.deepEqual(numbers(md.replace(/\\/g, "")), numbers(plain));
  }
});

test("every MarkdownV2 reserved character in dynamic values is escaped", () => {
  const md = renderSquadResolution(
    {
      marketId: "1",
      result: "Side_A (x)!",
      poolA: "1.0 USDC",
      poolB: "2.0 USDC",
      payoutPerUsdc: null,
      emptyWinningPool: true,
    },
    NOTIFICATION_MD,
    escapeMd,
  );
  assert.match(md, /\*Side\\_A \\\(x\\\)\\!\*/);
  assert.match(md, /no stake on Side\\_A \\\(x\\\)\\!/);
  // No unescaped reserved character outside the template's own `*` emphasis.
  const stripped = md.replace(/\\./g, "").replace(/\*/g, "");
  assert.doesNotMatch(stripped, /[_[\]()~`>#+\-=|{}.!\\]/);

  const plain = renderSquadResolution(formatSquadResolution(resolvedPayload()), NOTIFICATION_PLAIN);
  assert.doesNotMatch(plain, /\\/);
});

test("Spanish locale renders the payout line with the same numbers", () => {
  const es = { ...config, locale: "es" };
  const md = formatEvent(es, resolvedEvent());
  assert.match(md, /Pago: 1\\\.5000000 USDC por cada 1 USDC apostado \\\(bruto\\\)/);
  const plain = formatPlainTextEvent(es, resolvedEvent({ poolA: 0n }));
  assert.match(plain, /Pago: ninguno — nadie apostó en Side A/);
  assert.equal(typeof ES_MESSAGES.notificationPlain.resolvedPayout, "function");
});
