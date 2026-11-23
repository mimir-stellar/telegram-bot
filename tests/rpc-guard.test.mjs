import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  assertAllowedRpcUrl,
  assertEventsResponse,
  clampRetryDelayMs,
  DEFAULT_MAX_EVENTS_PER_RESPONSE,
  parseRetryAfterHeaderMs,
  RpcResponseShapeError,
  wrapOversizedResponseError,
} from "../dist/stellar/rpc-guard.js";
import {
  DEFAULT_RPC_MAX_BACKOFF_MS,
  resolveMaxBackoffMs,
} from "../dist/stellar/client.js";
import { extractRetryAfterMs } from "../dist/poller.js";
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

// ── Untrusted RPC retry-delay clamping ─────────────────────────────────────────

test("resolveMaxBackoffMs returns default when omitted and rejects invalid ceilings", () => {
  assert.equal(resolveMaxBackoffMs(undefined), DEFAULT_RPC_MAX_BACKOFF_MS);
  assert.equal(resolveMaxBackoffMs(15_000), 15_000);
  assert.equal(resolveMaxBackoffMs(0), 0);

  for (const invalid of [-1, NaN, Infinity, -Infinity, "60000"]) {
    assert.throws(() => resolveMaxBackoffMs(invalid), RangeError);
  }
});

test("clampRetryDelayMs rejects negative, nonfinite, and non-numeric values and clamps oversized delays", () => {
  assert.equal(clampRetryDelayMs(5_000, 10_000), 5_000);
  assert.equal(clampRetryDelayMs(0, 10_000), 0);
  assert.equal(clampRetryDelayMs(50_000, 10_000), 10_000);
  assert.equal(clampRetryDelayMs(DEFAULT_RPC_MAX_BACKOFF_MS + 1), DEFAULT_RPC_MAX_BACKOFF_MS);

  for (const invalid of [-1, -0.001, NaN, Infinity, -Infinity, "1000", null, undefined]) {
    assert.equal(clampRetryDelayMs(invalid, 10_000), null);
  }
});

test("parseRetryAfterHeaderMs rejects malformed/negative/nonfinite headers and keeps maxBackoffMs authoritative", () => {
  assert.equal(parseRetryAfterHeaderMs("5", 10_000), 5_000);
  assert.equal(parseRetryAfterHeaderMs(" 1.5 ", 10_000), 1_500);
  assert.equal(parseRetryAfterHeaderMs("0", 10_000), 0);
  assert.equal(parseRetryAfterHeaderMs("3600", 15_000), 15_000);
  assert.equal(parseRetryAfterHeaderMs(120, 30_000), 30_000);

  for (const invalid of [
    "-5",
    "-1",
    "NaN",
    "Infinity",
    "10abc",
    "",
    "1e308",
    -10,
    NaN,
    Infinity,
    null,
    undefined,
  ]) {
    assert.equal(parseRetryAfterHeaderMs(invalid, 10_000), null);
  }
});

test("extractRetryAfterMs respects configured maxBackoffMs and rejects invalid RPC headers", () => {
  const oversizedErr = { headers: { "Retry-After": "999999" } };
  assert.equal(extractRetryAfterMs(oversizedErr, 12_000), 12_000);

  const negativeErr = { headers: { "retry-after": "-30" } };
  assert.equal(extractRetryAfterMs(negativeErr, 12_000), null);

  const nonFiniteErr = { parameters: { retry_after: Infinity } };
  assert.equal(extractRetryAfterMs(nonFiniteErr, 12_000), null);

  const garbageErr = { headers: { "Retry-After": "10seconds" } };
  assert.equal(extractRetryAfterMs(garbageErr, 12_000), null);
});
