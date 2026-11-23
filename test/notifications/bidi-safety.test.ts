import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeUserText, stripBidiControls } from "../../src/notifications/sanitize.js";
import {
  formatEvent,
  formatPlainTextEvent,
  isolateAmount,
} from "../../src/notifications/format.js";
import { formatEventHtml } from "../../src/notifications/html.js";
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

const BIDI_ANY = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

function ev(payload: DecodedEvent["payload"], extra: Partial<DecodedEvent> = {}): DecodedEvent {
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
    ...extra,
  } as DecodedEvent;
}

describe("sanitizeUserText / stripBidiControls (#920)", () => {
  it("strips U+202E RLO from a category", () => {
    assert.equal(sanitizeUserText("crypto\u202Eevil"), "cryptoevil");
  });

  it("strips U+200E and U+200F bidi marks", () => {
    assert.equal(stripBidiControls("a\u200Eb\u200Fc"), "abc");
  });

  it("preserves legitimate Arabic characters", () => {
    assert.equal(sanitizeUserText("السعر"), "السعر");
  });
});

describe("formatNotificationExport bidi safety (#920)", () => {
  it("renders RTL label + amount with the amount intact and no bidi controls", () => {
    const out = formatPlainTextEvent(
      CONFIG,
      ev({
        name: "claim_challenged",
        claimId: 1,
        challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        stake: 12_345_678n,
      }),
    );
    assert.ok(out);
    assert.match(out, /1\.2345678 USDC/);
    // The isolate wraps the amount but the amount itself is unchanged.
    assert.ok(out.includes("\u2068"), "amount should be isolated with FSI");
    assert.ok(out.includes("\u2069"), "isolate should be closed with PDI");
    // No bidi controls other than the FSI/PDI we added.
    const rest = out.replace(/[\u2068\u2069]/g, "");
    assert.doesNotMatch(rest, BIDI_ANY);
  });

  it("strips untrusted U+202E around an amount so the digits do not reorder", () => {
    // Simulate an event whose category contains a hostile RLO before the amount line.
    const out = formatEvent(
      CONFIG,
      ev({
        name: "claim_created",
        claimId: 1,
        category: "a\u202Eb",
        creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    assert.ok(out);
    assert.doesNotMatch(out, /\u202E/);
    assert.match(out, /Category: a b|Category: ab/);
  });

  it("html renderer also sanitizes user fields and isolates amounts", () => {
    const out = formatEventHtml(
      CONFIG,
      ev({
        name: "claim_created",
        claimId: 1,
        category: "crypto\u202Ex",
        creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    assert.ok(out);
    assert.doesNotMatch(out, /\u202E/);
    assert.ok(!out.includes("\u200E") && !out.includes("\u200F"));
  });

  it("isolateAmount leaves the exact numeric text untouched", () => {
    const iso = isolateAmount("1.2345678 USDC");
    assert.equal(iso, "\u20681.2345678 USDC\u2069");
    assert.equal(iso.replace(/[\u2068\u2069]/g, ""), "1.2345678 USDC");
  });
});
