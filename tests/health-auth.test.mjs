import assert from "node:assert/strict";
import test from "node:test";

import { startHealthServer } from "../dist/health.js";

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
    cursorFile: "./data/cursor.json",
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
      headers: { Authorization: "Bearer test-secret-token" },
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
      headers: { Authorization: "Bearer test-secret-token" },
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
      headers: { Authorization: "Bearer test-secret-token" },
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
      headers: { Authorization: "Bearer test-secret-token" },
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
      headers: { Authorization: "bearer test-secret-token" },
    });
    assert.equal(resLower.status, 200);

    // mixed case "BeArEr"
    const resMixed = await fetch(`${server.url}/health`, {
      headers: { Authorization: "BeArEr test-secret-token" },
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
