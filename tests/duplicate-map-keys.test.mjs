/**
 * Focused tests for rejecting conflicting duplicate map keys in generic and
 * typed Soroban event payloads before conversion to JavaScript objects.
 *
 * Covers:
 * - src/stellar/generic-decode.ts (`findDuplicateMapKey`, `renderGenericScVal`, `decodeGenericEvent`)
 * - src/stellar/decode.ts (`decodeEvent`)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, xdr } from "@stellar/stellar-sdk";

import {
  MAX_GENERIC_DIAGNOSTIC_LENGTH,
  decodeGenericEvent,
  findDuplicateMapKey,
  renderGenericScVal,
} from "../dist/stellar/generic-decode.js";
import { decodeEvent } from "../dist/stellar/decode.js";

const TEST_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
const TEST_ADDR = TEST_KP.publicKey();

function scSymbol(s) {
  return xdr.ScVal.scvSymbol(String(s));
}

function scString(s) {
  return xdr.ScVal.scvString(String(s));
}

function scU32(n) {
  return xdr.ScVal.scvU32(Number(n));
}

function scU64(n) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
}

function scI128(n) {
  const bn = BigInt(n);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString(String(bn)),
    }),
  );
}

function scAddress(strkey) {
  return Address.fromString(strkey).toScVal();
}

function scVec(items) {
  return xdr.ScVal.scvVec(items);
}

function scMap(entries) {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: k, val: v })),
  );
}

// ── findDuplicateMapKey ──────────────────────────────────────────────────────

test("findDuplicateMapKey returns null for maps with distinct keys", () => {
  const map = scMap([
    [scSymbol("stake"), scI128(100)],
    [scSymbol("creator"), scString("alice")],
    [scU32(1), scU32(2)],
  ]);
  assert.equal(findDuplicateMapKey(map), null);
});

test("findDuplicateMapKey detects exact duplicate ScVal map keys", () => {
  const map = scMap([
    [scSymbol("stake"), scI128(100)],
    [scSymbol("stake"), scI128(999)],
  ]);
  const collision = findDuplicateMapKey(map);
  assert.ok(collision, "expected a duplicate key collision");
  assert.equal(collision.key, "stake");
  assert.match(collision.reason, /duplicate map key/i);
  assert.ok(collision.reason.length <= MAX_GENERIC_DIAGNOSTIC_LENGTH);
});

test("findDuplicateMapKey detects cross-type JS object key collisions", () => {
  const symAndStr = scMap([
    [scSymbol("amount"), scI128(10)],
    [scString("amount"), scI128(20)],
  ]);
  const c1 = findDuplicateMapKey(symAndStr);
  assert.ok(c1);
  assert.equal(c1.key, "amount");

  const numAndStr = scMap([
    [scU32(1), scString("first")],
    [scString("1"), scString("second")],
  ]);
  const c2 = findDuplicateMapKey(numAndStr);
  assert.ok(c2);
  assert.equal(c2.key, "1");
});

test("findDuplicateMapKey detects nested duplicate keys inside vectors and maps", () => {
  const nested = scMap([
    [
      scSymbol("items"),
      scVec([
        scMap([
          [scSymbol("k"), scU32(1)],
          [scString("k"), scU32(2)],
        ]),
      ]),
    ],
  ]);
  const collision = findDuplicateMapKey(nested);
  assert.ok(collision);
  assert.equal(collision.key, "k");
});

test("findDuplicateMapKey detects collisions in native Map instances", () => {
  const m = new Map([
    [1, "a"],
    ["1", "b"],
  ]);
  const collision = findDuplicateMapKey(m);
  assert.ok(collision);
  assert.equal(collision.key, "1");
});

// ── renderGenericScVal & decodeGenericEvent ──────────────────────────────────

test("renderGenericScVal rejects duplicate map keys with bounded malformed diagnostic", () => {
  const map = scMap([
    [scSymbol("amount"), scI128(100)],
    [scSymbol("amount"), scI128(500)],
  ]);
  const rendered = renderGenericScVal(map);
  assert.match(rendered, /^map:malformed\(duplicate map key/);
});

test("decodeGenericEvent returns bounded unknown-event diagnostic on duplicate map keys", () => {
  const raw = {
    id: "100-0",
    contractId: "C1",
    ledger: 100,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scSymbol("transfer")],
    value: scMap([
      [scSymbol("amount"), scI128(100)],
      [scString("amount"), scI128(999)],
    ]),
  };

  const decoded = decodeGenericEvent(raw);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "transfer");
  assert.equal(typeof decoded.payload.reason, "string");
  assert.match(decoded.payload.reason, /duplicate map key/i);
  assert.ok(decoded.payload.reason.length <= MAX_GENERIC_DIAGNOSTIC_LENGTH);
});

test("decodeGenericEvent bounds oversized colliding map keys in diagnostic reason", () => {
  const longKey = "K".repeat(400);
  const raw = {
    id: "101-0",
    contractId: "C1",
    ledger: 101,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scSymbol("custom_event")],
    value: scMap([
      [scString(longKey), scU32(1)],
      [scString(longKey), scU32(2)],
    ]),
  };

  const decoded = decodeGenericEvent(raw);
  assert.equal(decoded.payload.name, "unknown");
  assert.ok(decoded.payload.reason.length <= MAX_GENERIC_DIAGNOSTIC_LENGTH);
  assert.ok(!decoded.payload.reason.includes(longKey));
});

test("decodeGenericEvent preserves normal generic decoding when map keys are unique", () => {
  const raw = {
    id: "102-0",
    contractId: "C1",
    ledger: 102,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scSymbol("transfer")],
    value: scMap([
      [scSymbol("amount"), scI128(100)],
      [scSymbol("memo"), scString("ok")],
    ]),
  };

  const decoded = decodeGenericEvent(raw);
  assert.equal(decoded.payload.name, "generic");
  assert.equal(decoded.payload.reason, undefined);
});

// ── decodeEvent (typed decoder) ──────────────────────────────────────────────

test("decodeEvent rejects duplicate map keys before JS object conversion", () => {
  const raw = {
    id: "200-0",
    contractId: "C1",
    ledger: 200,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scSymbol("claim_challenged"), scU64(7), scAddress(TEST_ADDR)],
    value: scMap([
      [scSymbol("stake"), scI128(10_000_000)],
      [scString("stake"), scI128(99_000_000)],
    ]),
  };

  const decoded = decodeEvent("market", raw);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "claim_challenged");
  assert.equal(typeof decoded.payload.reason, "string");
  assert.match(decoded.payload.reason, /duplicate map key/i);
  assert.ok(decoded.payload.reason.length <= 200);
});

test("decodeEvent still decodes valid claim_challenged events with unique keys", () => {
  const raw = {
    id: "201-0",
    contractId: "C1",
    ledger: 201,
    txHash: "aabbcc",
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    topic: [scSymbol("claim_challenged"), scU64(7), scAddress(TEST_ADDR)],
    value: scMap([[scSymbol("stake"), scI128(10_000_000)]]),
  };

  const decoded = decodeEvent("market", raw);
  assert.equal(decoded.payload.name, "claim_challenged");
  assert.equal(decoded.payload.claimId, 7);
  assert.equal(decoded.payload.stake, 10_000_000n);
});
