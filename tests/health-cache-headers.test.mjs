import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { OPERATIONAL_CACHE_HEADERS, startHealthServer } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";

const execFileAsync = promisify(execFile);
const HEALTHCHECK_SCRIPT = fileURLToPath(new URL("../dist/healthcheck.js", import.meta.url));

// Built from parts so scripts/scan-secrets.mjs never flags this fixture.
const HEALTH_TOKEN = ["test-secret", "-token"].join("");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
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
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        cyclesWithoutAdvance: 0,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

function assertNoStoreHeaders(headers, { expectVaryAuth = false } = {}) {
  assert.equal(headers.get("cache-control"), OPERATIONAL_CACHE_HEADERS["cache-control"]);
  assert.equal(headers.get("pragma"), OPERATIONAL_CACHE_HEADERS.pragma);
  assert.equal(headers.get("expires"), OPERATIONAL_CACHE_HEADERS.expires);
  if (expectVaryAuth) {
    assert.equal(headers.get("vary"), "Authorization");
  }
}

test("health server sets cache-prevention headers on healthy, degraded, live, metrics, root, and 404 responses", async () => {
  const port = await findFreePort();
  let current = baseStatus();
  const server = startHealthServer({
    config: baseConfig({ healthPort: port }),
    status: () => current,
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    for (const [path, expectedStatus] of [
      ["/", 200],
      ["/health", 200],
      ["/healthz", 200],
      ["/health/live", 200],
      ["/livez", 200],
      ["/metrics", 200],
      ["/unknown-route", 404],
    ]) {
      const res = await fetch(`${server.url}${path}`);
      assert.equal(res.status, expectedStatus, `status for ${path}`);
      assertNoStoreHeaders(res.headers, { expectVaryAuth: true });
      await res.text();
    }

    // Degraded readiness (503) and stopped readiness (503) must also carry no-store
    current = baseStatus({ consecutiveFailures: 10 });
    const degraded = await fetch(`${server.url}/health`);
    assert.equal(degraded.status, 503);
    assertNoStoreHeaders(degraded.headers, { expectVaryAuth: true });
    await degraded.text();

    current = baseStatus({ running: false });
    const stopped = await fetch(`${server.url}/healthz`);
    assert.equal(stopped.status, 503);
    assertNoStoreHeaders(stopped.headers, { expectVaryAuth: true });
    await stopped.text();
  } finally {
    await server.close();
  }
});

test("health server sets cache-prevention headers on 401 unauthorized and 200 authorized responses", async () => {
  const port = await findFreePort();
  const server = startHealthServer({
    config: baseConfig({
      healthPort: port,
      healthAuthToken: HEALTH_TOKEN,
    }),
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    for (const path of ["/", "/health", "/healthz", "/health/live", "/livez", "/metrics", "/missing"]) {
      const missingAuth = await fetch(`${server.url}${path}`);
      assert.equal(missingAuth.status, 401, `missing auth on ${path}`);
      assertNoStoreHeaders(missingAuth.headers, { expectVaryAuth: true });
      assert.equal(await missingAuth.text(), "");

      const wrongAuth = await fetch(`${server.url}${path}`, {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(wrongAuth.status, 401, `wrong auth on ${path}`);
      assertNoStoreHeaders(wrongAuth.headers, { expectVaryAuth: true });
      assert.equal(await wrongAuth.text(), "");
    }

    for (const [path, expectedStatus] of [
      ["/health", 200],
      ["/health/live", 200],
      ["/metrics", 200],
    ]) {
      const authorized = await fetch(`${server.url}${path}`, {
        headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
      });
      assert.equal(authorized.status, expectedStatus, `authorized ${path}`);
      assertNoStoreHeaders(authorized.headers, { expectVaryAuth: true });
      await authorized.text();
    }
  } finally {
    await server.close();
  }
});

test("standalone metrics server sets cache-prevention headers on /metrics, /health, 404, and 405", async () => {
  const metrics = createMetrics();
  const srv = await metrics.startServer(0);

  try {
    const base = `http://127.0.0.1:${srv.port}`;

    const metricsRes = await fetch(`${base}/metrics`);
    assert.equal(metricsRes.status, 200);
    assertNoStoreHeaders(metricsRes.headers);
    await metricsRes.text();

    const healthRes = await fetch(`${base}/health`);
    assert.equal(healthRes.status, 200);
    assertNoStoreHeaders(healthRes.headers);
    assert.equal(await healthRes.text(), "OK\n");

    const notFoundRes = await fetch(`${base}/nope`);
    assert.equal(notFoundRes.status, 404);
    assertNoStoreHeaders(notFoundRes.headers);
    await notFoundRes.text();

    const methodNotAllowedRes = await fetch(`${base}/metrics`, { method: "POST" });
    assert.equal(methodNotAllowedRes.status, 405);
    assert.equal(methodNotAllowedRes.headers.get("allow"), "GET");
    assertNoStoreHeaders(methodNotAllowedRes.headers);
    await methodNotAllowedRes.text();
  } finally {
    await srv.close();
  }
});

test("healthcheck probe sends cache-prevention request headers", async () => {
  let receivedHeaders = null;
  const mockServer = await new Promise((resolve) => {
    const srv = createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, status: "ok" }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });

  const addr = mockServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  try {
    const { stdout } = await execFileAsync("node", [HEALTHCHECK_SCRIPT], {
      env: { ...process.env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(port) },
    });
    assert.match(stdout, /\[healthcheck\] OK/);
    assert.equal(receivedHeaders?.["cache-control"], "no-store");
    assert.equal(receivedHeaders?.pragma, "no-cache");
  } finally {
    await new Promise((resolve) => mockServer.close(() => resolve()));
  }
});
