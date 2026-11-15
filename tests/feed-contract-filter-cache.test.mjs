import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomFeed,
  buildFeedCacheKey,
  createFeedCache,
  FeedFilterError,
  filterFeedEvents,
  normalizeFeedFilter,
  parseFeedFilterParams,
} from "../dist/stellar/feed.js";

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const MARKET_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const MARKET_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const SQUAD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

const BASE_CONFIG = {
  marketContractId: MARKET_A,
  squadContractId: SQUAD_A,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

function makeMarketEvent(id, contractId = MARKET_A, name = "claim_created") {
  return {
    source: "market",
    contractId,
    version: "v1",
    ledger: 3000 + id,
    txHash: VALID_TX,
    at: 1_700_000_000 + id * 10,
    eventId: `market-${id}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId: id,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  };
}

function makeSquadEvent(id, contractId = SQUAD_A) {
  return {
    source: "squad",
    contractId,
    version: "v1",
    ledger: 4000 + id,
    txHash: VALID_TX,
    at: 1_700_001_000 + id * 10,
    eventId: `squad-${id}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "market_created",
      marketId: id,
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      question: `Squad question ${id}`,
      deadline: 1_700_050_000,
    },
  };
}

test("normalizeFeedFilter and buildFeedCacheKey produce identical keys for equivalent filters", () => {
  const baseOpts = {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
  };

  const keyA = buildFeedCacheKey({
    ...baseOpts,
    filter: {
      contractId: `  ${MARKET_A.toLowerCase()}  `,
      source: "  MARKET ",
      eventNames: ["claim_resolved", "claim_created", "CLAIM_RESOLVED"],
    },
  });

  const keyB = buildFeedCacheKey({
    ...baseOpts,
    filter: {
      contractId: MARKET_A,
      source: "market",
      eventNames: ["claim_created", "claim_resolved"],
    },
  });

  assert.equal(keyA, keyB);

  // Distinct contracts and distinct sources must produce distinct cache keys
  const keySquad = buildFeedCacheKey({
    ...baseOpts,
    filter: { contractId: SQUAD_A, source: "squad", eventNames: ["claim_created", "claim_resolved"] },
  });
  const keyMarketB = buildFeedCacheKey({
    ...baseOpts,
    filter: { contractId: MARKET_B, source: "market", eventNames: ["claim_created", "claim_resolved"] },
  });
  const keyUnfiltered = buildFeedCacheKey(baseOpts);

  assert.notEqual(keyA, keySquad);
  assert.notEqual(keyA, keyMarketB);
  assert.notEqual(keyA, keyUnfiltered);
});

test("createFeedCache isolates per-contract responses and never leaks one contract into another filter", () => {
  const cache = createFeedCache({ maxEntries: 8 });
  const m1 = makeMarketEvent(1, MARKET_A);
  const m2 = makeMarketEvent(2, MARKET_B);
  const s1 = makeSquadEvent(10, SQUAD_A);
  const allEvents = [m1, m2, s1];

  const commonOpts = {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    mimirAppUrl: "https://app.mimir.example",
  };

  const resMarketA = cache.getAtomFeed(allEvents, {
    ...commonOpts,
    filter: { contractId: MARKET_A },
  });
  assert.equal(resMarketA.fromCache, false);
  assert.equal(resMarketA.entryCount, 1);
  assert.ok(resMarketA.xml.includes("tag:mimir,event:market-1"));
  assert.ok(!resMarketA.xml.includes("tag:mimir,event:market-2"));
  assert.ok(!resMarketA.xml.includes("tag:mimir,event:squad-10"));
  assert.ok(resMarketA.xml.includes(`contract=${MARKET_A}`));
  assert.ok(resMarketA.xml.includes("https://app.mimir.example/claims/1"));

  const resMarketB = cache.getAtomFeed(allEvents, {
    ...commonOpts,
    filter: { contractId: MARKET_B },
  });
  assert.equal(resMarketB.fromCache, false);
  assert.equal(resMarketB.entryCount, 1);
  assert.ok(resMarketB.xml.includes("tag:mimir,event:market-2"));
  assert.ok(!resMarketB.xml.includes("tag:mimir,event:market-1"));
  assert.ok(!resMarketB.xml.includes("tag:mimir,event:squad-10"));

  const resSquad = cache.getAtomFeed(allEvents, {
    ...commonOpts,
    filter: { contractId: SQUAD_A },
  });
  assert.equal(resSquad.fromCache, false);
  assert.equal(resSquad.entryCount, 1);
  assert.ok(resSquad.xml.includes("tag:mimir,event:squad-10"));
  assert.ok(!resSquad.xml.includes("tag:mimir,event:market-1"));
  assert.ok(resSquad.xml.includes("https://app.mimir.example/squads/10"));

  const resAll = cache.getAtomFeed(allEvents, commonOpts);
  assert.equal(resAll.fromCache, false);
  assert.equal(resAll.entryCount, 3);

  // Repeat query with lowercase contractId hits isolated Market A cache
  const hitMarketA = cache.getAtomFeed(allEvents, {
    ...commonOpts,
    filter: { contractId: MARKET_A.toLowerCase() },
  });
  assert.equal(hitMarketA.fromCache, true);
  assert.equal(hitMarketA.cacheKey, resMarketA.cacheKey);
  assert.equal(hitMarketA.xml, resMarketA.xml);

  // Appending a new squad event invalidates squad & unfiltered caches while keeping Market A cached
  const updatedEvents = [...allEvents, makeSquadEvent(11, SQUAD_A)];
  const marketAAfterSquadUpdate = cache.getAtomFeed(updatedEvents, {
    ...commonOpts,
    filter: { contractId: MARKET_A },
  });
  assert.equal(marketAAfterSquadUpdate.fromCache, true);
  assert.equal(marketAAfterSquadUpdate.entryCount, 1);

  const squadAfterSquadUpdate = cache.getAtomFeed(updatedEvents, {
    ...commonOpts,
    filter: { contractId: SQUAD_A },
  });
  assert.equal(squadAfterSquadUpdate.fromCache, false);
  assert.equal(squadAfterSquadUpdate.entryCount, 2);
  assert.ok(squadAfterSquadUpdate.xml.includes("tag:mimir,event:squad-11"));
});

test("parseFeedFilterParams and normalizeFeedFilter reject malformed or unknown filter inputs", () => {
  const parsed = parseFeedFilterParams(
    new URLSearchParams(`contract=${MARKET_A.toLowerCase()}&source=MARKET&event=claim_resolved,claim_created`),
  );
  assert.deepEqual(parsed, {
    source: "market",
    contractId: MARKET_A,
    eventNames: ["claim_created", "claim_resolved"],
  });

  // Unknown query parameter must fail closed rather than returning unfiltered events
  assert.throws(
    () => parseFeedFilterParams(new URLSearchParams(`contrcat=${MARKET_A}`)),
    FeedFilterError,
  );

  // Conflicting contract parameters must fail closed
  assert.throws(
    () => parseFeedFilterParams(new URLSearchParams(`contract=${MARKET_A}&contract=${MARKET_B}`)),
    FeedFilterError,
  );

  // Invalid Stellar contract StrKey
  assert.throws(
    () => normalizeFeedFilter({ contractId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }),
    FeedFilterError,
  );
  assert.throws(
    () => normalizeFeedFilter({ contractId: "not-a-contract" }),
    FeedFilterError,
  );

  // Invalid source
  assert.throws(
    () => normalizeFeedFilter({ source: "governance" }),
    FeedFilterError,
  );

  // Invalid event name containing injection characters
  assert.throws(
    () => normalizeFeedFilter({ eventNames: ["claim_created<script>"] }),
    FeedFilterError,
  );
});

test("createFeedCache enforces bounded maxEntries LRU eviction and filterFeedEvents handles contradictions", () => {
  const cache = createFeedCache({ maxEntries: 2 });
  const events = [makeMarketEvent(1, MARKET_A), makeMarketEvent(2, MARKET_B), makeSquadEvent(3, SQUAD_A)];
  const opts = {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
  };

  cache.getAtomFeed(events, { ...opts, filter: { contractId: MARKET_A } });
  cache.getAtomFeed(events, { ...opts, filter: { contractId: MARKET_B } });
  assert.equal(cache.size(), 2);

  // Touch MARKET_A so MARKET_B becomes least-recently-used
  cache.getAtomFeed(events, { ...opts, filter: { contractId: MARKET_A } });
  cache.getAtomFeed(events, { ...opts, filter: { contractId: SQUAD_A } });
  assert.equal(cache.size(), 2);

  assert.equal(
    cache.getAtomFeed(events, { ...opts, filter: { contractId: MARKET_A } }).fromCache,
    true,
  );
  assert.equal(
    cache.getAtomFeed(events, { ...opts, filter: { contractId: MARKET_B } }).fromCache,
    false,
  );

  // Contradictory source=market + squad contractId yields 0 matching events cleanly
  const contradictory = filterFeedEvents(events, {
    source: "market",
    contractId: SQUAD_A,
  });
  assert.equal(contradictory.length, 0);

  const emptyFilteredXml = buildAtomFeed(events, {
    ...opts,
    filter: { source: "market", contractId: SQUAD_A },
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(!emptyFilteredXml.includes("<entry>"));
});
