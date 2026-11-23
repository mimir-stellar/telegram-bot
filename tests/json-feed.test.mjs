/**
 * Tests for src/stellar/feed.ts — bounded JSON Feed 1.1 export alongside Atom.
 *
 * Coverage:
 *   - Versioned JSON Feed 1.1 document structure and `_mimir` metadata
 *   - Canonical parity with Atom (id, title, timestamp, content, explorer link, ordering)
 *   - Sanitized `https:` links (feed_url, home_page_url, explorer url, Mimir app external_url)
 *   - Bounded item count (default cap, custom maxItems, 0 items, hard limit cap)
 *   - Failure / boundary cases (invalid maxItems throws RangeError, control chars,
 *     long strings clipped, non-notifiable admin events, non-https URLs rejected)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomEntry,
  buildAtomFeed,
  buildJsonFeed,
  buildJsonFeedDocument,
  buildJsonFeedItem,
  FEED_CONTENT_MAX_CHARS,
  FEED_TITLE_MAX_CHARS,
  JSON_FEED_DEFAULT_MAX_ITEMS,
  JSON_FEED_MAX_ITEMS_LIMIT,
  JSON_FEED_SCHEMA_VERSION,
  JSON_FEED_VERSION,
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
  explorerBaseUrl: "https://stellar.expert/explorer/testnet",
  mimirAppUrl: "https://app.mimir.example",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

let seq = 1;
function makeEvent(overrides = {}) {
  const id = seq++;
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 2000 + id,
    txHash: VALID_TX,
    at: 1_700_000_000 + id,
    eventId: `${2000 + id}-0`,
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

const BASE_OPTS = {
  title: "Mimir Events",
  selfUrl: "https://example.com/feed.json",
  config: BASE_CONFIG,
  subtitle: "Decoded Stellar contract events",
  updatedAt: "2026-01-15T12:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Document structure & versioning
// ---------------------------------------------------------------------------

test("buildJsonFeedDocument: emits versioned JSON Feed 1.1 shape", () => {
  const doc = buildJsonFeedDocument([], BASE_OPTS);
  assert.equal(doc.version, JSON_FEED_VERSION);
  assert.equal(doc.title, "Mimir Events");
  assert.equal(doc.feed_url, "https://example.com/feed.json");
  assert.equal(doc.home_page_url, "https://app.mimir.example");
  assert.equal(doc.description, "Decoded Stellar contract events");
  assert.deepEqual(doc._mimir, {
    schema_version: JSON_FEED_SCHEMA_VERSION,
    updated: "2026-01-15T12:00:00.000Z",
    total_items: 0,
    max_items: JSON_FEED_DEFAULT_MAX_ITEMS,
    truncated: false,
  });
  assert.deepEqual(doc.items, []);
});

test("buildJsonFeed: serializes valid JSON matching buildJsonFeedDocument", () => {
  const events = [makeEvent(), makeEvent()];
  const doc = buildJsonFeedDocument(events, BASE_OPTS);
  const raw = buildJsonFeed(events, BASE_OPTS);
  assert.deepEqual(JSON.parse(raw), doc);
});

// ---------------------------------------------------------------------------
// Parity with Atom & ordering preservation
// ---------------------------------------------------------------------------

test("buildJsonFeedItem: matches buildAtomEntry canonical fields and adds app deep link", () => {
  const event = makeEvent({ payload: { name: "claim_created", claimId: 42, category: "tech", creator: "GAAA" } });
  const atomEntry = buildAtomEntry(event, BASE_CONFIG);
  const jsonItem = buildJsonFeedItem(event, BASE_CONFIG);

  assert.equal(jsonItem.id, atomEntry.id);
  assert.equal(jsonItem.title, atomEntry.title);
  assert.equal(jsonItem.date_published, atomEntry.updated);
  assert.equal(jsonItem.content_text, atomEntry.content);
  assert.equal(jsonItem.url, atomEntry.link);
  assert.equal(jsonItem.external_url, "https://app.mimir.example/claims/42");
  assert.deepEqual(jsonItem.tags, ["market", "claim_created"]);
});

test("buildJsonFeedDocument: preserves event ordering identically to buildAtomFeed", () => {
  const events = [
    makeEvent({ eventId: "3001-0", at: 1_700_000_010 }),
    makeEvent({ eventId: "3002-0", at: 1_700_000_020 }),
    makeEvent({ eventId: "3003-0", at: 1_700_000_030 }),
  ];

  const atomXml = buildAtomFeed(events, { ...BASE_OPTS, selfUrl: "https://example.com/feed.atom" });
  const jsonDoc = buildJsonFeedDocument(events, BASE_OPTS);

  const atomIds = [...atomXml.matchAll(/<entry>[\s\S]*?<id>([^<]+)<\/id>/g)].map((m) => m[1]);
  const jsonIds = jsonDoc.items.map((item) => item.id);

  assert.equal(jsonIds.length, 3);
  assert.deepEqual(jsonIds, atomIds);
});

// ---------------------------------------------------------------------------
// Sanitized links
// ---------------------------------------------------------------------------

test("buildJsonFeedDocument: omits non-https feed_url, home_page_url, explorer url, and external_url", () => {
  const unsafeConfig = {
    ...BASE_CONFIG,
    explorerBaseUrl: "http://insecure.example/tx",
    mimirAppUrl: "javascript:alert(1)",
  };
  const doc = buildJsonFeedDocument([makeEvent()], {
    ...BASE_OPTS,
    selfUrl: "http://example.com/feed.json",
    homePageUrl: "ftp://example.com",
    config: unsafeConfig,
  });

  assert.equal(doc.feed_url, undefined);
  assert.equal(doc.home_page_url, undefined);
  assert.equal(doc.items[0].url, undefined);
  assert.equal(doc.items[0].external_url, undefined);
});

test("buildJsonFeedItem: omits url when txHash is empty and external_url when event has no app page", () => {
  const adminEvent = makeEvent({
    txHash: "",
    payload: { name: "admin_changed", oldAdmin: "GAAA", newAdmin: "GBBB" },
  });
  const item = buildJsonFeedItem(adminEvent, BASE_CONFIG);
  assert.equal(item.url, undefined);
  assert.equal(item.external_url, undefined);
  assert.equal(item.content_text, undefined);
});

// ---------------------------------------------------------------------------
// Boundedness & failure / boundary cases
// ---------------------------------------------------------------------------

test("buildJsonFeedDocument: enforces default maxItems bound and marks truncated", () => {
  const events = Array.from({ length: JSON_FEED_DEFAULT_MAX_ITEMS + 5 }, (_, i) =>
    makeEvent({ eventId: `4000-${i}`, at: 1_700_000_000 + i }),
  );
  const doc = buildJsonFeedDocument(events, BASE_OPTS);

  assert.equal(doc.items.length, JSON_FEED_DEFAULT_MAX_ITEMS);
  assert.equal(doc._mimir.total_items, JSON_FEED_DEFAULT_MAX_ITEMS + 5);
  assert.equal(doc._mimir.max_items, JSON_FEED_DEFAULT_MAX_ITEMS);
  assert.equal(doc._mimir.truncated, true);
  assert.equal(doc.items[0].id, buildAtomEntry(events[0], BASE_CONFIG).id);
  assert.equal(
    doc.items[JSON_FEED_DEFAULT_MAX_ITEMS - 1].id,
    buildAtomEntry(events[JSON_FEED_DEFAULT_MAX_ITEMS - 1], BASE_CONFIG).id,
  );
});

test("buildJsonFeedDocument: honors custom maxItems including 0 and caps above hard limit", () => {
  const events = [makeEvent(), makeEvent(), makeEvent()];

  const bounded = buildJsonFeedDocument(events, { ...BASE_OPTS, maxItems: 2 });
  assert.equal(bounded.items.length, 2);
  assert.equal(bounded._mimir.truncated, true);
  assert.equal(bounded._mimir.max_items, 2);

  const empty = buildJsonFeedDocument(events, { ...BASE_OPTS, maxItems: 0 });
  assert.equal(empty.items.length, 0);
  assert.equal(empty._mimir.truncated, true);
  assert.equal(empty._mimir.total_items, 3);

  const capped = buildJsonFeedDocument(events, {
    ...BASE_OPTS,
    maxItems: JSON_FEED_MAX_ITEMS_LIMIT + 250,
  });
  assert.equal(capped._mimir.max_items, JSON_FEED_MAX_ITEMS_LIMIT);
  assert.equal(capped._mimir.truncated, false);
});

test("buildJsonFeedDocument: throws RangeError for invalid maxItems", () => {
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildJsonFeedDocument([], { ...BASE_OPTS, maxItems: invalid }),
      RangeError,
      `expected RangeError for maxItems=${String(invalid)}`,
    );
  }
});

test("buildJsonFeedDocument: strips control characters and clips long title/description/content", () => {
  const longTitle = "A".repeat(FEED_TITLE_MAX_CHARS + 50);
  const longDesc = `desc\x00with\x07controls${"B".repeat(FEED_TITLE_MAX_CHARS + 50)}`;
  const longCategory = "C".repeat(FEED_CONTENT_MAX_CHARS + 500);
  const event = makeEvent({
    payload: { name: "claim_created", claimId: 9, category: longCategory, creator: "GAAA" },
  });

  const doc = buildJsonFeedDocument([event], {
    ...BASE_OPTS,
    title: longTitle,
    subtitle: longDesc,
  });

  assert.equal(Array.from(doc.title).length, FEED_TITLE_MAX_CHARS);
  assert.equal(Array.from(doc.description).length, FEED_TITLE_MAX_CHARS);
  assert.ok(!doc.description.includes("\x00"));
  assert.ok(!doc.description.includes("\x07"));
  assert.ok(Array.from(doc.items[0].content_text).length <= FEED_CONTENT_MAX_CHARS);
});
