import assert from "node:assert/strict";
import test from "node:test";
import { decodeEvent } from "../dist/stellar/decode.js";

test("malformed XDR never crashes the scanner", () => {
  const malformedEvent = {
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "C123",
    id: "100-1",
    pagingToken: "100-1",
    topic: ["malformed_xdr"], // Not actual scVal objects, this will fail native()
    value: "definitely_not_xdr",
  };

  // Ensure it doesn't throw, but returns a gracefully degraded unknown event
  const decoded = decodeEvent("market", malformedEvent);
  
  assert.equal(decoded.source, "market");
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "");
  // reason should be populated without crashing
  assert.ok(decoded.payload.reason.length > 0);
});
