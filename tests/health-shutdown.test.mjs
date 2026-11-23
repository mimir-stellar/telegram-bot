/**
 * Operational HTTP server shutdown duration & stalled-client grace period tests.
 *
 * Verifies that operational HTTP endpoints (`src/health.ts` and `src/metrics.ts`)
 * bound shutdown duration when local fake TCP/HTTP clients stall mid-request or
 * hold persistent keep-alive connections open:
 *
 *  - Stalled clients sending partial headers without completing the request are
 *    terminated after the configured grace period (`HEALTH_SHUTDOWN_GRACE_MS` /
 *    `gracePeriodMs`).
 *  - `gracePeriodMs: 0` (or `healthShutdownGraceMs: 0`) terminates stalled
 *    sockets immediately without waiting.
 *  - Idle HTTP/1.1 keep-alive connections are closed immediately on shutdown
 *    without waiting for the grace period.
 *  - Repeated `close()` calls are idempotent and share the same shutdown promise.
 *  - `loadConfig()` validates `HEALTH_SHUTDOWN_GRACE_MS` (default 2000, >= 0,
 *    rejects negative / non-integer values).
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  ConfigError,
  DEFAULT_HEALTH_SHUTDOWN_GRACE_MS,
  loadConfig,
} from "../dist/config.js";
import { startHealthServer } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";

const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4";

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: VALID_CONTRACT_A,
    squadContractId: VALID_CONTRACT_B,
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
    healthShutdownGraceMs: 100,
    healthAuthToken: null,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
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
    targets: [
      {
        source: "market",
        contractId: VALID_CONTRACT_A,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function validBotEnv(overrides = {}) {
  return {
    BOT_TOKEN: "123456789:" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: VALID_CONTRACT_A,
    SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
    HEALTH_SHUTDOWN_GRACE_MS: undefined,
    ...overrides,
  };
}

/**
 * Connect a fake local TCP client that writes partial HTTP request headers and
 * never finishes the request (simulating a stalled client during shutdown).
 */
async function connectStalledFakeClient(port, host = "127.0.0.1") {
  const socket = net.createConnection({ port, host });
  await once(socket, "connect");
  // Swallow ECONNRESET when the server force-closes the stalled socket.
  socket.on("error", () => {});
  // Send incomplete HTTP headers (missing final \r\n\r\n) so the HTTP parser
  // considers this an active in-flight request that cannot be reaped as idle.
  socket.write("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  // Yield briefly so the server's 'connection' event and parser see the bytes.
  await new Promise((r) => setTimeout(r, 20));
  return socket;
}

test("healthServer.close() terminates a stalled fake client after the configured grace period", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 18821, healthShutdownGraceMs: 80 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const stalledSocket = await connectStalledFakeClient(server.port);
  const closedPromise = once(stalledSocket, "close");

  const startedAt = Date.now();
  await server.close();
  const elapsedMs = Date.now() - startedAt;

  await closedPromise;
  assert.equal(stalledSocket.destroyed, true);
  assert.ok(
    elapsedMs >= 50 && elapsedMs < 1_500,
    `expected close() to finish near 80ms grace period; took ${elapsedMs}ms`,
  );
});

test("healthServer.close({ gracePeriodMs: 0 }) boundary force-closes a stalled client immediately", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 18822, healthShutdownGraceMs: 5_000 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const stalledSocket = await connectStalledFakeClient(server.port);
  const closedPromise = once(stalledSocket, "close");

  const startedAt = Date.now();
  await server.close({ gracePeriodMs: 0 });
  const elapsedMs = Date.now() - startedAt;

  await closedPromise;
  assert.equal(stalledSocket.destroyed, true);
  assert.ok(
    elapsedMs < 500,
    `expected immediate close with gracePeriodMs=0; took ${elapsedMs}ms`,
  );
});

test("healthServer.close() closes idle keep-alive clients without waiting for a long grace period", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 18823, healthShutdownGraceMs: 5_000 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const statusCode = await new Promise((resolve, reject) => {
      const req = http.get(
        `${server.url}/health`,
        { agent },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
    });
    assert.equal(statusCode, 200);

    const startedAt = Date.now();
    await server.close();
    const elapsedMs = Date.now() - startedAt;

    assert.ok(
      elapsedMs < 1_000,
      `expected idle keep-alive socket to close immediately (<< 5000ms grace); took ${elapsedMs}ms`,
    );
  } finally {
    agent.destroy();
  }
});

test("healthServer.close() is idempotent when called concurrently during drain", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 18824, healthShutdownGraceMs: 60 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const stalledSocket = await connectStalledFakeClient(server.port);
  try {
    const p1 = server.close();
    const p2 = server.close();
    assert.equal(p1, p2);
    await Promise.all([p1, p2]);
  } finally {
    stalledSocket.destroy();
  }
});

test("metricsServer.close() terminates a stalled fake client after the configured grace period", async () => {
  const metrics = createMetrics();
  const server = await metrics.startServer(0, "127.0.0.1", { shutdownGraceMs: 80 });

  const stalledSocket = await connectStalledFakeClient(server.port);
  const closedPromise = once(stalledSocket, "close");

  const startedAt = Date.now();
  await server.close();
  const elapsedMs = Date.now() - startedAt;

  await closedPromise;
  assert.equal(stalledSocket.destroyed, true);
  assert.ok(
    elapsedMs >= 50 && elapsedMs < 1_500,
    `expected metrics close() to finish near 80ms grace period; took ${elapsedMs}ms`,
  );
});

test("metricsServer.close({ gracePeriodMs: 0 }) force-closes a stalled client immediately", async () => {
  const metrics = createMetrics();
  const server = await metrics.startServer(0, "127.0.0.1", { shutdownGraceMs: 5_000 });

  const stalledSocket = await connectStalledFakeClient(server.port);
  const closedPromise = once(stalledSocket, "close");

  const startedAt = Date.now();
  await server.close({ gracePeriodMs: 0 });
  const elapsedMs = Date.now() - startedAt;

  await closedPromise;
  assert.equal(stalledSocket.destroyed, true);
  assert.ok(
    elapsedMs < 500,
    `expected immediate metrics close with gracePeriodMs=0; took ${elapsedMs}ms`,
  );
});

test("before/after regression: unbounded http.Server.close() hangs on a stalled client while bounded close() completes within gracePeriodMs", async () => {
  // 1. Reproduced failure on baseline main (unbounded server.close()):
  // A raw http.Server with a stalled client sending partial headers never
  // resolves server.close() within the 80ms shutdown budget.
  const rawServer = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
  const rawPort = rawServer.address().port;
  const rawStalled = await connectStalledFakeClient(rawPort);

  try {
    let rawClosed = false;
    const rawClosePromise = new Promise((resolve) => {
      rawServer.close(() => {
        rawClosed = true;
        resolve("closed");
      });
    });
    const raceOutcome = await Promise.race([
      rawClosePromise,
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 120)),
    ]);
    assert.equal(
      raceOutcome,
      "timed_out",
      "unbounded http.Server.close() remains stalled when a client holds an incomplete request open",
    );
    assert.equal(rawClosed, false);
  } finally {
    rawStalled.destroy();
    rawServer.closeAllConnections?.();
  }

  // 2. Fixed behavior with bounded startHealthServer().close():
  // The same stalled fake client is terminated after the 80ms grace period and
  // close() resolves cleanly.
  const boundedServer = startHealthServer({
    config: baseConfig({ healthPort: 18825, healthShutdownGraceMs: 80 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });
  const boundedStalled = await connectStalledFakeClient(boundedServer.port);
  const boundedClosed = once(boundedStalled, "close");

  const boundedOutcome = await Promise.race([
    boundedServer.close().then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timed_out"), 1_000)),
  ]);
  assert.equal(boundedOutcome, "closed");
  await boundedClosed;
  assert.equal(boundedStalled.destroyed, true);
});

test("boundary regression: negative or non-finite gracePeriodMs override clamps to 0 and closes immediately", async () => {
  const server = startHealthServer({
    config: baseConfig({ healthPort: 18826, healthShutdownGraceMs: 5_000 }),
    status: () => baseStatus(),
    now: () => 5_500,
  });

  const stalledSocket = await connectStalledFakeClient(server.port);
  const closedPromise = once(stalledSocket, "close");

  const startedAt = Date.now();
  await server.close({ gracePeriodMs: -50 });
  const elapsedMs = Date.now() - startedAt;

  await closedPromise;
  assert.equal(stalledSocket.destroyed, true);
  assert.ok(
    elapsedMs < 500,
    `expected negative gracePeriodMs to clamp to 0 and close immediately; took ${elapsedMs}ms`,
  );
});

test("loadConfig: HEALTH_SHUTDOWN_GRACE_MS defaults to 2000 and validates boundaries", () => {
  withEnv(validBotEnv(), () => {
    const config = loadConfig();
    assert.equal(config.healthShutdownGraceMs, DEFAULT_HEALTH_SHUTDOWN_GRACE_MS);
    assert.equal(config.healthShutdownGraceMs, 2_000);
  });

  withEnv(validBotEnv({ HEALTH_SHUTDOWN_GRACE_MS: "0" }), () => {
    const config = loadConfig();
    assert.equal(config.healthShutdownGraceMs, 0);
  });

  withEnv(validBotEnv({ HEALTH_SHUTDOWN_GRACE_MS: "750" }), () => {
    const config = loadConfig();
    assert.equal(config.healthShutdownGraceMs, 750);
  });

  withEnv(validBotEnv({ HEALTH_SHUTDOWN_GRACE_MS: "-1" }), () => {
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.problems.some((p) => p.includes("HEALTH_SHUTDOWN_GRACE_MS")));
        return true;
      },
    );
  });

  withEnv(validBotEnv({ HEALTH_SHUTDOWN_GRACE_MS: "12.5" }), () => {
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.ok(err.problems.some((p) => p.includes("HEALTH_SHUTDOWN_GRACE_MS")));
        return true;
      },
    );
  });
});
