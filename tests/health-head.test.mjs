import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildHealthReport,
  evaluateHealthStatus,
  startHealthServer,
} from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";

const execFileAsync = promisify(execFile);
const HEALTHCHECK_PATH = fileURLToPath(new URL("../dist/healthcheck.js", import.meta.url));
const FAKE_BOT_CRED = ["0000000000:SECRET", "-DO-NOT-LEAK"].join("");
const FAKE_AUTH_BEARER = ["head-probe-auth", "-credential-987654"].join("");

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

function rawHttpRequest(urlString, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const bodyBuffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            bodyBytes: bodyBuffer.length,
            bodyText: bodyBuffer.toString("utf8"),
          });
        });
      },
    );
    req.once("error", reject);
    req.end();
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
    botToken: FAKE_BOT_CRED,
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

test("evaluateHealthStatus matches buildHealthReport.status across healthy, degraded, and stopped states", () => {
  const cases = [
    { name: "fresh running", cfg: baseConfig(), st: baseStatus(), now: 5_500, expected: "ok" },
    { name: "paused", cfg: baseConfig({ healthStaleMs: 1 }), st: baseStatus({ paused: true, consecutiveFailures: 9 }), now: 9_000, expected: "ok" },
    { name: "draining", cfg: baseConfig({ healthStaleMs: 1 }), st: baseStatus({ stopping: true, consecutiveFailures: 9 }), now: 9_000, expected: "ok" },
    { name: "consecutive failures", cfg: baseConfig(), st: baseStatus({ consecutiveFailures: 5 }), now: 5_500, expected: "degraded" },
    { name: "stale poll", cfg: baseConfig({ healthStaleMs: 1_000 }), st: baseStatus({ lastSuccessAt: 1_000 }), now: 5_000, expected: "degraded" },
    {
      name: "cursor stale",
      cfg: baseConfig(),
      st: baseStatus({ targets: [{ ...baseStatus().targets[0], cursorStale: true }] }),
      now: 5_500,
      expected: "degraded",
    },
    {
      name: "cursor stalled",
      cfg: baseConfig(),
      st: baseStatus({ targets: [{ ...baseStatus().targets[0], cursorStalled: true }] }),
      now: 5_500,
      expected: "degraded",
    },
    { name: "stopped", cfg: baseConfig(), st: baseStatus({ running: false }), now: 5_500, expected: "stopped" },
  ];

  for (const c of cases) {
    const fastStatus = evaluateHealthStatus(c.cfg, c.st, c.now);
    const fullReport = buildHealthReport(c.cfg, c.st, c.now);
    assert.equal(fastStatus, c.expected, `${c.name}: unexpected evaluateHealthStatus`);
    assert.equal(fastStatus, fullReport.status, `${c.name}: parity mismatch with buildHealthReport`);
  }
});

test("HEAD on health server routes matches GET status/headers, sends zero body bytes, and skips report serialization", async () => {
  const port = await getFreePort();
  let currentStatus = baseStatus();
  let statusCalls = 0;
  let provenanceCalls = 0;

  const server = startHealthServer({
    config: baseConfig({ healthPort: port }),
    status: () => {
      statusCalls += 1;
      return currentStatus;
    },
    provenance: () => {
      provenanceCalls += 1;
      return { source: "env", entries: [] };
    },
    now: () => 5_500,
  });

  try {
    const routes = ["/health", "/healthz", "/health/live", "/livez", "/metrics", "/", "/missing"];

    for (const route of routes) {
      const headBeforeProvenance = provenanceCalls;
      const headBeforeStatus = statusCalls;
      const headRes = await rawHttpRequest(`${server.url}${route}`, { method: "HEAD" });
      assert.equal(headRes.bodyBytes, 0, `HEAD ${route} must emit zero response body bytes`);
      assert.equal(headRes.bodyText, "", `HEAD ${route} must have empty body text`);
      assert.equal(
        provenanceCalls,
        headBeforeProvenance,
        `HEAD ${route} must not build/serialize config provenance or full HealthReport`,
      );

      if (route !== "/health" && route !== "/healthz") {
        assert.equal(
          statusCalls,
          headBeforeStatus,
          `HEAD ${route} must not snapshot poller status unnecessarily`,
        );
      } else {
        assert.equal(statusCalls, headBeforeStatus + 1, `HEAD ${route} evaluates poller status once`);
      }

      const getRes = await rawHttpRequest(`${server.url}${route}`, { method: "GET" });
      assert.equal(headRes.statusCode, getRes.statusCode, `status mismatch between HEAD and GET on ${route}`);
      assert.equal(
        headRes.headers["content-type"],
        getRes.headers["content-type"],
        `content-type mismatch on ${route}`,
      );
      assert.equal(
        headRes.headers["cache-control"],
        getRes.headers["cache-control"],
        `cache-control mismatch on ${route}`,
      );
      assert.equal(headRes.headers["cache-control"], "no-store");
      assert.ok(getRes.bodyBytes > 0, `GET ${route} should still include its body`);
    }

    // Confirm GET /health actually exercised provenance() while HEAD /health skipped it.
    assert.equal(provenanceCalls, 2, "only GET /health and GET /healthz should call provenance()");

    // Degraded state: HEAD /health and HEAD /healthz return 503 without calling provenance()
    currentStatus = baseStatus({ consecutiveFailures: 6 });
    const degradedHead = await rawHttpRequest(`${server.url}/health`, { method: "HEAD" });
    const degradedGet = await rawHttpRequest(`${server.url}/health`, { method: "GET" });
    assert.equal(degradedHead.statusCode, 503);
    assert.equal(degradedGet.statusCode, 503);
    assert.equal(degradedHead.bodyBytes, 0);
    assert.equal(provenanceCalls, 3, "HEAD /health while degraded still skips provenance()");

    // Stopped state: HEAD /healthz returns 503 with zero body bytes
    currentStatus = baseStatus({ running: false });
    const stoppedHead = await rawHttpRequest(`${server.url}/healthz`, { method: "HEAD" });
    assert.equal(stoppedHead.statusCode, 503);
    assert.equal(stoppedHead.bodyBytes, 0);
    assert.equal(provenanceCalls, 3);
  } finally {
    await server.close();
  }
});

test("HEAD enforces bearer authentication identically to GET without evaluating status", async () => {
  const port = await getFreePort();
  let statusCalls = 0;
  let provenanceCalls = 0;

  const server = startHealthServer({
    config: baseConfig({ healthPort: port, healthAuthToken: FAKE_AUTH_BEARER }),
    status: () => {
      statusCalls += 1;
      return baseStatus();
    },
    provenance: () => {
      provenanceCalls += 1;
      return { source: "env", entries: [] };
    },
    now: () => 5_500,
  });

  try {
    const unauthHead = await rawHttpRequest(`${server.url}/health`, { method: "HEAD" });
    const unauthGet = await rawHttpRequest(`${server.url}/health`, { method: "GET" });
    assert.equal(unauthHead.statusCode, 401);
    assert.equal(unauthGet.statusCode, 401);
    assert.equal(unauthHead.bodyBytes, 0);
    assert.equal(unauthHead.headers["content-type"], unauthGet.headers["content-type"]);
    assert.equal(unauthHead.headers["cache-control"], "no-store");
    assert.equal(statusCalls, 0);
    assert.equal(provenanceCalls, 0);

    const wrongHead = await rawHttpRequest(`${server.url}/health/live`, {
      method: "HEAD",
      headers: { Authorization: "Bearer wrong-value" },
    });
    assert.equal(wrongHead.statusCode, 401);
    assert.equal(wrongHead.bodyBytes, 0);
    assert.equal(statusCalls, 0);

    const authHead = await rawHttpRequest(`${server.url}/health`, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${FAKE_AUTH_BEARER}` },
    });
    assert.equal(authHead.statusCode, 200);
    assert.equal(authHead.bodyBytes, 0);
    assert.equal(statusCalls, 1);
    assert.equal(provenanceCalls, 0);
  } finally {
    await server.close();
  }
});

test("MetricsServer supports HEAD /metrics and HEAD /health with empty bodies and Allow: GET, HEAD on 405", async () => {
  const metrics = createMetrics();
  metrics.pollCycles.inc(3);
  const srv = await metrics.startServer(0);

  try {
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    const headMetrics = await rawHttpRequest(`${baseUrl}/metrics`, { method: "HEAD" });
    const getMetrics = await rawHttpRequest(`${baseUrl}/metrics`, { method: "GET" });
    assert.equal(headMetrics.statusCode, 200);
    assert.equal(headMetrics.bodyBytes, 0);
    assert.equal(headMetrics.headers["content-type"], getMetrics.headers["content-type"]);
    assert.equal(headMetrics.headers["cache-control"], "no-store");
    assert.ok(getMetrics.bodyBytes > 0);

    const headHealth = await rawHttpRequest(`${baseUrl}/health`, { method: "HEAD" });
    const getHealth = await rawHttpRequest(`${baseUrl}/health`, { method: "GET" });
    assert.equal(headHealth.statusCode, 200);
    assert.equal(headHealth.bodyBytes, 0);
    assert.equal(headHealth.headers["content-type"], getHealth.headers["content-type"]);
    assert.equal(getHealth.bodyText, "OK\n");

    const headMissing = await rawHttpRequest(`${baseUrl}/unknown`, { method: "HEAD" });
    assert.equal(headMissing.statusCode, 404);
    assert.equal(headMissing.bodyBytes, 0);

    const postMetrics = await rawHttpRequest(`${baseUrl}/metrics`, { method: "POST" });
    assert.equal(postMetrics.statusCode, 405);
    assert.equal(postMetrics.headers.allow, "GET, HEAD");
  } finally {
    await srv.close();
  }
});

test("healthcheck CLI supports --head and HEALTHCHECK_METHOD=HEAD", async () => {
  const observedMethods = [];
  let responseCode = 200;

  const mockServer = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      observedMethods.push(req.method);
      res.writeHead(responseCode, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: responseCode === 200 }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });

  const { port } = mockServer.address();

  try {
    const { stdout } = await execFileAsync(process.execPath, [HEALTHCHECK_PATH, "--head"], {
      env: { ...process.env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(port) },
    });
    assert.match(stdout, /\[healthcheck\] OK/);
    assert.equal(observedMethods.at(-1), "HEAD");

    responseCode = 503;
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [HEALTHCHECK_PATH], {
          env: {
            ...process.env,
            HEALTH_HOST: "127.0.0.1",
            HEALTH_PORT: String(port),
            HEALTHCHECK_METHOD: "HEAD",
          },
        }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /HTTP 503/);
        return true;
      },
    );
    assert.equal(observedMethods.at(-1), "HEAD");
  } finally {
    await new Promise((resolve) => mockServer.close(() => resolve()));
  }
});
