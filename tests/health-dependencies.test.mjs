import assert from "node:assert/strict";
import test from "node:test";

import { buildHealthReport, startHealthServer } from "../dist/health.js";

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    ...overrides,
  };
}

/** A target with every field TargetState declares, fully populated. */
function target(source, overrides = {}) {
  return {
    source,
    contractId: source === "market" ? MARKET_ID : SQUAD_ID,
    version: "v1",
    lastCycleMs: 0,
    maxCycleMs: 0,
    cursor: "0018276211125911551-4294967295",
    lastEventLedger: 40,
    rewindFromLedger: null,
    cursorStale: false,
    gapLedgers: 0,
    cursorResetAt: null,
    cursorUnreadable: false,
    lastError: null,
    cyclesWithoutAdvance: 0,
    cursorStalled: false,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    chainClockAt: 5_000,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    eventsDeduplicated: 0,
    notificationsDropped: 0,
    cursorRewinds: 0,
    restartGaps: 0,
    lastRestartGap: null,
    consecutiveFailures: 0,
    suppressedLogs: 0,
    lastError: null,
    pendingFlush: false,
    lastFlushAt: null,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
    persistentVolumeAvailable: true,
    persistentVolumeError: null,
    targets: [target("market"), target("squad")],
    ...overrides,
  };
}

/** Short-hand: every dependency ready with a null reason. */
function allReady() {
  return {
    rpc: { ready: true, reason: null },
    cursor: { ready: true, reason: null },
    route: { ready: true, reason: null },
    delivery: { ready: true, reason: null },
  };
}

test("a healthy running poller reports all four dependencies ready", () => {
  const report = buildHealthReport(baseConfig(), baseStatus(), 5_500);
  assert.deepEqual(report.dependencies, allReady());
  assert.equal(report.ok, true);
  assert.equal(report.status, "ok");
});

test("rpc is not ready when consecutive failures exceed the budget", () => {
  // Default 30s interval -> budget = max(3, ceil(60000/30000)) = max(3, 2) = 3.
  const status = baseStatus({ consecutiveFailures: 4 });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.dependencies.rpc.ready, false);
  assert.equal(
    report.dependencies.rpc.reason,
    "consecutive failures (4) exceed budget (3)",
  );
  // The other dependencies are independent of RPC failures.
  assert.equal(report.dependencies.cursor.ready, true);
  assert.equal(report.dependencies.route.ready, true);
  assert.equal(report.dependencies.delivery.ready, true);
  // The overall status still degrades on the same RPC signal.
  assert.equal(report.status, "degraded");
});

test("rpc is not ready when the last successful poll is stale", () => {
  const status = baseStatus({ lastSuccessAt: 1_000 });
  const report = buildHealthReport(baseConfig({ healthStaleMs: 1_000 }), status, 5_000);

  assert.equal(report.dependencies.rpc.ready, false);
  assert.equal(
    report.dependencies.rpc.reason,
    "no successful poll within 1000 ms",
  );
  assert.equal(report.status, "degraded");
});

test("rpc is not ready when the circuit breaker is open", () => {
  const status = baseStatus({
    consecutiveFailures: 5,
    circuitBreaker: { open: true, openedAt: 4_000, failureCount: 5, lastFailureAt: 4_900 },
  });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.dependencies.rpc.ready, false);
  assert.equal(
    report.dependencies.rpc.reason,
    "circuit breaker open after 5 consecutive RPC failures",
  );
  assert.equal(report.status, "degraded");
});

test("cursor is not ready when one target has a stale cursor", () => {
  const status = baseStatus({
    targets: [target("market", { cursorStale: true }), target("squad")],
  });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.dependencies.cursor.ready, false);
  assert.equal(report.dependencies.cursor.reason, "stale cursor on market");
  assert.equal(report.dependencies.rpc.ready, true);
  assert.equal(report.status, "degraded");
});

test("cursor is not ready when one target has a stalled cursor", () => {
  const status = baseStatus({
    targets: [target("market"), target("squad", { cursorStalled: true })],
  });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.dependencies.cursor.ready, false);
  assert.equal(report.dependencies.cursor.reason, "stalled cursor on squad");
  assert.equal(report.status, "degraded");
});

test("cursor reason lists every affected source when several are failing", () => {
  const status = baseStatus({
    targets: [
      target("market", { cursorStale: true }),
      target("squad", { cursorStalled: true }),
    ],
  });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.dependencies.cursor.ready, false);
  assert.equal(
    report.dependencies.cursor.reason,
    "stale cursor on market; stalled cursor on squad",
  );
});

test("route is not ready when no destination is configured for a source", () => {
  // Degenerate config: no chat id at all, and no per-source override.
  const config = baseConfig({ chatIds: [], chatId: "" });
  const report = buildHealthReport(config, baseStatus(), 5_500);

  assert.equal(report.dependencies.route.ready, false);
  assert.equal(
    report.dependencies.route.reason,
    "no destination configured for market, squad",
  );
  // Route is config-derived and independent of poller state.
  assert.equal(report.dependencies.rpc.ready, true);
  assert.equal(report.status, "ok");
});

test("route is ready when a per-source destination overrides an empty default", () => {
  const config = baseConfig({
    chatIds: [],
    chatId: "",
    marketChatId: "-1001111111111",
    squadChatId: "-1002222222222",
  });
  const report = buildHealthReport(config, baseStatus(), 5_500);
  assert.deepEqual(report.dependencies.route, { ready: true, reason: null });
});

test("delivery is not ready when sends are parked in the dead-letter queue", () => {
  const status = baseStatus({
    deadLetter: { depth: 3, enqueued: 5, replayed: 2, dropped: 0 },
  });
  const report = buildHealthReport(baseConfig(), status, 5_500);

  assert.equal(report.dependencies.delivery.ready, false);
  assert.equal(
    report.dependencies.delivery.reason,
    "3 send(s) awaiting replay in the dead-letter queue",
  );
  // A delivery backlog does not change the overall status (it is additive).
  assert.equal(report.status, "ok");
});

test("a stopped poller makes rpc, cursor and delivery not ready, but not route", () => {
  const report = buildHealthReport(baseConfig(), baseStatus({ running: false }), 5_500);

  assert.equal(report.status, "stopped");
  assert.equal(report.dependencies.rpc.ready, false);
  assert.equal(report.dependencies.rpc.reason, "poller not running");
  assert.equal(report.dependencies.cursor.ready, false);
  assert.equal(report.dependencies.cursor.reason, "poller not running");
  assert.equal(report.dependencies.delivery.ready, false);
  assert.equal(report.dependencies.delivery.reason, "poller not running");
  // Route is config-derived and stays ready regardless of poller state.
  assert.deepEqual(report.dependencies.route, { ready: true, reason: null });
});

test("an operator pause suppresses rpc and cursor degradation", () => {
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1 }),
    baseStatus({
      paused: true,
      lastSuccessAt: 1_000,
      consecutiveFailures: 10,
      targets: baseStatus().targets.map((t) => ({ ...t, cursorStale: true })),
    }),
    5_000,
  );

  assert.equal(report.status, "ok");
  assert.deepEqual(report.dependencies.rpc, { ready: true, reason: null });
  assert.deepEqual(report.dependencies.cursor, { ready: true, reason: null });
});

test("a graceful drain suppresses rpc and cursor degradation but not a delivery backlog", () => {
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1 }),
    baseStatus({
      stopping: true,
      lastSuccessAt: 1_000,
      consecutiveFailures: 10,
      notificationsDropped: 3,
      deadLetter: { depth: 1, enqueued: 1, replayed: 0, dropped: 0 },
    }),
    5_500,
  );

  assert.equal(report.status, "ok");
  assert.deepEqual(report.dependencies.rpc, { ready: true, reason: null });
  assert.deepEqual(report.dependencies.cursor, { ready: true, reason: null });
  // The backlog is a persistent state, so it is reported during a drain.
  assert.equal(report.dependencies.delivery.ready, false);
  assert.equal(
    report.dependencies.delivery.reason,
    "1 send(s) awaiting replay in the dead-letter queue",
  );
});

test("a cold start (no successful poll yet) keeps rpc ready", () => {
  const report = buildHealthReport(
    baseConfig({ healthStaleMs: 1_000 }),
    baseStatus({ lastSuccessAt: null, lastPollAt: null, cycles: 0 }),
    5_000,
  );

  assert.equal(report.status, "ok");
  assert.deepEqual(report.dependencies.rpc, { ready: true, reason: null });
});

test("dependencies never leak credentials or private destination identifiers", () => {
  const config = baseConfig();
  // Force every private identifier into the config and the status.
  const status = baseStatus({
    deadLetter: { depth: 2, enqueued: 2, replayed: 0, dropped: 0 },
    targets: [target("market", { cursorStale: true }), target("squad")],
  });
  const report = buildHealthReport(config, status, 5_500);

  const blob = JSON.stringify(report.dependencies);
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes("SECRET-TOKEN"), false);
  for (const chatId of config.chatIds) {
    assert.equal(blob.includes(chatId), false);
  }
  // Reasons are built only from counts and public source names.
  assert.match(report.dependencies.delivery.reason, /^2 send\(s\) awaiting replay/);
  assert.match(report.dependencies.cursor.reason, /stale cursor on market/);
});

test("GET /health exposes the dependencies object over HTTP", async () => {
  const config = baseConfig({ healthPort: 18801 });
  const status = baseStatus({
    consecutiveFailures: 4,
    deadLetter: { depth: 1, enqueued: 1, replayed: 0, dropped: 0 },
  });
  const server = startHealthServer({
    config,
    status: () => status,
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.dependencies.rpc.ready, false);
    assert.match(body.dependencies.rpc.reason, /consecutive failures \(4\)/);
    assert.equal(body.dependencies.delivery.ready, false);
    assert.match(body.dependencies.delivery.reason, /1 send\(s\)/);
    assert.equal(body.dependencies.route.ready, true);
    assert.equal(body.dependencies.cursor.ready, true);

    // Nothing private reaches the wire.
    const text = JSON.stringify(body);
    assert.equal(text.includes(config.botToken), false);
    for (const chatId of config.chatIds) {
      assert.equal(text.includes(chatId), false);
    }
  } finally {
    await server.close();
  }
});
