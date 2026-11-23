import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatNotificationExport, formatPlainTextEvent } from "../../src/notifications/format.js";
import { formatFallbackEventHtml } from "../../src/notifications/html.js";
import type { DecodedEvent } from "../../src/stellar/decode.js";
import type { StellarConfig } from "../../src/config.js";

const CONFIG = {
  marketContractId: "CA",
  squadContractId: "CB",
  networkPassphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcUrl: "https://soroban-testnet.stellar.org",
  explorerBase: "https://stellar.expert/explorer/testnet",
  locale: "en",
} as unknown as StellarConfig;

function makeEvent(payload: DecodedEvent["payload"], txHash = ""): DecodedEvent {
  return {
    source: payload.name === "deposited" || payload.name === "market_created" ? "squad" : "market",
    contractId: "CTEST",
    version: "v1",
    ledger: 100,
    txHash,
    at: 1_700_000_000,
    eventId: "e-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  } as DecodedEvent;
}

describe("formatNotificationExport — accessible plaintext contract (#921)", () => {
  it("plain export carries identity, action, outcome, and no emoji-only meaning", () => {
    const ev = makeEvent({
      name: "claim_resolved",
      claimId: 7,
      winnerSide: 1,
      summary: "Resolved by oracle",
      confidence: 85,
      evidenceHash: "00",
    });
    const out = formatNotificationExport(CONFIG, ev);
    assert.ok(out, "plain export must return text");
    assert.match(out, /Claim #7/);
    assert.match(out, /resolved/);
    assert.match(out, /winner:\s*creator/);
    assert.match(out, /Confidence: 85/);
    assert.match(out, /ledger 100/);
  });

  it("no-image boundary: event with no txHash still yields a complete plain summary", () => {
    const ev = makeEvent({
      name: "claim_challenged",
      claimId: 42,
      challenger: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV",
      stake: 12_345_678n,
    }, "");
    const out = formatPlainTextEvent(CONFIG, ev);
    assert.ok(out);
    assert.match(out, /Claim #42 challenged/);
    assert.match(out, /Stake: 1\.2345678 USDC/);
    assert.match(out, /Challenger:/);
    assert.match(out, /ledger 100/);
    // No tx URL, but the message is still complete.
    assert.doesNotMatch(out, /tx:\s*https?:/);
  });

  it("no emoji-only lines: every line with a non-ASCII char also has an ASCII letter", () => {
    const cases: DecodedEvent["payload"][] = [
      { name: "claim_created", claimId: 1, category: "crypto", creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { name: "claim_resolved", claimId: 2, winnerSide: 2, summary: "ok", confidence: 90, evidenceHash: "00" },
      { name: "withdrawal", to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: 5_000_000n },
    ];
    for (const payload of cases) {
      const out = formatPlainTextEvent(CONFIG, makeEvent(payload));
      assert.ok(out, `plain export null for ${payload.name}`);
      for (const line of out.split("\n")) {
        const hasNonAscii = /[^\x00-\x7F]/.test(line);
        const hasAsciiLetter = /[A-Za-z]/.test(line);
        if (hasNonAscii) {
          assert.ok(hasAsciiLetter, `line relies on non-ASCII alone: ${JSON.stringify(line)}`);
        }
      }
    }
  });

  it("html fallback can be requested as plaintext for image-free consumers", () => {
    const ev = makeEvent({
      name: "claim_resolved",
      claimId: 9,
      winnerSide: 1,
      summary: "x",
      confidence: 50,
      evidenceHash: "00",
    });
    const html = formatFallbackEventHtml(CONFIG, ev, "boom", { accessibleFallback: true });
    assert.doesNotMatch(html, /<[a-z]/i, "accessible fallback must not contain HTML tags");
    assert.match(html, /Claim #9|Mimir event/);
  });
});
