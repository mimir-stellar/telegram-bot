import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  MAX_HEALTH_AUTH_HEADER_BYTES,
  isValidHealthAuth,
  startHealthServer,
} from "../dist/health.js";

const FAKE_BOT_CRED = ["0000000000:SECRET", "-DO-NOT-LEAK"].join("");
const SHORT_BEARER = ["abcd"].join("");
const STANDARD_BEARER = ["probe-auth", "-credential-42"].join("");

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

function rawHttpGet(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
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

test("isValidHealthAuth enforces MAX_HEALTH_AUTH_HEADER_BYTES exact UTF-8 byte boundary before parsing", () => {
  assert.equal(MAX_HEALTH_AUTH_HEADER_BYTES, 512);

  // "Bearer " is 7 bytes -> 505 ASCII chars hits the exact 512-byte ceiling
  const exactMaxCred = "a".repeat(MAX_HEALTH_AUTH_HEADER_BYTES - 7);
  const exactHeader = `Bearer ${exactMaxCred}`;
  assert.equal(Buffer.byteLength(exactHeader, "utf8"), MAX_HEALTH_AUTH_HEADER_BYTES);
  assert.equal(isValidHealthAuth(exactHeader, exactMaxCred), true);

  // 513 ASCII bytes -> rejected immediately even if expected credential matches
  const oneByteOverCred = "a".repeat(MAX_HEALTH_AUTH_HEADER_BYTES - 6);
  const overHeader = `Bearer ${oneByteOverCred}`;
  assert.equal(Buffer.byteLength(overHeader, "utf8"), MAX_HEALTH_AUTH_HEADER_BYTES + 1);
  assert.equal(isValidHealthAuth(overHeader, oneByteOverCred), false);

  // Multi-byte UTF-8 header whose UTF-16 .length <= 512 but UTF-8 byte length > 512
  // "é" is 1 UTF-16 code unit, 2 UTF-8 bytes: 260 * 2 + 7 = 527 UTF-8 bytes (UTF-16 length 267)
  const multiByteCred = "é".repeat(260);
  const multiByteHeader = `Bearer ${multiByteCred}`;
  assert.ok(multiByteHeader.length < MAX_HEALTH_AUTH_HEADER_BYTES);
  assert.ok(Buffer.byteLength(multiByteHeader, "utf8") > MAX_HEALTH_AUTH_HEADER_BYTES);
  assert.equal(isValidHealthAuth(multiByteHeader, multiByteCred), false);
});

test("isValidHealthAuth rejects malformed schemes, control chars, whitespace, arrays, and multi-byte length mismatches safely", () => {
  assert.equal(isValidHealthAuth(undefined, STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth("", STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth([`Bearer ${STANDARD_BEARER}`], STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth(`Basic ${STANDARD_BEARER}`, STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth(`Bearer${STANDARD_BEARER}`, STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth("Bearer ", STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth("Bearer \t ", STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth(`Bearer ${STANDARD_BEARER} extra`, STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth(`Bearer ${STANDARD_BEARER} `, STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth(`Bearer ${STANDARD_BEARER}\x00`, STANDARD_BEARER), false);
  assert.equal(isValidHealthAuth(`Bearer ${STANDARD_BEARER}\x7f`, STANDARD_BEARER), false);

  // Regression guard: "éééé" has UTF-16 length 4 (matching "abcd"), but UTF-8 byte length 8.
  // Must return false cleanly without throwing RangeError from crypto.timingSafeEqual.
  assert.equal("éééé".length, SHORT_BEARER.length);
  assert.equal(isValidHealthAuth("Bearer éééé", SHORT_BEARER), false);

  // Case-insensitive Bearer prefix and tab/multiple-space separator after scheme stay supported
  assert.equal(isValidHealthAuth(`bearer ${STANDARD_BEARER}`, STANDARD_BEARER), true);
  assert.equal(isValidHealthAuth(`BEARER\t${STANDARD_BEARER}`, STANDARD_BEARER), true);
  assert.equal(isValidHealthAuth(`Bearer   ${STANDARD_BEARER}`, STANDARD_BEARER), true);

  // Auth disabled (null / undefined): ambient headers do not block loopback access
  assert.equal(isValidHealthAuth(`Bearer ${"x".repeat(2_048)}`, null), true);
  assert.equal(isValidHealthAuth(undefined, undefined), true);
});

test("live HTTP server returns identical bounded 401 response for oversized and malformed Authorization headers", async () => {
  const port = await getFreePort();
  let statusCalls = 0;
  let provenanceCalls = 0;

  const server = startHealthServer({
    config: baseConfig({ healthPort: port, healthAuthToken: SHORT_BEARER }),
    status: () => {
      statusCalls += 1;
      return baseStatus();
    },
    provenance: () => {
      provenanceCalls += 1;
      return { profile: null, envFile: { present: false, suppliedKeys: 0 }, entries: [], counts: {}, warnings: [] };
    },
    now: () => 5_500,
  });

  try {
    const baselineUnauth = await rawHttpGet(`${server.url}/health`);
    assert.equal(baselineUnauth.statusCode, 401);
    assert.equal(baselineUnauth.bodyBytes, 0);
    assert.equal(baselineUnauth.headers["content-length"], "0");
    assert.equal(baselineUnauth.headers["cache-control"], "no-store");
    assert.equal(baselineUnauth.headers["content-type"], "application/json; charset=utf-8");

    const invalidHeaders = [
      `Bearer ${"a".repeat(4_096)}`,
      `Bearer ${" ".repeat(600)}${SHORT_BEARER}`,
      "Bearer éééé",
      `Bearer ${SHORT_BEARER} trailing`,
      "Basic YWJjZA==",
      "Bearer",
    ];

    for (const authValue of invalidHeaders) {
      for (const route of ["/health", "/health/live", "/metrics", "/", "/unknown"]) {
        const res = await rawHttpGet(`${server.url}${route}`, { Authorization: authValue });
        assert.equal(res.statusCode, 401, `expected 401 for route=${route}`);
        assert.equal(res.bodyBytes, 0, `expected empty 401 body for route=${route}`);
        assert.equal(res.headers["content-length"], baselineUnauth.headers["content-length"]);
        assert.equal(res.headers["content-type"], baselineUnauth.headers["content-type"]);
        assert.equal(res.headers["cache-control"], baselineUnauth.headers["cache-control"]);
      }
    }

    // Status and provenance must never be evaluated for rejected requests
    assert.equal(statusCalls, 0);
    assert.equal(provenanceCalls, 0);

    // Valid bounded Authorization header still succeeds with 200
    const validRes = await rawHttpGet(`${server.url}/health`, {
      Authorization: `Bearer ${SHORT_BEARER}`,
    });
    assert.equal(validRes.statusCode, 200);
    assert.equal(statusCalls, 1);
    assert.equal(provenanceCalls, 1);
  } finally {
    await server.close();
  }
});
