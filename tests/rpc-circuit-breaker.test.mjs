import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller } from "../dist/poller.js";
import { normalizeRpcEndpoint } from "../dist/stellar/client.js";
import {
  DEFAULT_CIRCUIT_COOLDOWN_MS,
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  DEFAULT_HALF_OPEN_MAX_PROBES,
  RpcCircuitBreaker,
} from "../dist/stellar/rpc-guard.js";

const MARKET_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SQUAD_CONTRACT = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2Y6U";
const CURSOR_1999 = "0000008585639624704-0000000000";

function testConfig(cursorFile, rpcUrl = "https://rpc-a.example.invalid/soroban") {
  return {
    botToken: "0000000000:TEST-TOKEN-DO-NOT-USE",
    chatId: "-1001234567890",
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl,
    horizonUrl: "https://horizon.example.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    cursorFile,
    pollIntervalMs: 60_000,
    startLookbackLedgers: 100,
    maxNotificationsPerCycle: 20,
    sendSpacingMs: 0,
    initialBackoffMs: 1,
    sendTimeoutMs: 50,
  };
}

// ── normalizeRpcEndpoint ──────────────────────────────────────────────────────

test("normalizeRpcEndpoint strips credentials, query, fragment, and trailing slashes", () => {
  assert.equal(
    normalizeRpcEndpoint("https://user:secret@RPC.Example.Invalid:8443/soroban///?key=123#frag"),
    "https://rpc.example.invalid:8443/soroban",
  );
  assert.equal(normalizeRpcEndpoint("  "), "default");
});

// ── RpcCircuitBreaker unit tests ──────────────────────────────────────────────

test("RpcCircuitBreaker isolates state per endpoint", () => {
  let clock = 1_000;
  const breaker = new RpcCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 5_000,
    now: () => clock,
  });

  const epA = "https://rpc-a.example.invalid/";
  const epB = "https://rpc-b.example.invalid/";

  breaker.recordFailure(epA);
  breaker.recordFailure(epA);

  const decA = breaker.allowRequest(epA);
  const decB = breaker.allowRequest(epB);

  assert.equal(decA.allowed, false);
  assert.equal(decA.state, "open");
  assert.equal(decA.remainingCooldownMs, 5_000);

  assert.equal(decB.allowed, true);
  assert.equal(decB.state, "closed");
  assert.equal(decB.isProbe, false);
});

test("RpcCircuitBreaker admits exactly one bounded half-open probe after cooldown", () => {
  let clock = 10_000;
  const breaker = new RpcCircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 1_000,
    maxHalfOpenProbes: 1,
    now: () => clock,
  });

  const ep = "https://rpc-a.example.invalid";
  breaker.recordFailure(ep, 2);
  assert.equal(breaker.snapshot(ep).state, "open");

  // Before cooldown elapses: rejected
  clock += 999;
  const before = breaker.allowRequest(ep);
  assert.equal(before.allowed, false);
  assert.equal(before.state, "open");
  assert.equal(before.remainingCooldownMs, 1);

  // At cooldown boundary: first request enters half-open as a bounded probe
  clock += 1;
  const firstProbe = breaker.allowRequest(ep);
  assert.equal(firstProbe.allowed, true);
  assert.equal(firstProbe.state, "half-open");
  assert.equal(firstProbe.isProbe, true);
  assert.equal(breaker.snapshot(ep).probesInFlight, 1);

  // Concurrent/second request while probe is in flight: rejected
  const secondReq = breaker.allowRequest(ep);
  assert.equal(secondReq.allowed, false);
  assert.equal(secondReq.state, "half-open");
  assert.equal(secondReq.isProbe, false);
});

test("RpcCircuitBreaker closes on half-open probe success and re-opens immediately on failure", () => {
  let clock = 1_000;
  const breaker = new RpcCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 500,
    now: () => clock,
  });

  const ep = "https://rpc-a.example.invalid";
  breaker.recordFailure(ep, 3);
  assert.equal(breaker.snapshot(ep).open, true);

  // Advance past cooldown -> half-open probe fails -> immediately re-opens
  clock += 500;
  assert.equal(breaker.allowRequest(ep).isProbe, true);
  const afterFail = breaker.recordFailure(ep, 1);
  assert.equal(afterFail.state, "open");
  assert.equal(afterFail.open, true);
  assert.equal(afterFail.openedAt, clock);
  assert.equal(afterFail.probesInFlight, 0);

  // Still blocked during fresh cooldown
  clock += 400;
  assert.equal(breaker.allowRequest(ep).allowed, false);

  // Advance past fresh cooldown -> half-open probe succeeds -> closes circuit
  clock += 100;
  assert.equal(breaker.allowRequest(ep).isProbe, true);
  const afterSuccess = breaker.recordSuccess(ep);
  assert.equal(afterSuccess.state, "closed");
  assert.equal(afterSuccess.open, false);
  assert.equal(afterSuccess.failureCount, 0);
  assert.equal(afterSuccess.openedAt, null);
  assert.equal(afterSuccess.probesInFlight, 0);
});

test("RpcCircuitBreaker releaseProbe frees slot when no RPC was sent", () => {
  let clock = 1_000;
  const breaker = new RpcCircuitBreaker({
    failureThreshold: 1,
    cooldownMs: 100,
    now: () => clock,
  });

  const ep = "https://rpc-a.example.invalid";
  breaker.recordFailure(ep, 1);
  clock += 100;

  assert.equal(breaker.allowRequest(ep).isProbe, true);
  assert.equal(breaker.allowRequest(ep).allowed, false);

  breaker.releaseProbe(ep);
  assert.equal(breaker.snapshot(ep).probesInFlight, 0);
  assert.equal(breaker.allowRequest(ep).isProbe, true);
});

test("RpcCircuitBreaker exposes expected default constants", () => {
  assert.equal(DEFAULT_CIRCUIT_FAILURE_THRESHOLD, 5);
  assert.equal(DEFAULT_CIRCUIT_COOLDOWN_MS, 60_000);
  assert.equal(DEFAULT_HALF_OPEN_MAX_PROBES, 1);
});

// ── Poller integration: bounded half-open recovery probe ──────────────────────

test("poller sends only one bounded recovery probe after cooldown instead of full poller load", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poller-half-open-"));
  const cursorFile = path.join(dir, "cursor.json");
  let clock = 100_000;
  const config = testConfig(cursorFile, "https://rpc-recover.example.invalid/soroban");

  let shouldFail = true;
  const callsPerCycle = [];
  let currentCycleCalls = 0;

  const server = {
    getHealth: async () => ({ oldestLedger: 1000, latestLedger: 2000 }),
    getEvents: async () => {
      currentCycleCalls += 1;
      if (shouldFail) {
        throw new Error("RPC unavailable");
      }
      return { events: [], latestLedger: 2000, cursor: CURSOR_1999 };
    },
  };

  const poller = createPoller({
    config,
    server,
    send: async () => {},
    now: () => clock,
    sleep: async () => {},
    targetBackoffOptions: { initialBackoffMs: 0, maxBackoffMs: 0 },
    circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 10_000, maxHalfOpenProbes: 1 },
  });

  try {
    // Cycle 1: both targets fail (2 failures -> circuit opens)
    currentCycleCalls = 0;
    await poller.pollOnce();
    callsPerCycle.push(currentCycleCalls);
    assert.equal(currentCycleCalls, 2, "full cycle scans both targets before circuit opens");
    assert.equal(poller.status().circuitBreaker.state, "open");
    assert.equal(poller.status().circuitBreaker.open, true);

    // Cycle 2: within cooldown -> 0 RPC calls
    clock += 5_000;
    currentCycleCalls = 0;
    await poller.pollOnce();
    assert.equal(currentCycleCalls, 0, "open circuit skips all RPC calls during cooldown");

    // Cycle 3: cooldown elapsed, endpoint still failing -> ONLY 1 bounded probe, then immediately re-opens
    clock += 5_000;
    currentCycleCalls = 0;
    await poller.pollOnce();
    assert.equal(currentCycleCalls, 1, "failed half-open probe must not hit remaining targets");
    assert.equal(poller.status().circuitBreaker.state, "open");
    assert.equal(poller.status().circuitBreaker.open, true);

    // Cycle 4: cooldown elapsed again, endpoint recovers -> ONLY 1 bounded probe in recovery cycle
    shouldFail = false;
    clock += 10_000;
    currentCycleCalls = 0;
    await poller.pollOnce();
    assert.equal(currentCycleCalls, 1, "recovering endpoint receives only 1 bounded probe, not full load");
    assert.equal(poller.status().circuitBreaker.state, "closed");
    assert.equal(poller.status().circuitBreaker.open, false);
    assert.equal(poller.status().circuitBreaker.failureCount, 0);

    // Cycle 5: circuit is closed -> full poller load (both targets, unbounded pages) resumes
    clock += 1_000;
    currentCycleCalls = 0;
    await poller.pollOnce();
    assert.ok(currentCycleCalls >= 2, `closed circuit resumes full multi-target polling (got ${currentCycleCalls} calls)`);
    assert.equal(poller.status().targets.every((t) => t.cursor === CURSOR_1999), true, "both targets scanned once closed");
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
