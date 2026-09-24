import assert from "node:assert/strict";
import test from "node:test";

import { decodeEvent } from "../dist/stellar/decode.js";
import { readContractEvents } from "../dist/stellar/events.js";

function malformedEvent() {
  return {
    contractId: "C" + "A".repeat(55),
    ledger: 42,
    ledgerClosedAt: "2026-09-25T00:00:00.000Z",
    txHash: "",
    id: "42-0",
    topic: [],
    value: new Proxy(
      {},
      {
        get() {
          throw new Error("malformed-xdr-".repeat(100));
        },
      },
    ),
  };
}

test("malformed XDR becomes a bounded unknown event instead of throwing", () => {
  const decoded = decodeEvent("market", malformedEvent());

  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.ledger, 42);
  assert.ok(decoded.payload.reason);
  assert.ok(decoded.payload.reason.length <= 240);
  assert.match(decoded.payload.reason, /malformed-xdr/);
});

test("a malformed event does not stop cursor-paginated scanning", async () => {
  let requests = 0;
  const server = {
    getHealth: async () => ({ oldestLedger: 1, latestLedger: 42 }),
    getEvents: async () => {
      requests += 1;
      return {
        events: [malformedEvent()],
        latestLedger: 42,
        cursor: "180388626432-0",
      };
    },
  };

  const scan = await readContractEvents(
    server,
    { source: "market", contractId: "C" + "A".repeat(55) },
    { startLedger: 1, maxPages: 1 },
  );

  assert.equal(requests, 1);
  assert.equal(scan.cursor, "180388626432-0");
  assert.equal(scan.events.length, 1);
  assert.equal(scan.events[0].payload.name, "unknown");
});