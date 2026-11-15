import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPoller } from "../dist/poller.js";
import {
  canonicalRpcEndpointKey,
  EndpointCircuitBreaker,
  EndpointCircuitBreakerRegistry,
  RpcCircuitOpenError,
  wrapRpcServerWithCircuitBreaker,
} from "../dist/stellar/client.js";

const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SQUAD_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF4";

test("EndpointCircuitBreaker opens after threshold, blocks during cooldown, and admits exactly one half-open probe", () => {
  let clock = 10_000;
  const breaker = new EndpointCircuitBreaker("https://rpc-primary.example.org/soroban/", {
    failureThreshold: 2,
    cooldownMs: 5_000,
    probeTimeoutMs: 1_500,
    now: () => clock,
  });

  // Two consecutive failures open the circuit
  const t1 = breaker.acquire();
  assert.equal(t1.allowed, true);
  assert.equal(t1.probe, false);
  t1.complete(false);
  assert.equal(breaker.snapshot().state, "closed");

  const t2 = breaker.acquire();
  assert.equal(t2.allowed, true);
  t2.complete(false);
  assert.equal(breaker.snapshot().state, "open");

  // During cooldown, requests are rejected immediately
  clock = 12_000;
  const blocked = breaker.acquire();
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.state, "open");
  assert.equal(blocked.reason, "cooldown-active");
  assert.equal(blocked.remainingMs, 3_000);

  // At cooldown expiry, FIRST caller gets the single half-open recovery probe
  clock = 15_000;
  const probeTicket = breaker.acquire();
  assert.equal(probeTicket.allowed, true);
  assert.equal(probeTicket.state, "half-open");
  assert.equal(probeTicket.probe, true);
  assert.equal(breaker.snapshot().probeInFlight, true);

  // Concurrent callers while the probe is in flight are rejected so recovering RPC never gets full load!
  const concurrent1 = breaker.acquire();
  const concurrent2 = breaker.acquire();
  assert.equal(concurrent1.allowed, false);
  assert.equal(concurrent1.state, "half-open");
  assert.equal(concurrent1.reason, "half-open-probe-in-flight");
  assert.equal(concurrent2.allowed, false);
  assert.equal(concurrent2.reason, "half-open-probe-in-flight");

  // Probe succeeds -> closes breaker and allows full load again
  probeTicket.complete(true);
  const snapClosed = breaker.snapshot();
  assert.equal(snapClosed.state, "closed");
  assert.equal(snapClosed.failureCount, 0);
  assert.equal(snapClosed.openedAt, null);
  assert.equal(snapClosed.probeInFlight, false);

  const postRecovery1 = breaker.acquire();
  const postRecovery2 = breaker.acquire();
  assert.equal(postRecovery1.allowed, true);
  assert.equal(postRecovery2.allowed, true);
});

test("EndpointCircuitBreaker immediately re-opens cooldown when half-open probe fails", () => {
  let clock = 50_000;
  const breaker = new EndpointCircuitBreaker("https://rpc.example.org", {
    failureThreshold: 3,
    cooldownMs: 4_000,
    probeTimeoutMs: 1_000,
    now: () => clock,
  });

  for (let i = 0; i < 3; i++) {
    const t = breaker.acquire();
    assert.equal(t.allowed, true);
    t.complete(false);
  }
  assert.equal(breaker.snapshot().state, "open");

  // Advance past cooldown -> half-open probe fails -> immediately re-opens after 1 failure (not 3!)
  clock = 54_000;
  const probe = breaker.acquire();
  assert.equal(probe.allowed, true);
  assert.equal(probe.probe, true);

  clock = 54_200;
  probe.complete(false);

  const snapReopened = breaker.snapshot();
  assert.equal(snapReopened.state, "open");
  assert.equal(snapReopened.openedAt, 54_200);
  assert.equal(snapReopened.failureCount, 4);

  clock = 56_000;
  const duringNewCooldown = breaker.acquire();
  assert.equal(duringNewCooldown.allowed, false);
  assert.equal(duringNewCooldown.reason, "cooldown-active");
});

test("EndpointCircuitBreaker bounds wedged half-open probe via probeTimeoutMs and ignores late completion", async () => {
  let clock = 1_000;
  const breaker = new EndpointCircuitBreaker("https://rpc.example.org", {
    failureThreshold: 1,
    cooldownMs: 500,
    probeTimeoutMs: 40,
    now: () => clock,
  });

  await assert.rejects(() =>
    breaker.execute(async () => {
      throw new Error("initial outage");
    }),
  );
  assert.equal(breaker.snapshot().state, "open");

  // Advance past cooldown and launch a probe that never resolves
  clock = 1_600;
  let resolveHung;
  const hungPromise = breaker.execute(
    () =>
      new Promise((resolve) => {
        resolveHung = resolve;
      }),
  );

  // Concurrent call during the hung probe is rejected immediately with RpcCircuitOpenError
  await assert.rejects(
    () => breaker.execute(async () => "should-not-run"),
    (err) =>
      err instanceof RpcCircuitOpenError &&
      err.state === "half-open" &&
      err.reason === "half-open-probe-in-flight",
  );

  clock = 1_650;
  await assert.rejects(hungPromise, /timed out after 40ms/);
  assert.equal(breaker.snapshot().state, "open");

  // Resolving the stale hung promise late must NOT close the re-opened breaker
  resolveHung("late-ok");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(breaker.snapshot().state, "open");
});

test("EndpointCircuitBreakerRegistry isolates distinct endpoints and normalizes credential/query URLs", () => {
  const userPart = ["op", "pw"].join(":");
  const qPart = ["api_key", "val123"].join("=");
  const key = canonicalRpcEndpointKey(
    `https://${userPart}@RPC-One.Example.org/v1/?${qPart}#sec`,
  );
  assert.equal(key, "https://rpc-one.example.org/v1");

  let clock = 10_000;
  const registry = new EndpointCircuitBreakerRegistry({
    failureThreshold: 1,
    cooldownMs: 5_000,
    maxEndpoints: 2,
    now: () => clock,
  });

  const b1 = registry.forEndpoint("https://rpc-one.example.org/v1/");
  const t1 = b1.acquire();
  assert.equal(t1.allowed, true);
  t1.complete(false);
  assert.equal(b1.snapshot().state, "open");

  // Same canonical endpoint with query string shares the open breaker
  assert.equal(
    registry.forEndpoint(`https://rpc-one.example.org/v1?${qPart}`).snapshot().state,
    "open",
  );

  // Secondary endpoint remains completely unaffected and closed
  const b2 = registry.forEndpoint("https://rpc-two.example.org/v1");
  assert.equal(b2.snapshot().state, "closed");
  assert.equal(b2.acquire().allowed, true);

  // Registry evicts oldest endpoint once maxEndpoints is exceeded
  registry.forEndpoint("https://rpc-three.example.org/v1");
  assert.equal(registry.snapshots().length, 2);
});

test("wrapRpcServerWithCircuitBreaker caps half-open getEvents probe limit and blocks concurrent load", async () => {
  let clock = 0;
  let seenLimits = [];
  let fail = true;
  let releaseProbe;

  const rawServer = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 100, latestLedger: 200 };
    },
    async getEvents(req) {
      seenLimits.push(req.limit);
      if (fail) {
        throw new Error("503 Service Unavailable");
      }
      await new Promise((resolve) => {
        releaseProbe = resolve;
      });
      return { events: [], cursor: "200-0", latestLedger: 200 };
    },
  };

  const guarded = wrapRpcServerWithCircuitBreaker(rawServer, "https://rpc.example.org", {
    failureThreshold: 1,
    cooldownMs: 1_000,
    halfOpenEventsLimit: 5,
    now: () => clock,
  });

  await assert.rejects(() => guarded.getEvents({ filters: [], startLedger: 150, limit: 200 }));
  assert.equal(guarded.breaker.snapshot().state, "open");

  // Advance past cooldown and start half-open recovery probe
  fail = false;
  clock = 1_500;
  const probeCall = guarded.getEvents({ filters: [], startLedger: 150, limit: 200 });

  // Second target hitting same guarded server while probe is in flight is blocked!
  await assert.rejects(
    () => guarded.getEvents({ filters: [], startLedger: 150, limit: 200 }),
    (err) =>
      err instanceof RpcCircuitOpenError &&
      err.reason === "half-open-probe-in-flight",
  );

  releaseProbe();
  await probeCall;

  // Half-open probe capped limit from 200 down to halfOpenEventsLimit=5
  assert.deepEqual(seenLimits, [200, 5]);
  assert.equal(guarded.breaker.snapshot().state, "closed");
});

test("poller sends only one single-target probe after cooldown and immediately re-opens on probe failure", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "poller-half-open-"));
  const cursorFile = path.join(dir, "cursor.json");

  let currentTime = 100_000;
  let getEventsCalls = 0;

  const server = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 1000, latestLedger: 2000 };
    },
    async getEvents() {
      getEventsCalls += 1;
      throw new Error("RPC still degraded");
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
    targetBackoffOptions: { initialBackoffMs: 100, maxBackoffMs: 500 },
    circuitBreakerOptions: { failureThreshold: 2, cooldownMs: 5_000, probeTimeoutMs: 1_000 },
  });

  try {
    await poller.start();
    await new Promise((r) => setTimeout(r, 25));

    // Cycle 1: market + squad both failed -> 2 failures -> circuit breaker opened
    assert.equal(getEventsCalls, 2);
    assert.equal(poller.status().circuitBreaker.open, true);

    // Advance past cooldown (5_000ms) while RPC is still failing
    currentTime = 106_000;
    poller.pause();
    poller.resume();
    await new Promise((r) => setTimeout(r, 25));

    // Half-open recovery cycle MUST only probe ONE target (getEventsCalls goes 2 -> 3, NOT 4!)
    // and immediately re-open the circuit breaker for a fresh cooldown!
    assert.equal(getEventsCalls, 3);
    assert.equal(poller.status().circuitBreaker.open, true);
    assert.equal(poller.status().circuitBreaker.openedAt, 106_000);
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
