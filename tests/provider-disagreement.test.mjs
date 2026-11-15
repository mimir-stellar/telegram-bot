import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalEventFingerprint,
  canonicalEventIdentity,
  compareProviderWindowEvents,
  compareRpcProvidersOnWindow,
  normalizeProviderIdentity,
  ProviderDisagreementTracker,
  ProviderWindowValidationError,
} from "../dist/stellar/client.js";

const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function makeEvent(overrides = {}) {
  return {
    id: "0001000-0001",
    type: "contract",
    contractId: CONTRACT_A,
    ledger: 1000,
    txHash: "a".repeat(64),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: ["AAAAEg=="],
    value: "AAAABQ==",
    ...overrides,
  };
}

test("compareProviderWindowEvents reports agreement on identical canonical events in shared window", () => {
  const ev1 = makeEvent({ id: "0001000-0001", ledger: 1000 });
  const ev2 = makeEvent({ id: "0001002-0001", ledger: 1002, txHash: "b".repeat(64) });

  const result = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org/soroban/",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev2, ev1],
    },
    {
      provider: "https://rpc-beta.example.org/soroban",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev1, ev2],
    },
  );

  assert.equal(result.status, "agreed");
  assert.equal(result.disagreed, false);
  assert.equal(result.authoritativeProvider, null);
  assert.deepEqual(result.providers, [
    "https://rpc-alpha.example.org/soroban",
    "https://rpc-beta.example.org/soroban",
  ]);
  assert.deepEqual(result.sharedWindow, { startLedger: 1000, endLedger: 1005 });
  assert.equal(result.matchedCount, 2);
  assert.deepEqual(result.matchedKeys, ["0001000-0001", "0001002-0001"]);
  assert.equal(result.onlyInFirstCount, 0);
  assert.equal(result.onlyInSecondCount, 0);
  assert.equal(result.divergentCount, 0);
});

test("compareProviderWindowEvents restricts comparison to overlapping ledger window", () => {
  const beforeOverlap = makeEvent({ id: "0000998-0001", ledger: 998 });
  const inOverlap = makeEvent({ id: "0001003-0001", ledger: 1003 });
  const afterOverlap = makeEvent({ id: "0001008-0001", ledger: 1008 });

  const result = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 995, endLedger: 1005 },
      events: [beforeOverlap, inOverlap],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1010 },
      events: [inOverlap, afterOverlap],
    },
  );

  assert.equal(result.status, "agreed");
  assert.equal(result.disagreed, false);
  assert.equal(result.authoritativeProvider, null);
  assert.deepEqual(result.sharedWindow, { startLedger: 1000, endLedger: 1005 });
  assert.deepEqual(result.matchedKeys, ["0001003-0001"]);
});

test("compareProviderWindowEvents returns no-overlap when ledger windows are disjoint", () => {
  const result = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 900, endLedger: 950 },
      events: [makeEvent({ id: "0000920-0001", ledger: 920 })],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 951, endLedger: 1000 },
      events: [makeEvent({ id: "0000960-0001", ledger: 960 })],
    },
  );

  assert.equal(result.status, "no-overlap");
  assert.equal(result.disagreed, false);
  assert.equal(result.authoritativeProvider, null);
  assert.equal(result.sharedWindow, null);
  assert.equal(result.matchedCount, 0);
});

test("compareProviderWindowEvents exposes missing/extra events symmetrically without choosing a winner", () => {
  const shared = makeEvent({ id: "0001001-0001", ledger: 1001 });
  const alphaOnly = makeEvent({ id: "0001002-0001", ledger: 1002, txHash: "c".repeat(64) });
  const betaOnly1 = makeEvent({ id: "0001003-0001", ledger: 1003, txHash: "d".repeat(64) });
  const betaOnly2 = makeEvent({ id: "0001004-0001", ledger: 1004, txHash: "e".repeat(64) });

  const forward = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [shared, alphaOnly],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [shared, betaOnly1, betaOnly2],
    },
  );

  assert.equal(forward.status, "disagreed");
  assert.equal(forward.disagreed, true);
  assert.equal(forward.authoritativeProvider, null);
  assert.equal(forward.matchedCount, 1);
  assert.deepEqual(forward.onlyInFirst.map((item) => item.key), ["0001002-0001"]);
  assert.deepEqual(forward.onlyInSecond.map((item) => item.key), [
    "0001003-0001",
    "0001004-0001",
  ]);

  // Swapping provider order flips directional lists symmetrically and still picks no winner.
  const reverse = compareProviderWindowEvents(
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [shared, betaOnly1, betaOnly2],
    },
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [shared, alphaOnly],
    },
  );

  assert.equal(reverse.status, "disagreed");
  assert.equal(reverse.authoritativeProvider, null);
  assert.deepEqual(reverse.onlyInFirst, forward.onlyInSecond);
  assert.deepEqual(reverse.onlyInSecond, forward.onlyInFirst);
});

test("compareProviderWindowEvents detects payload divergence on matching canonical event ids", () => {
  const untrustedBlob = "Z".repeat(2048);
  const evAlpha = makeEvent({ id: "0001001-0001", ledger: 1001, value: "AAAABQ==" });
  const evBeta = makeEvent({ id: "0001001-0001", ledger: 1001, value: untrustedBlob });

  const result = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [evAlpha],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [evBeta],
    },
  );

  assert.equal(result.status, "disagreed");
  assert.equal(result.disagreed, true);
  assert.equal(result.authoritativeProvider, null);
  assert.equal(result.divergentCount, 1);
  assert.deepEqual(result.divergentEvents[0].differingFields, ["value"]);
  assert.notEqual(
    result.divergentEvents[0].digestFirst,
    result.divergentEvents[0].digestSecond,
  );
  assert(!JSON.stringify(result).includes(untrustedBlob));
});

test("canonicalEventIdentity and canonicalEventFingerprint normalize ScVal toXDR objects and chain-composite keys", () => {
  const scValStub = (b64) => ({
    toXDR(fmt) {
      assert.equal(fmt, "base64");
      return b64;
    },
  });

  const rawJsonEvent = makeEvent({
    id: "synthetic-a",
    topic: ["AAAAEg=="],
    value: "AAAABQ==",
  });
  const sdkParsedEvent = makeEvent({
    id: "synthetic-b",
    topic: [scValStub("AAAAEg==")],
    value: scValStub("AAAABQ=="),
  });

  assert.equal(
    canonicalEventFingerprint(rawJsonEvent).digest,
    canonicalEventFingerprint(sdkParsedEvent).digest,
  );
  assert.equal(
    canonicalEventIdentity(rawJsonEvent, "chain-composite"),
    canonicalEventIdentity(sdkParsedEvent, "chain-composite"),
  );

  const comparison = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1000 },
      events: [rawJsonEvent],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1000 },
      events: [sdkParsedEvent],
    },
    { identityMode: "chain-composite" },
  );

  assert.equal(comparison.status, "agreed");
  assert.equal(comparison.matchedCount, 1);
});

test("compareProviderWindowEvents deduplicates identical intra-provider repeats but flags self-contradicting duplicates", () => {
  const ev = makeEvent({ id: "0001001-0001", ledger: 1001, value: "AAAABQ==" });
  const harmlessOverlap = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev, { ...ev }],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev],
    },
  );
  assert.equal(harmlessOverlap.status, "agreed");

  const conflicted = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev, { ...ev, value: "BBBBBQ==" }],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev],
    },
  );
  assert.equal(conflicted.status, "disagreed");
  assert.equal(conflicted.divergentCount, 1);
  assert.deepEqual(conflicted.divergentEvents[0].differingFields, ["duplicate-id-conflict"]);
});

test("normalizeProviderIdentity strips URL credentials, query strings, and fragments", () => {
  const userInfo = ["operator", "pass123"].join(":");
  const queryParam = ["api_key", "sensitiveValue123"].join("=");
  const rawUrl = `https://${userInfo}@RPC-Alpha.Example.org:8443/v1/soroban/?${queryParam}#frag`;

  const normalized = normalizeProviderIdentity(rawUrl);
  assert.equal(normalized, "https://rpc-alpha.example.org:8443/v1/soroban");
  assert(!normalized.includes("operator"));
  assert(!normalized.includes("pass123"));
  assert(!normalized.includes("sensitiveValue123"));
});

test("compareProviderWindowEvents enforces boundary validation with bounded errors", () => {
  const baseSample = {
    provider: "https://rpc-alpha.example.org",
    window: { startLedger: 1000, endLedger: 1005 },
    events: [],
  };

  assert.throws(
    () =>
      compareProviderWindowEvents(
        { ...baseSample, provider: "   " },
        baseSample,
      ),
    (err) => err instanceof ProviderWindowValidationError && err.problem === "invalid-provider",
  );

  assert.throws(
    () =>
      compareProviderWindowEvents(
        { ...baseSample, window: { startLedger: 1010, endLedger: 1005 } },
        baseSample,
      ),
    (err) => err instanceof ProviderWindowValidationError && err.problem === "malformed-window",
  );

  assert.throws(
    () =>
      compareProviderWindowEvents(
        { ...baseSample, events: [{ ledger: 1001 }] },
        baseSample,
      ),
    (err) =>
      err instanceof ProviderWindowValidationError && err.problem === "event-missing-identity",
  );

  assert.throws(
    () =>
      compareProviderWindowEvents(
        {
          ...baseSample,
          events: [
            makeEvent({ id: "ev-1", ledger: 1001 }),
            makeEvent({ id: "ev-2", ledger: 1002 }),
          ],
        },
        baseSample,
        { maxEvents: 1 },
      ),
    (err) => err instanceof ProviderWindowValidationError && err.problem === "events-oversized",
  );
});

test("compareProviderWindowEvents bounds diff item arrays while preserving exact totals", () => {
  const manyEvents = Array.from({ length: 8 }, (_, idx) =>
    makeEvent({ id: `0001001-000${idx}`, ledger: 1001 }),
  );

  const result = compareProviderWindowEvents(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: manyEvents,
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [],
    },
    { maxDiffItems: 3 },
  );

  assert.equal(result.status, "disagreed");
  assert.equal(result.onlyInFirstCount, 8);
  assert.equal(result.onlyInFirst.length, 3);
  assert.equal(result.truncatedDiffs, true);
});

test("ProviderDisagreementTracker bounds history and tracks pair disagreement lifecycle neutrally", () => {
  let clock = 1_700_000_000_000;
  const tracker = new ProviderDisagreementTracker({
    maxHistory: 2,
    maxPairs: 2,
    now: () => {
      clock += 1_000;
      return clock;
    },
  });

  const ev = makeEvent({ id: "0001001-0001", ledger: 1001 });

  // 1. Disagreement on [1000, 1005]
  tracker.record(
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev],
    },
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [],
    },
  );

  let snap = tracker.snapshot();
  assert.equal(snap.activeDisagreement, true);
  assert.equal(snap.authoritativeProvider, null);
  assert.equal(snap.disagreedCount, 1);
  assert.equal(snap.pairs.length, 1);
  assert.deepEqual(snap.pairs[0].providers, [
    "https://rpc-alpha.example.org",
    "https://rpc-beta.example.org",
  ]);
  assert.equal(snap.pairs[0].authoritativeProvider, null);

  // 2. Non-overlapping check does not erase active disagreement on that pair
  tracker.record(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 900, endLedger: 910 },
      events: [],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 920, endLedger: 930 },
      events: [],
    },
  );
  snap = tracker.snapshot();
  assert.equal(snap.activeDisagreement, true);
  assert.equal(snap.noOverlapCount, 1);

  // 3. Subsequent overlapping window agrees -> clears activeDisagreement, trims history to maxHistory=2
  tracker.record(
    {
      provider: "https://rpc-alpha.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev],
    },
    {
      provider: "https://rpc-beta.example.org",
      window: { startLedger: 1000, endLedger: 1005 },
      events: [ev],
    },
  );
  snap = tracker.snapshot();
  assert.equal(snap.activeDisagreement, false);
  assert.equal(snap.totalComparisons, 3);
  assert.equal(snap.agreedCount, 1);
  assert.equal(snap.recent.length, 2);
});

test("compareRpcProvidersOnWindow queries read-only servers, narrows to retained health bounds, and records disagreement", async () => {
  const ev1002 = makeEvent({ id: "0001002-0001", ledger: 1002 });
  const ev1004 = makeEvent({ id: "0001004-0001", ledger: 1004, txHash: "f".repeat(64) });
  const ev1008 = makeEvent({ id: "0001008-0001", ledger: 1008, txHash: "9".repeat(64) });

  const serverAlpha = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 900, latestLedger: 1005 };
    },
    async getEvents() {
      return {
        events: [ev1002, ev1004],
        cursor: "0001004-0001",
        latestLedger: 1005,
      };
    },
  };

  const serverBeta = {
    async getHealth() {
      return { status: "healthy", oldestLedger: 900, latestLedger: 1010 };
    },
    async getEvents() {
      // Missing ev1004 inside [1000, 1005], plus ev1008 outside alpha's tip (ignored)
      return {
        events: [ev1002, ev1008],
        cursor: "0001008-0001",
        latestLedger: 1010,
      };
    },
  };

  const tracker = new ProviderDisagreementTracker();
  const result = await compareRpcProvidersOnWindow(
    { provider: "https://rpc-alpha.example.org", server: serverAlpha },
    { provider: "https://rpc-beta.example.org", server: serverBeta },
    [{ type: "contract", contractIds: [CONTRACT_A] }],
    { startLedger: 1000, endLedger: 1010 },
    { tracker },
  );

  assert.equal(result.status, "disagreed");
  assert.equal(result.authoritativeProvider, null);
  assert.deepEqual(result.sharedWindow, { startLedger: 1000, endLedger: 1005 });
  assert.deepEqual(result.matchedKeys, ["0001002-0001"]);
  assert.deepEqual(result.onlyInFirst.map((e) => e.key), ["0001004-0001"]);
  assert.equal(result.onlyInSecondCount, 0);
  assert.equal(tracker.snapshot().activeDisagreement, true);
});
