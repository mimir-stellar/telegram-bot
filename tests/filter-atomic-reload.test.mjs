import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  FilterConfigValidationError,
  createAtomicFilterStore,
  validateCandidateFilterConfig,
} from "../dist/notifications/filter-expr.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function mockEvent(source, payload) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    version: "v1",
    ledger: 3000,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000003000-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("atomic filter reload validates candidate upfront and swaps active rules on success", () => {
  let clock = 1_700_000_000_000;
  const store = createAtomicFilterStore(
    {
      rules: ["claim_challenged where stake >= 10 USDC"],
      thresholds: { marketChallenge: "10" },
      categories: ["Crypto"],
    },
    { now: () => clock },
  );

  const smallChallenge = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 50_000_000n, // 5 USDC
  });
  const mediumChallenge = mockEvent("market", {
    name: "claim_challenged",
    claimId: 1,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 200_000_000n, // 20 USDC
  });
  const deposit30 = mockEvent("squad", {
    name: "deposited",
    marketId: 2,
    side: 1,
    participant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    amount: 300_000_000n, // 30 USDC
    shares: 300_000_000n,
  });

  assert.equal(store.current().version, 1);
  assert.equal(store.allows(smallChallenge), false);
  assert.equal(store.allows(mediumChallenge), true);
  assert.equal(store.allows(deposit30), false); // does not match claim_challenged rule

  clock += 5_000;
  const reloaded = store.reload({
    rules: [
      "claim_challenged where stake >= 50 USDC",
      "deposited where amount >= 25 USDC",
    ],
    thresholds: { marketChallenge: "50", squadDeposit: "25" },
  });

  assert.equal(reloaded.ok, true);
  assert.equal(reloaded.previousVersion, 1);
  assert.equal(reloaded.version, 2);
  assert.equal(store.current().version, 2);
  assert.equal(store.current().loadedAt, clock);

  // Under v2, 20 USDC challenge is now rejected (< 50 USDC) and 30 USDC deposit is allowed (>= 25 USDC)
  assert.equal(store.allows(mediumChallenge), false);
  assert.equal(store.allows(deposit30), true);
});

test("atomic filter reload retains previous working filter set unchanged on partial candidate failure", () => {
  const store = createAtomicFilterStore({
    rules: ["claim_challenged where stake >= 10 USDC"],
    thresholds: { marketChallenge: "10" },
  });

  const beforeSnapshot = store.current();
  const challenge15 = mockEvent("market", {
    name: "claim_challenged",
    claimId: 5,
    challenger: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    stake: 150_000_000n, // 15 USDC
  });
  assert.equal(store.allows(challenge15), true);

  // First rule and marketChallenge are valid, but second rule and squadDeposit are invalid:
  // neither rule[0] nor marketChallenge="100" may take effect!
  const failed = store.reload({
    rules: [
      "claim_challenged where stake >= 100 USDC",
      "claim_challenged where unknown_field == 1",
    ],
    thresholds: {
      marketChallenge: "100",
      squadDeposit: "-5",
    },
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.version, 1);
  assert.equal(failed.problems.length, 2);
  assert.match(failed.problems[0], /rules\[1\].*Unknown field "unknown_field"/);
  assert.match(failed.problems[1], /thresholds\.squadDeposit.*negative/);

  // Exact same immutable snapshot reference & live filtering behavior retained
  assert.equal(store.current(), beforeSnapshot);
  assert.equal(store.allows(challenge15), true);
  assert.equal(store.status().failedReloads, 1);
  assert.ok(store.status().lastReloadError);
});

test("reloadFromJson and reloadFromFile survive malformed JSON, missing files, and recover cleanly", async () => {
  await withTempDataDir(async (dir) => {
    const store = createAtomicFilterStore({
      rules: ["claim_created where category == 'crypto'"],
    });
    const initialSnapshot = store.current();

    const cryptoClaim = mockEvent("market", {
      name: "claim_created",
      claimId: 11,
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      category: "crypto",
      title: "BTC > 100k",
    });
    const sportsClaim = mockEvent("market", {
      name: "claim_created",
      claimId: 12,
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      category: "sports",
      title: "World Cup",
    });

    assert.equal(store.allows(cryptoClaim), true);
    assert.equal(store.allows(sportsClaim), false);

    // 1. Malformed JSON string
    const badJson = store.reloadFromJson("{ broken json");
    assert.equal(badJson.ok, false);
    assert.equal(store.current(), initialSnapshot);

    // 2. Missing file on disk
    const missingRes = await store.reloadFromFile(dir.file("does-not-exist.json"));
    assert.equal(missingRes.ok, false);
    assert.equal(store.current(), initialSnapshot);

    // 3. Unknown typo key in file
    const typoPath = dir.file("typo-filters.json");
    await writeFile(typoPath, JSON.stringify({ ruls: ["claim_created"] }), "utf8");
    const typoRes = await store.reloadFromFile(typoPath);
    assert.equal(typoRes.ok, false);
    assert.match(typoRes.problems[0], /Unknown filter configuration key "ruls"/);
    assert.equal(store.current(), initialSnapshot);
    assert.equal(store.allows(cryptoClaim), true);
    assert.equal(store.allows(sportsClaim), false);

    // 4. Valid file reload succeeds and clears lastReloadError
    const validPath = dir.file("valid-filters.json");
    await writeFile(
      validPath,
      JSON.stringify({
        rules: ["claim_created where category == 'sports'"],
        featureFlags: { enabled: true, market: true, squad: false },
      }),
      "utf8",
    );
    const okRes = await store.reloadFromFile(validPath);
    assert.equal(okRes.ok, true);
    assert.equal(okRes.version, 2);
    assert.equal(store.status().lastReloadError, null);
    assert.equal(store.status().failedReloads, 3);
    assert.equal(store.allows(cryptoClaim), false);
    assert.equal(store.allows(sportsClaim), true);
  }, "mimir-filter-reload-");
});

test("compiled snapshots are deeply frozen and invalid initial config throws FilterConfigValidationError", () => {
  const store = createAtomicFilterStore({
    rules: ["deposited where amount >= 5 USDC"],
    thresholds: { squadDeposit: 50_000_000n },
  });
  const snap = store.current();
  assert.equal(Object.isFrozen(snap), true);
  assert.equal(Object.isFrozen(snap.rules), true);
  assert.equal(Object.isFrozen(snap.thresholds), true);
  assert.throws(() => {
    snap.thresholds.squadDeposit = 0n;
  }, TypeError);

  assert.throws(
    () =>
      createAtomicFilterStore({
        rules: ["invalid_event where x == 1"],
      }),
    FilterConfigValidationError,
  );

  const check = validateCandidateFilterConfig([]);
  assert.equal(check.ok, false);
});
