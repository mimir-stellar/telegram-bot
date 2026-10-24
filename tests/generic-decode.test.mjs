/**
 * Tests for generic Soroban contract event decoding and plain-text notifications:
 * - src/stellar/generic-decode.ts
 * - src/notifications/generic.ts
 *
 * Invariants verified:
 * 1. Every ScVal type maps to a stable, unambiguous textual representation with a type tag.
 * 2. Hostile nesting (deep vectors, deep maps, wide maps/vectors, oversized strings/bytes) is bounded.
 * 3. Never throws on malformed XDR, unknown discriminators, nulls, or circular payloads.
 * 4. formatGenericEvent emits bounded plain text with optional explorer URL.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, xdr } from "@stellar/stellar-sdk";

import {
  MAX_GENERIC_BYTES_CHARS,
  MAX_GENERIC_DEPTH,
  MAX_GENERIC_KEYS,
  MAX_GENERIC_STRING_CHARS,
  MAX_GENERIC_VEC_ITEMS,
  decodeGenericEvent,
  renderGenericScVal,
  renderScVal,
  renderTopics,
} from "../dist/stellar/generic-decode.js";

import {
  MAX_GENERIC_NOTIFICATION_LENGTH,
  formatGenericEvent,
} from "../dist/notifications/generic.js";

// ── Deterministic Test Identities ────────────────────────────────────────────

const TEST_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));
const TEST_G_ADDR = TEST_KP.publicKey();
const TEST_C_ADDR = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_TX_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function testConfig(overrides = {}) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    chatId: "-1001234567890",
    ...overrides,
  };
}

// ── ScVal Builders ───────────────────────────────────────────────────────────

function scBool(b) {
  return xdr.ScVal.scvBool(Boolean(b));
}

function scVoid() {
  return xdr.ScVal.scvVoid();
}

function scU32(n) {
  return xdr.ScVal.scvU32(Number(n));
}

function scI32(n) {
  return xdr.ScVal.scvI32(Number(n));
}

function scU64(n) {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(n)));
}

function scI64(n) {
  return xdr.ScVal.scvI64(xdr.Int64.fromString(String(n)));
}

function scTimepoint(n) {
  return xdr.ScVal.scvTimepoint(new xdr.TimePoint(xdr.Uint64.fromString(String(n))));
}

function scDuration(n) {
  return xdr.ScVal.scvDuration(new xdr.Duration(xdr.Uint64.fromString(String(n))));
}

function scU128(n) {
  const bn = BigInt(n);
  const lo = bn & 0xffff_ffff_ffff_ffffn;
  const hi = bn >> 64n;
  return xdr.ScVal.scvU128(
    new xdr.UInt128Parts({
      hi: xdr.Uint64.fromString(String(hi)),
      lo: xdr.Uint64.fromString(String(lo)),
    }),
  );
}

function scI128(n) {
  const bn = BigInt(n);
  const isNeg = bn < 0n;
  const abs = isNeg ? -bn : bn;
  const lo = abs & 0xffff_ffff_ffff_ffffn;
  let hi = abs >> 64n;
  if (isNeg) {
    hi = (~hi + (lo === 0n ? 1n : 0n)) & 0xffff_ffff_ffff_ffffn;
    const loVal = lo === 0n ? 0n : (~lo + 1n) & 0xffff_ffff_ffff_ffffn;
    return xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: xdr.Int64.fromString(String(BigInt.asIntN(64, hi))),
        lo: xdr.Uint64.fromString(String(loVal)),
      }),
    );
  }
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString("0"),
      lo: xdr.Uint64.fromString(String(lo)),
    }),
  );
}

function scU256(n) {
  const bn = BigInt(n);
  return xdr.ScVal.scvU256(
    new xdr.UInt256Parts({
      hiHi: xdr.Uint64.fromString("0"),
      hiLo: xdr.Uint64.fromString("0"),
      loHi: xdr.Uint64.fromString("0"),
      loLo: xdr.Uint64.fromString(String(bn)),
    }),
  );
}

function scI256(n) {
  const bn = BigInt(n);
  return xdr.ScVal.scvI256(
    new xdr.Int256Parts({
      hiHi: xdr.Int64.fromString("0"),
      hiLo: xdr.Uint64.fromString("0"),
      loHi: xdr.Uint64.fromString("0"),
      loLo: xdr.Uint64.fromString(String(bn)),
    }),
  );
}

function scBytes(hexStr) {
  return xdr.ScVal.scvBytes(Buffer.from(hexStr, "hex"));
}

function scString(s) {
  return xdr.ScVal.scvString(String(s));
}

function scSymbol(s) {
  return xdr.ScVal.scvSymbol(String(s));
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

function scError(code = 404) {
  return xdr.ScVal.scvError(xdr.ScError.sceContract(code));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Every ScVal Type Maps to a Stable Textual Representation
// ─────────────────────────────────────────────────────────────────────────────

test("scvBool renders with bool: tag", () => {
  assert.equal(renderGenericScVal(scBool(true)), "bool:true");
  assert.equal(renderGenericScVal(scBool(false)), "bool:false");
});

test("scvVoid renders as void", () => {
  assert.equal(renderGenericScVal(scVoid()), "void");
});

test("scvU32 renders with u32: tag", () => {
  assert.equal(renderGenericScVal(scU32(42)), "u32:42");
  assert.equal(renderGenericScVal(scU32(0)), "u32:0");
});

test("scvI32 renders with i32: tag", () => {
  assert.equal(renderGenericScVal(scI32(-42)), "i32:-42");
  assert.equal(renderGenericScVal(scI32(100)), "i32:100");
});

test("scvU64 renders with u64: tag", () => {
  assert.equal(renderGenericScVal(scU64(1000000)), "u64:1000000");
});

test("scvI64 renders with i64: tag", () => {
  assert.equal(renderGenericScVal(scI64(-99999)), "i64:-99999");
});

test("scvTimepoint renders with timepoint: tag", () => {
  assert.equal(renderGenericScVal(scTimepoint(1700000000)), "timepoint:1700000000");
});

test("scvDuration renders with duration: tag", () => {
  assert.equal(renderGenericScVal(scDuration(3600)), "duration:3600");
});

test("scvU128 renders with u128: tag", () => {
  assert.equal(renderGenericScVal(scU128(50000000)), "u128:50000000");
});

test("scvI128 renders with i128: tag", () => {
  assert.equal(renderGenericScVal(scI128(10000000)), "i128:10000000");
  assert.equal(renderGenericScVal(scI128(-5000000)), "i128:-5000000");
});

test("scvU256 renders with u256: tag", () => {
  assert.equal(renderGenericScVal(scU256(12345)), "u256:12345");
});

test("scvI256 renders with i256: tag", () => {
  assert.equal(renderGenericScVal(scI256(67890)), "i256:67890");
});

test("scvBytes renders with bytes: tag and lowercase hex", () => {
  assert.equal(renderGenericScVal(scBytes("deadbeef0102")), "bytes:deadbeef0102");
});

test("scvString renders with string: tag and quotes", () => {
  assert.equal(renderGenericScVal(scString("hello world")), 'string:"hello world"');
});

test("scvSymbol renders with symbol: tag", () => {
  assert.equal(renderGenericScVal(scSymbol("transfer")), "symbol:transfer");
});

test("scvAddress renders with address: tag for both G... and C... addresses", () => {
  assert.equal(renderGenericScVal(scAddress(TEST_G_ADDR)), `address:${TEST_G_ADDR}`);
  assert.equal(renderGenericScVal(scAddress(TEST_C_ADDR)), `address:${TEST_C_ADDR}`);
});

test("scvVec renders with vec:[...] containing typed elements", () => {
  const v = scVec([scU32(1), scSymbol("alpha"), scBool(true)]);
  assert.equal(renderGenericScVal(v), "vec:[u32:1, symbol:alpha, bool:true]");
});

test("scvMap renders with map:{...} containing key-value pairs", () => {
  const m = scMap([
    [scSymbol("id"), scU32(7)],
    [scSymbol("active"), scBool(true)],
  ]);
  assert.equal(renderGenericScVal(m), "map:{symbol:id: u32:7, symbol:active: bool:true}");
});

test("scvError renders with error tag", () => {
  const err = scError(404);
  assert.match(renderGenericScVal(err), /^error:/);
});

test("native JS types render with appropriate type tags", () => {
  assert.equal(renderGenericScVal(true), "bool:true");
  assert.equal(renderGenericScVal(false), "bool:false");
  assert.equal(renderGenericScVal(null), "void");
  assert.equal(renderGenericScVal(undefined), "void");
  assert.equal(renderGenericScVal(42), "number:42");
  assert.equal(renderGenericScVal(100n), "bigint:100");
  assert.equal(renderGenericScVal("regular string"), 'string:"regular string"');
  assert.equal(renderGenericScVal(TEST_G_ADDR), `address:${TEST_G_ADDR}`);
  assert.equal(renderGenericScVal(Buffer.from([0x01, 0x02])), "bytes:0102");
  assert.equal(renderGenericScVal([1, 2]), "vec:[number:1, number:2]");
  assert.equal(renderGenericScVal({ a: 1 }), "map:{a: number:1}");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Hostile Nesting Is Bounded
// ─────────────────────────────────────────────────────────────────────────────

test("hostile nesting: deep vectors are bounded by MAX_GENERIC_DEPTH", () => {
  let cur = scU32(42);
  for (let i = 0; i < 20; i++) {
    cur = scVec([cur]);
  }
  const rendered = renderGenericScVal(cur);
  assert.ok(rendered.length < 500, "rendered depth must not explode");
  assert.ok(rendered.includes("vec:[...]"), "must stop recursing at depth cap");
});

test("hostile nesting: deep maps are bounded by MAX_GENERIC_DEPTH", () => {
  let cur = scU32(99);
  for (let i = 0; i < 20; i++) {
    cur = scMap([[scSymbol(`k${i}`), cur]]);
  }
  const rendered = renderGenericScVal(cur);
  assert.ok(rendered.length < 500, "rendered depth must not explode");
  assert.ok(rendered.includes("map:{...}"), "must stop recursing at depth cap");
});

test("hostile nesting: alternating vectors of maps of vectors do not crash or exceed bound", () => {
  let cur = scU32(1);
  for (let i = 0; i < 15; i++) {
    cur = i % 2 === 0 ? scVec([cur]) : scMap([[scSymbol("nest"), cur]]);
  }
  assert.doesNotThrow(() => {
    const rendered = renderGenericScVal(cur);
    assert.ok(typeof rendered === "string");
  });
});

test("custom maxDepth option overrides default depth limit", () => {
  const nested = scVec([scVec([scVec([scU32(1)])])]);
  const shallow = renderGenericScVal(nested, 0, { maxDepth: 1 });
  assert.equal(shallow, "vec:[vec:[...]]");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Wide Maps & Vectors Are Bounded (Key / Item Caps)
// ─────────────────────────────────────────────────────────────────────────────

test("wide vectors are capped at MAX_GENERIC_VEC_ITEMS with truncation note", () => {
  const items = Array.from({ length: 50 }, (_, i) => scU32(i));
  const v = scVec(items);
  const rendered = renderGenericScVal(v);
  assert.ok(rendered.includes("… (+30 more)"));
  assert.ok(rendered.startsWith("vec:[u32:0, u32:1,"));
});

test("wide maps are capped at MAX_GENERIC_KEYS with truncation note", () => {
  const pairs = Array.from({ length: 60 }, (_, i) => [scSymbol(`key_${i}`), scU32(i)]);
  const m = scMap(pairs);
  const rendered = renderGenericScVal(m);
  assert.ok(rendered.includes("… (+40 more)"));
  assert.ok(rendered.startsWith("map:{symbol:key_0: u32:0,"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. String & Byte Length Bounds & Sanitization
// ─────────────────────────────────────────────────────────────────────────────

test("oversized string is clipped to MAX_GENERIC_STRING_CHARS with ellipsis", () => {
  const huge = "A".repeat(500);
  const rendered = renderGenericScVal(scString(huge));
  assert.ok(rendered.length <= MAX_GENERIC_STRING_CHARS + 12);
  assert.ok(rendered.endsWith('…"'));
});

test("oversized symbol is clipped with ellipsis", () => {
  const huge = "s".repeat(200);
  const rendered = renderGenericScVal(scSymbol(huge));
  assert.ok(rendered.length <= MAX_GENERIC_STRING_CHARS + 10);
  assert.ok(rendered.endsWith("…"));
});

test("oversized bytes buffer is clipped to MAX_GENERIC_BYTES_CHARS hex with ellipsis", () => {
  const hugeHex = "ab".repeat(200); // 400 hex chars
  const rendered = renderGenericScVal(scBytes(hugeHex));
  assert.ok(rendered.length <= MAX_GENERIC_BYTES_CHARS + 10);
  assert.ok(rendered.endsWith("…"));
});

test("strings with newlines and control characters are sanitized into single spaces", () => {
  const dirty = "first line\r\nsecond line\twith tab";
  const rendered = renderGenericScVal(scString(dirty));
  assert.ok(!rendered.includes("\n"));
  assert.ok(!rendered.includes("\r"));
  assert.ok(!rendered.includes("\t"));
  assert.equal(rendered, 'string:"first line second line with tab"');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Malformed XDR & Error Safety (Never Throws)
// ─────────────────────────────────────────────────────────────────────────────

test("malformed XDR: object with throwing switch() returns malformed without throwing", () => {
  const corrupt = {
    switch: () => {
      throw new Error("Invalid XDR discriminator 9999");
    },
  };
  assert.doesNotThrow(() => {
    const res = renderGenericScVal(corrupt);
    assert.equal(res, "malformed");
  });
});

test("malformed XDR: throwing getter does not throw", () => {
  const throwingObj = {
    get value() {
      throw new Error("corrupt getter");
    },
  };
  assert.doesNotThrow(() => {
    const res = renderGenericScVal(throwingObj);
    assert.ok(typeof res === "string");
  });
});

test("circular native object does not loop infinitely", () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.doesNotThrow(() => {
    const res = renderGenericScVal(obj);
    assert.ok(res.includes("[circular]"));
  });
});

test("circular native array does not loop infinitely", () => {
  const arr = [1];
  arr.push(arr);
  assert.doesNotThrow(() => {
    const res = renderGenericScVal(arr);
    assert.ok(res.includes("[circular]"));
  });
});

test("renderTopics handles null, undefined, and non-array safely", () => {
  assert.deepEqual(renderTopics(null), []);
  assert.deepEqual(renderTopics(undefined), []);
  assert.deepEqual(renderTopics("not an array"), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. decodeGenericEvent Integration
// ─────────────────────────────────────────────────────────────────────────────

test("decodeGenericEvent populates all event meta and generic payload fields", () => {
  const rawEvent = {
    contractId: TEST_C_ADDR,
    ledger: 123456,
    txHash: VALID_TX_HASH,
    ledgerClosedAt: "2026-03-01T12:00:00Z",
    id: "0018276211125911551-0000000001",
    type: "contract",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [scSymbol("mint"), scAddress(TEST_G_ADDR), scU64(5000)],
    value: scMap([[scSymbol("amount"), scI128(100_000_000)]]),
  };

  const decoded = decodeGenericEvent(rawEvent, "token");

  assert.equal(decoded.source, "token");
  assert.equal(decoded.contractId, TEST_C_ADDR);
  assert.equal(decoded.ledger, 123456);
  assert.equal(decoded.txHash, VALID_TX_HASH);
  assert.equal(decoded.eventName, "mint");
  assert.equal(decoded.topics.length, 3);
  assert.equal(decoded.topics[0], "symbol:mint");
  assert.equal(decoded.topics[1], `address:${TEST_G_ADDR}`);
  assert.equal(decoded.topics[2], "u64:5000");
  assert.equal(decoded.value, "map:{symbol:amount: i128:100000000}");
  assert.equal(decoded.payload.name, "generic");
  assert.equal(decoded.payload.eventName, "mint");
  assert.ok(decoded.summary.includes("[mint]"));
});

test("decodeGenericEvent never throws on completely empty, null or corrupt input", () => {
  const empty = decodeGenericEvent(null);
  assert.equal(empty.eventName, "unknown");
  assert.equal(empty.topics.length, 0);
  assert.equal(empty.value, "void");
  assert.equal(empty.ledger, 0);
  assert.equal(empty.txHash, "");

  const corrupt = decodeGenericEvent({
    contractId: null,
    topic: [null, { switch: () => { throw new Error("bad"); } }],
    value: { switch: () => { throw new Error("bad"); } },
  });
  assert.equal(corrupt.eventName, "unknown");
  assert.equal(corrupt.topics[0], "void");
  assert.equal(corrupt.topics[1], "malformed");
  assert.equal(corrupt.value, "malformed");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. formatGenericEvent Plain-Text Output
// ─────────────────────────────────────────────────────────────────────────────

test("formatGenericEvent outputs clean, plain text with contract, event, topics and value", () => {
  const decoded = decodeGenericEvent({
    contractId: TEST_C_ADDR,
    ledger: 4226691,
    txHash: VALID_TX_HASH,
    topic: [scSymbol("transfer"), scAddress(TEST_G_ADDR)],
    value: scMap([[scSymbol("amount"), scI128(50_000_000)]]),
  });

  const formatted = formatGenericEvent(decoded);
  assert.ok(!formatted.includes("*"), "must not include Markdown bold asterisks");
  assert.ok(!formatted.includes("_"), "must not include Markdown italics underscores");
  assert.ok(!formatted.includes("[tx]("), "must not include Markdown link brackets");

  assert.ok(formatted.includes("Event: transfer"));
  assert.ok(formatted.includes("Topics: symbol:transfer | address:"));
  assert.ok(formatted.includes("Value: map:{symbol:amount: i128:50000000}"));
  assert.ok(formatted.includes("ledger 4226691"));
  assert.ok(formatted.includes(VALID_TX_HASH));
});

test("formatGenericEvent appends explorer URL when config and txHash are provided", () => {
  const config = testConfig();
  const decoded = decodeGenericEvent({
    contractId: TEST_C_ADDR,
    ledger: 4226691,
    txHash: VALID_TX_HASH,
    topic: [scSymbol("token_swap")],
    value: scVoid(),
  });

  const formatted = formatGenericEvent(decoded, config);
  assert.ok(formatted.includes("https://stellar.expert/explorer/testnet/tx/"));
});

test("formatGenericEvent works with (config, event) argument order", () => {
  const config = testConfig();
  const decoded = decodeGenericEvent({
    contractId: TEST_C_ADDR,
    ledger: 100,
    topic: [scSymbol("alert")],
    value: scString("system update"),
  });

  const formatted = formatGenericEvent(config, decoded);
  assert.ok(formatted.includes("Event: alert"));
  assert.ok(formatted.includes('Value: string:"system update"'));
});

test("formatGenericEvent never throws on null, undefined or empty input", () => {
  assert.doesNotThrow(() => {
    const res = formatGenericEvent(null);
    assert.ok(res.includes("Event:"));
  });

  assert.doesNotThrow(() => {
    const res = formatGenericEvent({});
    assert.ok(res.includes("Event:"));
  });
});

test("formatGenericEvent bounds output length under MAX_GENERIC_NOTIFICATION_LENGTH", () => {
  const hugeValue = "X".repeat(10000);
  const formatted = formatGenericEvent({
    eventName: "overflow_test",
    topics: [hugeValue],
    value: hugeValue,
  });
  assert.ok(formatted.length <= MAX_GENERIC_NOTIFICATION_LENGTH);
});
