import assert from "node:assert/strict";
import test from "node:test";

import {
  assertEventsResponse,
  DEFAULT_MAX_EVENTS_PER_RESPONSE,
  DEFAULT_MAX_LEDGER_STALL_MS,
  LedgerProgressTracker,
  RpcResponseShapeError,
} from "../dist/stellar/rpc-guard.js";
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

// ── Unit tests for LedgerProgressTracker ───────────────────────────────────────

test("LedgerProgressTracker does not flag an up-to-date provider as stale when no events exist", () => {
  let now = 1_000;
  const tracker = new LedgerProgressTracker({ maxStaleMs: 30_000, now: () => now });

  assert.equal(tracker.snapshot(), null);

  // Initial observation with zero events -> idle, not stale
  const r1 = tracker.observe({ latestLedger: 500, eventsCount: 0 });
  assert.equal(r1.status, "idle");
  assert.equal(r1.stale, false);
  assert.equal(r1.idle, true);
  assert.equal(r1.regressed, false);
  assert.equal(r1.ledgerDelta, 0);
  assert.equal(r1.stalledMs, 0);

  // 25s later, still zero events, but ledger advanced -> idle, not stale, timer reset
  now += 25_000;
  const r2 = tracker.observe({ latestLedger: 505, eventsCount: 0 });
  assert.equal(r2.status, "idle");
  assert.equal(r2.stale, false);
  assert.equal(r2.idle, true);
  assert.equal(r2.ledgerDelta, 5);
  assert.equal(r2.stalledMs, 0);

  // Another 25s later (50s total > maxStaleMs), still zero events, ledger advanced again
  now += 25_000;
  const r3 = tracker.observe({ latestLedger: 510, eventsCount: 0 });
  assert.equal(r3.status, "idle");
  assert.equal(r3.stale, false);
  assert.equal(r3.idle, true);
  assert.equal(r3.ledgerDelta, 5);
  assert.equal(r3.stalledMs, 0);
  assert.deepEqual(tracker.snapshot(), r3);
});

test("LedgerProgressTracker flags a stale provider when latestLedger fails to advance over the bounded interval", () => {
  let now = 10_000;
  const tracker = new LedgerProgressTracker({ maxStaleMs: 60_000, now: () => now });

  const r1 = tracker.observe({ latestLedger: 1000, eventsCount: 2 });
  assert.equal(r1.status, "active");
  assert.equal(r1.stale, false);

  // Within bounded interval (59_999 ms < 60_000 ms): not stale yet
  now += 59_999;
  const r2 = tracker.observe({ latestLedger: 1000, eventsCount: 0 });
  assert.equal(r2.status, "idle");
  assert.equal(r2.stale, false);
  assert.equal(r2.stalledMs, 59_999);

  // At boundary (60_000 ms >= 60_000 ms): flagged as stale-provider
  now += 1;
  const r3 = tracker.observe({ latestLedger: 1000, eventsCount: 0 });
  assert.equal(r3.status, "stale-provider");
  assert.equal(r3.stale, true);
  assert.equal(r3.idle, true);
  assert.equal(r3.stalledMs, 60_000);
  assert.equal(r3.baselineLedger, 1000);

  // Provider recovers when latestLedger advances
  now += 5_000;
  const r4 = tracker.observe({ latestLedger: 1001, eventsCount: 1 });
  assert.equal(r4.status, "active");
  assert.equal(r4.stale, false);
  assert.equal(r4.ledgerDelta, 1);
  assert.equal(r4.stalledMs, 0);
  assert.equal(r4.baselineLedger, 1001);
});

test("LedgerProgressTracker detects regressed latestLedger without resetting stall anchor", () => {
  const tracker = new LedgerProgressTracker({ maxStaleMs: DEFAULT_MAX_LEDGER_STALL_MS });

  tracker.observe({ latestLedger: 2000, eventsCount: 0, observedAtMs: 0 });

  // Provider oscillates backwards to 1998 at t=30s
  const r1 = tracker.observe({ latestLedger: 1998, eventsCount: 0, observedAtMs: 30_000 });
  assert.equal(r1.regressed, true);
  assert.equal(r1.ledgerDelta, -2);
  assert.equal(r1.baselineLedger, 2000);
  assert.equal(r1.stale, false);
  assert.equal(r1.stalledMs, 30_000);

  // Still below 2000 at t=60s -> stale-provider
  const r2 = tracker.observe({ latestLedger: 1999, eventsCount: 0, observedAtMs: 60_000 });
  assert.equal(r2.regressed, true);
  assert.equal(r2.ledgerDelta, -1);
  assert.equal(r2.baselineLedger, 2000);
  assert.equal(r2.stale, true);
  assert.equal(r2.status, "stale-provider");
});

test("LedgerProgressTracker validates options and inputs and supports reset", () => {
  assert.throws(() => new LedgerProgressTracker({ maxStaleMs: 0 }), RangeError);
  assert.throws(() => new LedgerProgressTracker({ maxStaleMs: -100 }), RangeError);
  assert.throws(() => new LedgerProgressTracker({ maxStaleMs: NaN }), RangeError);

  const tracker = new LedgerProgressTracker({ maxStaleMs: 10_000 });
  assert.throws(
    () => tracker.observe({ latestLedger: -1 }),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert.equal(err.problem, "latest-ledger-invalid");
      return true;
    },
  );

  tracker.observe({ latestLedger: 100, observedAtMs: 0 });
  assert.ok(tracker.snapshot() !== null);
  tracker.reset();
  assert.equal(tracker.snapshot(), null);
});
