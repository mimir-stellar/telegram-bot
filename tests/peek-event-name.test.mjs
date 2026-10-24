/**
 * Unit tests for peekEventName and decodeEvent with shouldDecode hook.
 *
 * Verifies:
 *  - peekEventName with valid topic symbol, string, Uint8Array.
 *  - peekEventName with empty topics, missing topic array, null/undefined/non-object.
 *  - peekEventName with malformed or non-symbol/non-string ScVal types (never throws).
 *  - decodeEvent skips full value decoding when shouldDecode returns false for known non-admin events.
 *  - decodeEvent keeps admin events and unknown events on the existing decode path regardless of shouldDecode.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { xdr } from "@stellar/stellar-sdk";

import { peekEventName } from "../dist/stellar/peek.js";
import { decodeEvent, isAdminEventName } from "../dist/stellar/decode.js";
import {
  squadMarketCreatedEvent,
  squadDepositedEvent,
  claimCreatedEvent,
  oracleChangedEvent,
} from "./fixtures/events.mjs";

test("peekEventName extracts symbol from ScVal topic[0]", () => {
  const rawEvent = {
    topic: [xdr.ScVal.scvSymbol("deposited"), xdr.ScVal.scvU32(1)],
  };
  assert.equal(peekEventName(rawEvent), "deposited");
});

test("peekEventName extracts string from ScVal string topic[0]", () => {
  const rawEvent = {
    topic: [xdr.ScVal.scvString("market_created")],
  };
  assert.equal(peekEventName(rawEvent), "market_created");
});

test("peekEventName extracts string from plain string topic[0]", () => {
  const rawEvent = {
    topic: ["claim_created", "topic2"],
  };
  assert.equal(peekEventName(rawEvent), "claim_created");
});

test("peekEventName extracts string from Uint8Array/Buffer topic[0]", () => {
  const rawEvent = {
    topic: [Buffer.from("market_settled", "utf8")],
  };
  assert.equal(peekEventName(rawEvent), "market_settled");
});

test("peekEventName returns empty string on empty topics", () => {
  assert.equal(peekEventName({ topic: [] }), "");
});

test("peekEventName returns empty string on missing or non-array topic", () => {
  assert.equal(peekEventName({}), "");
  assert.equal(peekEventName({ topic: null }), "");
  assert.equal(peekEventName({ topic: "not-an-array" }), "");
});

test("peekEventName returns empty string on null/undefined/non-object rawEvent", () => {
  assert.equal(peekEventName(null), "");
  assert.equal(peekEventName(undefined), "");
  assert.equal(peekEventName("string-not-event"), "");
  assert.equal(peekEventName(123), "");
});

test("peekEventName returns empty string on malformed/non-string ScVal (never throws)", () => {
  // ScVal U32 or Bool cannot be an event name
  assert.equal(peekEventName({ topic: [xdr.ScVal.scvU32(42)] }), "");
  assert.equal(peekEventName({ topic: [xdr.ScVal.scvBool(true)] }), "");
  assert.equal(peekEventName({ topic: [null] }), "");
  assert.equal(peekEventName({ topic: [undefined] }), "");
  assert.equal(peekEventName({ topic: [{ bad: "object" }] }), "");
});

test("isAdminEventName identifies all admin events", () => {
  assert.equal(isAdminEventName("admin"), true);
  assert.equal(isAdminEventName("oracle_changed"), true);
  assert.equal(isAdminEventName("ownership_transferred"), true);
  assert.equal(isAdminEventName("agent_attributed"), true);
  assert.equal(isAdminEventName("fee_accrued"), true);
  assert.equal(isAdminEventName("fee_policy_set"), true);
  assert.equal(isAdminEventName("fee_policy_changed"), true);
  assert.equal(isAdminEventName("admin_custom"), true);
  assert.equal(isAdminEventName("deposited"), false);
  assert.equal(isAdminEventName("market_created"), false);
  assert.equal(isAdminEventName("claim_created"), false);
});

test("decodeEvent skips full value decoding when shouldDecode returns false", () => {
  const rawSquad = squadDepositedEvent();
  let decodedCalls = 0;
  const decoded = decodeEvent("squad", rawSquad, "v1", {
    shouldDecode: (name) => {
      decodedCalls++;
      return false;
    },
  });

  assert.equal(decodedCalls, 1);
  assert.equal(decoded.source, "squad");
  assert.equal(decoded.payload.name, "deposited");
  // Value fields are not decoded
  assert.equal((decoded.payload).amount, undefined);
  assert.equal((decoded.payload).shares, undefined);
});

test("decodeEvent does full decode when shouldDecode returns true", () => {
  const rawSquad = squadDepositedEvent();
  const decoded = decodeEvent("squad", rawSquad, "v1", {
    shouldDecode: (name) => true,
  });

  assert.equal(decoded.payload.name, "deposited");
  assert.equal(typeof (decoded.payload).amount, "bigint");
  assert.equal(typeof (decoded.payload).shares, "bigint");
});

test("decodeEvent keeps admin events on the full decode path regardless of shouldDecode", () => {
  const rawAdmin = oracleChangedEvent();
  const decoded = decodeEvent("market", rawAdmin, "v1", {
    shouldDecode: (name) => false,
  });

  assert.equal(decoded.payload.name, "oracle_changed");
  assert.ok((decoded.payload).newOracle !== undefined || (decoded.payload).admin !== undefined || (decoded.payload).details !== undefined);
});

test("decodeEvent keeps unknown events on the existing decode path regardless of shouldDecode", () => {
  const rawUnknown = {
    topic: [xdr.ScVal.scvSymbol("unknown_custom_event"), xdr.ScVal.scvU32(1)],
    value: xdr.ScVal.scvMap([]),
  };
  const decoded = decodeEvent("market", rawUnknown, "v1", {
    shouldDecode: (name) => false,
  });

  assert.equal(decoded.payload.name, "unknown");
  assert.equal((decoded.payload).eventName, "unknown_custom_event");
  assert.equal((decoded.payload).reason, "no decoder");
});
