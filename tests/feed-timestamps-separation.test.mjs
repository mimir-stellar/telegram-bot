import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomFeed,
  buildAtomFeedResult,
  computeFeedRevision,
  FEED_EMPTY_UPDATED_AT,
  MIMIR_FEED_XMLNS,
  resolveFeedTimestamps,
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

function makeFixtureEvent(overrides = {}) {
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 2001,
    txHash: VALID_TX,
    at: 1_700_000_100,
    eventId: "2001-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 42,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
    ...overrides,
  };
}

test("empty feeds separate generation time from <updated> and emit empty state metadata", () => {
  const first = buildAtomFeedResult([], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    generatedAt: "2026-11-15T10:00:00.000Z",
  });
  const second = buildAtomFeedResult([], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    generatedAt: "2026-11-15T10:05:00.000Z",
    previousRevision: first.metadata.revision,
    previousUpdatedAt: first.metadata.feedUpdatedAt,
  });

  assert.equal(first.metadata.state, "empty");
  assert.equal(first.metadata.entryCount, 0);
  assert.equal(first.metadata.lastEventUpdatedAt, null);
  assert.equal(first.metadata.feedUpdatedAt, FEED_EMPTY_UPDATED_AT);
  assert.equal(first.metadata.generatedAt, "2026-11-15T10:00:00.000Z");

  assert.equal(second.metadata.state, "empty");
  assert.equal(second.metadata.unchanged, true);
  assert.equal(second.metadata.feedUpdatedAt, FEED_EMPTY_UPDATED_AT);
  assert.equal(second.metadata.generatedAt, "2026-11-15T10:05:00.000Z");

  assert.ok(first.xml.includes(`<updated>${FEED_EMPTY_UPDATED_AT}</updated>`));
  assert.ok(second.xml.includes(`<updated>${FEED_EMPTY_UPDATED_AT}</updated>`));
  assert.ok(first.xml.includes("<mimir:state>empty</mimir:state>"));
  assert.ok(!first.xml.includes("<mimir:lastEventUpdatedAt>"));
  assert.ok(first.xml.includes("<mimir:generatedAt>2026-11-15T10:00:00.000Z</mimir:generatedAt>"));
  assert.ok(second.xml.includes("<mimir:generatedAt>2026-11-15T10:05:00.000Z</mimir:generatedAt>"));
});

test("unchanged feeds keep <updated> pinned to lastEventUpdatedAt while generatedAt advances", () => {
  const event1 = makeFixtureEvent({ eventId: "2001-0", at: 1_700_000_100 });
  const expectedEventIso = new Date(1_700_000_100 * 1000).toISOString();

  const initial = buildAtomFeedResult([event1], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    generatedAt: "2026-11-15T12:00:00.000Z",
  });

  assert.equal(initial.metadata.state, "updated");
  assert.equal(initial.metadata.unchanged, false);
  assert.equal(initial.metadata.lastEventUpdatedAt, expectedEventIso);
  assert.equal(initial.metadata.feedUpdatedAt, expectedEventIso);
  assert.ok(initial.xml.includes("<mimir:state>updated</mimir:state>"));
  assert.ok(initial.xml.includes(`<mimir:lastEventUpdatedAt>${expectedEventIso}</mimir:lastEventUpdatedAt>`));

  const rerendered = buildAtomFeedResult([event1], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    generatedAt: "2026-11-15T12:30:00.000Z",
    previousRevision: initial.metadata.revision,
    previousUpdatedAt: initial.metadata.feedUpdatedAt,
  });

  assert.equal(rerendered.metadata.state, "unchanged");
  assert.equal(rerendered.metadata.unchanged, true);
  assert.equal(rerendered.metadata.feedUpdatedAt, expectedEventIso);
  assert.equal(rerendered.metadata.generatedAt, "2026-11-15T12:30:00.000Z");
  assert.ok(rerendered.xml.includes(`<updated>${expectedEventIso}</updated>`));
  assert.ok(rerendered.xml.includes("<mimir:state>unchanged</mimir:state>"));
  assert.ok(rerendered.xml.includes("<mimir:generatedAt>2026-11-15T12:30:00.000Z</mimir:generatedAt>"));

  // Adding a second event transitions back to "updated" and advances <updated>
  const event2 = makeFixtureEvent({ ledger: 2002, eventId: "2002-0", at: 1_700_000_500 });
  const newerIso = new Date(1_700_000_500 * 1000).toISOString();
  const afterNewEvent = buildAtomFeedResult([event1, event2], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    generatedAt: "2026-11-15T12:35:00.000Z",
    previousRevision: rerendered.metadata.revision,
  });

  assert.equal(afterNewEvent.metadata.state, "updated");
  assert.equal(afterNewEvent.metadata.unchanged, false);
  assert.equal(afterNewEvent.metadata.feedUpdatedAt, newerIso);
  assert.notEqual(afterNewEvent.metadata.revision, rerendered.metadata.revision);
});

test("deterministic snapshot fixtures: buildAtomFeed never consults wall-clock time", () => {
  const expectedEmptySnapshot = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:mimir="${MIMIR_FEED_XMLNS}">`,
    '  <title type="text">Mimir Events</title>',
    "  <id>https://example.com/feed.atom</id>",
    `  <updated>${FEED_EMPTY_UPDATED_AT}</updated>`,
    "  <mimir:state>empty</mimir:state>",
    '  <link rel="self" type="application/atom+xml" href="https://example.com/feed.atom"/>',
    "</feed>",
  ].join("\n");

  const origNow = Date.now;
  try {
    Date.now = () => 1_800_000_000_000;
    const snapA = buildAtomFeed([], {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
    });

    Date.now = () => 1_900_000_000_000;
    const snapB = buildAtomFeed([], {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
    });

    assert.equal(snapA, expectedEmptySnapshot);
    assert.equal(snapB, expectedEmptySnapshot);

    // Events with missing/zero ledger timestamps also stay deterministic and never read Date.now()
    const timeless = makeFixtureEvent({ at: 0 });
    const snapTimelessA = buildAtomFeed([timeless], {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
    });
    Date.now = () => 2_000_000_000_000;
    const snapTimelessB = buildAtomFeed([timeless], {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
    });
    assert.equal(snapTimelessA, snapTimelessB);
    assert.ok(snapTimelessA.includes(`<updated>${FEED_EMPTY_UPDATED_AT}</updated>`));
  } finally {
    Date.now = origNow;
  }
});

test("resolveFeedTimestamps rejects malformed ISO timestamps and produces stable revisions", () => {
  const e1 = makeFixtureEvent();
  assert.equal(computeFeedRevision([e1]), computeFeedRevision([makeFixtureEvent()]));

  assert.throws(
    () => resolveFeedTimestamps([e1], { generatedAt: "not-a-timestamp" }),
    RangeError,
  );
  assert.throws(
    () => resolveFeedTimestamps([e1], { updatedAt: "2026-99-99T99:99:99Z" }),
    RangeError,
  );
  assert.throws(
    () => resolveFeedTimestamps([], { previousUpdatedAt: "yesterday" }),
    RangeError,
  );
});
