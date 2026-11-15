import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";

import {
  ConfigError,
  DEFAULT_HEALTH_SHUTDOWN_GRACE_MS,
  loadConfig,
} from "../dist/config.js";
import { startHealthServer } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";

const REQUIRED_ENV = {
  MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  BOT_TOKEN: "123456789:" + "TEST-ONLY-TOKEN-NEVER-USE-PADDED-TO-35",
  TELEGRAM_CHAT_ID: "-1001234567890",
};

function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, REQUIRED_ENV, overrides);
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: REQUIRED_ENV.MARKET_CONTRACT_ID,
    squadContractId: REQUIRED_ENV.SQUAD_CONTRACT_ID,
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
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthShutdownGraceMs: DEFAULT_HEALTH_SHUTDOWN_GRACE_MS,
    healthAuthToken: null,
    ...overrides,
  };
}

function baseStatus() {
  return {
    running: true,
    paused: false,
    startedAt: 1_000,
    cycles: 2,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    chainClockAt: 5_000,
    notificationsSent: 1,
    notificationsFailed: 0,
    eventsSkipped: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: REQUIRED_ENV.MARKET_CONTRACT_ID,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
      },
    ],
  };
}

test("HEALTH_SHUTDOWN_GRACE_MS defaults to 2000ms and validates integer >= 0", () => {
  assert.equal(DEFAULT_HEALTH_SHUTDOWN_GRACE_MS, 2_000);
  assert.equal(withEnv({}, () => loadConfig()).healthShutdownGraceMs, 2_000);
  assert.equal(
    withEnv({ HEALTH_SHUTDOWN_GRACE_MS: "150" }, () => loadConfig()).healthShutdownGraceMs,
    150,
  );
  assert.equal(
    withEnv({ HEALTH_SHUTDOWN_GRACE_MS: "0" }, () => loadConfig()).healthShutdownGraceMs,
    0,
  );

  for (const invalid of ["-1", "12.5", "forever"]) {
    assert.throws(
      () => withEnv({ HEALTH_SHUTDOWN_GRACE_MS: invalid }, () => loadConfig()),
      ConfigError,
    );
  }
});

test("startHealthServer closes a stalled partial-request fake client after the grace period", async () => {
  const port = await freePort();
  const server = startHealthServer({
    config: baseConfig({ healthPort: port, healthShutdownGraceMs: 80 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  // Fake local client opens TCP connection and sends incomplete HTTP headers,
  // stalling indefinitely without terminating the header block.
  const stalledClient = net.createConnection({ host: "127.0.0.1", port: server.port });
  stalledClient.on("error", () => {});
  await once(stalledClient, "connect");
  stalledClient.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  // Give the server loop a turn to register the socket and partial bytes.
  await new Promise((resolve) => setTimeout(resolve, 25));

  const clientClosed = once(stalledClient, "close");
  const startedAt = Date.now();
  await server.close();
  const elapsedMs = Date.now() - startedAt;

  await clientClosed;
  assert.equal(stalledClient.destroyed, true);
  assert.ok(elapsedMs >= 50, `expected grace wait before forced close, got ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_500, `expected bounded shutdown duration, got ${elapsedMs}ms`);

  // Repeated close() calls are idempotent and never reject.
  await server.close();
});

test("startHealthServer graceMs=0 destroys stalled clients immediately during shutdown", async () => {
  const port = await freePort();
  const server = startHealthServer({
    config: baseConfig({ healthPort: port, healthShutdownGraceMs: 5_000 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const stalledClient = net.createConnection({ host: "127.0.0.1", port: server.port });
  stalledClient.on("error", () => {});
  await once(stalledClient, "connect");
  stalledClient.write("GET /health/live HTTP/1.1\r\n");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const clientClosed = once(stalledClient, "close");
  const startedAt = Date.now();
  await server.close({ graceMs: 0 });
  const elapsedMs = Date.now() - startedAt;

  await clientClosed;
  assert.ok(elapsedMs < 500, `expected immediate shutdown with graceMs=0, got ${elapsedMs}ms`);
});

test("startHealthServer closes idle keep-alive clients immediately without waiting out grace period", async () => {
  const port = await freePort();
  const server = startHealthServer({
    config: baseConfig({ healthPort: port, healthShutdownGraceMs: 4_000 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const res = await fetch(`${server.url}/health`);
  assert.equal(res.status, 200);
  await res.json();

  const startedAt = Date.now();
  await server.close();
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1_000, `idle keep-alive client should not delay close, got ${elapsedMs}ms`);
});

test("metrics HTTP server also bounds stalled client duration during shutdown", async () => {
  const metrics = createMetrics();
  const server = await metrics.startServer(0, "127.0.0.1", { shutdownGraceMs: 75 });

  const stalledClient = net.createConnection({ host: "127.0.0.1", port: server.port });
  stalledClient.on("error", () => {});
  await once(stalledClient, "connect");
  stalledClient.write("GET /metrics HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const clientClosed = once(stalledClient, "close");
  const startedAt = Date.now();
  await server.close();
  const elapsedMs = Date.now() - startedAt;

  await clientClosed;
  assert.ok(elapsedMs < 1_500, `expected bounded metrics server close, got ${elapsedMs}ms`);
});
