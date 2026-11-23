import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LINK_LENGTH,
  SAFE_LINK_PROTOCOLS,
  escapeMdLinkUrl,
  isSafeLinkUrl,
  safeLinkUrl,
} from "../dist/notifications/link-safety.js";
import {
  eventExplorerUrl,
  explorerKeyboard,
  formatEvent,
  formatFallbackEvent,
  formatPlainTextEvent,
} from "../dist/notifications/format.js";
import { formatEventHtml, formatFallbackEventHtml, linkHtml } from "../dist/notifications/html.js";
import { appUrlFor } from "../dist/notifications/app-links.js";

const VALID_TX = "0123456789abcdef".repeat(4);

function config(overrides = {}) {
  return {
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    chatId: "-1001234567890",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

function challenged(overrides = {}) {
  return {
    source: "market",
    contractId: "market",
    ledger: 4226692,
    txHash: VALID_TX,
    at: 0,
    eventId: "0018276211125911551-0000000001",
    payload: { name: "claim_challenged", claimId: 7, challenger: "GABCD", stake: 20_000_000n },
    ...overrides,
  };
}

const SAFE_TX_URL = `https://stellar.expert/explorer/testnet/tx/${VALID_TX}`;

/** Explorer origins a hand-built config could carry that must never become links. */
const UNSAFE_ORIGINS = [
  "javascript:alert(1)//",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "tg://resolve?domain=evil",
  "http://stellar.expert/explorer",
  "ftp://stellar.expert/explorer",
  "https://user:pass@stellar.expert/explorer",
];

test("only https is a documented safe link scheme", () => {
  assert.deepEqual([...SAFE_LINK_PROTOCOLS], ["https:"]);
  assert.ok(Object.isFrozen(SAFE_LINK_PROTOCOLS));
});

test("safeLinkUrl accepts https explorer and app URLs unchanged", () => {
  assert.equal(safeLinkUrl(SAFE_TX_URL), SAFE_TX_URL);
  assert.equal(safeLinkUrl("https://app.mimir.example/claims/7"), "https://app.mimir.example/claims/7");
  assert.equal(isSafeLinkUrl(SAFE_TX_URL), true);
});

test("safeLinkUrl rejects unsafe schemes, userinfo, controls and oversized values", () => {
  const bad = [
    ...UNSAFE_ORIGINS,
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "https://stellar.expert/tx/\nhttps://evil.example",
    "https://stellar.expert/\u202Etx",
    "https://",
    "not a url",
    "",
    `https://stellar.expert/${"a".repeat(MAX_LINK_LENGTH)}`,
    undefined,
    null,
    42,
  ];
  for (const url of bad) {
    assert.equal(safeLinkUrl(url), null, String(url).slice(0, 40));
  }
});

test("escapeMdLinkUrl escapes the characters MarkdownV2 reserves inside a link target", () => {
  assert.equal(escapeMdLinkUrl(SAFE_TX_URL), SAFE_TX_URL);
  assert.equal(escapeMdLinkUrl("https://x.example/a)b\\c"), "https://x.example/a\\)b\\\\c");
});

test("before/after: unsafe explorer origin renders inert tx text in every renderer", () => {
  for (const explorerBaseUrl of UNSAFE_ORIGINS) {
    const cfg = config({ explorerBaseUrl });
    const event = challenged();

    assert.equal(eventExplorerUrl(cfg, event), null, explorerBaseUrl);
    assert.equal(explorerKeyboard(cfg, event), undefined, explorerBaseUrl);

    const md = formatEvent(cfg, event);
    assert.ok(md.endsWith("_ledger 4226692_ · tx"), `markdown: ${explorerBaseUrl}\n${md}`);
    assert.ok(!md.includes("]("), "markdown must not contain a link");

    const html = formatEventHtml(cfg, event);
    assert.ok(html.endsWith("<i>ledger 4226692</i> · tx"), `html: ${explorerBaseUrl}\n${html}`);
    assert.ok(!html.includes("<a"), "html must not contain an anchor");

    const plain = formatPlainTextEvent(cfg, event);
    assert.ok(!plain.includes("tx:"), "plain text must not print a URL line");
    assert.ok(!plain.includes(explorerBaseUrl.replace(/\/+$/, "")), plain);

    const fbMd = formatFallbackEvent(cfg, event, "boom");
    assert.ok(fbMd.includes("Ledger: 4226692 · tx\n"), fbMd);
    assert.ok(!fbMd.includes("]("));

    const fbHtml = formatFallbackEventHtml(cfg, event, "boom");
    assert.ok(fbHtml.includes("Ledger: 4226692 · tx\n"), fbHtml);
    assert.ok(!fbHtml.includes("<a"));
  }
});

test("safe explorer origin keeps its existing link in every renderer", () => {
  const cfg = config();
  const event = challenged();

  assert.ok(formatEvent(cfg, event).endsWith(`_ledger 4226692_ · [tx](${SAFE_TX_URL})`));
  assert.ok(formatEventHtml(cfg, event).endsWith(`<i>ledger 4226692</i> · <a href="${SAFE_TX_URL}">tx</a>`));
  assert.ok(formatPlainTextEvent(cfg, event).includes(`tx: ${SAFE_TX_URL}`));
  assert.ok(formatFallbackEvent(cfg, event, "boom").includes(`· [tx](${SAFE_TX_URL})`));
  assert.ok(formatFallbackEventHtml(cfg, event, "boom").includes(`· <a href="${SAFE_TX_URL}">tx</a>`));
  assert.deepEqual(explorerKeyboard(cfg, event).inline_keyboard[0].map((b) => b.url), [SAFE_TX_URL]);
});

test("fallback renderers never emit an empty link target for a malformed hash", () => {
  const cfg = config();
  const event = challenged({ txHash: "not-a-valid-hash", payload: { name: "unknown" } });
  const md = formatFallbackEvent(cfg, event, "no decoder");
  const html = formatFallbackEventHtml(cfg, event, "no decoder");
  assert.ok(!md.includes("[tx]()"), md);
  assert.ok(md.includes("· tx\n"), md);
  assert.ok(!html.includes('href=""'), html);
  assert.ok(html.includes("· tx\n"), html);
});

test("events without a hash still render no tx part at all", () => {
  const cfg = config();
  const event = challenged({ txHash: "" });
  assert.ok(formatEvent(cfg, event).endsWith("_ledger 4226692_"));
  assert.ok(formatEventHtml(cfg, event).endsWith("<i>ledger 4226692</i>"));
  assert.ok(!formatFallbackEvent(cfg, event, "x").includes("tx"));
});

test("linkHtml renders unsafe targets as escaped inert text", () => {
  assert.equal(linkHtml("tx", SAFE_TX_URL), `<a href="${SAFE_TX_URL}">tx</a>`);
  assert.equal(linkHtml("<tx>", "javascript:alert(1)"), "&lt;tx&gt;");
  assert.equal(linkHtml("tx", ""), "tx");
  assert.equal(linkHtml("tx", null), "tx");
});

test("app deep links go through the same policy", () => {
  const event = challenged();
  assert.equal(appUrlFor(event, "https://app.mimir.example"), "https://app.mimir.example/claims/7");
  assert.equal(appUrlFor(event, "https://user:pw@app.mimir.example"), null);
  assert.equal(appUrlFor(event, "data:text/html,hi"), null);
});
