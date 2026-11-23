import assert from "node:assert/strict";
import test from "node:test";

import { xdr } from "@stellar/stellar-sdk";

import {
  DEPTH_LIMIT_REASON,
  MAX_DECODED_COLLECTION_DEPTH,
  MAX_DECODED_EVENT_XDR_BYTES,
  decodeEvent,
  scValCollectionDepth,
} from "../dist/stellar/decode.js";
import {
  MAX_GENERIC_DEPTH,
  decodeGenericEvent,
} from "../dist/stellar/generic-decode.js";

function scvSymbol(value) {
  return xdr.ScVal.scvSymbol(value);
}

function scvU32(value) {
  return xdr.ScVal.scvU32(value);
}

function scvU64(value) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(value)));
}

function nestedVec(depth) {
  let value = scvU32(1);
  for (let i = 0; i < depth; i += 1) value = xdr.ScVal.scvVec([value]);
  return value;
}

function nestedMap(depth) {
  let value = scvU32(1);
  for (let i = 0; i < depth; i += 1) {
    value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: scvSymbol(`k${i}`), val: value }),
    ]);
  }
  return value;
}

function baseEvent(value, topic = [scvSymbol("claim_cancelled"), scvU64(7)]) {
  return {
    contractId: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCM",
    ledger: 42,
    txHash: "abcd",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    id: "42-0",
    topic,
    value,
  };
}

test("depth cap is a shared, stable interface constant", () => {
  assert.equal(MAX_DECODED_COLLECTION_DEPTH, MAX_GENERIC_DEPTH);
  assert.equal(DEPTH_LIMIT_REASON, "collection depth limit exceeded");
  assert.ok(new TextEncoder().encode(DEPTH_LIMIT_REASON).length < MAX_DECODED_EVENT_XDR_BYTES);
});

test("boundary: nesting at MAX_DECODED_COLLECTION_DEPTH still decodes", () => {
  const value = nestedVec(MAX_DECODED_COLLECTION_DEPTH);
  assert.equal(value.toXDR().byteLength < MAX_DECODED_EVENT_XDR_BYTES, true);
  const decoded = decodeEvent("market", baseEvent(value));
  assert.equal(decoded.payload.name, "claim_cancelled");
  assert.equal(decoded.payload.reason, undefined);
});

test("negative: one level past the depth cap is unknown with the stable reason", () => {
  const value = nestedVec(MAX_DECODED_COLLECTION_DEPTH + 1);
  // Tiny on the wire: this must be rejected by depth, not by the byte cap.
  assert.equal(value.toXDR().byteLength < MAX_DECODED_EVENT_XDR_BYTES, true);
  const decoded = decodeEvent("market", baseEvent(value));
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "claim_cancelled");
  assert.equal(decoded.payload.reason, DEPTH_LIMIT_REASON);
});

test("deeply nested small payloads are rejected predictably at any depth", () => {
  const reasons = new Set();
  for (const depth of [MAX_DECODED_COLLECTION_DEPTH + 1, 20, 50]) {
    const value = nestedVec(depth);
    assert.equal(value.toXDR().byteLength < MAX_DECODED_EVENT_XDR_BYTES, true);
    const decoded = decodeEvent("market", baseEvent(value));
    assert.equal(decoded.payload.name, "unknown");
    reasons.add(decoded.payload.reason);
  }
  assert.deepEqual([...reasons], [DEPTH_LIMIT_REASON]);
});

test("nested maps are bounded too, without a stack overflow", () => {
  const value = nestedMap(20);
  assert.equal(value.toXDR().byteLength < MAX_DECODED_EVENT_XDR_BYTES, true);
  assert.doesNotThrow(() => {
    const decoded = decodeEvent("market", baseEvent(value));
    assert.equal(decoded.payload.name, "unknown");
    assert.equal(decoded.payload.reason, DEPTH_LIMIT_REASON);
  });
});

test("overly deep topics are rejected before native conversion", () => {
  const topic = [scvSymbol("claim_cancelled"), nestedVec(20), scvU64(7)];
  const decoded = decodeEvent("market", baseEvent(xdr.ScVal.scvMap([]), topic));
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.reason, DEPTH_LIMIT_REASON);
});

test("maxDepth option is honored at its boundary", () => {
  const within = decodeEvent("market", baseEvent(nestedVec(2)), { maxDepth: 2 });
  assert.equal(within.payload.name, "claim_cancelled");
  const beyond = decodeEvent("market", baseEvent(nestedVec(3)), { maxDepth: 2 });
  assert.equal(beyond.payload.name, "unknown");
  assert.equal(beyond.payload.reason, DEPTH_LIMIT_REASON);
});

test("generic decode exposes the same stable reason and stays bounded", () => {
  const shallow = decodeGenericEvent(baseEvent(nestedVec(MAX_GENERIC_DEPTH)));
  assert.equal(shallow.payload.reason, undefined);

  const deep = decodeGenericEvent(baseEvent(nestedVec(MAX_GENERIC_DEPTH + 1)));
  assert.equal(deep.reason, DEPTH_LIMIT_REASON);
  assert.equal(deep.payload.reason, DEPTH_LIMIT_REASON);
  assert.ok(deep.value.length < 100);
  assert.ok(deep.value.includes("vec:[...]"));
});

test("scValCollectionDepth measures scalar, vector and map nesting without throwing", () => {
  assert.equal(scValCollectionDepth(scvU32(1)), 0);
  assert.equal(scValCollectionDepth(nestedVec(3)), 3);
  assert.equal(scValCollectionDepth(nestedMap(3)), 3);
  assert.equal(scValCollectionDepth(nestedVec(9), 4), 5);
  assert.equal(scValCollectionDepth([1, [2, [3]]]), 3);
  assert.equal(scValCollectionDepth({ a: { b: [1] } }), 3);

  const corrupt = { get value() { throw new Error("corrupt"); }, type: "scvVec" };
  assert.doesNotThrow(() => scValCollectionDepth(corrupt));
});

test("byte-size cap still reports its own reason for a shallow oversized value", () => {
  const huge = xdr.ScVal.scvString("x".repeat(MAX_DECODED_EVENT_XDR_BYTES));
  const decoded = decodeEvent("market", baseEvent(huge));
  assert.equal(decoded.payload.name, "unknown");
  assert.match(decoded.payload.reason ?? "", /exceeds cap/i);
});
