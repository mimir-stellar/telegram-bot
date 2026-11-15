import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAtomEntry,
  buildAtomEntryId,
  buildAtomFeed,
  canonicalChainEventIdentity,
  canonicalFeedContractId,
  canonicalFeedNetworkId,
} from "../dist/stellar/feed.js";

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const OTHER_TX = "1111111234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const VALID_MARKET = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const VALID_SQUAD = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function makeConfig(overrides = {}) {
  return {
    marketContractId: VALID_MARKET,
    squadContractId: VALID_SQUAD,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    locale: "en",
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  return {
    source: "market",
    contractId: VALID_MARKET,
    version: "v1",
    ledger: 50_100,
    txHash: VALID_TX,
    at: 1_700_000_500,
    eventId: "0000215178201088000-0000000001",
    eventType: "contract",
    transactionIndex: 2,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 42,
      category: "governance",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
    ...overrides,
  };
}

test("buildAtomEntryId encodes network, contract, and chain event identity", () => {
  const cfgTestnet = makeConfig();
  const cfgMainnet = makeConfig({
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  });
  const cfgFuturenet = makeConfig({
    networkPassphrase: "Test SDF Future Network ; October 2022",
  });
  const cfgCustomA = makeConfig({
    networkPassphrase: "Standalone Network ; February 2017",
  });
  const cfgCustomB = makeConfig({
    networkPassphrase: "Private Sandbox ; November 2026",
  });

  assert.equal(canonicalFeedNetworkId(cfgTestnet), "testnet");
  assert.equal(canonicalFeedNetworkId(cfgMainnet), "mainnet");
  assert.equal(canonicalFeedNetworkId(cfgFuturenet), "futurenet");
  assert.match(canonicalFeedNetworkId(cfgCustomA), /^custom-[0-9a-f]{12}$/);
  assert.notEqual(canonicalFeedNetworkId(cfgCustomA), canonicalFeedNetworkId(cfgCustomB));

  const eventMarket = makeEvent();
  const idTestnet = buildAtomEntryId(eventMarket, cfgTestnet);
  const idMainnet = buildAtomEntryId(eventMarket, cfgMainnet);
  const idFuturenet = buildAtomEntryId(eventMarket, cfgFuturenet);
  const idCustomA = buildAtomEntryId(eventMarket, cfgCustomA);
  const idCustomB = buildAtomEntryId(eventMarket, cfgCustomB);

  assert.equal(
    idTestnet,
    `tag:mimir,event:testnet:${VALID_MARKET}:0000215178201088000-0000000001`,
  );
  // Same contract + eventId across different networks never collide
  assert.equal(new Set([idTestnet, idMainnet, idFuturenet, idCustomA, idCustomB]).size, 5);

  // Same network + eventId across different contracts never collide
  const eventSquad = makeEvent({
    source: "squad",
    contractId: VALID_SQUAD,
  });
  const idSquad = buildAtomEntryId(eventSquad, cfgTestnet);
  assert.notEqual(idSquad, idTestnet);
  assert.ok(idSquad.includes(VALID_SQUAD));

  // Same network + contract across different chain eventIds never collide
  const eventNext = makeEvent({ eventId: "0000215178201088000-0000000002" });
  assert.notEqual(buildAtomEntryId(eventNext, cfgTestnet), idTestnet);
});

test("buildAtomEntry and buildAtomFeed preserve entry IDs when wording templates, locales, or links change", () => {
  const eventV1 = makeEvent();

  // 1. Default English template
  const entryEn = buildAtomEntry(eventV1, makeConfig({ locale: "en" }));

  // 2. Spanish locale template (rewrites plain-text notification wording)
  const entryEs = buildAtomEntry(eventV1, makeConfig({ locale: "es" }));
  assert.notEqual(entryEn.content, entryEs.content);
  assert.equal(entryEn.id, entryEs.id);

  // 3. Complete wording template overhaul via formatTitle + formatContent
  const entryCustomTemplate = buildAtomEntry(eventV1, makeConfig({ locale: "en" }), {
    mimirAppUrl: "https://app.mimir.example",
    formatTitle: (ev) => `[Redesigned V2 Copy] Market Claim #${ev.payload.claimId}`,
    formatContent: (_cfg, ev) =>
      `Brand-new editorial wording for claim ${ev.payload.claimId} on ledger ${ev.ledger}.`,
  });
  assert.notEqual(entryCustomTemplate.title, entryEn.title);
  assert.notEqual(entryCustomTemplate.content, entryEn.content);
  assert.equal(entryCustomTemplate.appLink, "https://app.mimir.example/claims/42");
  assert.equal(entryCustomTemplate.id, entryEn.id);

  // 4. Re-decoded payload presentation fields & explorer URL changes keep identical ID
  const eventRenamedPayload = makeEvent({
    at: 1_700_999_999,
    payload: {
      name: "market_settled",
      claimId: 999,
      outcome: "yes",
      totalPool: 50_000_000n,
    },
  });
  const entryRenamed = buildAtomEntry(
    eventRenamedPayload,
    makeConfig({
      explorerBaseUrl: "https://custom-explorer.example/explorer",
      channelPreviewMode: true,
    }),
  );
  assert.notEqual(entryRenamed.title, entryEn.title);
  assert.notEqual(entryRenamed.content, entryEn.content);
  assert.notEqual(entryRenamed.link, entryEn.link);
  assert.equal(entryRenamed.id, entryEn.id);

  // 5. XML feed <id> elements stay byte-for-byte identical across wording template changes
  const xmlBefore = buildAtomFeed([eventV1], {
    title: "Mimir Events v1",
    selfUrl: "https://example.com/feed.atom",
    config: makeConfig({ locale: "en" }),
    updatedAt: "2026-11-15T00:00:00.000Z",
  });
  const xmlAfter = buildAtomFeed([eventV1], {
    title: "Mimir Events v2 Redesigned",
    subtitle: "Updated copy template",
    selfUrl: "https://example.com/feed.atom",
    config: makeConfig({ locale: "es" }),
    mimirAppUrl: "https://app.mimir.example",
    updatedAt: "2026-11-15T00:00:00.000Z",
    formatTitle: () => "Updated Headline Wording",
    formatContent: () => "Updated plain-text body wording template.",
  });

  const extractEntryIds = (xml) =>
    [...xml.matchAll(/<entry>[\s\S]*?<id>([^<]+)<\/id>[\s\S]*?<\/entry>/g)].map((m) => m[1]);

  assert.deepEqual(extractEntryIds(xmlAfter), extractEntryIds(xmlBefore));
  assert.equal(extractEntryIds(xmlAfter)[0], entryEn.id);
});

test("boundary cases: missing eventId falls back to chain coordinates, contract normalizes case, and special chars stay XML-safe", () => {
  const cfg = makeConfig();

  // Lowercase StrKey contractId normalizes to canonical uppercase
  const lowerContract = VALID_MARKET.toLowerCase();
  assert.equal(
    canonicalFeedContractId(makeEvent({ contractId: lowerContract }), cfg),
    VALID_MARKET,
  );

  // Empty contractId falls back to configured contract for event.source
  assert.equal(
    canonicalFeedContractId(makeEvent({ contractId: "", source: "squad" }), cfg),
    VALID_SQUAD,
  );

  // Empty eventId with topic uses eventKey v2 composite
  const topicEventA = makeEvent({
    eventId: "",
    topic: ["claim_created", "42"],
    transactionIndex: 1,
    operationIndex: 0,
  });
  const topicEventB = makeEvent({
    eventId: "",
    topic: ["claim_created", "43"],
    transactionIndex: 1,
    operationIndex: 0,
  });
  const idTopicA = buildAtomEntryId(topicEventA, cfg);
  const idTopicB = buildAtomEntryId(topicEventB, cfg);
  assert.ok(idTopicA.includes("v2:50100:"));
  assert.notEqual(idTopicA, idTopicB);

  // Empty eventId without topic falls back to deterministic chain coordinates
  const coordOp0 = makeEvent({
    eventId: "   ",
    ledger: 60_000,
    txHash: VALID_TX,
    transactionIndex: 3,
    operationIndex: 0,
  });
  const coordOp1 = makeEvent({
    eventId: "",
    ledger: 60_000,
    txHash: VALID_TX,
    transactionIndex: 3,
    operationIndex: 1,
  });
  const coordOtherTx = makeEvent({
    eventId: "",
    ledger: 60_000,
    txHash: OTHER_TX,
    transactionIndex: 3,
    operationIndex: 0,
  });

  assert.match(canonicalChainEventIdentity(coordOp0), /^coord:60000:/);
  assert.notEqual(buildAtomEntryId(coordOp0, cfg), buildAtomEntryId(coordOp1, cfg));
  assert.notEqual(buildAtomEntryId(coordOp0, cfg), buildAtomEntryId(coordOtherTx, cfg));

  // Hostile eventId characters are percent-encoded and never break XML
  const hostile = makeEvent({ eventId: '1001-0"><script>&' });
  const xml = buildAtomFeed([hostile], {
    title: "Mimir Events",
    selfUrl: "https://example.com/feed.atom",
    config: cfg,
    updatedAt: "2026-11-15T00:00:00.000Z",
  });
  assert.equal(xml.includes("<script>"), false);
  assert.match(xml, /<id>tag:mimir,event:testnet:/);
});
