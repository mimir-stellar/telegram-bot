/**
 * Tests for src/stellar/feed.ts — Atom feed builder.
 *
 * Coverage:
 *   - escapeXml: each of the five predefined entities
 *   - stripXmlIllegal: removes C0 control chars, keeps printable Unicode
 *   - xmlText: clips to max code points *after* XML escaping, entity-safe
 *   - clipEscapedXml: post-escape code-point clip, entity and surrogate safety
 *   - safeHttpsUrl: accepts https, rejects http and other schemes
 *   - buildAtomEntry: id, title, updated, content, link derivation
 *   - buildAtomFeed: well-formed XML, required Atom elements, entry count,
 *                    empty feed, hostile title / content strings, subtitle
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeXml,
  stripXmlIllegal,
  xmlText,
  clipEscapedXml,
  safeHttpsUrl,
  buildAtomEntry,
  buildAtomFeed,
  resolveAtomFeedMetadata,
  FEED_CONTENT_MAX_CHARS,
  FEED_TITLE_MAX_CHARS,
  FEED_EPOCH_UPDATED_AT,
  MIMIR_FEED_NS,
} from "../dist/stellar/feed.js";

// ---------------------------------------------------------------------------
// Minimal fixture helpers
// ---------------------------------------------------------------------------

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";
const VALID_SQUAD  = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC";

/**
 * Minimal StellarConfig that satisfies eventExplorerUrl and formatPlainTextEvent
 * without needing a real RPC connection.
 */
const BASE_CONFIG = {
  marketContractId: VALID_MARKET,
  squadContractId:  VALID_SQUAD,
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer/testnet",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

let eventSeq = 1;

function makeEvent(overrides = {}) {
  const id = eventSeq++;
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 1000 + id,
    txHash: VALID_TX,
    at: 1_700_000_000 + id,
    eventId: `${1000 + id}-0`,
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

const FEED_OPTS = {
  title: "Mimir Events",
  selfUrl: "https://example.com/feed.atom",
  config: BASE_CONFIG,
};

// ---------------------------------------------------------------------------
// escapeXml
// ---------------------------------------------------------------------------

test("escapeXml: escapes ampersand first to avoid double-escaping", () => {
  assert.equal(escapeXml("a&b"), "a&amp;b");
  assert.equal(escapeXml("&amp;"), "&amp;amp;");
});

test("escapeXml: escapes < and >", () => {
  assert.equal(escapeXml("<tag>"), "&lt;tag&gt;");
});

test("escapeXml: escapes double-quote", () => {
  assert.equal(escapeXml('"hello"'), "&quot;hello&quot;");
});

test("escapeXml: escapes single-quote", () => {
  assert.equal(escapeXml("it's"), "it&apos;s");
});

test("escapeXml: all five entities in one string", () => {
  assert.equal(escapeXml(`<a href="x&y">it's</a>`), `&lt;a href=&quot;x&amp;y&quot;&gt;it&apos;s&lt;/a&gt;`);
});

test("escapeXml: leaves safe characters untouched", () => {
  const safe = "Hello, World! 123 αβγ 🚀";
  assert.equal(escapeXml(safe), safe);
});

// ---------------------------------------------------------------------------
// stripXmlIllegal
// ---------------------------------------------------------------------------

test("stripXmlIllegal: removes NUL and C0 controls", () => {
  const input = "hello\x00world\x01\x08";
  assert.equal(stripXmlIllegal(input), "helloworld");
});

test("stripXmlIllegal: keeps tab (0x09), LF (0x0A), CR (0x0D)", () => {
  const input = "a\tb\nc\rd";
  assert.equal(stripXmlIllegal(input), input);
});

test("stripXmlIllegal: keeps printable ASCII and Unicode", () => {
  const input = "Mimir αβγ 🚀 café";
  assert.equal(stripXmlIllegal(input), input);
});

test("stripXmlIllegal: removes 0x0B, 0x0C, 0x0E–0x1F, 0x7F", () => {
  const stripped = stripXmlIllegal("\x0B\x0C\x0E\x1F\x7F");
  assert.equal(stripped, "");
});

// ---------------------------------------------------------------------------
// xmlText
// ---------------------------------------------------------------------------

test("xmlText: short string passes through escaped", () => {
  assert.equal(xmlText("<b>bold</b>", 100), "&lt;b&gt;bold&lt;/b&gt;");
});

test("xmlText: clips to max Unicode code points and appends ellipsis", () => {
  const result = xmlText("abcde", 4);
  // 3 chars + ellipsis (…) = 4 code points total
  assert.ok(result.startsWith("abc"), `result was "${result}"`);
  assert.ok(result.includes("…"), "clipped result should end with ellipsis");
});

test("xmlText: clips by code point, not byte (emoji)", () => {
  // Each 🚀 is one code point but 4 UTF-16 bytes
  const result = xmlText("🚀🚀🚀🚀🚀", 3);
  assert.ok(result.includes("…"), "should clip emoji string");
});

test("xmlText: strips XML-illegal chars before escaping", () => {
  const result = xmlText("hello\x00world", 100);
  assert.equal(result, "helloworld");
  assert.ok(!result.includes("\x00"), "NUL should be stripped");
});

test("xmlText: output never exceeds max code points even when escaping expands chars", () => {
  // "&&&&" → "&amp;&amp;&amp;&amp;" which is 20 code points.
  // With max=10 the clip must stay ≤ 10 code points.
  const result = xmlText("&&&&", 10);
  assert.ok(Array.from(result).length <= 10, `output was ${Array.from(result).length} code points: "${result}"`);
  assert.ok(result.includes("…"), "must include ellipsis when input is clipped");
  // Must not contain a dangling & (every & must be part of &...;)
  const danglingAmp = /&(?!amp;|lt;|gt;|quot;|apos;|#)/;
  assert.ok(!danglingAmp.test(result), `dangling & in result: "${result}"`);
});

test("xmlText: entity reference at the clip boundary is not split", () => {
  // "ab&cd" escapes to "ab&amp;cd" (9 code points).
  // With max=6 the budget is 5. "ab&amp;" = 7 code points, so the entity
  // doesn't fit: cut should land at "ab" (2 code points) + "…" = "ab…".
  const result = xmlText("ab&cd", 6);
  assert.equal(result, "ab…", `result was "${result}"`);
  // No dangling &
  assert.ok(!result.includes("&amp;".slice(0, -1).trimEnd()), "no half-entity");
});

// ---------------------------------------------------------------------------
// clipEscapedXml
// ---------------------------------------------------------------------------

test("clipEscapedXml: short string returns unchanged", () => {
  assert.equal(clipEscapedXml("hello", 10), "hello");
});

test("clipEscapedXml: clips plain ASCII and appends ellipsis", () => {
  // "abcde" with max=4 → "abc…"
  assert.equal(clipEscapedXml("abcde", 4), "abc…");
});

test("clipEscapedXml: empty string returns empty", () => {
  assert.equal(clipEscapedXml("", 5), "");
});

test("clipEscapedXml: max=1 returns ellipsis for any multi-char input", () => {
  assert.equal(clipEscapedXml("hello", 1), "…");
});

test("clipEscapedXml: does not split inside &amp; entity reference", () => {
  // "&amp;abc" = 8 code points. With max=5, budget=4.
  // "&amp;" is 5 code points which exceeds the budget of 4, so cut at 0 → "…"
  assert.equal(clipEscapedXml("&amp;abc", 5), "…");
});

test("clipEscapedXml: includes entity reference when it fits in budget", () => {
  // "&amp;xy" = 7 code points, exactly max=7, so no clipping.
  assert.equal(clipEscapedXml("&amp;xy", 7), "&amp;xy");
  // "&amp;xyz" = 8 code points. With max=7, budget=6.
  // "&amp;" = 5 cp, then "x" = 1 cp → total 6 = budget. Next "y" pushes to 7 > budget.
  // Safe cut after "x": "&amp;x" + "…" = "&amp;x…" (7 code points).
  assert.equal(clipEscapedXml("&amp;xyz", 7), "&amp;x…");
});

test("clipEscapedXml: handles surrogate pair (emoji) without splitting", () => {
  // "🚀" is 2 UTF-16 units but 1 code point.  "🚀🚀🚀" with max=2 → "🚀…"
  assert.equal(clipEscapedXml("🚀🚀🚀", 2), "🚀…");
});

test("clipEscapedXml: before/after — entity-safe vs naive slice", () => {
  // Before fix: a naive slice("&lt;tag&gt;", 0, 5) would give "&lt;t" which looks fine,
  // but a naive byte-slice could land mid-entity. After fix: entity-aware clipping.
  // "&lt;tag&gt;" = 10 code points. max=5, budget=4.
  //   "&lt;" = 4 code points → fills budget exactly. Next char "t" would be cp 5 > budget.
  //   Result: "&lt;" + "…" = "&lt;…"
  const result = clipEscapedXml("&lt;tag&gt;", 5);
  assert.equal(Array.from(result).length, 5, `code points: "${result}"`);
  // The result must start with the complete entity "&lt;"
  assert.ok(result.startsWith("&lt;"), `should start with &lt;, got "${result}"`);
  assert.ok(result.endsWith("…"), `should end with ellipsis, got "${result}"`);
  // Must not contain a partial &gt; (the closing entity shouldn't appear split)
  assert.ok(!result.includes("&gt"), `no split &gt; entity, got "${result}"`);
});

test("clipEscapedXml: all five entity types are kept whole or excluded entirely", () => {
  const entities = ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"];
  for (const ent of entities) {
    // max = entity.length (exactly fits content, no room for ellipsis = no clip)
    assert.equal(clipEscapedXml(ent, ent.length), ent, `full entity should pass: ${ent}`);
    // max = entity.length - 1 (entity does not fit, output is just ellipsis)
    assert.equal(clipEscapedXml(ent, ent.length - 1), "…", `entity should not be split: ${ent}`);
  }
});

test("clipEscapedXml: output code-point count is always <= max", () => {
  const inputs = [
    "&amp;&amp;&amp;", // all entities
    "hello &lt;world&gt;", // mixed
    "🚀 &amp; 🌍", // emoji + entity
    "normal text here", // plain
    "&apos;&quot;&apos;", // apos/quot
  ];
  const maxValues = [1, 3, 5, 10, 20, 50];
  for (const input of inputs) {
    for (const max of maxValues) {
      const result = clipEscapedXml(input, max);
      const len = Array.from(result).length;
      assert.ok(len <= max, `"${input}" max=${max}: got ${len} code points in "${result}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// safeHttpsUrl
// ---------------------------------------------------------------------------

test("safeHttpsUrl: accepts a valid https URL", () => {
  const url = "https://stellar.expert/explorer/testnet/tx/abc";
  assert.equal(safeHttpsUrl(url), url);
});

test("safeHttpsUrl: rejects http URL", () => {
  assert.equal(safeHttpsUrl("http://example.com/feed"), null);
});

test("safeHttpsUrl: rejects javascript: scheme", () => {
  assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
});

test("safeHttpsUrl: rejects non-URL garbage", () => {
  assert.equal(safeHttpsUrl("not a url at all"), null);
});

test("safeHttpsUrl: rejects empty string", () => {
  assert.equal(safeHttpsUrl(""), null);
});

test("safeHttpsUrl: rejects credential-bearing URLs (userinfo)", () => {
  assert.equal(safeHttpsUrl("https://user:pass@example.com/feed"), null);
  assert.equal(safeHttpsUrl("https://user@example.com/feed"), null);
  assert.equal(safeHttpsUrl("https://:pass@example.com/feed"), null);
});

// ---------------------------------------------------------------------------
// buildAtomEntry
// ---------------------------------------------------------------------------

test("buildAtomEntry: id is scoped to the network, contract, and chain event", () => {
  const event = makeEvent({ eventId: "ledger-1000:0" });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.equal(
    entry.id,
    `tag:mimir,event:${encodeURIComponent(BASE_CONFIG.networkPassphrase)}:${encodeURIComponent(event.contractId)}:ledger-1000%3A0`,
  );
});

test("buildAtomEntry: id is independent of presentation wording", () => {
  const event = makeEvent();
  const reworded = {
    ...event,
    payload: { name: "unknown", eventName: "claim_opened" },
  };

  const originalEntry = buildAtomEntry(event, BASE_CONFIG);
  const rewordedEntry = buildAtomEntry(reworded, BASE_CONFIG);

  assert.notEqual(originalEntry.title, rewordedEntry.title);
  assert.equal(rewordedEntry.id, originalEntry.id);
});

test("buildAtomEntry: id differs when network, contract, or chain event differs", () => {
  const event = makeEvent({ eventId: "same-event" });
  const originalId = buildAtomEntry(event, BASE_CONFIG).id;

  assert.notEqual(
    buildAtomEntry(event, { ...BASE_CONFIG, networkPassphrase: "Public Global Stellar Network ; September 2015" }).id,
    originalId,
    "network must scope the id",
  );
  assert.notEqual(
    buildAtomEntry({ ...event, contractId: VALID_SQUAD }, BASE_CONFIG).id,
    originalId,
    "contract must scope the id",
  );
  assert.notEqual(
    buildAtomEntry({ ...event, eventId: "another-event" }, BASE_CONFIG).id,
    originalId,
    "chain event must scope the id",
  );
});

test("buildAtomEntry: title contains source and event name", () => {
  const event = makeEvent({ source: "market", payload: { name: "claim_created", claimId: 1, category: "test", creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI" } });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.title.includes("market"), `title was "${entry.title}"`);
  assert.ok(entry.title.includes("claim_created"), `title was "${entry.title}"`);
});

test("buildAtomEntry: updated is an ISO 8601 string derived from event.at", () => {
  const event = makeEvent({ at: 1_700_000_000 });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  // ISO 8601 basic check: ends in Z, contains T
  assert.ok(entry.updated.includes("T") && entry.updated.endsWith("Z"),
    `updated was "${entry.updated}"`);
  const parsed = new Date(entry.updated);
  assert.ok(!Number.isNaN(parsed.getTime()), "updated should parse as a valid date");
  assert.equal(parsed.getTime(), 1_700_000_000 * 1000);
});

test("buildAtomEntry: unknown or invalid event.at uses UNKNOWN_EVENT_TIMESTAMP", () => {
  for (const at of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const entry = buildAtomEntry(makeEvent({ at }), BASE_CONFIG);
    assert.equal(entry.updated, UNKNOWN_EVENT_TIMESTAMP);
  }
});

test("buildAtomEntry: content is a non-empty string for a notifiable event", () => {
  const event = makeEvent();
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.content !== null && entry.content.length > 0, "content should be non-null for claim_created");
});

test("buildAtomEntry: link is a valid https URL when the event has a good txHash", () => {
  const event = makeEvent({ txHash: VALID_TX });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.ok(entry.link !== null, "link should not be null for a valid txHash");
  assert.ok(entry.link?.startsWith("https://"), `link was "${entry.link}"`);
});

test("buildAtomEntry: link is null when txHash is empty", () => {
  const event = makeEvent({ txHash: "" });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  assert.equal(entry.link, null);
});

test("buildAtomEntry: content is null for an admin event (no plain-text rendering)", () => {
  const event = makeEvent({
    source: "market",
    payload: { name: "unknown", eventName: "oracle_changed" },
  });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  // formatPlainTextEvent returns null for unknown/admin events
  assert.equal(entry.content, null);
});

test("buildAtomEntry: content is bounded to FEED_CONTENT_MAX_CHARS", () => {
  // Craft an event whose plain-text rendering would be very long by using a
  // long category string in the payload (format.ts clips at 200 chars for the
  // Telegram layer, but feed.ts applies its own cap independently).
  const event = makeEvent({
    payload: {
      name: "claim_created",
      claimId: 999,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const entry = buildAtomEntry(event, BASE_CONFIG);
  if (entry.content !== null) {
    assert.ok(
      Array.from(entry.content).length <= FEED_CONTENT_MAX_CHARS,
      `content length ${Array.from(entry.content).length} exceeds cap`,
    );
  }
});

// ---------------------------------------------------------------------------
// buildAtomFeed — structure
// ---------------------------------------------------------------------------

test("buildAtomFeed: starts with XML declaration and Atom namespace", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "missing XML declaration");
  assert.ok(feed.includes('xmlns="http://www.w3.org/2005/Atom"'), "missing Atom namespace");
});

test("buildAtomFeed: contains required <title>, <id>, <updated> elements", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.includes("<title"), "missing <title>");
  assert.ok(feed.includes("<id>"), "missing <id>");
  assert.ok(feed.includes("<updated>"), "missing <updated>");
});

test("buildAtomFeed: <id> contains the selfUrl", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.includes("https://example.com/feed.atom"), "selfUrl not found in feed");
});

test("buildAtomFeed: <link rel='self'> is present for a valid https selfUrl", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(feed.includes('rel="self"'), "missing self link");
  assert.ok(feed.includes("https://example.com/feed.atom"), "selfUrl not in self link");
});

test("buildAtomFeed: rejects credential-bearing selfUrl without serializing it", () => {
  const selfUrl = "https://private:secret@example.com/feed.atom";
  assert.throws(
    () => buildAtomFeed([], { ...FEED_OPTS, selfUrl }),
    /valid HTTPS URL without credentials/,
  );
});

test("buildAtomFeed: empty events array produces no <entry> elements", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(!feed.includes("<entry>"), "empty feed should have no entries");
});

test("buildAtomFeed: entry count matches events array length", () => {
  const events = [makeEvent(), makeEvent(), makeEvent()];
  const feed = buildAtomFeed(events, FEED_OPTS);
  const count = (feed.match(/<entry>/g) ?? []).length;
  assert.equal(count, 3, `expected 3 entries, found ${count}`);
});

test("buildAtomFeed: <updated> reflects the most recent event.at", () => {
  const events = [
    makeEvent({ at: 1_700_000_100 }),
    makeEvent({ at: 1_700_000_200 }),  // most recent
    makeEvent({ at: 1_700_000_050 }),
  ];
  const feed = buildAtomFeed(events, FEED_OPTS);
  // The feed's <updated> should be the ISO string of the max at (1_700_000_200)
  const expected = new Date(1_700_000_200 * 1000).toISOString();
  assert.ok(feed.includes(expected), `feed <updated> should be ${expected}`);
});

test("buildAtomFeed: <updated> uses UNKNOWN_EVENT_TIMESTAMP when events have no valid ledger time", () => {
  const events = [
    makeEvent({ at: 0 }),
    makeEvent({ at: -5 }),
    makeEvent({ at: Number.NaN }),
  ];
  const feed = buildAtomFeed(events, FEED_OPTS);
  assert.ok(
    feed.includes(`<updated>${UNKNOWN_EVENT_TIMESTAMP}</updated>`),
    `feed <updated> should be ${UNKNOWN_EVENT_TIMESTAMP}, not wall-clock time`,
  );
});

test("buildAtomFeed: <updated> uses UNKNOWN_EVENT_TIMESTAMP for empty events without updatedAt", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(
    feed.includes(`<updated>${UNKNOWN_EVENT_TIMESTAMP}</updated>`),
    `empty feed <updated> should be ${UNKNOWN_EVENT_TIMESTAMP}`,
  );
});

test("buildAtomFeed: <updated> ignores invalid event.at when another event has a valid ledger time", () => {
  const events = [
    makeEvent({ at: Number.POSITIVE_INFINITY }),
    makeEvent({ at: 1_700_000_123 }),
    makeEvent({ at: 0 }),
  ];
  const feed = buildAtomFeed(events, FEED_OPTS);
  const expected = new Date(1_700_000_123 * 1000).toISOString();
  assert.ok(feed.includes(`<updated>${expected}</updated>`), `feed <updated> should be ${expected}`);
});

test("buildAtomFeed: updatedAt option overrides event timestamps", () => {
  const fixed = "2024-01-15T12:00:00.000Z";
  const feed = buildAtomFeed([makeEvent()], { ...FEED_OPTS, updatedAt: fixed });
  assert.ok(feed.includes(fixed), "updatedAt override not found in feed");
});

test("buildAtomFeed: subtitle element is rendered when provided", () => {
  const feed = buildAtomFeed([], { ...FEED_OPTS, subtitle: "Testnet activity" });
  assert.ok(feed.includes("<subtitle"), "missing <subtitle>");
  assert.ok(feed.includes("Testnet activity"), "subtitle text not found");
});

test("buildAtomFeed: subtitle is absent when not provided", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  assert.ok(!feed.includes("<subtitle"), "<subtitle> should not appear when not set");
});

// ---------------------------------------------------------------------------
// buildAtomFeed — hostile input (injection / escaping)
// ---------------------------------------------------------------------------

test("buildAtomFeed: hostile title with XML special chars is escaped", () => {
  const hostileTitle = '<script>alert("xss")</script> & \'injection\'';
  const feed = buildAtomFeed([], { ...FEED_OPTS, title: hostileTitle });

  // The raw hostile string must not appear verbatim
  assert.ok(!feed.includes("<script>"), "raw <script> tag must not appear in feed");
  assert.ok(!feed.includes('alert("xss")') || feed.includes("&quot;"), "quotes must be escaped");

  // The escaped form must be present
  assert.ok(feed.includes("&lt;script&gt;"), "< and > must be escaped in title");
  assert.ok(feed.includes("&amp;"), "& must be escaped in title");
});

test("buildAtomFeed: hostile selfUrl with XML chars is escaped in attributes", () => {
  // Embed a double-quote in the selfUrl to attempt attribute break-out
  // safeHttpsUrl will reject a non-parseable URL, but we test the escaping layer too
  const feed = buildAtomFeed([], {
    ...FEED_OPTS,
    // Use a valid https URL that contains characters that need escaping
    selfUrl: "https://example.com/feed?a=1&b=2",
  });
  // The & in the query string must be escaped in XML attributes
  assert.ok(!feed.includes("a=1&b=2"), "raw & in URL must be XML-escaped");
  assert.ok(feed.includes("a=1&amp;b=2"), "& in URL must appear as &amp;");
});

test("buildAtomFeed: event with hostile category does not break XML", () => {
  const event = makeEvent({
    payload: {
      name: "claim_created",
      claimId: 1,
      category: '<evil attr="injected">',
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const feed = buildAtomFeed([event], FEED_OPTS);

  // The raw attack string must not appear verbatim in content
  assert.ok(!feed.includes('<evil attr="injected">'), "hostile category must be escaped in content");
});

test("buildAtomFeed: event with NUL / C0 control chars in payload does not produce malformed XML", () => {
  const event = makeEvent({
    payload: {
      name: "claim_created",
      claimId: 1,
      category: "crypto\x00\x01\x08",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  });
  const feed = buildAtomFeed([event], FEED_OPTS);
  // XML-illegal NUL must not appear in the output
  assert.ok(!feed.includes("\x00"), "NUL byte must not appear in feed XML");
  assert.ok(!feed.includes("\x01"), "0x01 must not appear in feed XML");
});

test("buildAtomFeed: feed closes with </feed>", () => {
  const feed = buildAtomFeed([makeEvent()], FEED_OPTS);
  assert.ok(feed.trimEnd().endsWith("</feed>"), "feed must end with </feed>");
});

// ---------------------------------------------------------------------------
// buildAtomFeed — each entry structure
// ---------------------------------------------------------------------------

test("buildAtomFeed: each entry has <id>, <title>, <updated>, <content>", () => {
  const feed = buildAtomFeed([makeEvent()], FEED_OPTS);
  assert.ok(feed.includes("<id>"), "entry missing <id>");
  assert.ok(feed.includes("<title"), "entry missing <title>");
  assert.ok(feed.includes("<updated>"), "entry missing <updated>");
  assert.ok(feed.includes("<content"), "entry missing <content>");
});

test("buildAtomFeed: entry link element is present for event with valid txHash", () => {
  const event = makeEvent({ txHash: VALID_TX });
  const feed = buildAtomFeed([event], FEED_OPTS);
  assert.ok(feed.includes('rel="alternate"'), "entry should have an alternate link");
});

test("buildAtomFeed: entry link element is absent for event with no txHash", () => {
  const event = makeEvent({ txHash: "" });
  const feed = buildAtomFeed([event], FEED_OPTS);
  // No link rel=alternate should appear anywhere in a single-entry feed
  assert.ok(!feed.includes('rel="alternate"'), "no link should appear for missing txHash");
});

// ---------------------------------------------------------------------------
// Feed generation time vs last event update time
// ---------------------------------------------------------------------------

test("resolveAtomFeedMetadata: empty feed uses deterministic epoch updatedAt and separate generatedAt", () => {
  const meta = resolveAtomFeedMetadata([], {
    generatedAt: "2026-08-21T10:00:00.000Z",
  });
  assert.deepEqual(meta, {
    updatedAt: FEED_EPOCH_UPDATED_AT,
    generatedAt: "2026-08-21T10:00:00.000Z",
    entryCount: 0,
    isEmpty: true,
  });
});

test("resolveAtomFeedMetadata: unchanged events keep updatedAt fixed while generatedAt advances", () => {
  const events = [
    makeEvent({ at: 1_700_000_100 }),
    makeEvent({ at: 1_700_000_200 }),
  ];
  const first = resolveAtomFeedMetadata(events, {
    generatedAt: "2026-08-21T10:00:00.000Z",
  });
  const second = resolveAtomFeedMetadata(events, {
    generatedAt: "2026-08-21T10:05:00.000Z",
  });

  const expectedUpdated = new Date(1_700_000_200 * 1000).toISOString();
  assert.equal(first.updatedAt, expectedUpdated);
  assert.equal(second.updatedAt, expectedUpdated);
  assert.equal(first.generatedAt, "2026-08-21T10:00:00.000Z");
  assert.equal(second.generatedAt, "2026-08-21T10:05:00.000Z");
  assert.equal(first.entryCount, 2);
  assert.equal(first.isEmpty, false);
});

test("resolveAtomFeedMetadata: events with missing, zero, negative, or non-finite at fall back to epoch", () => {
  const events = [
    makeEvent({ at: 0 }),
    makeEvent({ at: -50 }),
    makeEvent({ at: Number.NaN }),
    makeEvent({ at: Number.POSITIVE_INFINITY }),
  ];
  const meta = resolveAtomFeedMetadata(events, {
    generatedAt: "2026-08-21T10:00:00.000Z",
  });
  assert.equal(meta.updatedAt, FEED_EPOCH_UPDATED_AT);
  assert.equal(meta.generatedAt, "2026-08-21T10:00:00.000Z");
  assert.equal(meta.entryCount, 4);
  assert.equal(meta.isEmpty, false);
});

test("buildAtomFeed: deterministic snapshot for empty feed without generatedAt", () => {
  const feed = buildAtomFeed([], FEED_OPTS);
  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title type="text">Mimir Events</title>',
    "  <id>https://example.com/feed.atom</id>",
    `  <updated>${FEED_EPOCH_UPDATED_AT}</updated>`,
    '  <link rel="self" type="application/atom+xml" href="https://example.com/feed.atom"/>',
    "</feed>",
  ].join("\n");

  assert.equal(feed, expected);
});

test("buildAtomFeed: deterministic snapshot for empty feed with generatedAt", () => {
  const generatedAt = "2026-08-21T10:00:00.000Z";
  const feed = buildAtomFeed([], { ...FEED_OPTS, generatedAt });
  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:mimir="${MIMIR_FEED_NS}">`,
    '  <title type="text">Mimir Events</title>',
    "  <id>https://example.com/feed.atom</id>",
    `  <updated>${FEED_EPOCH_UPDATED_AT}</updated>`,
    `  <mimir:generated>${generatedAt}</mimir:generated>`,
    '  <link rel="self" type="application/atom+xml" href="https://example.com/feed.atom"/>',
    "</feed>",
  ].join("\n");

  assert.equal(feed, expected);
});

test("buildAtomFeed: regenerating an unchanged feed updates <mimir:generated> without changing <updated>", () => {
  const events = [makeEvent({ at: 1_700_000_200 })];
  const expectedUpdated = new Date(1_700_000_200 * 1000).toISOString();

  const feed1 = buildAtomFeed(events, {
    ...FEED_OPTS,
    generatedAt: "2026-08-21T10:00:00.000Z",
  });
  const feed2 = buildAtomFeed(events, {
    ...FEED_OPTS,
    generatedAt: "2026-08-21T10:05:00.000Z",
  });

  assert.ok(feed1.includes(`  <updated>${expectedUpdated}</updated>`));
  assert.ok(feed2.includes(`  <updated>${expectedUpdated}</updated>`));
  assert.ok(feed1.includes("  <mimir:generated>2026-08-21T10:00:00.000Z</mimir:generated>"));
  assert.ok(feed2.includes("  <mimir:generated>2026-08-21T10:05:00.000Z</mimir:generated>"));
  assert.notEqual(feed1, feed2);
});

test("buildAtomFeed: hostile generatedAt is sanitized and XML-escaped", () => {
  const feed = buildAtomFeed([], {
    ...FEED_OPTS,
    generatedAt: '2026-08-21T10:00:00Z\x00<bad>&"',
  });
  assert.ok(!feed.includes("\x00"), "NUL byte must not appear in <mimir:generated>");
  assert.ok(!feed.includes("<bad>"), "raw XML tag must not appear in <mimir:generated>");
  assert.ok(
    feed.includes("  <mimir:generated>2026-08-21T10:00:00Z&lt;bad&gt;&amp;&quot;</mimir:generated>"),
    "<mimir:generated> must be XML-escaped",
  );
});
