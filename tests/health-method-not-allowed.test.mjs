import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startHealthServer } from "../dist/health.js";
import { createPoller } from "../dist/poller.js";

// Built from parts so scripts/scan-secrets.mjs never flags this fixture.
const HEALTH_AUTH = ["test-secret", "-token"].join("");
const FAKE_BOT_SECRET = ["0000000000:SECRET", "-TOKEN-DO-NOT-LEAK"].join("");

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
    botToken: FAKE_BOT_SECRET,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: path.join(os.tmpdir(), "mimir-862-unused-cursor.json"),
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

test("unsupported HTTP methods on health routes return bounded 405 with Allow: GET", async () => {
  const port = await findFreePort();
  let statusCalls = 0;
  const server = startHealthServer({
    config: baseConfig({ healthPort: port }),
    status: () => {
      statusCalls += 1;
      return baseStatus();
    },
    now: () => 5_500,
  });
  assert.ok(server.url);

  const routes = ["/", "/health", "/healthz", "/health/live", "/livez", "/metrics"];
  const methods = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

  try {
    for (const route of routes) {
      for (const method of methods) {
        const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
        const hostilePayload = hasBody
          ? JSON.stringify({ paused: true, running: false, extra: "x".repeat(4096) })
          : undefined;

        const res = await fetch(`${server.url}${route}?probe=1`, {
          method,
          headers: hasBody ? { "content-type": "application/json" } : undefined,
          body: hostilePayload,
        });

        assert.equal(res.status, 405, `expected 405 for ${method} ${route}`);
        assert.equal(res.headers.get("allow"), "GET", `Allow header for ${method} ${route}`);
        assert.equal(res.headers.get("cache-control"), "no-store");
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);

        const text = await res.text();
        assert.ok(Buffer.byteLength(text, "utf8") <= 64, "405 body must stay bounded");
        assert.deepEqual(JSON.parse(text), { ok: false, error: "method_not_allowed" });
      }
    }

    // Rejected methods never even evaluate status()
    assert.equal(statusCalls, 0);

    // Supported GET requests still work normally afterwards
    const okRes = await fetch(`${server.url}/health`);
    assert.equal(okRes.status, 200);
    assert.equal((await okRes.json()).ok, true);
    assert.equal(statusCalls, 1);
  } finally {
    await server.close();
  }
});

test("405 method rejection preserves bearer authentication and keeps unknown paths at 404", async () => {
  const port = await findFreePort();
  const server = startHealthServer({
    config: baseConfig({
      healthPort: port,
      healthAuthToken: HEALTH_AUTH,
    }),
    status: () => baseStatus(),
    now: () => 5_500,
  });
  assert.ok(server.url);

  try {
    // Missing auth on unsupported method must still return 401, not 405
    const unauthPost = await fetch(`${server.url}/health`, { method: "POST" });
    assert.equal(unauthPost.status, 401);
    assert.equal(unauthPost.headers.get("allow"), null);
    assert.equal(await unauthPost.text(), "");

    // Invalid auth on unsupported method must still return 401, not 405
    const wrongAuthDelete = await fetch(`${server.url}/metrics`, {
      method: "DELETE",
      headers: { Authorization: "Bearer invalid" },
    });
    assert.equal(wrongAuthDelete.status, 401);
    assert.equal(await wrongAuthDelete.text(), "");

    // Valid auth on unsupported method returns 405 with Allow: GET
    const authedPost = await fetch(`${server.url}/health`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HEALTH_AUTH}` },
    });
    assert.equal(authedPost.status, 405);
    assert.equal(authedPost.headers.get("allow"), "GET");
    assert.deepEqual(await authedPost.json(), { ok: false, error: "method_not_allowed" });

    // Unknown path with valid auth returns 404 (not 405) regardless of method
    for (const method of ["GET", "POST", "DELETE"]) {
      const unknown = await fetch(`${server.url}/does-not-exist`, {
        method,
        headers: { Authorization: `Bearer ${HEALTH_AUTH}` },
      });
      assert.equal(unknown.status, 404, `unknown route with ${method}`);
      assert.equal(unknown.headers.get("allow"), null);
      assert.deepEqual(await unknown.json(), { ok: false, error: "not_found" });
    }
  } finally {
    await server.close();
  }
});

test("unsupported methods never mutate live poller state and respect webhook mode Allow: POST", async () => {
  const port = await findFreePort();
  const cfg = baseConfig({ healthPort: port });
  const poller = createPoller({
    config: cfg,
    server: {
      getHealth: async () => ({ status: "healthy", oldestLedger: 100, latestLedger: 200 }),
      getEvents: async () => ({ events: [], latestLedger: 200, oldestLedger: 100 }),
    },
    send: async () => undefined,
    persistAudit: false,
  });

  let webhookCalls = 0;
  const server = startHealthServer({
    config: cfg,
    status: () => poller.status(),
    webhookHandler: (_req, res) => {
      webhookCalls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    const before = structuredClone(poller.status());

    for (const [method, route] of [
      ["POST", "/health"],
      ["DELETE", "/healthz"],
      ["PUT", "/health/live"],
      ["PATCH", "/metrics"],
      ["GET", "/telegram-webhook"],
      ["DELETE", "/telegram-webhook"],
    ]) {
      const res = await fetch(`${server.url}${route}`, {
        method,
        headers: method === "POST" || method === "PUT" || method === "PATCH"
          ? { "content-type": "application/json" }
          : undefined,
        body:
          method === "POST" || method === "PUT" || method === "PATCH"
            ? JSON.stringify({ paused: true, stopping: true, cycles: 999 })
            : undefined,
      });
      assert.equal(res.status, 405, `${method} ${route}`);
      assert.equal(
        res.headers.get("allow"),
        route === "/telegram-webhook" ? "POST" : "GET",
      );
      assert.deepEqual(await res.json(), { ok: false, error: "method_not_allowed" });
    }

    assert.equal(webhookCalls, 0);
    assert.deepEqual(poller.status(), before, "poller state must remain strictly unchanged");

    // POST /telegram-webhook still reaches webhookHandler
    const postWebhook = await fetch(`${server.url}/telegram-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(postWebhook.status, 200);
    assert.equal(webhookCalls, 1);
  } finally {
    await server.close();
  }
});
