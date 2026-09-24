/**
 * Unit tests for paginatedGetEvents, eventCursorLedger, and readContractEvents.
 *
 * All tests use a fake RPC server — no live Testnet connection required.
 *
 * Design principles under test:
 *  - Termination is driven by the cursor, not by page length.
 *  - An empty page is NOT the end of the scan.
 *  - startLedger and cursor are mutually exclusive request shapes.
 *  - maxPages bounds one cycle's worst case; truncated=true signals that.
 *  - When the cursor stops advancing the loop exits without an extra request.
 *  - lastCursor is always the last cursor returned by the server, even when
 *    the walk terminates because the cursor's ledger reached the chain tip.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  eventCursorLedger,
  paginatedGetEvents,
  readContractEvents,
  EVENT_PAGE_LIMIT,
  EVENT_MAX_PAGES,
} from "../dist/stellar/events.js";

// ── Cursor helpers ────────────────────────────────────────────────────────────

/**
 * Pack a ledger sequence into the high 32 bits of a TOID, like the Soroban RPC
 * does, then stringify as `<TOID>-<index>`.
 */
function makeCursor(ledger, index = 0) {
  const toid = BigInt(ledger) << 32n;
  return `${toid}-${index}`;
}

// ── Fake RPC builder ─────────────────────────────────────────────────────────

/**
 * Build a minimal fake rpc.Server.
 *
 * `pages` is an array of page descriptors:
 *   { events?: RawEvent[], cursor?: string, latestLedger?: number }
 *
 * `getHealth` returns { status: "healthy", oldestLedger, latestLedger }.
 * `getEvents` dequeues from `pages` on each call.
 */
function fakeServer({
  oldestLedger = 1,
  latestLedger = 1000,
  pages = [],
} = {}) {
  const queue = [...pages];
  const calls = [];

  return {
    calls,
    server: {
      async getHealth() {
        return { status: "healthy", oldestLedger, latestLedger };
      },
      async getEvents(req) {
        calls.push({ ...req });
        if (queue.length === 0) {
          return { events: [], cursor: "", latestLedger };
        }
        const page = queue.shift();
        return {
          events: page.events ?? [],
          cursor: page.cursor ?? "",
          latestLedger: page.latestLedger ?? latestLedger,
        };
      },
    },
  };
}

/** A minimal raw event payload the RPC would return. */
function rawEvent(ledger = 100, id = "0") {
  return {
    id: `${ledger}-${id}`,
    ledger,
    ledgerClosedAt: new Date(0).toISOString(),
    txHash: `txhash${ledger}`,
    topic: [],
    value: { _type: "xdr", xdr: "" },
    contractId: "",
    type: "contract",
    pagingToken: makeCursor(ledger),
  };
}

// ── eventCursorLedger ─────────────────────────────────────────────────────────

test("eventCursorLedger extracts the ledger from a well-formed cursor", () => {
  // ledger 500 → TOID = 500n << 32n = 2147483648000n
  const cursor = makeCursor(500);
  assert.equal(eventCursorLedger(cursor), 500);
});

test("eventCursorLedger returns null for an empty string", () => {
  assert.equal(eventCursorLedger(""), null);
});

test("eventCursorLedger returns null for a non-numeric TOID", () => {
  assert.equal(eventCursorLedger("notanumber-0"), null);
});

test("eventCursorLedger handles the all-ones sentinel cursor shape", () => {
  // The all-ones TOID that the RPC uses as a high-watermark sentinel.
  const allOnes = "0018276211125911551-4294967295";
  const ledger = eventCursorLedger(allOnes);
  // 0018276211125911551 >> 32 = 4261412863 — just needs to be a number > 0
  assert.ok(typeof ledger === "number" && ledger > 0);
});

test("eventCursorLedger returns null when TOID portion is missing", () => {
  assert.equal(eventCursorLedger("-0"), null);
});

// ── paginatedGetEvents — cursor loop termination ──────────────────────────────

test("paginatedGetEvents terminates when cursor reaches the chain tip", async () => {
  const latestLedger = 1000;
  const tipCursor = makeCursor(latestLedger);

  const { server, calls } = fakeServer({
    latestLedger,
    pages: [
      { events: [rawEvent(999)], cursor: tipCursor, latestLedger },
    ],
  });

  const result = await paginatedGetEvents(server, [], { startLedger: 900 });

  // Should stop after 1 content page — the cursor's ledger == latestLedger.
  assert.equal(result.events.length, 1);
  assert.equal(result.cursor, tipCursor);
  assert.equal(result.truncated, false);
  // 1 getHealth + 1 getEvents
  assert.equal(calls.length, 1);
});

test("paginatedGetEvents does NOT terminate on an empty page — empty is not EOF", async () => {
  const latestLedger = 1000;
  const midCursor = makeCursor(500);
  const tipCursor = makeCursor(latestLedger);

  const { server, calls } = fakeServer({
    latestLedger,
    pages: [
      // Empty page — must not stop here
      { events: [], cursor: midCursor, latestLedger },
      // Page with data — reached because we kept going
      { events: [rawEvent(999)], cursor: tipCursor, latestLedger },
    ],
  });

  const result = await paginatedGetEvents(server, [], { startLedger: 400 });

  assert.equal(result.events.length, 1, "should have collected the event from the second page");
  assert.equal(result.pages, 2, "should have fetched 2 pages");
  assert.equal(result.truncated, false);
  assert.equal(calls.length, 2);
});

test("paginatedGetEvents stops when the cursor stops advancing", async () => {
  const latestLedger = 1000;
  const stalledCursor = makeCursor(600);

  const { server, calls } = fakeServer({
    latestLedger,
    pages: [
      { events: [rawEvent(600)], cursor: stalledCursor, latestLedger },
      // Same cursor returned again — the server is stuck.
      { events: [], cursor: stalledCursor, latestLedger },
    ],
  });

  const result = await paginatedGetEvents(server, [], { startLedger: 500 });

  // The stall is detected on the SECOND request, when nextCursor === previousCursor.
  // So the loop fetches page 1 (sets previousCursor), then fetches page 2
  // (detects stall) and breaks — 2 pages total, not 1.
  assert.equal(result.pages, 2, "stall detected after 2 requests (1 to see cursor, 1 to confirm it stopped)");
  assert.equal(result.cursor, stalledCursor);
  // No third request should have been made.
  assert.equal(calls.length, 2);
});

test("paginatedGetEvents stops when the server returns an empty cursor", async () => {
  const latestLedger = 1000;

  const { server } = fakeServer({
    latestLedger,
    pages: [
      // Empty cursor signals the server has nothing more to say.
      { events: [rawEvent(500)], cursor: "", latestLedger },
    ],
  });

  const result = await paginatedGetEvents(server, [], { startLedger: 400 });

  assert.equal(result.events.length, 1);
  assert.equal(result.pages, 1);
  // lastCursor is null because the initial cursor was undefined and the server
  // returned "" — nothing to resume from.
  assert.equal(result.cursor, null);
});

test("paginatedGetEvents honours maxPages and sets truncated=true", async () => {
  const latestLedger = 10000;

  // Build 5 pages that all look like the tip is far away.
  const pages = Array.from({ length: 5 }, (_, i) => ({
    events: [rawEvent(100 + i)],
    cursor: makeCursor(100 + i),
    latestLedger,
  }));

  const { server, calls } = fakeServer({ latestLedger, pages });

  const result = await paginatedGetEvents(server, [], {
    startLedger: 100,
    maxPages: 3,
  });

  assert.equal(result.truncated, true, "should be truncated after maxPages");
  assert.equal(result.pages, 3);
  // Should have fetched exactly 3 pages (not the 4th or 5th).
  assert.equal(calls.length, 3);
});

test("paginatedGetEvents accumulates events across multiple pages", async () => {
  const latestLedger = 1000;

  const pages = [
    { events: [rawEvent(100), rawEvent(101)], cursor: makeCursor(200), latestLedger },
    { events: [rawEvent(200), rawEvent(201)], cursor: makeCursor(300), latestLedger },
    { events: [rawEvent(300)], cursor: makeCursor(latestLedger), latestLedger },
  ];

  const { server } = fakeServer({ latestLedger, pages });

  const result = await paginatedGetEvents(server, [], { startLedger: 50 });

  assert.equal(result.events.length, 5, "all events from all pages");
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
});

// ── Request shape: startLedger vs cursor (mutually exclusive) ─────────────────

test("paginatedGetEvents uses startLedger on the first request when no cursor given", async () => {
  const latestLedger = 1000;

  const { server, calls } = fakeServer({
    latestLedger,
    oldestLedger: 100,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  await paginatedGetEvents(server, [], { startLedger: 500 });

  // First request must have startLedger, not cursor.
  assert.ok("startLedger" in calls[0], "first request should use startLedger");
  assert.ok(!("cursor" in calls[0]) || calls[0].cursor === undefined,
    "first request must not have cursor");
});

test("paginatedGetEvents uses cursor on subsequent requests (never startLedger)", async () => {
  const latestLedger = 1000;
  const midCursor = makeCursor(500);

  const { server, calls } = fakeServer({
    latestLedger,
    pages: [
      { events: [], cursor: midCursor, latestLedger },
      { events: [], cursor: makeCursor(latestLedger), latestLedger },
    ],
  });

  await paginatedGetEvents(server, [], { startLedger: 100 });

  // Second request must use cursor, not startLedger.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, midCursor);
  assert.ok(!("startLedger" in calls[1]), "follow-up request must not have startLedger");
});

test("paginatedGetEvents passes an existing cursor directly on the first request", async () => {
  const latestLedger = 1000;
  const resumeCursor = makeCursor(700);

  const { server, calls } = fakeServer({
    latestLedger,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  await paginatedGetEvents(server, [], { cursor: resumeCursor });

  assert.equal(calls[0].cursor, resumeCursor);
  assert.ok(!("startLedger" in calls[0]), "cursor resume must not send startLedger");
});

// ── Floor clamping ────────────────────────────────────────────────────────────

test("paginatedGetEvents clamps startLedger up to the retained floor", async () => {
  const latestLedger = 5000;
  const oldestLedger = 3000;

  const { server, calls } = fakeServer({
    latestLedger,
    oldestLedger,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  // Ask to start at 100, which is below the retained floor.
  await paginatedGetEvents(server, [], { startLedger: 100 });

  // The actual startLedger sent must be clamped to oldestLedger.
  assert.equal(calls[0].startLedger, oldestLedger);
});

// ── lookbackLedgers cold-start ────────────────────────────────────────────────

test("paginatedGetEvents derives startLedger from lookbackLedgers on cold start", async () => {
  const latestLedger = 1000;
  const oldestLedger = 1;
  const lookback = 60;

  const { server, calls } = fakeServer({
    latestLedger,
    oldestLedger,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  await paginatedGetEvents(server, [], { lookbackLedgers: lookback });

  const expected = Math.max(1, latestLedger - lookback);
  assert.equal(calls[0].startLedger, expected);
});

// ── Return values ─────────────────────────────────────────────────────────────

test("paginatedGetEvents exposes oldestLedger and latestLedger from health", async () => {
  const oldestLedger = 42;
  const latestLedger = 9999;

  const { server } = fakeServer({
    oldestLedger,
    latestLedger,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  const result = await paginatedGetEvents(server, [], { startLedger: oldestLedger });

  assert.equal(result.oldestLedger, oldestLedger);
  assert.equal(result.latestLedger, latestLedger);
});

test("paginatedGetEvents returns the last cursor seen even when events are empty", async () => {
  const latestLedger = 1000;
  const cursor1 = makeCursor(500);
  const cursor2 = makeCursor(latestLedger);

  const { server } = fakeServer({
    latestLedger,
    pages: [
      { events: [], cursor: cursor1, latestLedger },
      { events: [], cursor: cursor2, latestLedger },
    ],
  });

  const result = await paginatedGetEvents(server, [], { startLedger: 1 });

  assert.equal(result.cursor, cursor2, "last cursor should be the tip cursor");
  assert.equal(result.events.length, 0);
});

// ── readContractEvents ────────────────────────────────────────────────────────

test("readContractEvents decodes events and computes lastEventLedger", async () => {
  const latestLedger = 2000;

  // A minimal raw Soroban event for a claim_created.
  // We only care that the decoded shape is what decodeEvent produces — no need
  // to build a real XDR value, so we test the integration by inspecting the
  // unknown payload it degrades to (the fake value is not valid XDR).
  const fakeRawEvent = {
    ...rawEvent(1500),
    ledger: 1500,
  };

  const { server } = fakeServer({
    latestLedger,
    pages: [
      { events: [fakeRawEvent], cursor: makeCursor(latestLedger), latestLedger },
    ],
  });

  const scan = await readContractEvents(
    server,
    { source: "market", contractId: "CFAKE" },
    { startLedger: 1000 },
  );

  assert.equal(scan.source, "market");
  assert.equal(scan.contractId, "CFAKE");
  assert.equal(scan.events.length, 1);
  // The raw event has ledger=1500 so lastEventLedger should be 1500.
  assert.equal(scan.lastEventLedger, 1500);
  assert.equal(scan.truncated, false);
});

test("readContractEvents returns null lastEventLedger when no events found", async () => {
  const latestLedger = 2000;

  const { server } = fakeServer({
    latestLedger,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  const scan = await readContractEvents(
    server,
    { source: "squad", contractId: "CFAKE" },
    { startLedger: 1000 },
  );

  assert.equal(scan.lastEventLedger, null);
  assert.equal(scan.events.length, 0);
});

test("readContractEvents passes the contractId filter to getEvents", async () => {
  const latestLedger = 2000;
  const contractId = "CMARKETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  const { server, calls } = fakeServer({
    latestLedger,
    pages: [{ events: [], cursor: makeCursor(latestLedger), latestLedger }],
  });

  await readContractEvents(server, { source: "market", contractId }, { startLedger: 1 });

  assert.deepEqual(calls[0].filters, [{ type: "contract", contractIds: [contractId] }]);
});

// ── Constants ─────────────────────────────────────────────────────────────────

test("EVENT_PAGE_LIMIT and EVENT_MAX_PAGES are exported positive integers", () => {
  assert.ok(Number.isInteger(EVENT_PAGE_LIMIT) && EVENT_PAGE_LIMIT > 0);
  assert.ok(Number.isInteger(EVENT_MAX_PAGES) && EVENT_MAX_PAGES > 0);
});
