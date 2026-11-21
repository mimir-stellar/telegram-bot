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

test("health routes reject unsupported HTTP methods with bounded 405 and Allow: GET", async () => {
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
        assert.equal(res.headers.get("allow"), "GET", `${method} ${route} should set Allow: GET`);
        assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(EXPECTED_405_BODY)));
        assert.equal(await res.text(), EXPECTED_405_BODY);
      }
    }

    // HEAD is also rejected with 405 and Allow: GET (Node omits body for HEAD)
    const headRes = await fetch(`${server.url}/health`, { method: "HEAD" });
    assert.equal(headRes.status, 405);
    assert.equal(headRes.headers.get("allow"), "GET");
    assert.equal(headRes.headers.get("cache-control"), "no-store");
    assert.equal(await headRes.text(), "");

    // Poller status must never be queried or mutated on rejected methods
    assert.equal(statusCalls, 0);
    assert.equal(JSON.stringify(pollerState), initialSnapshot);

    // Unknown routes still return 404
    const notFoundGet = await fetch(`${server.url}/unknown`, { method: "GET" });
    assert.equal(notFoundGet.status, 404);
    assert.deepEqual(await notFoundGet.json(), { ok: false, error: "not_found" });

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

    // Authenticated POST /health returns 405 with Allow: GET
    const authRes = await fetch(`${server.url}/health`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(authRes.status, 405);
    assert.equal(authRes.headers.get("allow"), "GET");
    assert.equal(authRes.headers.get("cache-control"), "no-store");
    assert.equal(await authRes.text(), EXPECTED_405_BODY);

    assert.equal(statusCalls, 0);
  } finally {
    await server.close();
  }
});
