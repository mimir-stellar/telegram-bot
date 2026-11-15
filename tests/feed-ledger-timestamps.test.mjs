import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomEntry,
  buildAtomFeed,
  EVENT_TIME_CATEGORY_SCHEME,
  resolveLedgerPublicationTime,
  UNKNOWN_EVENT_UPDATED_AT,
} from "../dist/stellar/feed.js";

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const VALID_SQUAD = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

const BASE_CONFIG = {
  marketContractId: VALID_MARKET,
  squadContractId: VALID_SQUAD,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

function makeHistoricalEvent(overrides = {}) {
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 1234,
    txHash: VALID_TX,
    at: 1_700_000_000,
    eventId: "1234-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 9,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
    ...overrides,
  };
}

test("historical events emit ledger <published> and <updated> without using process startup time", () => {
  const origNow = Date.now;
  const fakeStartupIso = "2026-11-15T18:00:00.000Z";
  Date.now = () => Date.parse(fakeStartupIso);

  try {
    const ledgerAt = 1_690_000_000;
    const expectedLedgerIso = new Date(ledgerAt * 1000).toISOString();
    const event = makeHistoricalEvent({ at: ledgerAt });

    const entry = buildAtomEntry(event, BASE_CONFIG);
    assert.equal(entry.eventTimeStatus, "known");
    assert.equal(entry.published, expectedLedgerIso);
    assert.equal(entry.updated, expectedLedgerIso);

    const xml = buildAtomFeed([event], {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
    });

    assert.ok(xml.includes(`<published>${expectedLedgerIso}</published>`));
    assert.ok(xml.includes(`<updated>${expectedLedgerIso}</updated>`));
    assert.ok(!xml.includes("2026-11-15"), "startup year must never appear in historical feed");
    assert.ok(!xml.includes(`scheme="${EVENT_TIME_CATEGORY_SCHEME}"`));
  } finally {
    Date.now = origNow;
  }
});

test("unknown event timestamps are represented explicitly and never fall back to Date.now()", () => {
  const origNow = Date.now;
  Date.now = () => Date.parse("2026-11-15T19:30:00.000Z");

  try {
    for (const invalidAt of [0, -100, undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 9_999_999_999_999]) {
      const pub = resolveLedgerPublicationTime(invalidAt);
      assert.equal(pub.status, "unknown");
      assert.equal(pub.published, null);
      assert.equal(pub.updated, UNKNOWN_EVENT_UPDATED_AT);
    }

    const unknownEvent = makeHistoricalEvent({ eventId: "1235-0", at: 0 });
    const entry = buildAtomEntry(unknownEvent, BASE_CONFIG);
    assert.equal(entry.eventTimeStatus, "unknown");
    assert.equal(entry.published, null);
    assert.equal(entry.updated, UNKNOWN_EVENT_UPDATED_AT);

    const xml = buildAtomFeed([unknownEvent], {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
    });

    assert.ok(!xml.includes("<published>"), "entry with unknown ledger time must omit <published>");
    assert.ok(xml.includes(`<updated>${UNKNOWN_EVENT_UPDATED_AT}</updated>`));
    assert.ok(
      xml.includes(`    <category scheme="${EVENT_TIME_CATEGORY_SCHEME}" term="unknown"`),
      "entry must carry explicit unknown event-time category",
    );
    assert.ok(
      xml.includes(`  <category scheme="${EVENT_TIME_CATEGORY_SCHEME}" term="unknown"`),
      "feed must mark when all entries have unknown ledger timestamps",
    );
    assert.ok(!xml.includes("2026-11-15"), "Date.now() must never leak into timeless historical events");
  } finally {
    Date.now = origNow;
  }
});

test("mixed feeds use latest known ledger timestamp for <feed><updated> and flag partial timestamp coverage", () => {
  const knownOlder = makeHistoricalEvent({ eventId: "100-0", at: 1_700_000_100 });
  const knownNewer = makeHistoricalEvent({ eventId: "101-0", at: 1_700_000_900 });
  const unknown = makeHistoricalEvent({ eventId: "102-0", at: 0 });

  const expectedFeedIso = new Date(1_700_000_900 * 1000).toISOString();
  const xml = buildAtomFeed([knownOlder, unknown, knownNewer], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
  });

  assert.ok(xml.includes(`  <updated>${expectedFeedIso}</updated>`));
  assert.ok(xml.includes(`  <category scheme="${EVENT_TIME_CATEGORY_SCHEME}" term="partial"`));
  assert.equal((xml.match(/<published>/g) ?? []).length, 2);
});
