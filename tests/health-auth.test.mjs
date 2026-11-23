import assert from "node:assert/strict";
import test from "node:test";

import { MAX_AUTH_HEADER_BYTES, startHealthServer } from "../dist/health.js";

// Built from parts so the secret scanner (scripts/scan-secrets.mjs) does not
// flag this test fixture as a leaked bearer token.
const HEALTH_TOKEN = ["test-secret", "-token"].join("");

function baseConfig(overrides = {}) {
  return {
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
    cursorFile: "/tmp/unused-cursor.json", // never read or written by these tests
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    ...overrides,
  };
}

async function assertBoundedUnauthorized(res) {
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-length"), "0");
  assert.equal(await res.text(), "");
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
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test("health endpoint requires authentication when HEALTH_AUTH_TOKEN is set", async () => {
  const config = baseConfig({
    healthPort: 18788,
    healthAuthToken: "test-secret-token",
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Request without token should return 401
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 401);
    assert.equal(await res.text(), "");

    // Request with invalid token should return 401
    const resInvalid = await fetch(`${server.url}/health`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    assert.equal(resInvalid.status, 401);
    assert.equal(await resInvalid.text(), "");

    // Request with valid token should return 200
    const resValid = await fetch(`${server.url}/health`, {
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(resValid.status, 200);
    const body = await resValid.json();
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
  } finally {
    await server.close();
  }
});

test("health endpoint accessible without authentication when HEALTH_AUTH_TOKEN is null", async () => {
  const config = baseConfig({
    healthPort: 18789,
    healthAuthToken: null,
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Request without token should succeed
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // An oversized header is ignored when no token is configured.
    const resOversized = await fetch(`${server.url}/health`, {
      headers: { Authorization: `Bearer ${"a".repeat(MAX_AUTH_HEADER_BYTES)}` },
    });
    assert.equal(resOversized.status, 200);
  } finally {
    await server.close();
  }
});

test("liveness endpoint requires authentication when HEALTH_AUTH_TOKEN is set", async () => {
  const config = baseConfig({
    healthPort: 18790,
    healthAuthToken: "test-secret-token",
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Request without token should return 401
    const res = await fetch(`${server.url}/health/live`);
    assert.equal(res.status, 401);

    // Request with valid token should return 200
    const resValid = await fetch(`${server.url}/health/live`, {
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(resValid.status, 200);
    const body = await resValid.json();
    assert.equal(body.status, "live");
  } finally {
    await server.close();
  }
});

test("root endpoint requires authentication when HEALTH_AUTH_TOKEN is set", async () => {
  const config = baseConfig({
    healthPort: 18791,
    healthAuthToken: "test-secret-token",
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Request without token should return 401
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 401);

    // Request with valid token should return 200
    const resValid = await fetch(`${server.url}/`, {
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(resValid.status, 200);
    const body = await resValid.json();
    assert.equal(body.service, "mimir-telegram-bot");
  } finally {
    await server.close();
  }
});

test("404 responses require authentication when HEALTH_AUTH_TOKEN is set", async () => {
  const config = baseConfig({
    healthPort: 18792,
    healthAuthToken: "test-secret-token",
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Request without token should return 401 (not 404)
    const res = await fetch(`${server.url}/nonexistent`);
    assert.equal(res.status, 401);

    // Request with valid token should return 404
    const resValid = await fetch(`${server.url}/nonexistent`, {
      headers: { Authorization: `Bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(resValid.status, 404);
  } finally {
    await server.close();
  }
});

test("Bearer token is case-insensitive for the scheme name", async () => {
  const config = baseConfig({
    healthPort: 18793,
    healthAuthToken: "test-secret-token",
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // lowercase "bearer"
    const resLower = await fetch(`${server.url}/health`, {
      headers: { Authorization: `bearer ${HEALTH_TOKEN}` },
    });
    assert.equal(resLower.status, 200);

    // mixed case "BeArEr"
    const resMixed = await fetch(`${server.url}/health`, {
      headers: { Authorization: `BeArEr ${HEALTH_TOKEN}` },
    });
    assert.equal(resMixed.status, 200);
  } finally {
    await server.close();
  }
});

test("malformed Authorization header returns 401", async () => {
  const config = baseConfig({
    healthPort: 18794,
    healthAuthToken: "test-secret-token",
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Missing "Bearer" prefix
    const resNoPrefix = await fetch(`${server.url}/health`, {
      headers: { Authorization: "test-secret-token" },
    });
    assert.equal(resNoPrefix.status, 401);

    // Empty token
    const resEmpty = await fetch(`${server.url}/health`, {
      headers: { Authorization: "Bearer " },
    });
    assert.equal(resEmpty.status, 401);
  } finally {
    await server.close();
  }
});

test("oversized Authorization headers get the same bounded 401", async () => {
  const oversizedToken = "a".repeat(MAX_AUTH_HEADER_BYTES);
  const config = baseConfig({
    healthPort: 18795,
    healthAuthToken: oversizedToken,
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const resMatching = await fetch(`${server.url}/health`, {
      headers: { Authorization: `Bearer ${oversizedToken}` },
    });
    await assertBoundedUnauthorized(resMatching);

    const resMalformed = await fetch(`${server.url}/health`, {
      headers: { Authorization: "x".repeat(MAX_AUTH_HEADER_BYTES + 1) },
    });
    await assertBoundedUnauthorized(resMalformed);
  } finally {
    await server.close();
  }
});

test("Authorization header at the fixed byte limit is accepted", async () => {
  const token = "a".repeat(MAX_AUTH_HEADER_BYTES - Buffer.byteLength("Bearer "));
  assert.equal(Buffer.byteLength(`Bearer ${token}`), MAX_AUTH_HEADER_BYTES);
  const config = baseConfig({
    healthPort: 18796,
    healthAuthToken: token,
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const res = await fetch(`${server.url}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  } finally {
    await server.close();
  }
});

test("operational HTTP responses set Cache-Control: no-store for success, degraded, and unauthorized", async () => {
  let healthy = true;
  const config = baseConfig({
    healthPort: 18797,
    healthAuthToken: HEALTH_TOKEN,
  });
  const server = startHealthServer({
    config,
    status: () => baseStatus({ running: healthy }),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    const authHeaders = { Authorization: `Bearer ${HEALTH_TOKEN}` };

    for (const path of ["/health", "/healthz", "/health/live", "/livez", "/metrics", "/"]) {
      const unauth = await fetch(`${server.url}${path}`);
      assert.equal(unauth.status, 401, `expected 401 for unauthenticated ${path}`);
      assert.equal(
        unauth.headers.get("cache-control"),
        "no-store",
        `expected Cache-Control: no-store for 401 on ${path}`,
      );

      const ok = await fetch(`${server.url}${path}`, { headers: authHeaders });
      assert.equal(ok.status, 200, `expected 200 for authenticated ${path}`);
      assert.equal(
        ok.headers.get("cache-control"),
        "no-store",
        `expected Cache-Control: no-store for 200 on ${path}`,
      );
    }

    healthy = false;
    const degraded = await fetch(`${server.url}/health`, { headers: authHeaders });
    assert.equal(degraded.status, 503);
    assert.equal(degraded.headers.get("cache-control"), "no-store");

    const notFound = await fetch(`${server.url}/does-not-exist`, { headers: authHeaders });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});
