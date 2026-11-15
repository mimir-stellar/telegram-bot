import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import test from "node:test";

import {
  buildDependencyReadiness,
  buildHealthReport,
  startHealthServer,
} from "../dist/health.js";
import { validate } from "./helpers/json-schema-lite.mjs";

const schema = JSON.parse(
  readFileSync(new URL("../docs/schemas/health-report.schema.json", import.meta.url), "utf8"),
);

const CANARY_BOT_CRED = ["0000000000:CANARY", "-BOT-CREDENTIAL-999"].join("");
const CANARY_RPC_URL = "https://soroban-private-node.internal.example/v1/api-canary-777";
const CANARY_HORIZON_URL = "https://horizon-private.internal.example/canary-888";
const CANARY_CHAT_DEFAULT = "-1009998887771";
const CANARY_CHAT_MARKET = "-1009998887772";
const CANARY_CHAT_SQUAD = "-1009998887773";
const CANARY_OPERATOR_ID = "98765432101";
const CANARY_WEBHOOK_URL = "https://webhook-canary.internal.example/hook";
const CANARY_HEALTH_BEARER = ["canary-health", "-bearer-555"].join("");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: CANARY_RPC_URL,
    horizonUrl: CANARY_HORIZON_URL,
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: CANARY_BOT_CRED,
    chatId: CANARY_CHAT_DEFAULT,
    chatIds: [CANARY_CHAT_DEFAULT],
    marketChatId: CANARY_CHAT_MARKET,
    squadChatId: CANARY_CHAT_SQUAD,
    allowedChatIds: [CANARY_CHAT_DEFAULT],
    operatorTelegramUserId: CANARY_OPERATOR_ID,
    telegramWebhookUrl: CANARY_WEBHOOK_URL,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/private-canary-dir/cursor.json",
    maxNotificationsPerCycle: 20,
    deadLetterFile: "/tmp/private-canary-dir/dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    featureFlags: { enabled: true, market: true, squad: true },
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
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    persistentVolumeAvailable: true,
    persistentVolumeError: null,
    circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
        cursorStale: false,
        cursorStalled: false,
        cyclesWithoutAdvance: 0,
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: "0018276211125911552-0",
        lastEventLedger: 41,
        lastError: null,
        cursorStale: false,
        cursorStalled: false,
        cyclesWithoutAdvance: 0,
      },
    ],
    ...overrides,
  };
}

test("readiness separates RPC, cursor, route, and delivery failures independently", () => {
  // 1. All healthy
  const healthy = buildDependencyReadiness(baseConfig(), baseStatus(), 5_500);
  assert.deepEqual(healthy, {
    rpc: { ready: true, status: "ready", reason: "ok" },
    cursor: { ready: true, status: "ready", reason: "ok" },
    route: { ready: true, status: "ready", reason: "ok" },
    delivery: { ready: true, status: "ready", reason: "ok" },
  });

  // 2. RPC degraded only (consecutive failures, poll stale, circuit open, cold start)
  const rpcFailures = buildDependencyReadiness(baseConfig(), baseStatus({ consecutiveFailures: 5 }), 5_500);
  assert.deepEqual(rpcFailures.rpc, { ready: false, status: "degraded", reason: "consecutive_failures" });
  assert.equal(rpcFailures.cursor.ready, true);
  assert.equal(rpcFailures.route.ready, true);
  assert.equal(rpcFailures.delivery.ready, true);

  const rpcStale = buildDependencyReadiness(
    baseConfig({ healthStaleMs: 1_000 }),
    baseStatus({ lastSuccessAt: 1_000 }),
    5_000,
  );
  assert.deepEqual(rpcStale.rpc, { ready: false, status: "degraded", reason: "poll_stale" });
  assert.equal(rpcStale.cursor.ready, true);

  const rpcCircuit = buildDependencyReadiness(
    baseConfig(),
    baseStatus({ circuitBreaker: { open: true, openedAt: 4_000, failureCount: 5, lastFailureAt: 4_000 } }),
    5_500,
  );
  assert.deepEqual(rpcCircuit.rpc, { ready: false, status: "degraded", reason: "circuit_open" });

  const rpcColdStart = buildDependencyReadiness(
    baseConfig(),
    baseStatus({ lastSuccessAt: null, cycles: 0 }),
    5_500,
  );
  assert.deepEqual(rpcColdStart.rpc, { ready: true, status: "ready", reason: "cold_start" });

  // 3. Cursor degraded only (stale cursor, stalled cursor, persistence unavailable) while RPC stays ready
  const cursorStale = buildDependencyReadiness(
    baseConfig(),
    baseStatus({
      targets: [
        { ...baseStatus().targets[0], cursorStale: true },
        baseStatus().targets[1],
      ],
    }),
    5_500,
  );
  assert.equal(cursorStale.rpc.ready, true);
  assert.deepEqual(cursorStale.cursor, { ready: false, status: "degraded", reason: "cursor_stale" });
  assert.equal(cursorStale.route.ready, true);
  assert.equal(cursorStale.delivery.ready, true);

  const cursorStalled = buildDependencyReadiness(
    baseConfig(),
    baseStatus({
      targets: [
        baseStatus().targets[0],
        { ...baseStatus().targets[1], cursorStalled: true, cyclesWithoutAdvance: 6 },
      ],
    }),
    5_500,
  );
  assert.deepEqual(cursorStalled.cursor, { ready: false, status: "degraded", reason: "cursor_stalled" });
  assert.equal(cursorStalled.rpc.ready, true);

  const cursorPersistence = buildDependencyReadiness(
    baseConfig(),
    baseStatus({ persistentVolumeAvailable: false, persistentVolumeError: "EACCES" }),
    5_500,
  );
  assert.deepEqual(cursorPersistence.cursor, {
    ready: false,
    status: "degraded",
    reason: "persistence_unavailable",
  });
  assert.equal(cursorPersistence.rpc.ready, true);

  // 4. Route readiness (missing destination, global mute, partial source disabled)
  const routeMissing = buildDependencyReadiness(
    baseConfig({ chatId: "", chatIds: [], marketChatId: "", squadChatId: "" }),
    baseStatus(),
    5_500,
  );
  assert.deepEqual(routeMissing.route, {
    ready: false,
    status: "degraded",
    reason: "missing_destination",
  });
  assert.equal(routeMissing.rpc.ready, true);
  assert.equal(routeMissing.cursor.ready, true);
  assert.equal(routeMissing.delivery.ready, true);

  const routeMuted = buildDependencyReadiness(
    baseConfig({
      chatId: "",
      chatIds: [],
      marketChatId: "",
      squadChatId: "",
      featureFlags: { enabled: false, market: true, squad: true },
    }),
    baseStatus(),
    5_500,
  );
  assert.deepEqual(routeMuted.route, {
    ready: true,
    status: "ready",
    reason: "notifications_disabled",
  });

  const routePartial = buildDependencyReadiness(
    baseConfig({
      chatId: "",
      chatIds: [],
      marketChatId: CANARY_CHAT_MARKET,
      squadChatId: "",
      featureFlags: { enabled: true, market: true, squad: false },
    }),
    baseStatus(),
    5_500,
  );
  assert.deepEqual(routePartial.route, {
    ready: true,
    status: "ready",
    reason: "partial_source_disabled",
  });

  // 5. Delivery readiness (dead-letter backlog, dead-letter dropped, send timeouts)
  const dlqBacklog = buildDependencyReadiness(
    baseConfig(),
    baseStatus({ deadLetter: { depth: 3, enqueued: 3, replayed: 0, dropped: 0 } }),
    5_500,
  );
  assert.deepEqual(dlqBacklog.delivery, {
    ready: false,
    status: "degraded",
    reason: "dead_letter_backlog",
  });
  assert.equal(dlqBacklog.rpc.ready, true);

  const dlqDropped = buildDependencyReadiness(
    baseConfig(),
    baseStatus({ deadLetter: { depth: 0, enqueued: 5, replayed: 4, dropped: 1 } }),
    5_500,
  );
  assert.deepEqual(dlqDropped.delivery, {
    ready: false,
    status: "degraded",
    reason: "dead_letter_dropped",
  });

  const sendTimeouts = buildDependencyReadiness(
    baseConfig(),
    baseStatus({ sendTimeouts: 2, lastSendTimeout: "chat -1009998887771 timed out" }),
    5_500,
  );
  assert.deepEqual(sendTimeouts.delivery, {
    ready: false,
    status: "degraded",
    reason: "send_timeouts",
  });

  // 6. Lifecycle states: paused, draining, stopped
  const paused = buildDependencyReadiness(baseConfig(), baseStatus({ paused: true }), 5_500);
  assert.deepEqual(paused.rpc, { ready: true, status: "ready", reason: "paused" });

  const draining = buildDependencyReadiness(baseConfig(), baseStatus({ stopping: true }), 5_500);
  assert.deepEqual(draining.rpc, { ready: true, status: "ready", reason: "draining" });
  assert.deepEqual(draining.delivery, { ready: true, status: "ready", reason: "draining" });

  const stopped = buildDependencyReadiness(baseConfig(), baseStatus({ running: false }), 5_500);
  assert.deepEqual(stopped.rpc, { ready: false, status: "stopped", reason: "stopped" });
  assert.deepEqual(stopped.cursor, { ready: false, status: "stopped", reason: "stopped" });
  assert.deepEqual(stopped.delivery, { ready: false, status: "stopped", reason: "stopped" });
});

test("GET /health serves schema-valid dependency readiness with zero credentials or destination IDs", async () => {
  const port = await getFreePort();
  const config = baseConfig({
    healthPort: port,
    healthAuthToken: CANARY_HEALTH_BEARER,
  });
  const status = baseStatus({
    consecutiveFailures: 6,
    persistentVolumeAvailable: false,
    deadLetter: { depth: 2, enqueued: 2, replayed: 0, dropped: 0 },
    sendTimeouts: 1,
    lastSendTimeout: `send to ${CANARY_CHAT_MARKET} timed out`,
  });

  const server = startHealthServer({
    config,
    status: () => status,
    now: () => 5_500,
  });

  try {
    const res = await fetch(`${server.url}/health`, {
      headers: { Authorization: `Bearer ${CANARY_HEALTH_BEARER}` },
    });
    assert.equal(res.status, 503);
    const rawText = await res.text();
    const report = JSON.parse(rawText);

    assert.deepEqual(validate(schema, report), []);
    assert.deepEqual(report.readiness, {
      rpc: { ready: false, status: "degraded", reason: "consecutive_failures" },
      cursor: { ready: false, status: "degraded", reason: "persistence_unavailable" },
      route: { ready: true, status: "ready", reason: "ok" },
      delivery: { ready: false, status: "degraded", reason: "dead_letter_backlog" },
    });

    // Strictly assert zero private configuration values or destination IDs anywhere in payload
    for (const secretOrPrivateValue of [
      CANARY_BOT_CRED,
      CANARY_RPC_URL,
      CANARY_HORIZON_URL,
      CANARY_CHAT_DEFAULT,
      CANARY_CHAT_MARKET,
      CANARY_CHAT_SQUAD,
      CANARY_OPERATOR_ID,
      CANARY_WEBHOOK_URL,
      CANARY_HEALTH_BEARER,
      "private-canary-dir",
    ]) {
      assert.equal(
        rawText.includes(secretOrPrivateValue),
        false,
        `GET /health must never expose private value: ${secretOrPrivateValue}`,
      );
    }

    // Also verify buildHealthReport directly when route is degraded
    const missingRouteReport = buildHealthReport(
      baseConfig({ chatId: "", chatIds: [], marketChatId: "", squadChatId: "" }),
      baseStatus(),
      5_500,
    );
    assert.deepEqual(validate(schema, JSON.parse(JSON.stringify(missingRouteReport))), []);
    assert.deepEqual(missingRouteReport.readiness.route, {
      ready: false,
      status: "degraded",
      reason: "missing_destination",
    });
  } finally {
    await server.close();
  }
});
