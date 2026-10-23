/**
 * Tests for synthetic fixture determinism and event decoding.
 *
 * Covers:
 * - Calling generateSyntheticEventFixture twice with identical inputs yields deep equality.
 * - No dependence on wall-clock time unless injected (controlled clock yields stable fixtures).
 * - Generated event structures decode with decodeEvent without falling back to unknown.
 * - Metadata preservation (ledger, txHash, contractId, indexes) across decoding.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";

import { generateSyntheticEventFixture } from "../dist/stellar/client.js";
import { decodeEvent, MARKET_DECODERS, SQUAD_DECODERS } from "../dist/stellar/decode.js";

// Deterministic test identities
const TEST_KP = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x5a));
const TEST_ADDR = TEST_KP.publicKey();

const FIXED_ISO_TIME = "2026-10-18T00:00:00.000Z";

const BASE_CONFIG = {
  rpcUrl: "http://127.0.0.1:8420",
  networkPassphrase: "Test SDF Network ; September 2015",
  network: "testnet",
};

/**
 * Execute a callback with an injected/fixed wall-clock Date.
 */
function withInjectedTime(isoString, fn) {
  const RealDate = global.Date;
  class InjectedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(isoString);
      } else {
        super(...args);
      }
    }
    static now() {
      return new RealDate(isoString).getTime();
    }
  }

  global.Date = InjectedDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generator Determinism Tests
// ─────────────────────────────────────────────────────────────────────────────

test("generateSyntheticEventFixture: calling twice with the same inputs produces deep equality", () => {
  withInjectedTime(FIXED_ISO_TIME, () => {
    const fixture1 = generateSyntheticEventFixture(BASE_CONFIG, "mock-tx-hash-determinism-1");
    const fixture2 = generateSyntheticEventFixture(BASE_CONFIG, "mock-tx-hash-determinism-1");

    assert.deepEqual(fixture1, fixture2, "Fixtures with identical inputs and injected time must be deeply equal");
    assert.equal(fixture1.events.length, 1);
    assert.equal(fixture1.latestLedger, 12345678);
    assert.equal(fixture1.oldestLedger, 12345678);
    assert.equal(fixture1.events[0].ledgerClosedAt, FIXED_ISO_TIME);
    assert.equal(fixture1.events[0].txHash, "mock-tx-hash-determinism-1");
  });
});

test("generateSyntheticEventFixture: no dependence on wall-clock time unless injected", () => {
  const timeA = "2026-01-01T12:00:00.000Z";
  const timeB = "2026-06-15T18:30:00.000Z";

  let fixtureA1;
  let fixtureA2;
  withInjectedTime(timeA, () => {
    fixtureA1 = generateSyntheticEventFixture(BASE_CONFIG);
    fixtureA2 = generateSyntheticEventFixture(BASE_CONFIG);
  });

  assert.deepEqual(fixtureA1, fixtureA2);
  assert.equal(fixtureA1.events[0].ledgerClosedAt, timeA);

  let fixtureB;
  withInjectedTime(timeB, () => {
    fixtureB = generateSyntheticEventFixture(BASE_CONFIG);
  });

  assert.equal(fixtureB.events[0].ledgerClosedAt, timeB);
  assert.notEqual(fixtureA1.events[0].ledgerClosedAt, fixtureB.events[0].ledgerClosedAt);
});

test("generateSyntheticEventFixture: deterministic default arguments and structure", () => {
  withInjectedTime(FIXED_ISO_TIME, () => {
    const fixtureA = generateSyntheticEventFixture(BASE_CONFIG);
    const fixtureB = generateSyntheticEventFixture(BASE_CONFIG);

    assert.deepEqual(fixtureA, fixtureB);
    assert.equal(fixtureA.events[0].txHash, "mock-tx-hash-1234567890abcdef");
    assert.equal(fixtureA.cursor, "");
    assert.equal(fixtureA.latestLedgerCloseTime, "0");
    assert.equal(fixtureA.oldestLedgerCloseTime, "0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event Decoding Tests
// ─────────────────────────────────────────────────────────────────────────────

test("generated events decode with decodeEvent without falling back to unknown (market)", () => {
  let fixture;
  withInjectedTime(FIXED_ISO_TIME, () => {
    fixture = generateSyntheticEventFixture(BASE_CONFIG, "tx-hash-market-decode-test");
  });

  const rawEvent = fixture.events[0];

  // Hydrate the generated fixture event shape with Soroban ScVal contract topics
  const claimId = 42;
  const hydratedEvent = {
    ...rawEvent,
    topic: [
      xdr.ScVal.scvSymbol("claim_created"),
      xdr.ScVal.scvU64(BigInt(claimId)),
      Address.fromString(TEST_ADDR).toScVal(),
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("category"),
        val: xdr.ScVal.scvString("crypto"),
      }),
    ]),
  };

  const decoded = decodeEvent("market", hydratedEvent);

  // Assert generated event decodes without falling back to unknown
  assert.notEqual(decoded.payload.name, "unknown", "Payload name must not fall back to unknown");
  assert.equal(decoded.payload.name, "claim_created");
  assert.equal(decoded.payload.claimId, claimId);
  assert.equal(decoded.payload.creator, TEST_ADDR);
  assert.equal(decoded.payload.category, "crypto");

  // Verify metadata carried from the generator fixture
  assert.equal(decoded.source, "market");
  assert.equal(decoded.contractId, rawEvent.contractId);
  assert.equal(decoded.ledger, rawEvent.ledger);
  assert.equal(decoded.txHash, rawEvent.txHash);
  assert.equal(decoded.transactionIndex, rawEvent.transactionIndex);
  assert.equal(decoded.operationIndex, rawEvent.operationIndex);
  assert.equal(decoded.inSuccessfulContractCall, rawEvent.inSuccessfulContractCall);
});

test("generated events decode with decodeEvent without falling back to unknown (squad)", () => {
  let fixture;
  withInjectedTime(FIXED_ISO_TIME, () => {
    fixture = generateSyntheticEventFixture(BASE_CONFIG, "tx-hash-squad-decode-test");
  });

  const rawEvent = fixture.events[0];

  const marketId = 101;
  const hydratedEvent = {
    ...rawEvent,
    topic: [
      xdr.ScVal.scvSymbol("market_created"),
      xdr.ScVal.scvU64(BigInt(marketId)),
      Address.fromString(TEST_ADDR).toScVal(),
    ],
    value: xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("deadline"),
        val: xdr.ScVal.scvU64(1800000000n),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("fee_bps"),
        val: xdr.ScVal.scvU32(200),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("question"),
        val: xdr.ScVal.scvString("Will BTC hit $100k?"),
      }),
    ]),
  };

  const decoded = decodeEvent("squad", hydratedEvent);

  assert.notEqual(decoded.payload.name, "unknown", "Squad payload must not fall back to unknown");
  assert.equal(decoded.payload.name, "market_created");
  assert.equal(decoded.payload.marketId, marketId);
  assert.equal(decoded.payload.captain, TEST_ADDR);
  assert.equal(decoded.payload.question, "Will BTC hit $100k?");
  assert.equal(decoded.payload.deadline, 1800000000);
  assert.equal(decoded.payload.feeBps, 200);
  assert.equal(decoded.source, "squad");
  assert.equal(decoded.txHash, rawEvent.txHash);
});

test("generated events decode with decodeEvent using custom version decoder without falling back to unknown", () => {
  let fixture;
  withInjectedTime(FIXED_ISO_TIME, () => {
    fixture = generateSyntheticEventFixture(BASE_CONFIG, "tx-custom-version-test");
  });

  const rawEvent = fixture.events[0];

  const customVersion = "mock-synthetic-v1";
  MARKET_DECODERS[customVersion] = (name, topics, fields) => {
    if (name === "synthetic_event") {
      return {
        name: "synthetic_event",
        id: Number(topics[1] ?? 0),
        data: String(fields.data ?? ""),
      };
    }
    return null;
  };

  try {
    const event = {
      ...rawEvent,
      topic: [
        xdr.ScVal.scvSymbol("synthetic_event"),
        xdr.ScVal.scvU64(999n),
      ],
      value: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("data"),
          val: xdr.ScVal.scvString("Hello World"),
        }),
      ]),
    };

    const decoded = decodeEvent("market", event, customVersion);
    assert.notEqual(decoded.payload.name, "unknown");
    assert.equal(decoded.payload.name, "synthetic_event");
    assert.equal(decoded.payload.id, 999);
    assert.equal(decoded.payload.data, "Hello World");
    assert.equal(decoded.version, customVersion);
  } finally {
    delete MARKET_DECODERS[customVersion];
  }
});
