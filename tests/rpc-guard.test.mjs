import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  assertEventsResponse,
  assertRpcResponseSize,
  DEFAULT_MAX_EVENTS_PER_RESPONSE,
  DEFAULT_MAX_RESPONSE_BYTES,
  RpcResponseShapeError,
  wrapOversizedResponseError,
} from "../dist/stellar/rpc-guard.js";
import { createRpcServer } from "../dist/stellar/client.js";
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

// ── Response byte-limit guard ──────────────────────────────────────────────────

test("assertRpcResponseSize accepts responses up to and including maxBytes", () => {
  assert.doesNotThrow(() => assertRpcResponseSize(0, 1024));
  assert.doesNotThrow(() => assertRpcResponseSize(1024, 1024));
  assert.doesNotThrow(() => assertRpcResponseSize(DEFAULT_MAX_RESPONSE_BYTES));
});

test("assertRpcResponseSize rejects responses exceeding maxBytes", () => {
  assert.throws(
    () => assertRpcResponseSize(1025, 1024),
    (err) => {
      assert(err instanceof RpcResponseShapeError);
      assert.equal(err.problem, "response-oversized");
      assert.match(err.message, /1025 bytes exceeds limit of 1024 bytes/);
      assert(err.message.length <= 150);
      return true;
    },
  );
});

test("wrapOversizedResponseError normalizes maxContentLength errors and preserves others", () => {
  const sdkErr = new Error("maxContentLength size of 2048 exceeded");
  const wrapped = wrapOversizedResponseError(sdkErr, 2048);
  assert(wrapped instanceof RpcResponseShapeError);
  assert.equal(wrapped.problem, "response-oversized");
  assert.match(wrapped.message, /2048 bytes/);

  const unrelated = new Error("ECONNRESET");
  assert.equal(wrapOversizedResponseError(unrelated, 2048), unrelated);
});

async function startFakeRpcServer(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      handler(body, res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("createRpcServer aborts oversized getEvents response before JSON parsing and leaves cursor unchanged", async () => {
  const limitBytes = 512;
  const fakeRpc = await startFakeRpcServer((body, res) => {
    if (body.method === "getHealth") {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { status: "healthy", oldestLedger: 900, latestLedger: 1000 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
      return;
    }

    // Stream an oversized, invalid-JSON payload without Content-Length (chunked)
    // to prove the client aborts while reading bytes rather than parsing JSON.
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"jsonrpc":"2.0","id":1,"result":{"events":[');
    res.write(`"${"X".repeat(limitBytes * 2)}"`);
    // Intentionally omit closing JSON brackets: if JSON.parse ran, it would throw SyntaxError.
    res.end();
  });

  try {
    const server = createRpcServer({
      rpcUrl: fakeRpc.url,
      horizonUrl: fakeRpc.url,
      networkPassphrase: "Test SDF Network ; September 2015",
      marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      marketContractVersion: "v1",
      squadContractVersion: "v1",
      explorerBaseUrl: "https://stellar.expert/explorer",
      rpcMaxResponseBytes: limitBytes,
    });

    const initialCursor = "0000000950000000000-0000000000";
    let targetCursor = initialCursor;

    await assert.rejects(
      async () => {
        const result = await paginatedGetEvents(server, [], { cursor: targetCursor });
        if (result.cursor) targetCursor = result.cursor;
      },
      (err) => {
        assert(err instanceof RpcResponseShapeError);
        assert.equal(err.problem, "response-oversized");
        assert.match(err.message, /512 bytes/);
        return true;
      },
    );

    assert.equal(targetCursor, initialCursor, "target cursor must remain unchanged on oversized response");
  } finally {
    await fakeRpc.close();
  }
});

test("createRpcServer accepts getEvents response within configured rpcMaxResponseBytes", async () => {
  const fakeRpc = await startFakeRpcServer((body, res) => {
    if (body.method === "getHealth") {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { status: "healthy", oldestLedger: 900, latestLedger: 1000 },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
      return;
    }

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        events: [],
        cursor: "0000001000000000000-0000000000",
        latestLedger: 1000,
      },
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    });
    res.end(payload);
  });

  try {
    const server = createRpcServer({
      rpcUrl: fakeRpc.url,
      horizonUrl: fakeRpc.url,
      networkPassphrase: "Test SDF Network ; September 2015",
      marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      marketContractVersion: "v1",
      squadContractVersion: "v1",
      explorerBaseUrl: "https://stellar.expert/explorer",
      rpcMaxResponseBytes: 4096,
    });

    const result = await paginatedGetEvents(server, [], {
      cursor: "0000000950000000000-0000000000",
    });
    assert.equal(result.cursor, "0000001000000000000-0000000000");
  } finally {
    await fakeRpc.close();
  }
});
