import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomFeed,
  buildCanonicalFeedRecord,
  buildJsonFeed,
  buildJsonFeedObject,
  FEED_CONTENT_MAX_CHARS,
  FEED_DEFAULT_MAX_ITEMS,
  FEED_HARD_MAX_ITEMS,
  JSON_FEED_VERSION,
  MIMIR_JSON_FEED_SCHEMA_VERSION,
} from "../dist/stellar/feed.js";

const VALID_TX_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const VALID_TX_2 = "2222222222222222222222222222222222222222222222222222222222222222";
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

function makeMarketEvent(id, overrides = {}) {
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 5000 + id,
    txHash: VALID_TX_1,
    at: 1_700_000_000 + id * 60,
    eventId: `${5000 + id}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: id,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
    ...overrides,
  };
}

function makeSquadEvent(id, overrides = {}) {
  return {
    source: "squad",
    contractId: VALID_SQUAD,
    version: "v1",
    ledger: 6000 + id,
    txHash: VALID_TX_2,
    at: 1_700_010_000 + id * 60,
    eventId: `${6000 + id}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "market_created",
      marketId: id,
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      question: `Question ${id}`,
      deadline: 1_700_100_000,
    },
    ...overrides,
  };
}

test("buildJsonFeed emits versioned JSON Feed 1.1 and preserves ordering and sanitized links with Atom", () => {
  const e1 = makeMarketEvent(7);
  const e2 = makeSquadEvent(12);
  const e3 = makeMarketEvent(9, {
    txHash: "",
    payload: { name: "unknown", eventName: "oracle_changed" },
  });
  const events = [e1, e2, e3];

  const opts = {
    title: "Mimir Feed",
    subtitle: "Contract activity",
    selfUrl: "https://example.com/feed.json",
    config: BASE_CONFIG,
    mimirAppUrl: "https://app.mimir.example/",
    updatedAt: "2026-11-15T12:00:00.000Z",
  };

  const atomXml = buildAtomFeed(events, {
    ...opts,
    selfUrl: "https://example.com/feed.atom",
  });
  const jsonText = buildJsonFeed(events, opts);
  const doc = JSON.parse(jsonText);

  assert.equal(doc.version, JSON_FEED_VERSION);
  assert.equal(doc.title, "Mimir Feed");
  assert.equal(doc.description, "Contract activity");
  assert.equal(doc.feed_url, "https://example.com/feed.json");
  assert.equal(doc.home_page_url, "https://app.mimir.example/");
  assert.deepEqual(doc._mimir, {
    schemaVersion: MIMIR_JSON_FEED_SCHEMA_VERSION,
    updatedAt: "2026-11-15T12:00:00.000Z",
    entryCount: 3,
    totalEvents: 3,
    truncated: false,
  });

  // Extract entry IDs from Atom XML and verify exact 1-for-1 ordering parity with JSON Feed
  const atomEntryIds = [...atomXml.matchAll(/<entry>[\s\S]*?<id>([^<]+)<\/id>/g)].map((m) => m[1]);
  const jsonItemIds = doc.items.map((item) => item.id);
  assert.deepEqual(jsonItemIds, atomEntryIds);

  // Item 0: market claim_created -> explorer tx link + /claims/7 deep link in both formats
  assert.equal(doc.items[0].url, `https://stellar.expert/explorer/testnet/tx/${VALID_TX_1}`);
  assert.equal(doc.items[0].external_url, "https://app.mimir.example/claims/7");
  assert.ok(atomXml.includes(`href="${doc.items[0].url}"`));
  assert.ok(atomXml.includes(`href="${doc.items[0].external_url}"`));

  // Item 1: squad market_created -> explorer tx link + /squads/12 deep link in both formats
  assert.equal(doc.items[1].url, `https://stellar.expert/explorer/testnet/tx/${VALID_TX_2}`);
  assert.equal(doc.items[1].external_url, "https://app.mimir.example/squads/12");
  assert.ok(atomXml.includes(`href="${doc.items[1].url}"`));
  assert.ok(atomXml.includes(`href="${doc.items[1].external_url}"`));

  // Item 2: unknown admin event with no txHash -> no url, no external_url, notifiable: false
  assert.equal(doc.items[2].url, undefined);
  assert.equal(doc.items[2].external_url, undefined);
  assert.equal(doc.items[2].content_text, "");
  assert.equal(doc.items[2]._mimir.notifiable, false);
});

test("JSON Feed and Atom reject non-HTTPS URLs and strip C0 control bytes consistently", () => {
  const hostileEvent = makeMarketEvent(3, {
    payload: {
      name: "claim_created",
      claimId: 3,
      category: "crypto\x00\x01\x07",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });

  const insecureConfig = {
    ...BASE_CONFIG,
    explorerBaseUrl: "http://insecure.example/explorer",
  };

  const record = buildCanonicalFeedRecord(hostileEvent, insecureConfig, "http://insecure-app.example");
  assert.equal(record.explorerUrl, null);
  assert.equal(record.appUrl, null);
  assert.ok(!record.content.includes("\x00"));

  const doc = buildJsonFeedObject([hostileEvent], {
    title: "Title\x00WithNull",
    selfUrl: "javascript:alert(1)",
    config: insecureConfig,
    mimirAppUrl: "http://insecure-app.example",
  });

  assert.equal(doc.title, "TitleWithNull");
  assert.equal(doc.feed_url, undefined);
  assert.equal(doc.home_page_url, undefined);
  assert.equal(doc.items[0].url, undefined);
  assert.equal(doc.items[0].external_url, undefined);
  assert.ok(!JSON.stringify(doc).includes("\x00"));
  assert.ok(Array.from(doc.items[0].content_text).length <= FEED_CONTENT_MAX_CHARS);
});

test("JSON Feed and Atom enforce bounded item counts and reject out-of-range maxItems", () => {
  const manyEvents = Array.from({ length: FEED_DEFAULT_MAX_ITEMS + 25 }, (_, i) =>
    makeMarketEvent(i + 1),
  );

  // Default cap (100 items)
  const defaultDoc = buildJsonFeedObject(manyEvents, {
    title: "Bounded Feed",
    selfUrl: "https://example.com/feed.json",
    config: BASE_CONFIG,
  });
  assert.equal(defaultDoc.items.length, FEED_DEFAULT_MAX_ITEMS);
  assert.equal(defaultDoc._mimir.entryCount, FEED_DEFAULT_MAX_ITEMS);
  assert.equal(defaultDoc._mimir.totalEvents, FEED_DEFAULT_MAX_ITEMS + 25);
  assert.equal(defaultDoc._mimir.truncated, true);

  // Explicit maxItems cap applies identically to Atom and JSON Feed
  const customAtom = buildAtomFeed(manyEvents, {
    title: "Bounded Feed",
    selfUrl: "https://example.com/feed.atom",
    config: BASE_CONFIG,
    maxItems: 5,
  });
  const customJson = buildJsonFeedObject(manyEvents, {
    title: "Bounded Feed",
    selfUrl: "https://example.com/feed.json",
    config: BASE_CONFIG,
    maxItems: 5,
  });
  assert.equal((customAtom.match(/<entry>/g) ?? []).length, 5);
  assert.equal(customJson.items.length, 5);
  assert.equal(customJson._mimir.truncated, true);

  // Out-of-range or non-integer maxItems fails fast with RangeError
  assert.throws(
    () =>
      buildJsonFeedObject([], {
        title: "Bad Cap",
        selfUrl: "https://example.com/feed.json",
        config: BASE_CONFIG,
        maxItems: -1,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildJsonFeedObject([], {
        title: "Bad Cap",
        selfUrl: "https://example.com/feed.json",
        config: BASE_CONFIG,
        maxItems: FEED_HARD_MAX_ITEMS + 1,
      }),
    RangeError,
  );
});
