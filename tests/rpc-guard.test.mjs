import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEventsResponse,
  compareProviderEvents,
  DEFAULT_MAX_EVENTS_PER_RESPONSE,
  ProviderDisagreementTracker,
  RpcResponseShapeError,
} from "../dist/stellar/rpc-guard.js";
import { LedgerWindowError } from "../dist/stellar/client.js";
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

// ── Multi-provider disagreement tracking ───────────────────────────────────────

test("compareProviderEvents agrees when canonical identities match regardless of order", () => {
  const result = compareProviderEvents(
    { startLedger: 100, endLedger: 110 },
    {
      provider: "primary",
      events: [
        { id: "100-0", ledger: 100 },
        { eventId: "101-0", ledger: 101 },
      ],
    },
    {
      provider: "secondary",
      events: [
        { id: "101-0", ledger: 101 },
        { id: "100-0", ledger: 100 },
      ],
    },
  );

  assert.equal(result.agrees, true);
  assert.equal(result.disagrees, false);
  assert.equal(result.sharedCount, 2);
  assert.deepEqual(result.onlyInA, []);
  assert.deepEqual(result.onlyInB, []);
  assert.equal(result.unidentifiableA, 0);
  assert.equal(result.unidentifiableB, 0);
  assert.equal("winner" in result, false);
});

test("compareProviderEvents exposes disagreement symmetrically without picking a winner", () => {
  const result = compareProviderEvents(
    { startLedger: 200, endLedger: 220 },
    {
      provider: "rpc-a",
      events: [
        { id: "200-0", ledger: 200 },
        { id: "205-0", ledger: 205 },
      ],
    },
    {
      provider: "rpc-b",
      events: [
        { id: "200-0", ledger: 200 },
        { id: "210-0", ledger: 210 },
      ],
    },
  );

  assert.equal(result.agrees, false);
  assert.equal(result.disagrees, true);
  assert.equal(result.providerA, "rpc-a");
  assert.equal(result.providerB, "rpc-b");
  assert.equal(result.sharedCount, 1);
  assert.deepEqual(result.onlyInA, ["205-0"]);
  assert.deepEqual(result.onlyInB, ["210-0"]);
  assert.equal("winner" in result, false);
});

test("compareProviderEvents treats unidentifiable events as disagreement", () => {
  const result = compareProviderEvents(
    { startLedger: 300, endLedger: 310 },
    { provider: "a", events: [{ id: "300-0", ledger: 300 }, { ledger: 301 }] },
    { provider: "b", events: [{ id: "300-0", ledger: 300 }] },
  );

  assert.equal(result.agrees, false);
  assert.equal(result.disagrees, true);
  assert.equal(result.sharedCount, 1);
  assert.equal(result.unidentifiableA, 1);
  assert.equal(result.unidentifiableB, 0);
});

test("compareProviderEvents rejects malformed or inverted scan windows and non-array events", () => {
  assert.throws(
    () =>
      compareProviderEvents(
        { startLedger: 500, endLedger: 400 },
        { events: [] },
        { events: [] },
      ),
    (err) => err instanceof LedgerWindowError && err.problem === "malformed-window",
  );

  assert.throws(
    () =>
      compareProviderEvents(
        { startLedger: -1, endLedger: 10 },
        { events: [] },
        { events: [] },
      ),
    (err) => err instanceof LedgerWindowError && err.problem === "malformed-window",
  );

  assert.throws(
    () =>
      compareProviderEvents(
        { startLedger: 10, endLedger: 20 },
        { provider: "bad", events: "not-an-array" },
        { events: [] },
      ),
    (err) => err instanceof RpcResponseShapeError && err.problem === "events-not-an-array",
  );
});

test("ProviderDisagreementTracker tracks summary metrics and bounds recent history", () => {
  const tracker = new ProviderDisagreementTracker(2);
  assert.equal(tracker.hasDisagreement(), false);

  tracker.compareAndTrack(
    { startLedger: 100, endLedger: 105 },
    { events: [{ id: "100-0" }] },
    { events: [{ id: "100-0" }] },
  );
  tracker.compareAndTrack(
    { startLedger: 106, endLedger: 110 },
    { events: [{ id: "106-0" }] },
    { events: [] },
  );
  tracker.compareAndTrack(
    { startLedger: 111, endLedger: 115 },
    { events: [] },
    { events: [{ id: "111-0" }] },
  );
  tracker.compareAndTrack(
    { startLedger: 116, endLedger: 120 },
    { events: [{ id: "116-0" }] },
    { events: [{ id: "116-1" }] },
  );

  assert.equal(tracker.hasDisagreement(), true);
  const summary = tracker.summary();
  assert.equal(summary.totalWindows, 4);
  assert.equal(summary.agreedWindows, 1);
  assert.equal(summary.disagreedWindows, 3);
  assert.equal(summary.disagreementRate, 0.75);
  assert.equal(summary.recentDisagreements.length, 2);
  assert.deepEqual(
    summary.recentDisagreements.map((d) => d.window.startLedger),
    [111, 116],
  );

  tracker.clear();
  assert.equal(tracker.hasDisagreement(), false);
  assert.equal(tracker.summary().totalWindows, 0);
});
