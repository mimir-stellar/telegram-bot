import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeEvent, fingerprintDecodedEvent } from "../dist/stellar/decode.js";
import { decodeGenericEvent, fingerprintGenericEvent } from "../dist/stellar/generic-decode.js";
import {
  DECODER_FINGERPRINT_VERSION,
  canonicalizeValue,
  fingerprintDecoderOutput,
  compareFixtureFingerprints,
  formatDriftReport,
} from "../dist/stellar/decoder-fingerprint.js";
import * as ev from "./fixtures/events.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, "fixtures", "decoder-fingerprints.v1.json");

function buildReviewedFixtureFingerprints() {
  const cases = {
    "typed:market:claim_created": decodeEvent("market", ev.claimCreatedEvent()),
    "typed:market:claim_challenged": decodeEvent("market", ev.claimChallengedEvent()),
    "typed:market:claim_resolved": decodeEvent("market", ev.claimResolvedEvent()),
    "typed:market:claim_cancelled": decodeEvent("market", ev.claimCancelledEvent()),
    "typed:market:market_settled": decodeEvent("market", ev.marketSettledEvent()),
    "typed:market:challenger_paid": decodeEvent("market", ev.challengerPaidEvent()),
    "typed:market:fee_claimed": decodeEvent("market", ev.feeClaimedEvent()),
    "typed:market:withdrawal": decodeEvent("market", ev.withdrawalEvent()),
    "typed:market:withdrawal_pending": decodeEvent("market", ev.withdrawalPendingEvent()),
    "typed:squad:market_created": decodeEvent("squad", ev.squadMarketCreatedEvent()),
    "typed:squad:deposited": decodeEvent("squad", ev.squadDepositedEvent()),
    "typed:squad:withdrawn": decodeEvent("squad", ev.squadWithdrawnEvent()),
    "typed:squad:resolved": decodeEvent("squad", ev.squadResolvedEvent()),
    "typed:squad:claimed": decodeEvent("squad", ev.squadClaimedEvent()),
    "typed:squad:fees_claimed": decodeEvent("squad", ev.squadFeesClaimedEvent()),
    "typed:admin:oracle_changed": decodeEvent("market", ev.oracleChangedEvent()),
    "typed:admin:ownership_transferred": decodeEvent("market", ev.ownershipTransferredEvent()),
    "typed:admin:agent_attributed": decodeEvent("market", ev.agentAttributedEvent()),
    "typed:admin:fee_accrued": decodeEvent("market", ev.feeAccruedEvent()),
    "typed:admin:fee_policy_set": decodeEvent("market", ev.feePolicySetEvent()),
    "typed:unknown:empty_topics": decodeEvent("market", ev.emptyTopicsEvent()),
    "typed:unknown:truncated_topics": decodeEvent("market", ev.truncatedTopicsEvent()),
    "typed:unknown:wrong_field_type": decodeEvent("market", ev.wrongFieldTypeEvent()),
    "generic:claim_created": decodeGenericEvent(ev.claimCreatedEvent(), "generic"),
    "generic:squad_market_created": decodeGenericEvent(ev.squadMarketCreatedEvent(), "generic"),
    "generic:empty_topics": decodeGenericEvent(ev.emptyTopicsEvent(), "generic"),
  };

  return Object.fromEntries(
    Object.entries(cases).map(([id, decoded]) => [id, fingerprintDecoderOutput(decoded)]),
  );
}

describe("decoder semantic fingerprint", () => {
  it("produces versioned SHA-256 fingerprints for typed and generic decoders", () => {
    const typed = decodeEvent("market", ev.claimCreatedEvent());
    const generic = decodeGenericEvent(ev.claimCreatedEvent(), "generic");

    const typedFp = fingerprintDecodedEvent(typed);
    const genericFp = fingerprintGenericEvent(generic);

    assert.equal(typedFp.version, DECODER_FINGERPRINT_VERSION);
    assert.equal(typedFp.kind, "typed");
    assert.match(typedFp.hash, /^[0-9a-f]{64}$/);
    assert.equal(typedFp.fingerprint, `${DECODER_FINGERPRINT_VERSION}:typed:${typedFp.hash}`);

    assert.equal(genericFp.version, DECODER_FINGERPRINT_VERSION);
    assert.equal(genericFp.kind, "generic");
    assert.match(genericFp.hash, /^[0-9a-f]{64}$/);
    assert.equal(genericFp.fingerprint, `${DECODER_FINGERPRINT_VERSION}:generic:${genericFp.hash}`);

    // Auto-dispatch matches direct helpers.
    assert.equal(fingerprintDecoderOutput(typed).fingerprint, typedFp.fingerprint);
    assert.equal(fingerprintDecoderOutput(generic).fingerprint, genericFp.fingerprint);
  });

  it("hashes canonical fields independent of presentation text", () => {
    const generic = decodeGenericEvent(ev.claimCreatedEvent(), "generic");
    const baseline = fingerprintGenericEvent(generic);

    const rewordedPresentation = {
      ...generic,
      topicSummary: "COMPLETELY DIFFERENT TOPIC SUMMARY",
      valueSummary: "COMPLETELY DIFFERENT VALUE SUMMARY",
      summary: "Custom Telegram-ready presentation string!",
      payload: {
        ...generic.payload,
        summary: "Different payload summary prose",
        reason: "Different diagnostic wording",
      },
    };
    assert.equal(fingerprintGenericEvent(rewordedPresentation).fingerprint, baseline.fingerprint);

    // UnknownPayload diagnostic reason is presentation prose, not semantic data.
    const unknown = decodeEvent("market", ev.wrongFieldTypeEvent());
    const unknownBaseline = fingerprintDecodedEvent(unknown);
    const rewordedUnknown = {
      ...unknown,
      payload: {
        ...unknown.payload,
        reason: "rephrased human-readable error message",
      },
    };
    assert.equal(fingerprintDecodedEvent(rewordedUnknown).fingerprint, unknownBaseline.fingerprint);
  });

  it("is invariant to object key order and omitted undefined fields", () => {
    const a = decodeEvent("market", ev.claimCreatedEvent());
    const b = {
      ...a,
      payload: {
        category: a.payload.category,
        creator: a.payload.creator,
        claimId: a.payload.claimId,
        name: a.payload.name,
        title: undefined,
      },
    };
    assert.equal(fingerprintDecodedEvent(a).fingerprint, fingerprintDecodedEvent(b).fingerprint);
  });

  it("distinguishes semantic types (bigint vs number vs string, bytes, non-finite)", () => {
    const challenged = decodeEvent("market", ev.claimChallengedEvent());
    const fpBigint = fingerprintDecodedEvent(challenged);

    const asString = {
      ...challenged,
      payload: { ...challenged.payload, stake: challenged.payload.stake.toString() },
    };
    const asNumber = {
      ...challenged,
      payload: { ...challenged.payload, stake: Number(challenged.payload.stake) },
    };

    assert.notEqual(fingerprintDecodedEvent(asString).fingerprint, fpBigint.fingerprint);
    assert.notEqual(fingerprintDecodedEvent(asNumber).fingerprint, fpBigint.fingerprint);

    // Boundary canonicalization for Uint8Array and non-finite numbers.
    assert.deepEqual(canonicalizeValue(new Uint8Array([0xde, 0xad])), { $bytes: "dead" });
    assert.deepEqual(canonicalizeValue(Number.NaN), { $nonFinite: "NaN" });
    assert.deepEqual(canonicalizeValue(Number.POSITIVE_INFINITY), { $nonFinite: "Infinity" });
  });

  it("matches the reviewed fixture manifest with zero breaking changes", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const actual = buildReviewedFixtureFingerprints();
    const report = compareFixtureFingerprints(manifest, actual);

    assert.equal(report.hasBreakingChanges, false, formatDriftReport(report));
    assert.equal(report.breaking, 0);
    assert.equal(report.missing, 0);
    assert.equal(report.nonBreaking, 0);
    assert.equal(report.added, 0);
    assert.equal(report.unchanged, Object.keys(manifest.fixtures).length);
  });

  it("reports breaking changes (removed field, changed value, type change, missing fixture, version mismatch)", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const actual = buildReviewedFixtureFingerprints();

    // 1. Removed canonical field -> breaking
    const removedFieldEvent = decodeEvent("market", ev.claimCreatedEvent());
    delete removedFieldEvent.payload.category;
    actual["typed:market:claim_created"] = fingerprintDecodedEvent(removedFieldEvent);

    // 2. Type change (bigint -> string) -> breaking
    const typeChangedEvent = decodeEvent("market", ev.claimChallengedEvent());
    typeChangedEvent.payload.stake = typeChangedEvent.payload.stake.toString();
    actual["typed:market:claim_challenged"] = fingerprintDecodedEvent(typeChangedEvent);

    // 3. Missing fixture -> breaking
    delete actual["typed:market:claim_cancelled"];

    // 4. Version mismatch -> breaking
    actual["typed:market:fee_claimed"] = {
      ...actual["typed:market:fee_claimed"],
      version: "v2",
      fingerprint: actual["typed:market:fee_claimed"].fingerprint.replace(/^v1:/, "v2:"),
    };

    const report = compareFixtureFingerprints(manifest, actual);
    assert.equal(report.hasBreakingChanges, true);
    assert.equal(report.breaking, 3);
    assert.equal(report.missing, 1);

    const byId = Object.fromEntries(report.entries.map((e) => [e.id, e]));
    assert.equal(byId["typed:market:claim_created"].status, "breaking");
    assert.equal(byId["typed:market:claim_created"].diffs[0].kind, "removed");
    assert.equal(byId["typed:market:claim_created"].diffs[0].path, "payload.category");

    assert.equal(byId["typed:market:claim_challenged"].status, "breaking");
    assert.equal(byId["typed:market:claim_challenged"].diffs[0].kind, "type_changed");
    assert.equal(byId["typed:market:claim_challenged"].diffs[0].path, "payload.stake");

    assert.equal(byId["typed:market:claim_cancelled"].status, "missing");
    assert.equal(byId["typed:market:fee_claimed"].status, "breaking");
    assert.equal(byId["typed:market:fee_claimed"].diffs[0].path, "$version");

    const rendered = formatDriftReport(report);
    assert.match(rendered, /3 breaking, 1 missing/);
    assert.match(rendered, /\[BREAKING\] typed:market:claim_created/);
    assert.match(rendered, /BREAKING removed at payload\.category/);
    assert.match(rendered, /BREAKING type_changed at payload\.stake/);
    assert.match(rendered, /\[MISSING\] typed:market:claim_cancelled/);
  });

  it("classifies additive optional fields and newly added fixtures as non-breaking", () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const actual = buildReviewedFixtureFingerprints();

    const extended = decodeEvent("market", ev.claimCreatedEvent());
    extended.payload.title = "Optional v2 title";
    actual["typed:market:claim_created"] = fingerprintDecodedEvent(extended);

    actual["typed:market:new_future_event"] = fingerprintDecodedEvent(
      decodeEvent("market", ev.claimCancelledEvent()),
    );

    const report = compareFixtureFingerprints(manifest, actual);
    assert.equal(report.hasBreakingChanges, false);
    assert.equal(report.breaking, 0);
    assert.equal(report.nonBreaking, 1);
    assert.equal(report.added, 1);

    const byId = Object.fromEntries(report.entries.map((e) => [e.id, e]));
    assert.equal(byId["typed:market:claim_created"].status, "non_breaking");
    assert.equal(byId["typed:market:claim_created"].diffs[0].kind, "added");
    assert.equal(byId["typed:market:claim_created"].diffs[0].breaking, false);
    assert.equal(byId["typed:market:new_future_event"].status, "added");
  });
});
