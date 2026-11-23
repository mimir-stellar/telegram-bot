/**
 * Focused tests for event topic count validation before variant access / payload parsing:
 * - src/stellar/decode.ts (decodeEvent, MAX_EVENT_TOPICS)
 * - src/stellar/generic-decode.ts (decodeGenericEvent, MAX_GENERIC_TOPICS)
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, xdr } from "@stellar/stellar-sdk";

import {
  MAX_EVENT_TOPICS,
  decodeEvent,
} from "../dist/stellar/decode.js";
import {
  MAX_GENERIC_TOPICS,
  decodeGenericEvent,
} from "../dist/stellar/generic-decode.js";

const TEST_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x11));
const TEST_ADDR = TEST_KP.publicKey();

function sym(s) {
  return xdr.ScVal.scvSymbol(s);
}

function u64(n) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
}

function u32(n) {
  return xdr.ScVal.scvU32(n);
}

function addrVal(strkey) {
  return Address.fromString(strkey).toScVal();
}

function scStr(s) {
  return xdr.ScVal.scvString(s);
}

function scI128(n) {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString(String(n)),
    }),
  );
}

function scMap(entries) {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })),
  );
}

function makeEventWithGuardedValue(topic) {
  let valueAccessed = false;
  const event = {
    type: "contract",
    ledger: 1000,
    ledgerClosedAt: "2026-03-01T00:00:00Z",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    id: "0000004294967296000-0000000001",
    txHash: "a".repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic,
    get value() {
      valueAccessed = true;
      return scMap([["category", scStr("sports")]]);
    },
  };
  return { event, wasValueAccessed: () => valueAccessed };
}

test("decodeEvent rejects short topic vector for known event without parsing payload", () => {
  // claim_created expects 3 topics: [name, id, creator]
  const { event, wasValueAccessed } = makeEventWithGuardedValue([
    sym("claim_created"),
    u64(42),
  ]);

  const decoded = decodeEvent("market", event);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "claim_created");
  assert.match(decoded.payload.reason ?? "", /invalid topic\[\] count \(expected 3, got 2\)/);
  assert.equal(wasValueAccessed(), false, "must not advance payload parsing on short topic vector");
});

test("decodeEvent rejects oversized topic vector for known event without parsing payload", () => {
  // claim_created expects 3 topics; 4 topics is oversized for this variant
  const { event, wasValueAccessed } = makeEventWithGuardedValue([
    sym("claim_created"),
    u64(42),
    addrVal(TEST_ADDR),
    u64(999),
  ]);

  const decoded = decodeEvent("market", event);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "claim_created");
  assert.match(decoded.payload.reason ?? "", /invalid topic\[\] count \(expected 3, got 4\)/);
  assert.equal(wasValueAccessed(), false, "must not advance payload parsing on oversized topic vector");
});

test("decodeEvent rejects topic vectors exceeding MAX_EVENT_TOPICS without parsing payload", () => {
  const { event, wasValueAccessed } = makeEventWithGuardedValue([
    sym("custom_future_event"),
    u64(1),
    u64(2),
    u64(3),
    u64(4),
  ]);

  const decoded = decodeEvent("market", event);
  assert.equal(decoded.payload.name, "unknown");
  assert.equal(decoded.payload.eventName, "custom_future_event");
  assert.match(
    decoded.payload.reason ?? "",
    new RegExp(`topic count 5 exceeds maximum of ${MAX_EVENT_TOPICS}`),
  );
  assert.equal(wasValueAccessed(), false, "must not advance payload parsing above MAX_EVENT_TOPICS");
});

test("decodeEvent boundary: valid 4-topic squad deposited event decodes normally", () => {
  const event = {
    type: "contract",
    ledger: 1001,
    ledgerClosedAt: "2026-03-01T00:00:00Z",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    id: "0000004294967296001-0000000001",
    txHash: "b".repeat(64),
    topic: [sym("deposited"), u64(7), u32(1), addrVal(TEST_ADDR)],
    value: scMap([
      ["amount", scI128(50_000_000)],
      ["shares", scI128(50_000_000)],
    ]),
  };

  const decoded = decodeEvent("squad", event);
  assert.equal(decoded.payload.name, "deposited");
  assert.equal(decoded.payload.marketId, 7);
  assert.equal(decoded.payload.side, 1);
  assert.equal(decoded.payload.participant, TEST_ADDR);
});

test("decodeGenericEvent rejects empty topic vector without parsing payload", () => {
  const { event, wasValueAccessed } = makeEventWithGuardedValue([]);

  const decoded = decodeGenericEvent(event, "custom");
  assert.equal(decoded.eventName, "unknown");
  assert.deepEqual(decoded.topics, []);
  assert.equal(decoded.value, "void");
  assert.equal(decoded.payload.reason, "empty topic array");
  assert.equal(wasValueAccessed(), false, "must not advance payload parsing on empty topic vector");
});

test("decodeGenericEvent rejects oversized topic vector without parsing payload", () => {
  const { event, wasValueAccessed } = makeEventWithGuardedValue([
    sym("transfer"),
    addrVal(TEST_ADDR),
    addrVal(TEST_ADDR),
    u64(1),
    u64(2),
  ]);

  const decoded = decodeGenericEvent(event, "token");
  assert.equal(decoded.eventName, "unknown");
  assert.deepEqual(decoded.topics, []);
  assert.equal(decoded.value, "void");
  assert.match(
    decoded.payload.reason ?? "",
    new RegExp(`topic count 5 exceeds maximum of ${MAX_GENERIC_TOPICS}`),
  );
  assert.equal(wasValueAccessed(), false, "must not advance payload parsing on oversized topic vector");
});

test("decodeGenericEvent boundary: valid 4-topic event decodes normally", () => {
  const event = {
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 1002,
    txHash: "c".repeat(64),
    topic: [sym("transfer"), addrVal(TEST_ADDR), addrVal(TEST_ADDR), u64(1)],
    value: scI128(10_000_000),
  };

  const decoded = decodeGenericEvent(event, "token");
  assert.equal(decoded.eventName, "transfer");
  assert.equal(decoded.topics.length, 4);
  assert.equal(decoded.value, "i128:10000000");
  assert.equal(decoded.payload.reason, undefined);
});
