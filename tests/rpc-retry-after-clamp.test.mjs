import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller, extractRetryAfterMs } from "../dist/poller.js";
import {
  clampRpcRetryAfterMs,
  DEFAULT_RPC_MAX_BACKOFF_MS,
  evaluateRpcRetryAfter,
  MAX_RPC_RETRY_HEADER_CHARS,
  resolveRpcRetryDelayMs,
  RpcRetryConfigError,
} from "../dist/stellar/client.js";

const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SQUAD_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF4";

test("evaluateRpcRetryAfter accepts valid delta-seconds and future HTTP-date within maxBackoffMs", () => {
  const secResult = evaluateRpcRetryAfter(
    { headers: { "Retry-After": "15" } },
    { maxBackoffMs: 60_000 },
  );
  assert.deepEqual(secResult, {
    accepted: true,
    clamped: false,
    rawDelayMs: 15_000,
    delayMs: 15_000,
    rejectedReason: null,
  });

  const fixedNow = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  const dateResult = evaluateRpcRetryAfter(
    {
      response: {
        headers: new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:12 GMT" }),
      },
    },
    { maxBackoffMs: 60_000, nowMs: fixedNow },
  );
  assert.deepEqual(dateResult, {
    accepted: true,
    clamped: false,
    rawDelayMs: 12_000,
    delayMs: 12_000,
    rejectedReason: null,
  });
});

test("evaluateRpcRetryAfter clamps oversized delays so configured maxBackoffMs stays authoritative", () => {
  const largeDelta = evaluateRpcRetryAfter(
    { response: { headers: { "Retry-After": "3600" } } },
    { maxBackoffMs: 15_000 },
  );
  assert.equal(largeDelta.accepted, true);
  assert.equal(largeDelta.clamped, true);
  assert.equal(largeDelta.rawDelayMs, 3_600_000);
  assert.equal(largeDelta.delayMs, 15_000);

  const fixedNow = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  const distantDate = evaluateRpcRetryAfter(
    "Thu, 22 Oct 2026 07:28:00 GMT",
    { maxBackoffMs: 25_000, nowMs: fixedNow },
  );
  assert.equal(distantDate.accepted, true);
  assert.equal(distantDate.clamped, true);
  assert.equal(distantDate.delayMs, 25_000);

  assert.equal(
    clampRpcRetryAfterMs({ headers: { "retry-after": "7200" } }),
    DEFAULT_RPC_MAX_BACKOFF_MS,
  );
});

test("evaluateRpcRetryAfter rejects negative, zero, nonfinite, malformed, and overflowing values", () => {
  const fixedNow = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");

  const negativeCases = [
    -1,
    -0.5,
    "-5",
    "-0.25",
    "Wed, 21 Oct 2026 07:27:55 GMT",
  ];
  for (const input of negativeCases) {
    const res = evaluateRpcRetryAfter(input, { maxBackoffMs: 60_000, nowMs: fixedNow });
    assert.equal(res.accepted, false);
    assert.equal(res.delayMs, null);
    assert.equal(res.rejectedReason, "negative");
  }

  const zeroCases = [0, "0", "0.0", "Wed, 21 Oct 2026 07:28:00 GMT"];
  for (const input of zeroCases) {
    const res = evaluateRpcRetryAfter(input, { maxBackoffMs: 60_000, nowMs: fixedNow });
    assert.equal(res.accepted, false);
    assert.equal(res.delayMs, null);
    assert.equal(res.rejectedReason, "non-positive");
  }

  const nonFiniteCases = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "NaN",
    "Infinity",
    "+Infinity",
    "-Infinity",
  ];
  for (const input of nonFiniteCases) {
    const res = evaluateRpcRetryAfter(input, { maxBackoffMs: 60_000, nowMs: fixedNow });
    assert.equal(res.accepted, false);
    assert.equal(res.delayMs, null);
    assert.equal(res.rejectedReason, "non-finite");
  }

  const malformedCases = [
    "",
    "   ",
    "10abc",
    "1e5",
    "+10",
    "0x10",
    "2099-01-01",
    ["5", "10"],
    true,
  ];
  for (const input of malformedCases) {
    const res = evaluateRpcRetryAfter(input, { maxBackoffMs: 60_000, nowMs: fixedNow });
    assert.equal(res.accepted, false);
    assert.equal(res.delayMs, null);
    assert.equal(res.rejectedReason, "malformed");
  }

  const oversizedHeader = "9".repeat(MAX_RPC_RETRY_HEADER_CHARS + 1);
  assert.equal(
    evaluateRpcRetryAfter(oversizedHeader, { maxBackoffMs: 60_000 }).rejectedReason,
    "oversized",
  );

  const safeIntegerOverflow = "99999999999999999999";
  assert.equal(
    evaluateRpcRetryAfter(safeIntegerOverflow, { maxBackoffMs: 60_000 }).rejectedReason,
    "oversized",
  );

  const explicitRejectCap = evaluateRpcRetryAfter("3600", {
    maxBackoffMs: 60_000,
    rejectAboveMs: 300_000,
  });
  assert.equal(explicitRejectCap.accepted, false);
  assert.equal(explicitRejectCap.rejectedReason, "oversized");
  assert.equal(explicitRejectCap.delayMs, null);
});

test("resolveRpcRetryDelayMs keeps maxBackoffMs authoritative and prevents undercutting computed backoff", () => {
  // Valid header larger than computed backoff, smaller than maxBackoffMs -> uses header
  assert.equal(
    resolveRpcRetryDelayMs(
      { headers: { "Retry-After": "12" } },
      { computedBackoffMs: 4_000, maxBackoffMs: 30_000 },
    ),
    12_000,
  );

  // Oversized header -> clamped to maxBackoffMs
  assert.equal(
    resolveRpcRetryDelayMs(
      { headers: { "Retry-After": "9000" } },
      { computedBackoffMs: 4_000, maxBackoffMs: 30_000 },
    ),
    30_000,
  );

  // Hostile tiny Retry-After -> cannot shrink exponential computedBackoffMs
  assert.equal(
    resolveRpcRetryDelayMs(
      { headers: { "Retry-After": "1" } },
      { computedBackoffMs: 8_000, maxBackoffMs: 30_000 },
    ),
    8_000,
  );

  // Rejected header -> falls back to computedBackoffMs (still bounded by maxBackoffMs)
  assert.equal(
    resolveRpcRetryDelayMs(
      { headers: { "Retry-After": "-50" } },
      { computedBackoffMs: 6_000, maxBackoffMs: 30_000 },
    ),
    6_000,
  );
  assert.equal(
    resolveRpcRetryDelayMs(
      { headers: { "Retry-After": "garbage" } },
      { computedBackoffMs: 90_000, maxBackoffMs: 30_000 },
    ),
    30_000,
  );
});

test("evaluateRpcRetryAfter rejects invalid maxBackoffMs configuration", () => {
  for (const badMax of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => evaluateRpcRetryAfter("5", { maxBackoffMs: badMax }),
      (err) => err instanceof RpcRetryConfigError,
    );
  }
});

test("extractRetryAfterMs preserves Telegram parameters.retry_after while hardening untrusted headers", () => {
  assert.equal(extractRetryAfterMs({ parameters: { retry_after: 8 } }), 8_000);
  assert.equal(extractRetryAfterMs({ parameters: { retry_after: Number.POSITIVE_INFINITY } }), null);
  assert.equal(extractRetryAfterMs({ parameters: { retry_after: -3 } }), null);
  assert.equal(extractRetryAfterMs({ headers: { "retry-after": "10trailing" } }), null);
});

test("poller clamps untrusted RPC Retry-After headers to targetMaxBackoff and ignores invalid headers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rpc-retry-clamp-"));
  const cursorFile = path.join(dir, "cursor.json");

  let currentTime = 1_000_000;
  let nextHeaderValue = "7200";

  const server = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 1000, latestLedger: 2000 };
    },
    async getEvents() {
      const err = new Error("HTTP 429 Too Many Requests");
      err.response = { headers: { "Retry-After": nextHeaderValue } };
      throw err;
    },
  };

  const poller = createPoller({
    config: {
      botToken: "test-bot-placeholder",
      chatId: "-1001234567890",
      marketContractId: MARKET_ID,
      squadContractId: SQUAD_ID,
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      cursorFile,
      pollIntervalMs: 100_000,
      startLookbackLedgers: 60,
      maxNotificationsPerCycle: 10,
    },
    server,
    send: async () => {},
    now: () => currentTime,
    targetBackoffOptions: {
      initialBackoffMs: 2_000,
      maxBackoffMs: 12_000,
      backoffFactor: 2,
    },
    circuitBreakerOptions: { failureThreshold: 100 },
  });

  try {
    await poller.start();
    await new Promise((r) => setTimeout(r, 25));

    // Cycle 1: Retry-After: 7200s (7,200,000ms) is clamped to maxBackoffMs = 12,000ms!
    let market = poller.status().targets.find((t) => t.source === "market");
    assert.equal(market.nextEligibleAt, 1_000_000 + 12_000);

    // Cycle 2: Negative Retry-After is rejected -> falls back to exponential backoff (2000 * 2^1 = 4000ms)
    nextHeaderValue = "-999";
    currentTime = 1_020_000;
    poller.pause();
    poller.resume();
    await new Promise((r) => setTimeout(r, 25));

    market = poller.status().targets.find((t) => t.source === "market");
    assert.equal(market.nextEligibleAt, 1_020_000 + 4_000);
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
