import assert from "node:assert/strict";
import test from "node:test";

import { resolutionLatency } from "../dist/stellar/resolution-latency.js";

function makeClaimEvent({
  name,
  claimId,
  ledger,
  at,
  contractId = "CMARKET1",
  eventId,
  txHash,
  winnerSide = 1,
  evidenceHash = "hash-default",
}) {
  return {
    source: "market",
    contractId,
    version: "v1",
    ledger,
    txHash: txHash ?? `tx-${ledger}-${name}`,
    at,
    eventId: eventId ?? `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId,
      ...(name === "claim_created"
        ? { creator: "G1", category: "crypto", title: `Claim ${claimId}` }
        : name === "claim_resolved"
          ? { winnerSide, summary: "Outcome", confidence: 100, evidenceHash }
          : {}),
    },
  };
}

test("detects claim_resolved + claim_cancelled conflict for the same identity instead of picking an event", () => {
  const events = [
    makeClaimEvent({ name: "claim_created", claimId: 7, ledger: 100, at: 1000, eventId: "100-1" }),
    makeClaimEvent({ name: "claim_resolved", claimId: 7, ledger: 120, at: 1100, eventId: "120-1", winnerSide: 1 }),
    makeClaimEvent({ name: "claim_cancelled", claimId: 7, ledger: 130, at: 1150, eventId: "130-1" }),
    // Healthy control claim in the same stream
    makeClaimEvent({ name: "claim_created", claimId: 8, ledger: 100, at: 1000, eventId: "100-2" }),
    makeClaimEvent({ name: "claim_resolved", claimId: 8, ledger: 140, at: 1200, eventId: "140-1", winnerSide: 2 }),
  ];

  const forwardReport = resolutionLatency(events);
  const reverseReport = resolutionLatency([...events].reverse());

  assert.deepEqual(forwardReport, reverseReport);
  assert.equal(forwardReport.excludedCount, 1);
  assert.equal(forwardReport.resolved.claims.length, 1);
  assert.equal(forwardReport.resolved.claims[0].claimId, 8);
  assert.equal(forwardReport.cancelled.claims.length, 0);

  assert.equal(forwardReport.inconsistencies.length, 1);
  const inc = forwardReport.inconsistencies[0];
  assert.equal(inc.identity, "CMARKET1:7");
  assert.equal(inc.contractId, "CMARKET1");
  assert.equal(inc.claimId, 7);
  assert.equal(inc.reason, "resolved_and_cancelled");
  assert.equal(inc.creationLedger, 100);
  assert.equal(inc.creationAt, 1000);
  assert.equal(inc.terminalEvents.length, 2);
  assert.equal(inc.terminalEvents[0].kind, "claim_resolved");
  assert.equal(inc.terminalEvents[1].kind, "claim_cancelled");
});

test("detects contradictory winnerSide across multiple claim_resolved events", () => {
  const events = [
    makeClaimEvent({ name: "claim_created", claimId: 11, ledger: 50, at: 500, eventId: "50-1" }),
    makeClaimEvent({
      name: "claim_resolved",
      claimId: 11,
      ledger: 60,
      at: 560,
      eventId: "60-1",
      winnerSide: 1,
      evidenceHash: "ev-a",
    }),
    makeClaimEvent({
      name: "claim_resolved",
      claimId: 11,
      ledger: 65,
      at: 590,
      eventId: "65-1",
      winnerSide: 2,
      evidenceHash: "ev-b",
    }),
  ];

  const report = resolutionLatency(events);

  assert.equal(report.resolved.claims.length, 0);
  assert.equal(report.resolved.summary, null);
  assert.equal(report.excludedCount, 1);
  assert.equal(report.inconsistencies.length, 1);
  assert.equal(report.inconsistencies[0].reason, "conflicting_winner_side");
  assert.deepEqual(
    report.inconsistencies[0].terminalEvents.map((t) => t.winnerSide),
    [1, 2],
  );
});

test("detects conflicting evidenceHash even when winnerSide matches", () => {
  const events = [
    makeClaimEvent({ name: "claim_created", claimId: 15, ledger: 50, at: 500, eventId: "50-1" }),
    makeClaimEvent({
      name: "claim_resolved",
      claimId: 15,
      ledger: 60,
      at: 560,
      eventId: "60-1",
      winnerSide: 1,
      evidenceHash: "evidence-v1",
    }),
    makeClaimEvent({
      name: "claim_resolved",
      claimId: 15,
      ledger: 62,
      at: 575,
      eventId: "62-1",
      winnerSide: 1,
      evidenceHash: "evidence-v2",
    }),
  ];

  const report = resolutionLatency(events);

  assert.equal(report.resolved.claims.length, 0);
  assert.equal(report.excludedCount, 1);
  assert.equal(report.inconsistencies.length, 1);
  assert.equal(report.inconsistencies[0].reason, "conflicting_evidence");
});

test("reports terminal conflict even when claim_created is absent from partial window", () => {
  const events = [
    makeClaimEvent({ name: "claim_cancelled", claimId: 21, ledger: 210, at: 2100, eventId: "210-1" }),
    makeClaimEvent({ name: "claim_resolved", claimId: 21, ledger: 210, at: 2100, eventId: "210-2", winnerSide: 1 }),
  ];

  const report = resolutionLatency(events);

  assert.equal(report.excludedCount, 1);
  assert.equal(report.inconsistencies.length, 1);
  assert.equal(report.inconsistencies[0].claimId, 21);
  assert.equal(report.inconsistencies[0].creationLedger, null);
  assert.equal(report.inconsistencies[0].creationAt, null);
  assert.equal(report.inconsistencies[0].reason, "resolved_and_cancelled");
});

test("idempotent duplicate re-deliveries collapse cleanly without false conflict", () => {
  const resolvedEvent = makeClaimEvent({
    name: "claim_resolved",
    claimId: 30,
    ledger: 90,
    at: 1090,
    eventId: "90-1",
    winnerSide: 1,
    evidenceHash: "same-hash",
  });
  const events = [
    makeClaimEvent({ name: "claim_created", claimId: 30, ledger: 80, at: 1000, eventId: "80-1" }),
    resolvedEvent,
    { ...resolvedEvent }, // redelivered duplicate on overlapping page
  ];

  const report = resolutionLatency(events);

  assert.equal(report.inconsistencies.length, 0);
  assert.equal(report.excludedCount, 0);
  assert.equal(report.resolved.claims.length, 1);
  assert.deepEqual(report.resolved.claims[0].duration, { seconds: 90, ledgers: 10 });
});

test("isolates identical numeric claimIds across distinct contractIds without cross-contract conflict", () => {
  const events = [
    makeClaimEvent({ contractId: "CMARKET_A", name: "claim_created", claimId: 1, ledger: 10, at: 100, eventId: "a-1" }),
    makeClaimEvent({ contractId: "CMARKET_A", name: "claim_resolved", claimId: 1, ledger: 20, at: 150, eventId: "a-2", winnerSide: 1 }),
    makeClaimEvent({ contractId: "CMARKET_B", name: "claim_created", claimId: 1, ledger: 12, at: 110, eventId: "b-1" }),
    makeClaimEvent({ contractId: "CMARKET_B", name: "claim_cancelled", claimId: 1, ledger: 22, at: 160, eventId: "b-2" }),
  ];

  const report = resolutionLatency(events);

  assert.equal(report.inconsistencies.length, 0);
  assert.equal(report.excludedCount, 0);
  assert.equal(report.resolved.claims.length, 1);
  assert.equal(report.cancelled.claims.length, 1);
});
