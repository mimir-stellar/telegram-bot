import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAllowedRpcUrl,
  assertEventsResponse,
  createEgressGuardedFetch,
  DEFAULT_MAX_EVENTS_PER_RESPONSE,
  RpcEgressError,
  RpcResponseShapeError,
  validateRpcRedirect,
} from "../dist/stellar/rpc-guard.js";
import { createRpcEgressFetch, createRpcServer } from "../dist/stellar/client.js";
import { defaultMockScenario, startMockRpc } from "../dist/stellar/mock-rpc.js";
import { paginatedGetEvents } from "../dist/stellar/events.js";

// ── Unit tests for assertEventsResponse ────────────────────────────────────────

test("assertEventsResponse accepts valid response shape", () => {
  const valid = {
    events: [
      { id: "100-0", ledger: 100, topic: [], value: null },
      { id: "100-1", ledger: 100, topic: [], value: null },
    ],
    cursor: "100-1",
    latestLedger: 105,
    oldestLedger: 90,
  };

  const result = assertEventsResponse(valid);
  assert.equal(result, valid);
  assert.equal(result.events.length, 2);
  assert.equal(result.cursor, "100-1");
  assert.equal(result.latestLedger, 105);
});

test("assertEventsResponse accepts empty events array with cursor and latestLedger", () => {
  const emptyPage = {
    events: [],
    cursor: "200-0",
    latestLedger: 200,
  };

  const result = assertEventsResponse(emptyPage);
  assert.equal(result, emptyPage);
  assert.equal(result.events.length, 0);
});

test("assertEventsResponse accepts missing cursor or latestLedger if undefined", () => {
  const minimal = {
    events: [],
  };

  const result = assertEventsResponse(minimal);
  assert.equal(result, minimal);
});

test("assertEventsResponse rejects non-object or null input", () => {
  const nonObjects = [null, undefined, "hello", 123, true, [1, 2, 3]];

  for (const input of nonObjects) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "not-an-object");
        assert(!err.message.includes("hello"));
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("assertEventsResponse rejects missing or non-array events field", () => {
  const invalidEvents = [
    {},
    { events: null },
    { events: "events" },
    { events: 123 },
    { events: {} },
  ];

  for (const input of invalidEvents) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "events-not-an-array");
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("assertEventsResponse rejects oversized events array", () => {
  const cap = 5;
  const oversized = {
    events: Array.from({ length: 6 }, (_, i) => ({
      id: `ev-${i}`,
      ledger: 100 + i,
    })),
    cursor: "100-0",
    latestLedger: 200,
  };

  assert.throws(
    () => assertEventsResponse(oversized, { maxEvents: cap }),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert.equal(err.problem, "events-oversized");
      assert.match(err.message, /exceeding cap of 5/);
      assert(err.message.length <= 150);
      return true;
    },
  );
});

test("assertEventsResponse uses DEFAULT_MAX_EVENTS_PER_RESPONSE if cap not provided", () => {
  const oversized = {
    events: Array.from({ length: DEFAULT_MAX_EVENTS_PER_RESPONSE + 1 }, (_, i) => ({
      id: `ev-${i}`,
      ledger: 100 + i,
    })),
  };

  assert.throws(
    () => assertEventsResponse(oversized),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert.equal(err.problem, "events-oversized");
      assert.match(err.message, new RegExp(`exceeding cap of ${DEFAULT_MAX_EVENTS_PER_RESPONSE}`));
      return true;
    },
  );
});

test("assertEventsResponse rejects invalid cursor types", () => {
  const invalidCursors = [
    { events: [], cursor: 12345 },
    { events: [], cursor: true },
    { events: [], cursor: {} },
    { events: [], cursor: ["123"] },
  ];

  for (const input of invalidCursors) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "cursor-invalid");
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("assertEventsResponse rejects invalid latestLedger types or values", () => {
  const invalidLedgers = [
    { events: [], latestLedger: "100" },
    { events: [], latestLedger: -1 },
    { events: [], latestLedger: 1.5 },
    { events: [], latestLedger: NaN },
    { events: [], latestLedger: Infinity },
    { events: [], latestLedger: {} },
  ];

  for (const input of invalidLedgers) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "latest-ledger-invalid");
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("assertEventsResponse rejects events that are not objects", () => {
  const invalidItems = [
    { events: ["not-an-object"] },
    { events: [null] },
    { events: [123] },
  ];

  for (const input of invalidItems) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "event-not-an-object");
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("assertEventsResponse rejects events with missing or invalid id", () => {
  const invalidIds = [
    { events: [{ ledger: 100 }] },
    { events: [{ id: "", ledger: 100 }] },
    { events: [{ id: 123, ledger: 100 }] },
    { events: [{ id: null, ledger: 100 }] },
  ];

  for (const input of invalidIds) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "event-missing-id");
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("assertEventsResponse rejects events with missing or invalid ledger", () => {
  const invalidLedgers = [
    { events: [{ id: "ev-1" }] },
    { events: [{ id: "ev-1", ledger: "100" }] },
    { events: [{ id: "ev-1", ledger: -10 }] },
    { events: [{ id: "ev-1", ledger: 10.5 }] },
    { events: [{ id: "ev-1", ledger: NaN }] },
    { events: [{ id: "ev-1", ledger: null }] },
  ];

  for (const input of invalidLedgers) {
    assert.throws(
      () => assertEventsResponse(input),
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "event-missing-ledger");
        assert(err.message.length <= 150);
        return true;
      },
    );
  }
});

test("error messages are strictly bounded and do not echo raw payloads", () => {
  const hugePayload = "A".repeat(5000);
  const maliciousObject = {
    events: [
      {
        id: "ev-1",
        ledger: -1,
        maliciousSecret: hugePayload,
      },
    ],
  };

  assert.throws(
    () => assertEventsResponse(maliciousObject),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert(!err.message.includes(hugePayload));
      assert(err.message.length <= 150);
      return true;
    },
  );
});

// ── Integration with mock RPC ──────────────────────────────────────────────────

test("valid mock RPC responses pass assertEventsResponse unchanged", async () => {
  const mock = await startMockRpc({
    port: 0,
    scenario: defaultMockScenario(),
  });

  try {
    const rawResult = await fetch(mock.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getEvents",
        params: {
          startLedger: 980,
          limit: 10,
        },
      }),
    });
    const json = await rawResult.json();
    assert.ok(json.result, "expected RPC result");

    const validated = assertEventsResponse(json.result);
    assert.equal(validated, json.result);
    assert.ok(Array.isArray(validated.events));
    assert.ok(validated.events.length > 0);
    assert.equal(typeof validated.cursor, "string");
    assert.equal(typeof validated.latestLedger, "number");
  } finally {
    await mock.close();
  }
});

test("paginatedGetEvents rejects invalid RPC response shapes at the boundary", async () => {
  const tip = 1000;
  const invalidServer = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 900, latestLedger: tip };
    },
    async getEvents() {
      // Hostile / broken response: events is a string instead of an array
      return {
        events: "NOT_AN_ARRAY",
        cursor: "100-0",
        latestLedger: tip,
      };
    },
  };

  await assert.rejects(
    () => paginatedGetEvents(invalidServer, [], { startLedger: 950 }),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert.equal(err.problem, "events-not-an-array");
      return true;
    },
  );
});

test("paginatedGetEvents rejects oversized RPC response at the boundary", async () => {
  const tip = 1000;
  const oversizedServer = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 900, latestLedger: tip };
    },
    async getEvents() {
      return {
        events: Array.from({ length: 1500 }, (_, i) => ({
          id: `ev-${i}`,
          ledger: 950,
        })),
        cursor: "950-0",
        latestLedger: tip,
      };
    },
  };

  await assert.rejects(
    () => paginatedGetEvents(oversizedServer, [], { startLedger: 950 }),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert.equal(err.problem, "events-oversized");
      return true;
    },
  );
});

// ── RPC egress allowlist & redirect guard tests ────────────────────────────────

test("assertAllowedRpcUrl permits allowlisted hosts and wildcard domains over HTTPS", () => {
  const opts = { allowlist: ["soroban-testnet.stellar.org", "*.rpc.example.invalid"] };
  assert.equal(
    assertAllowedRpcUrl("https://soroban-testnet.stellar.org/", opts).hostname,
    "soroban-testnet.stellar.org",
  );
  assert.equal(
    assertAllowedRpcUrl("https://eu.rpc.example.invalid/soroban", opts).hostname,
    "eu.rpc.example.invalid",
  );
});

test("assertAllowedRpcUrl rejects disallowed hosts, plain HTTP, and embedded credentials", () => {
  const opts = { allowlist: ["soroban-testnet.stellar.org"], allowLoopback: true };

  assert.throws(
    () => assertAllowedRpcUrl("https://evil.example.invalid/", opts),
    (err) => err instanceof RpcEgressError && err.problem === "host-not-allowed",
  );
  assert.throws(
    () => assertAllowedRpcUrl("http://soroban-testnet.stellar.org/", opts),
    (err) => err instanceof RpcEgressError && err.problem === "protocol-not-allowed",
  );
  assert.throws(
    () => assertAllowedRpcUrl("https://user:pass@soroban-testnet.stellar.org/", opts),
    (err) =>
      err instanceof RpcEgressError &&
      err.problem === "credentials-not-allowed" &&
      !err.message.includes("pass"),
  );
  // Loopback with embedded credentials must still be rejected
  assert.throws(
    () => assertAllowedRpcUrl("http://admin:secret@127.0.0.1:8420/", opts),
    (err) =>
      err instanceof RpcEgressError &&
      err.problem === "credentials-not-allowed" &&
      !err.message.includes("secret"),
  );
});

test("assertAllowedRpcUrl retains credential-free loopback exception for mock mode", () => {
  const opts = { allowlist: ["soroban-testnet.stellar.org"], allowLoopback: true };
  assert.equal(assertAllowedRpcUrl("http://127.0.0.1:8420/", opts).hostname, "127.0.0.1");
  assert.equal(assertAllowedRpcUrl("http://localhost:8420/rpc", opts).hostname, "localhost");
  assert.equal(assertAllowedRpcUrl("http://[::1]:8420/", opts).hostname, "[::1]");
});

test("createEgressGuardedFetch validates redirect destinations and blocks disallowed hops", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://rpc.example.invalid/v1") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://mirror.example.invalid/v1" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  // Allowed redirect succeeds
  const guardedOk = createEgressGuardedFetch({
    allowlist: ["rpc.example.invalid", "mirror.example.invalid"],
    fetchImpl: fakeFetch,
  });
  const res = await guardedOk("https://rpc.example.invalid/v1");
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [
    "https://rpc.example.invalid/v1",
    "https://mirror.example.invalid/v1",
  ]);

  // Redirect to non-allowlisted destination is blocked before second request
  const blockedCalls = [];
  const guardedBlocked = createEgressGuardedFetch({
    allowlist: ["rpc.example.invalid"],
    fetchImpl: async (url) => {
      blockedCalls.push(String(url));
      return new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example.invalid/steal" },
      });
    },
  });
  await assert.rejects(
    () => guardedBlocked("https://rpc.example.invalid/v1"),
    (err) => err instanceof RpcEgressError && err.problem === "redirect-disallowed",
  );
  assert.deepEqual(blockedCalls, ["https://rpc.example.invalid/v1"]);

  // Redirect loop exceeding maxRedirects is rejected
  const guardedLoop = createEgressGuardedFetch({
    allowlist: ["rpc.example.invalid"],
    maxRedirects: 2,
    fetchImpl: async () =>
      new Response(null, { status: 302, headers: { location: "https://rpc.example.invalid/v1" } }),
  });
  await assert.rejects(
    () => guardedLoop("https://rpc.example.invalid/v1"),
    (err) => err instanceof RpcEgressError && err.problem === "redirect-limit-exceeded",
  );

  // Relative redirect to disallowed credentialed target is rejected
  assert.throws(
    () => validateRpcRedirect("https://rpc.example.invalid/a", "https://u:p@rpc.example.invalid/b", { allowlist: ["rpc.example.invalid"] }),
    (err) => err instanceof RpcEgressError && err.problem === "credentials-not-allowed",
  );
});

test("createRpcServer & createRpcEgressFetch enforce configured allowlist with mock loopback", () => {
  const baseConfig = {
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "https://evil.example.invalid",
    rpcEgressAllowlist: ["soroban-testnet.stellar.org"],
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };

  assert.throws(
    () => createRpcServer(baseConfig),
    (err) => err instanceof RpcEgressError && err.problem === "host-not-allowed",
  );

  const mockConfig = {
    ...baseConfig,
    rpcUrl: "http://127.0.0.1:8420",
    allowLoopbackRpc: true,
  };
  const server = createRpcServer(mockConfig);
  assert.ok(server);
  assert.equal(typeof createRpcEgressFetch(mockConfig), "function");
});
