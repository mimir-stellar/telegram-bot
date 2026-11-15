import assert from "node:assert/strict";
import test from "node:test";

import { buildDigestPeriodSummary } from "../dist/notifications/digest-grouping.js";
import { formatDigest } from "../dist/notifications/format.js";
import {
  ScheduleParseError,
  createDigestPeriodTracker,
  normalizeDigestCompleteness,
} from "../dist/notifications/schedule.js";

function makeEvent({ ledger = 1020, claimId = 5n, name = "claim_created" } = {}) {
  return {
    source: "market",
    contractId: "CDUMMY00000000000000000000000000000000000000000000000000",
    version: "v1",
    ledger,
    txHash: "f".repeat(64),
    at: 1_763_193_600 + ledger,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: { name, claimId },
  };
}

test("labels periods affected by RPC gaps and restarts as incomplete and never presents partial counts as complete", () => {
  const tracker = createDigestPeriodTracker();
  tracker.recordRpcGap({ fromLedger: 1000, toLedger: 1014, source: "market" });
  tracker.recordRestart();

  const ev1 = makeEvent({ ledger: 1020, claimId: 5n, name: "claim_created" });
  const ev2 = makeEvent({ ledger: 1021, claimId: 5n, name: "claim_challenged" });

  const summary = buildDigestPeriodSummary([ev1, ev2], {
    grouped: true,
    completeness: tracker.snapshot(),
  });

  assert.equal(summary.status, "incomplete");
  assert.equal(summary.completeness.complete, false);
  assert.equal(summary.completeness.missedLedgers, 15);
  assert.deepEqual(summary.completeness.reasons, ["rpc_gap", "restart"]);
  assert.equal(summary.observedEventCount, 2);
  assert.ok(summary.text);
  assert.equal(summary.text.includes("events in this cycle"), false);
  assert.ok(
    summary.text.includes(
      "*Mimir Digest \\(incomplete period\\)* — 2 observed events \\(partial — ledger coverage incomplete\\)",
    ),
  );
  assert.ok(
    summary.text.includes(
      "_Coverage affected by: RPC retention gap \\(15 missed ledgers: market ledgers 1000\\-1014\\); mid\\-period restart_",
    ),
  );

  // Resetting for the next healthy cycle restores complete labeling.
  tracker.reset();
  const nextSummary = buildDigestPeriodSummary([ev1], {
    grouped: true,
    completeness: tracker.snapshot(),
  });
  assert.equal(nextSummary.status, "complete");
  assert.ok(nextSummary.text.startsWith("*Mimir Digest* — 1 events in this cycle"));
});

test("incomplete period with zero observed events still emits an explicit incomplete notice while complete empty stays null", () => {
  assert.equal(formatDigest([]), null);
  assert.equal(formatDigest([], { completeness: { complete: true } }), null);

  const emptyAfterRestart = formatDigest([], {
    grouped: true,
    completeness: { reasons: ["restart"] },
  });
  assert.ok(emptyAfterRestart);
  assert.ok(
    emptyAfterRestart.includes(
      "*Mimir Digest \\(incomplete period\\)* — 0 observed events \\(partial — ledger coverage incomplete\\)",
    ),
  );
  assert.ok(emptyAfterRestart.includes("_Coverage affected by: mid\\-period restart_"));
  assert.equal(emptyAfterRestart.includes("events in this cycle"), false);
});

test("contradictory completeness flags cannot disguise a gap or restart as complete, and invalid ranges fail fast", () => {
  const forcedIncompleteByReason = normalizeDigestCompleteness({
    complete: true,
    reasons: ["rpc_error"],
  });
  assert.equal(forcedIncompleteByReason.complete, false);
  assert.equal(forcedIncompleteByReason.status, "incomplete");

  const forcedIncompleteByMissed = normalizeDigestCompleteness({
    complete: true,
    missedLedgers: 4,
  });
  assert.equal(forcedIncompleteByMissed.complete, false);
  assert.deepEqual(forcedIncompleteByMissed.reasons, ["rpc_gap"]);

  assert.throws(
    () => normalizeDigestCompleteness({ gaps: [{ fromLedger: 200, toLedger: 199 }] }),
    ScheduleParseError,
  );
  assert.throws(
    () => normalizeDigestCompleteness({ missedLedgers: -1 }),
    ScheduleParseError,
  );
  assert.throws(
    () => normalizeDigestCompleteness({ reasons: ["unknown_reason"] }),
    ScheduleParseError,
  );
});
