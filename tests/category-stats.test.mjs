import assert from "node:assert/strict";
import test from "node:test";

import { categoryStats } from "../dist/stellar/category-stats.js";

// ── Helpers ─────────────────────────────────────────────────────────────────────

function marketEvent(payload) {
  return {
    source: "market",
    contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    ledger: 100,
    txHash: "abc123",
    at: 0,
    eventId: "100-0",
    payload,
  };
}

// ── Basic aggregation ───────────────────────────────────────────────────────────

test("categoryStats: empty input returns empty stats", () => {
  const result = categoryStats([]);
  assert.equal(result.byCategory.length, 0);
  assert.equal(result.totalCreated, 0);
  assert.equal(result.totalChallenged, 0);
});

test("categoryStats: single claim without challenge", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 1);
  assert.equal(result.byCategory[0].challenged, 0);
  assert.equal(result.byCategory[0].challengerWon, 0);
  assert.equal(result.byCategory[0].creatorWon, 0);
  assert.equal(result.byCategory[0].challengeRatePerMille, 0);
  assert.equal(result.byCategory[0].challengerWinRatePerMille, 0);
  assert.equal(result.totalCreated, 1);
  assert.equal(result.totalChallenged, 0);
});

test("categoryStats: single claim with challenge (challenger wins)", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 2, summary: "test", confidence: 100, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 1);
  assert.equal(result.byCategory[0].challenged, 1);
  assert.equal(result.byCategory[0].challengerWon, 1);
  assert.equal(result.byCategory[0].creatorWon, 0);
  assert.equal(result.byCategory[0].challengeRatePerMille, 1000);
  assert.equal(result.byCategory[0].challengerWinRatePerMille, 1000);
});

test("categoryStats: single claim with challenge (creator wins)", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 1, summary: "test", confidence: 100, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 1);
  assert.equal(result.byCategory[0].challenged, 1);
  assert.equal(result.byCategory[0].challengerWon, 0);
  assert.equal(result.byCategory[0].creatorWon, 1);
  assert.equal(result.byCategory[0].challengeRatePerMille, 1000);
  assert.equal(result.byCategory[0].challengerWinRatePerMille, 0);
});

test("categoryStats: challenge without resolution (no winner counted)", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 1);
  assert.equal(result.byCategory[0].challenged, 1);
  assert.equal(result.byCategory[0].challengerWon, 0);
  assert.equal(result.byCategory[0].creatorWon, 0);
  assert.equal(result.byCategory[0].challengeRatePerMille, 1000);
  assert.equal(result.byCategory[0].challengerWinRatePerMille, 0);
});

// ── Multiple categories ───────────────────────────────────────────────────────

test("categoryStats: multiple categories aggregate separately", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 2, category: "sports", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 2);

  // Categories sorted deterministically
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 1);
  assert.equal(result.byCategory[0].challenged, 1);

  assert.equal(result.byCategory[1].category, "sports");
  assert.equal(result.byCategory[1].created, 1);
  assert.equal(result.byCategory[1].challenged, 0);

  assert.equal(result.totalCreated, 2);
  assert.equal(result.totalChallenged, 1);
});

test("categoryStats: per-mille rates are accurate", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 2, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 3, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 4, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_challenged", claimId: 2, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 2, summary: "test", confidence: 100, evidenceHash: "00" }),
    marketEvent({ name: "claim_resolved", claimId: 2, winnerSide: 1, summary: "test", confidence: 100, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 4);
  assert.equal(result.byCategory[0].challenged, 2);
  assert.equal(result.byCategory[0].challengerWon, 1);
  assert.equal(result.byCategory[0].creatorWon, 1);
  assert.equal(result.byCategory[0].challengeRatePerMille, 500); // 2/4 * 1000
  assert.equal(result.byCategory[0].challengerWinRatePerMille, 500); // 1/2 * 1000
});

// ── Category normalization ───────────────────────────────────────────────────

test("categoryStats: normalizes category (lowercase and trim)", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "  Crypto  ", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 2, category: "CRYPTO", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 3, category: "crypto", creator: "GABCD" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 3);
});

// ── Unknown category (challenges without creation) ─────────────────────────────

test("categoryStats: challenge without creation goes to unknown category", () => {
  const events = [
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 2, summary: "test", confidence: 100, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "unknown");
  assert.equal(result.byCategory[0].created, 0);
  assert.equal(result.byCategory[0].challenged, 1);
  assert.equal(result.byCategory[0].challengerWon, 1);
  assert.equal(result.byCategory[0].creatorWon, 0);
  assert.equal(result.totalCreated, 0);
  assert.equal(result.totalChallenged, 1);
});

test("categoryStats: mix of known and unknown categories", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 2, challenger: "GXYZ", stake: 100n }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 2);

  // Sorted deterministically: "crypto" < "unknown"
  assert.equal(result.byCategory[0].category, "crypto");
  assert.equal(result.byCategory[0].created, 1);
  assert.equal(result.byCategory[0].challenged, 0);

  assert.equal(result.byCategory[1].category, "unknown");
  assert.equal(result.byCategory[1].created, 0);
  assert.equal(result.byCategory[1].challenged, 1);
});

// ── Window boundary (events outside window) ───────────────────────────────────

test("categoryStats: claims created outside window treated as unknown", () => {
  const events = [
    // Only challenged, no creation event in the window
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 2, summary: "test", confidence: 100, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 1);
  assert.equal(result.byCategory[0].category, "unknown");
  assert.equal(result.byCategory[0].created, 0);
  assert.equal(result.byCategory[0].challenged, 1);
});

// ── Non-market events ignored ─────────────────────────────────────────────────

test("categoryStats: ignores squad and admin events", () => {
  const events = [
    {
      source: "squad",
      contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
      ledger: 100,
      txHash: "abc123",
      at: 0,
      eventId: "100-0",
      payload: { name: "squad_market_created", marketId: 1, captain: "GABCD", deadline: 1000, feeBps: 100, question: "test" },
    },
    {
      source: "admin",
      contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      ledger: 100,
      txHash: "abc123",
      at: 0,
      eventId: "100-0",
      payload: { name: "admin", action: "oracle_changed", address: "GABCD" },
    },
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 0);
  assert.equal(result.totalCreated, 0);
  assert.equal(result.totalChallenged, 0);
});

// ── Deterministic ordering ──────────────────────────────────────────────────────

test("categoryStats: categories sorted deterministically", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "zebra", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 2, category: "alpha", creator: "GABCD" }),
    marketEvent({ name: "claim_created", claimId: 3, category: "beta", creator: "GABCD" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 3);
  assert.equal(result.byCategory[0].category, "alpha");
  assert.equal(result.byCategory[1].category, "beta");
  assert.equal(result.byCategory[2].category, "zebra");
});

// ── Edge cases ─────────────────────────────────────────────────────────────────

test("categoryStats: draw outcome (winnerSide 3) not counted as win", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 3, summary: "test", confidence: 50, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory[0].challengerWon, 0);
  assert.equal(result.byCategory[0].creatorWon, 0);
});

test("categoryStats: unresolved outcome (winnerSide 0) not counted as win", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 0, summary: "test", confidence: 0, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory[0].challengerWon, 0);
  assert.equal(result.byCategory[0].creatorWon, 0);
});

test("categoryStats: unresolvable outcome (winnerSide 4) not counted as win", () => {
  const events = [
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 4, summary: "test", confidence: 0, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory[0].challengerWon, 0);
  assert.equal(result.byCategory[0].creatorWon, 0);
});

test("categoryStats: multiple claims with mixed outcomes", () => {
  const events = [
    // Claim 1: crypto, challenged, challenger wins
    marketEvent({ name: "claim_created", claimId: 1, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 1, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 1, winnerSide: 2, summary: "test", confidence: 100, evidenceHash: "00" }),

    // Claim 2: crypto, challenged, creator wins
    marketEvent({ name: "claim_created", claimId: 2, category: "crypto", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 2, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 2, winnerSide: 1, summary: "test", confidence: 100, evidenceHash: "00" }),

    // Claim 3: sports, not challenged
    marketEvent({ name: "claim_created", claimId: 3, category: "sports", creator: "GABCD" }),

    // Claim 4: sports, challenged, draw
    marketEvent({ name: "claim_created", claimId: 4, category: "sports", creator: "GABCD" }),
    marketEvent({ name: "claim_challenged", claimId: 4, challenger: "GXYZ", stake: 100n }),
    marketEvent({ name: "claim_resolved", claimId: 4, winnerSide: 3, summary: "test", confidence: 50, evidenceHash: "00" }),
  ];

  const result = categoryStats(events);
  assert.equal(result.byCategory.length, 2);

  const crypto = result.byCategory.find((c) => c.category === "crypto");
  assert.ok(crypto);
  assert.equal(crypto.created, 2);
  assert.equal(crypto.challenged, 2);
  assert.equal(crypto.challengerWon, 1);
  assert.equal(crypto.creatorWon, 1);
  assert.equal(crypto.challengeRatePerMille, 1000);
  assert.equal(crypto.challengerWinRatePerMille, 500);

  const sports = result.byCategory.find((c) => c.category === "sports");
  assert.ok(sports);
  assert.equal(sports.created, 2);
  assert.equal(sports.challenged, 1);
  assert.equal(sports.challengerWon, 0);
  assert.equal(sports.creatorWon, 0);
  assert.equal(sports.challengeRatePerMille, 500);
  assert.equal(sports.challengerWinRatePerMille, 0);

  assert.equal(result.totalCreated, 4);
  assert.equal(result.totalChallenged, 3);
});
