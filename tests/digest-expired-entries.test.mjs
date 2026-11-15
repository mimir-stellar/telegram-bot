import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CRITICAL_DIGEST_EVENTS,
  isCriticalDigestEvent,
  pruneExpiredDigestEvents,
} from "../dist/notifications/digest-grouping.js";
import { formatDigest } from "../dist/notifications/format.js";
import { DEFAULT_SILENT_EVENTS } from "../dist/notifications/priority.js";
import {
  ScheduleParseError,
  defaultMaxAgeForSchedule,
  parseDigestMaxAgeMs,
} from "../dist/notifications/schedule.js";

function makeEvent({
  source = "market",
  ledger = 100,
  at = 1_760_000_000,
  name = "claim_created",
  id = 1n,
} = {}) {
  const payload =
    source === "squad"
      ? { name, marketId: id }
      : { name, claimId: id };
  return {
    source,
    contractId: "CDUMMY00000000000000000000000000000000000000000000000000",
    version: "v1",
    ledger,
    txHash: "d".repeat(64),
    at,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("pruneExpiredDigestEvents drops expired low-priority entries, retains critical events, and counts omissions", () => {
  const nowSec = 1_760_010_000;
  const nowMs = nowSec * 1000;
  // maxAge = 1h (3600s)
  const expiredDeposit = makeEvent({
    source: "squad",
    ledger: 10,
    at: nowSec - 7200,
    name: "deposited",
    id: 5n,
  });
  const expiredFee = makeEvent({
    source: "market",
    ledger: 11,
    at: nowSec - 3601,
    name: "fee_claimed",
    id: 6n,
  });
  const exactBoundary = makeEvent({
    source: "squad",
    ledger: 12,
    at: nowSec - 3600, // exact 1h boundary -> retained
    name: "deposited",
    id: 5n,
  });
  const expiredCriticalMarket = makeEvent({
    source: "market",
    ledger: 13,
    at: nowSec - 86_400, // 24h old critical -> retained!
    name: "claim_resolved",
    id: 7n,
  });
  const expiredCriticalSquad = makeEvent({
    source: "squad",
    ledger: 14,
    at: nowSec - 86_400,
    name: "resolved",
    id: 5n,
  });
  const missingTimestamp = makeEvent({
    source: "market",
    ledger: 15,
    at: 0, // absent close time -> conservatively retained
    name: "withdrawal",
    id: 8n,
  });

  const result = pruneExpiredDigestEvents(
    [
      expiredDeposit,
      expiredFee,
      exactBoundary,
      expiredCriticalMarket,
      expiredCriticalSquad,
      missingTimestamp,
    ],
    { maxAge: "1h", nowMs },
  );

  assert.equal(result.omittedCount, 2);
  assert.equal(result.retainedCriticalCount, 2);
  assert.deepEqual(
    result.events.map((e) => e.ledger),
    [12, 13, 14, 15],
  );
  assert.equal(isCriticalDigestEvent(expiredCriticalMarket), true);
  assert.equal(isCriticalDigestEvent(expiredDeposit), false);
  assert.ok(DEFAULT_CRITICAL_DIGEST_EVENTS.includes("market_settled"));
});

test("lowPriorityEvents option scopes expiration to configured low-priority set while keeping critical events", () => {
  const nowSec = 1_760_010_000;
  const expiredDeposit = makeEvent({
    source: "squad",
    ledger: 20,
    at: nowSec - 10_000,
    name: "deposited",
  });
  const expiredClaimCreated = makeEvent({
    source: "market",
    ledger: 21,
    at: nowSec - 10_000,
    name: "claim_created",
  });

  const scoped = pruneExpiredDigestEvents([expiredDeposit, expiredClaimCreated], {
    maxAge: 3_600_000,
    nowMs: nowSec * 1000,
    lowPriorityEvents: DEFAULT_SILENT_EVENTS,
  });
  assert.equal(scoped.omittedCount, 1);
  assert.deepEqual(
    scoped.events.map((e) => e.ledger),
    [21],
  );
});

test("formatDigest exposes omitted expired entry counter and preserves unchanged default layout", () => {
  const nowSec = 1_760_010_000;
  const oldDeposit = makeEvent({
    source: "squad",
    ledger: 30,
    at: nowSec - 9_000,
    name: "deposited",
    id: 10n,
  });
  const oldResolved = makeEvent({
    source: "squad",
    ledger: 31,
    at: nowSec - 9_000,
    name: "resolved",
    id: 10n,
  });

  // Default call (no maxAge) stays byte-identical.
  const baseline = formatDigest([oldDeposit]);
  assert.equal(
    baseline,
    "*Mimir Digest* — 1 events in this cycle\n\n· mimir\\-squad `deposited` at ledger 30",
  );

  // Grouped with maxAge drops oldDeposit, keeps oldResolved, and appends explicit counter.
  const prunedMd = formatDigest([oldDeposit, oldResolved], {
    grouped: true,
    maxAge: "1h",
    nowMs: nowSec * 1000,
  });
  assert.equal(
    prunedMd,
    [
      "*Mimir Digest* — 1 events in this cycle",
      "",
      "· mimir\\-squad `resolved` at ledger 31",
      "",
      "_1 expired low\\-priority entry omitted_",
    ].join("\n"),
  );

  // When every entry expires, the digest surfaces 0 events + plural counter instead of silently vanishing.
  const allExpiredMd = formatDigest(
    [oldDeposit, makeEvent({ source: "squad", ledger: 32, at: nowSec - 9_000, name: "withdrawn" })],
    { maxAge: "1h", nowMs: nowSec * 1000 },
  );
  assert.equal(
    allExpiredMd,
    "*Mimir Digest* — 0 events in this cycle\n\n_2 expired low\\-priority entries omitted_",
  );
});

test("parseDigestMaxAgeMs and schedule defaults validate age bounds", () => {
  assert.equal(parseDigestMaxAgeMs("30m"), 30 * 60 * 1000);
  assert.equal(parseDigestMaxAgeMs("6h"), 6 * 3600 * 1000);
  assert.equal(parseDigestMaxAgeMs(0), 0);
  assert.equal(defaultMaxAgeForSchedule("daily@08:00"), 24 * 3600 * 1000);
  assert.equal(defaultMaxAgeForSchedule("weekly@mon 08:00"), 7 * 24 * 3600 * 1000);

  for (const bad of [-1, Number.NaN, "abc", "-5m", "10years"]) {
    assert.throws(() => parseDigestMaxAgeMs(bad), ScheduleParseError);
  }
  assert.throws(() => formatDigest([], { omittedExpiredCount: -1 }), RangeError);
});
