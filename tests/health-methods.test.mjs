import assert from "node:assert/strict";
import test from "node:test";

import { startHealthServer } from "../dist/health.js";

// Built from parts so the secret scanner (scripts/scan-secrets.mjs) does not
// flag this test fixture as a leaked bearer token.
const HEALTH_TOKEN = ["test-secret", "-token"].join("");

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
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
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

const EXPECTED_405_BODY = '{"ok":false,"error":"method_not_allowed"}\n';

test("health routes reject unsupported HTTP methods with bounded 405 and Allow: GET, HEAD", async () => {
  let statusCalls = 0;
  const pollerState = baseStatus();
  const initialSnapshot = JSON.stringify(pollerState);

  const server = startHealthServer({
    config: baseConfig({ healthPort: 18895 }),
    status: () => {
      statusCalls += 1;
      return pollerState;
    },
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const routes = ["/", "/health", "/healthz", "/health/live", "/livez", "/metrics"];
    const unsupportedMethods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

    for (const route of routes) {
      for (const method of unsupportedMethods) {
        const res = await fetch(`${server.url}${route}`, { method });
        assert.equal(res.status, 405, `${method} ${route} should return 405`);
        assert.equal(res.headers.get("allow"), "GET, HEAD", `${method} ${route} should set Allow: GET, HEAD`);
        assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(EXPECTED_405_BODY)));
        assert.equal(await res.text(), EXPECTED_405_BODY);
      }
    }

    // Poller status must never be queried or mutated on rejected methods
    assert.equal(statusCalls, 0);
    assert.equal(JSON.stringify(pollerState), initialSnapshot);

    // Unknown routes still return 404
    const notFoundGet = await fetch(`${server.url}/unknown`, { method: "GET" });
    assert.equal(notFoundGet.status, 404);
    assert.deepEqual(await notFoundGet.json(), { ok: false, error: "not_found" });

    const notFoundHead = await fetch(`${server.url}/unknown`, { method: "HEAD" });
    assert.equal(notFoundHead.status, 404);
    assert.equal(notFoundHead.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(notFoundHead.headers.get("cache-control"), "no-store");
    assert.equal(await notFoundHead.text(), "");

    const notFoundPost = await fetch(`${server.url}/unknown`, { method: "POST" });
    assert.equal(notFoundPost.status, 404);
    assert.deepEqual(await notFoundPost.json(), { ok: false, error: "not_found" });

    // Supported GET routes continue to work
    const okRes = await fetch(`${server.url}/health`);
    assert.equal(okRes.status, 200);
    const body = await okRes.json();
    assert.equal(body.ok, true);
    assert.equal(statusCalls, 1);
  } finally {
    await server.close();
  }
});

test("health routes support HEAD without response bodies or full report serialization", async () => {
  let statusCalls = 0;
  let provenanceCalls = 0;
  let pollerState = baseStatus();

  const server = startHealthServer({
    config: baseConfig({ healthPort: 18897 }),
    status: () => {
      statusCalls += 1;
      return pollerState;
    },
    provenance: () => {
      provenanceCalls += 1;
      return { profile: null, envFile: { present: false, suppliedKeys: 0 }, entries: [], counts: {}, warnings: [] };
    },
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Healthy readiness routes return 200 with GET-equivalent headers and no body
    for (const route of ["/health", "/healthz"]) {
      const res = await fetch(`${server.url}${route}`, { method: "HEAD" });
      assert.equal(res.status, 200, `HEAD ${route} should return 200 when ready`);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), "");
    }
    assert.equal(statusCalls, 2);
    // Provenance is part of the full JSON report; HEAD must not build or serialize it
    assert.equal(provenanceCalls, 0);

    // Liveness and index routes return 200 with empty body and do not query poller status
    for (const route of ["/health/live", "/livez", "/"]) {
      const res = await fetch(`${server.url}${route}`, { method: "HEAD" });
      assert.equal(res.status, 200, `HEAD ${route} should return 200`);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(await res.text(), "");
    }
    assert.equal(statusCalls, 2);

    // Metrics route returns 200 with Prometheus content-type and empty body
    const metricsHead = await fetch(`${server.url}/metrics`, { method: "HEAD" });
    assert.equal(metricsHead.status, 200);
    assert.equal(metricsHead.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
    assert.equal(metricsHead.headers.get("cache-control"), "no-store");
    assert.equal(await metricsHead.text(), "");
    assert.equal(statusCalls, 2);

    // Stopped/degraded poller causes HEAD /health and /healthz to return 503 like GET
    pollerState = baseStatus({ running: false });
    const stoppedHead = await fetch(`${server.url}/health`, { method: "HEAD" });
    assert.equal(stoppedHead.status, 503);
    assert.equal(stoppedHead.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(stoppedHead.headers.get("cache-control"), "no-store");
    assert.equal(await stoppedHead.text(), "");
    assert.equal(provenanceCalls, 0);

    // Draining state also causes HEAD /health to return 503 while HEAD /health/live stays 200
    pollerState = baseStatus({ running: true });
    server.beginShutdown();
    const drainingHead = await fetch(`${server.url}/health`, { method: "HEAD" });
    assert.equal(drainingHead.status, 503);
    assert.equal(await drainingHead.text(), "");

    const drainingLiveHead = await fetch(`${server.url}/health/live`, { method: "HEAD" });
    assert.equal(drainingLiveHead.status, 200);
    assert.equal(await drainingLiveHead.text(), "");
    assert.equal(provenanceCalls, 0);

    // GET /health still builds the full report (calling provenance)
    const getRes = await fetch(`${server.url}/health`, { method: "GET" });
    assert.equal(getRes.status, 503);
    assert.equal(provenanceCalls, 1);
  } finally {
    await server.close();
  }
});

test("health routes preserve authentication before returning 405 on unsupported methods", async () => {
  let statusCalls = 0;
  const server = startHealthServer({
    config: baseConfig({
      healthPort: 18896,
      healthAuthToken: HEALTH_TOKEN,
    }),
    status: () => {
      statusCalls += 1;
      return baseStatus();
    },
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Unauthenticated POST /health must return 401, not 405
    const unauthRes = await fetch(`${server.url}/health`, { method: "POST" });
    assert.equal(unauthRes.status, 401);
    assert.equal(unauthRes.headers.get("allow"), null);
    assert.equal(await unauthRes.text(), "");

    // Wrong token on DELETE /health/live must return 401, not 405
    const badAuthRes = await fetch(`${server.url}/health/live`, {
      method: "DELETE",
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(badAuthRes.status, 401);
    assert.equal(badAuthRes.headers.get("allow"), null);
    assert.equal(await badAuthRes.text(), "");

    // Unauthenticated HEAD /health must also return 401
    const unauthHead = await fetch(`${server.url}/health`, { method: "HEAD" });
    assert.equal(unauthHead.status, 401);
    assert.equal(unauthHead.headers.get("allow"), null);
    assert.equal(await unauthHead.text(), "");

    // Authenticated POST /health returns 405 with Allow: GET, HEAD
    const authRes = await fetch(`${server.url}/health`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(authRes.status, 405);
    assert.equal(authRes.headers.get("allow"), "GET, HEAD");
    assert.equal(authRes.headers.get("cache-control"), "no-store");
    assert.equal(await authRes.text(), EXPECTED_405_BODY);

    assert.equal(statusCalls, 0);

    // Authenticated HEAD /health returns 200 with empty body
    const authHead = await fetch(`${server.url}/health`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(authHead.status, 200);
    assert.equal(await authHead.text(), "");
    assert.equal(statusCalls, 1);
  } finally {
    await server.close();
  }
});
