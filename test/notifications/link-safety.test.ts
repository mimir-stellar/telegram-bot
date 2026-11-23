import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeShareLink, appUrlFor, appTargetFor } from "../../src/notifications/app-links.js";
import type { DecodedEvent } from "../../src/stellar/decode.js";

const BASE = "https://app.mimir.example";

function ev(payload: DecodedEvent["payload"]): DecodedEvent {
  return {
    source: "market",
    contractId: "CTEST",
    version: "v1",
    ledger: 100,
    txHash: "",
    at: 1_700_000_000,
    eventId: "e-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  } as DecodedEvent;
}

describe("sanitizeShareLink (#924)", () => {
  it("happy: public link is byte-identical", () => {
    const url = `${BASE}/claims/42?id=42`;
    assert.equal(sanitizeShareLink(url), url);
  });

  it("failure: private query key is stripped", () => {
    const out = sanitizeShareLink(`${BASE}/claims/42?id=42&token=SECRET`);
    assert.ok(out);
    assert.doesNotMatch(out, /token/);
    assert.match(out, /id=42/);
  });

  it("failure: fragment is dropped when a private key was present", () => {
    const out = sanitizeShareLink(`${BASE}/claims/42?token=SECRET#access=SECRET`);
    assert.ok(out);
    assert.doesNotMatch(out, /token/);
    assert.doesNotMatch(out, /#/);
  });

  it("boundary: URL with only private params falls back to the bare path", () => {
    const out = sanitizeShareLink(`${BASE}/claims/42?token=S&ref=S`);
    assert.ok(out);
    assert.equal(out, `${BASE}/claims/42`);
  });

  it("fragment preserved when no private key is present", () => {
    const url = `${BASE}/claims/42#section`;
    assert.equal(sanitizeShareLink(url), url);
  });

  it("rejects non-http(s) URLs and garbage", () => {
    assert.equal(sanitizeShareLink("javascript:alert(1)"), null);
    assert.equal(sanitizeShareLink("not a url"), null);
    assert.equal(sanitizeShareLink(null), null);
    assert.equal(sanitizeShareLink(""), null);
  });
});

describe("appUrlFor routes through sanitizeShareLink (#924)", () => {
  it("appTargetFor mapping is unchanged", () => {
    assert.deepEqual(
      appTargetFor(ev({ name: "claim_created", claimId: 7, creator: "G", category: "c" })),
      { route: "claims", id: "7" },
    );
    assert.deepEqual(
      appTargetFor(ev({ name: "market_created", marketId: 3, question: "q", captain: "G", feeBps: 1, deadline: 1 })),
      { route: "squads", id: "3" },
    );
    assert.equal(appTargetFor(ev({ name: "withdrawal", to: "G", amount: 1n })), null);
  });

  it("emits a link with a public id and no private params", () => {
    const out = appUrlFor(
      ev({ name: "claim_created", claimId: 42, creator: "G", category: "c" }),
      `${BASE}/?token=SECRET`,
    );
    assert.ok(out);
    assert.doesNotMatch(out, /token/);
    assert.match(out, /\/claims\/42$/);
  });

  it("returns null when no base URL is configured", () => {
    assert.equal(appUrlFor(ev({ name: "claim_created", claimId: 1, creator: "G", category: "c" }), null), null);
    assert.equal(appUrlFor(ev({ name: "claim_created", claimId: 1, creator: "G", category: "c" }), undefined), null);
  });
});
