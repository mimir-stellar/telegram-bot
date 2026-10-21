import assert from "node:assert/strict";
import test from "node:test";

import { compareResolved, createSquadPools, reduceSquadPools } from "../dist/stellar/squad-pools.js";

function balanceEvent({ marketId, name, side, amount }) {
  return {
    marketId,
    name,
    side,
    amount: typeof amount === "bigint" ? amount : BigInt(amount),
  };
}

test("reduceSquadPools is pure and accumulates deposits per side", () => {
  const events = [
    balanceEvent({ marketId: 1, name: "deposited", side: 0, amount: 100 }),
    balanceEvent({ marketId: 1, name: "deposited", side: 1, amount: 50 }),
    balanceEvent({ marketId: 1, name: "withdrawn", side: 0, amount: 30 }),
    balanceEvent({ marketId: 2, name: "deposited", side: 0, amount: 10 }),
  ];

  const pools = reduceSquadPools(events);

  assert.equal(pools.size, 2);
  assert.deepEqual([...pools.entries()].map(([m, p]) => [m, p]), [
    [1, { poolA: 70n, poolB: 50n }],
    [2, { poolA: 10n, poolB: 0n }],
  ]);
});

test("reduceSquadPools: empty input yields an empty map", () => {
  assert.equal(reduceSquadPools([]).size, 0);
});

test("compareResolved returns undefined when pools match", () => {
  assert.equal(compareResolved({ poolA: 100n, poolB: 50n }, 100n, 50n), undefined);
});

test("compareResolved returns a mismatch record when pools differ", () => {
  const mismatch = compareResolved({ poolA: 100n, poolB: 50n }, 99n, 50n);
  assert.ok(mismatch);
  assert.equal(mismatch.marketId, undefined);
  assert.deepEqual(mismatch.expected, { poolA: 100n, poolB: 50n });
  assert.deepEqual(mismatch.observed, { poolA: 99n, poolB: 50n });
});

test("compareResolved returns undefined for an untracked market", () => {
  assert.equal(compareResolved(undefined, 100n, 50n), undefined);
});

test("checkResolved: matching resolution is ok", () => {
  const pools = createSquadPools();
  pools.observeCreated(1);
  pools.record(balanceEvent({ marketId: 1, name: "deposited", side: 0, amount: 100 }));
  pools.record(balanceEvent({ marketId: 1, name: "deposited", side: 1, amount: 50 }));

  const result = pools.checkResolved(1, 100n, 50n);
  assert.equal(result.status, "ok");
  assert.equal(result.mismatch, undefined);
  assert.equal(pools.status(1), "ok");
});

test("checkResolved: mismatched resolution reports expected and observed", () => {
  const pools = createSquadPools();
  pools.observeCreated(1);
  pools.record(balanceEvent({ marketId: 1, name: "deposited", side: 0, amount: 100 }));

  const result = pools.checkResolved(1, 99n, 50n);
  assert.equal(result.status, "mismatched");
  assert.ok(result.mismatch);
  assert.equal(result.mismatch.marketId, 1);
  assert.deepEqual(result.mismatch.expected, { poolA: 100n, poolB: 0n });
  assert.deepEqual(result.mismatch.observed, { poolA: 99n, poolB: 50n });
  assert.equal(pools.status(1), "mismatched");
  assert.equal(pools.mismatches.length, 1);
});

test("checkResolved: market whose creation was never observed is unverifiable", () => {
  const pools = createSquadPools();
  pools.record(balanceEvent({ marketId: 1, name: "deposited", side: 0, amount: 100 }));

  const result = pools.checkResolved(1, 100n, 0n);
  assert.equal(result.status, "unverifiable");
  assert.equal(result.mismatch, undefined);
  assert.equal(pools.status(1), "unverifiable");
});

test("checkResolved: fully unknown market is unverifiable", () => {
  const pools = createSquadPools();
  const result = pools.checkResolved(42, 100n, 50n);
  assert.equal(result.status, "unverifiable");
  assert.equal(result.mismatch, undefined);
});

test("checkResolved: created but not yet resolved has no status", () => {
  const pools = createSquadPools();
  pools.observeCreated(1);
  assert.equal(pools.status(1), undefined);
});

test("mismatches are bounded and evict the oldest when full", () => {
  const pools = createSquadPools({ maxMismatches: 2 });
  for (const marketId of [1, 2, 3]) {
    pools.observeCreated(marketId);
    pools.record(balanceEvent({ marketId, name: "deposited", side: 0, amount: 100 }));
    pools.checkResolved(marketId, 99n, 0n);
  }
  assert.equal(pools.mismatches.length, 2);
  assert.equal(pools.mismatches[0].marketId, 2);
  assert.equal(pools.mismatches[1].marketId, 3);
});

test("tracked markets are bounded and evict the oldest when full", () => {
  const pools = createSquadPools({ maxMarkets: 2 });
  pools.observeCreated(1);
  pools.observeCreated(2);
  pools.observeCreated(3);
  assert.equal(pools.size, 2);
  assert.equal(pools.status(1), undefined);
  assert.equal(pools.status(2), undefined);
  assert.equal(pools.status(3), undefined);
});
