import assert from "node:assert/strict";
import test from "node:test";

import {
  FEED_CONTENT_MAX_CHARS,
  boundEscapedXml,
  buildAtomFeed,
  renderAtomEntry,
  xmlText,
} from "../dist/stellar/feed.js";

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const BASE_CONFIG = {
  marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
  squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  explorerBaseUrl: "https://stellar.expert/explorer/testnet",
  marketContractVersion: "v1",
  squadContractVersion: "v1",
};

function assertValidXmlFragment(escapedFragment) {
  // 1. No lone UTF-16 surrogates
  for (let i = 0; i < escapedFragment.length; i++) {
    const code = escapedFragment.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = escapedFragment.charCodeAt(i + 1);
      assert.ok(
        next >= 0xdc00 && next <= 0xdfff,
        `Lone high surrogate at UTF-16 offset ${i} in "${escapedFragment}"`,
      );
      i += 1;
    } else {
      assert.ok(
        code < 0xdc00 || code > 0xdfff,
        `Lone low surrogate at UTF-16 offset ${i} in "${escapedFragment}"`,
      );
    }
  }

  // 2. Every '&' must begin a complete XML entity reference; no raw '<' or '>'
  assert.ok(!escapedFragment.includes("<"), `Unescaped '<' in "${escapedFragment}"`);
  assert.ok(!escapedFragment.includes(">"), `Unescaped '>' in "${escapedFragment}"`);
  const strippedEntities = escapedFragment.replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
    "",
  );
  assert.ok(
    !strippedEntities.includes("&"),
    `Broken or unescaped XML entity in "${escapedFragment}"`,
  );
}

test("bounds post-escape expansion so repeated '&' never exceeds FEED_CONTENT_MAX_CHARS", () => {
  const ampFlood = "&".repeat(FEED_CONTENT_MAX_CHARS);
  const out = xmlText(ampFlood, FEED_CONTENT_MAX_CHARS);

  const cpLength = Array.from(out).length;
  assert.ok(
    cpLength <= FEED_CONTENT_MAX_CHARS,
    `Expected <= ${FEED_CONTENT_MAX_CHARS} code points after XML escaping, got ${cpLength}`,
  );
  assert.ok(out.endsWith("…"), "Truncated output must end with readable ellipsis");
  assertValidXmlFragment(out);
});

test("never splits surrogate pairs or XML entity sequences across every cut boundary", () => {
  const mixed = `🚀a&b<c>d"e'f🧪🎉<&"'>`;

  for (let max = 1; max <= 50; max++) {
    const result = xmlText(mixed, max);
    const codePoints = Array.from(result);
    assert.ok(
      codePoints.length <= max,
      `Length ${codePoints.length} exceeded max=${max}: "${result}"`,
    );
    assertValidXmlFragment(result);
    if (max >= 2 && result !== xmlText(mixed, 500)) {
      assert.equal(codePoints[codePoints.length - 1], "…");
    }
  }

  assert.equal(xmlText(mixed, 0), "");
  assert.equal(boundEscapedXml("&#x1F680;&quot;hello&amp;world", 10), "&#x1F680;…");
  assertValidXmlFragment(boundEscapedXml("&#x1F680;&quot;hello&amp;world", 10));
});

test("buildAtomFeed and renderAtomEntry bound <content> and <summary> after XML escaping", () => {
  const rendered = renderAtomEntry(
    {
      id: "tag:mimir,event:1001-0",
      title: "mimir-market: claim_resolved",
      updated: "2026-10-20T12:00:00.000Z",
      summary: `Summary <&"'> 🚀🚀🚀 with entities`,
      content: `Content <&"'> 🧪🧪🧪 with entities and trailing text`,
      link: "https://stellar.expert/explorer/testnet/tx/abc",
    },
    24,
  );

  const summaryMatch = rendered.match(/<summary type="text">([^<]*)<\/summary>/);
  const contentMatch = rendered.match(/<content type="text">([^<]*)<\/content>/);
  assert.ok(summaryMatch);
  assert.ok(contentMatch);
  assert.ok(Array.from(summaryMatch[1]).length <= 24);
  assert.ok(Array.from(contentMatch[1]).length <= 24);
  assert.ok(summaryMatch[1].endsWith("…"));
  assert.ok(contentMatch[1].endsWith("…"));
  assertValidXmlFragment(summaryMatch[1]);
  assertValidXmlFragment(contentMatch[1]);

  const feed = buildAtomFeed(
    [
      {
        source: "market",
        contractId: BASE_CONFIG.marketContractId,
        version: "v1",
        ledger: 1050,
        txHash: VALID_TX,
        at: 1_700_000_500,
        eventId: "1050-0",
        eventType: "contract",
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        payload: {
          name: "claim_resolved",
          claimId: 42,
          winnerSide: 1,
          summary: `<"&'>🚀`.repeat(60),
          confidence: 99,
          evidenceHash: "ab".repeat(32),
        },
      },
    ],
    {
      title: "Mimir Events",
      selfUrl: "https://example.com/feed.atom",
      config: BASE_CONFIG,
      maxContentChars: 60,
    },
  );

  const feedContent = feed.match(/<content type="text">([\s\S]*?)<\/content>/);
  assert.ok(feedContent);
  assert.ok(Array.from(feedContent[1]).length <= 60);
  assert.ok(feedContent[1].endsWith("…"));
  assertValidXmlFragment(feedContent[1]);
});
