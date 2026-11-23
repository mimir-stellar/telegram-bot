import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  evaluateEventAgainstFilter,
  formatFilterDryRunReport,
  normalizeArchiveEventPayload,
  runFilterDryRunReport,
} from "../dist/notifications/filter-dry-run.js";
import {
  FilterParseError,
  parseFilterExpression,
} from "../dist/notifications/filter-expr.js";
import { createEventArchive, MalformedArchiveRecordError } from "../dist/stellar/archive.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeDummyEvent(id, name, overrides = {}) {
  const isMarket = [
    "claim_created",
    "claim_challenged",
    "claim_resolved",
    "claim_cancelled",
    "market_settled",
  ].includes(name);

  return {
    source: isMarket ? "market" : "squad",
    ledger: 1000 + id,
    txHash: `0xdeadbeef${id}`,
    eventId: `event-${id}`,
    txIndex: 1,
    operationIndex: 1,
    topicName: name,
    contractId: "C1234567890",
    blockTime: 1700000000 + id,
    payload: {
      name,
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// evaluateEventAgainstFilter & normalizeArchiveEventPayload unit tests
// ---------------------------------------------------------------------------

test("normalizeArchiveEventPayload: converts string numbers to bigint for known schema bigint fields", () => {
  const rawEvent = {
    source: "market",
    payload: {
      name: "claim_challenged",
      claimId: 1,
      stake: "10000000",
    },
  };

  const normalized = normalizeArchiveEventPayload(rawEvent);
  assert.equal(typeof normalized.payload.stake, "bigint");
  assert.equal(normalized.payload.stake, 10_000_000n);
});

test("evaluateEventAgainstFilter: matches when no expressions and no thresholds given", () => {
  const event = makeDummyEvent(1, "claim_created", { claimId: 1, category: "crypto" });
  const result = evaluateEventAgainstFilter(event, [], undefined);
  assert.deepEqual(result, { matched: true });
});

test("evaluateEventAgainstFilter: rejects unknown or missing payload as unknown_payload or malformed", () => {
  const eventUnknown = makeDummyEvent(1, "unknown", {});
  const resUnknown = evaluateEventAgainstFilter(eventUnknown, [], undefined);
  assert.deepEqual(resUnknown, { matched: false, reason: "unknown_payload" });

  const eventMalformed = { ...eventUnknown, payload: null };
  const resMalformed = evaluateEventAgainstFilter(eventMalformed, [], undefined);
  assert.deepEqual(resMalformed, { matched: false, reason: "malformed" });
});

test("evaluateEventAgainstFilter: rejects with threshold_unmet when stake/deposit below threshold", () => {
  const challengeEvent = makeDummyEvent(1, "claim_challenged", {
    claimId: 1,
    challenger: "G...",
    stake: 5_000_000n, // 0.5 USDC
  });

  const res = evaluateEventAgainstFilter(challengeEvent, [], {
    marketChallenge: 10_000_000n, // 1 USDC
  });
  assert.deepEqual(res, { matched: false, reason: "threshold_unmet" });

  const depositEvent = makeDummyEvent(2, "deposited", {
    marketId: 1,
    side: 1,
    participant: "G...",
    amount: 10_000_000n, // 1 USDC
    shares: 10_000_000n,
  });
  const resDeposit = evaluateEventAgainstFilter(depositEvent, [], {
    squadDeposit: 20_000_000n, // 2 USDC
  });
  assert.deepEqual(resDeposit, { matched: false, reason: "threshold_unmet" });
});

test("evaluateEventAgainstFilter: rejects with name_mismatch and condition_unmet", () => {
  const rule = parseFilterExpression("claim_challenged where stake >= 100 USDC");

  const createdEvent = makeDummyEvent(1, "claim_created", { claimId: 1, category: "crypto" });
  const resName = evaluateEventAgainstFilter(createdEvent, [rule], undefined);
  assert.deepEqual(resName, { matched: false, reason: "name_mismatch" });

  const lowStakeChallenge = makeDummyEvent(2, "claim_challenged", {
    claimId: 1,
    challenger: "G...",
    stake: 50_000_000n, // 5 USDC
  });
  const resCond = evaluateEventAgainstFilter(lowStakeChallenge, [rule], undefined);
  assert.deepEqual(resCond, { matched: false, reason: "condition_unmet" });

  const highStakeChallenge = makeDummyEvent(3, "claim_challenged", {
    claimId: 1,
    challenger: "G...",
    stake: 150_000_000n, // 15 USDC
  });
  const resPass = evaluateEventAgainstFilter(
    highStakeChallenge,
    [parseFilterExpression("claim_challenged where stake >= 10 USDC")],
    undefined,
  );
  assert.deepEqual(resPass, { matched: true });
});

// ---------------------------------------------------------------------------
// runFilterDryRunReport archive tests
// ---------------------------------------------------------------------------

test("runFilterDryRunReport: empty archive produces zeroed report", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    await mkdir(archiveDir, { recursive: true });

    const report = await runFilterDryRunReport({
      archiveDir,
      filter: { expression: "claim_created" },
      now: () => new Date("2026-11-19T00:00:00.000Z"),
    });

    assert.equal(report.totalEvents, 0);
    assert.equal(report.matchedEvents, 0);
    assert.equal(report.rejectedEvents, 0);
    assert.equal(report.rejectionReasons.name_mismatch, 0);
    assert.equal(report.executedAt, "2026-11-19T00:00:00.000Z");
  });
});

test("runFilterDryRunReport: counts matching and rejected events by reason over archive", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });

    const events = [
      makeDummyEvent(1, "claim_created", { claimId: 1, category: "crypto" }),
      makeDummyEvent(2, "claim_created", { claimId: 2, category: "sports" }),
      makeDummyEvent(3, "claim_challenged", { claimId: 1, challenger: "G...", stake: 5_000_000n }),
      makeDummyEvent(4, "claim_challenged", { claimId: 2, challenger: "G...", stake: 500_000_000n }),
      makeDummyEvent(5, "deposited", { marketId: 1, side: 1, participant: "G...", amount: 1_000_000n }),
      makeDummyEvent(6, "unknown", {}),
    ];

    await archive.append(events);
    await archive.close();

    const report = await runFilterDryRunReport({
      archiveDir,
      filter: {
        expression: "claim_challenged where stake >= 10 USDC",
      },
      now: () => new Date("2026-11-19T12:00:00.000Z"),
    });

    assert.equal(report.totalEvents, 6);
    assert.equal(report.matchedEvents, 1); // event 4 (50 USDC >= 10 USDC)
    assert.equal(report.rejectedEvents, 5); // events 1, 2, 3, 5, 6

    assert.equal(report.rejectionReasons.name_mismatch, 3); // events 1, 2, 5 (different event names)
    assert.equal(report.rejectionReasons.condition_unmet, 1); // event 3 (stake < 10 USDC)
    assert.equal(report.rejectionReasons.unknown_payload, 1); // event 6 (name "unknown")
    assert.equal(report.rejectionReasons.threshold_unmet, 0);

    assert.equal(report.byEventName.claim_created.total, 2);
    assert.equal(report.byEventName.claim_created.matched, 0);
    assert.equal(report.byEventName.claim_created.rejected, 2);

    assert.equal(report.byEventName.claim_challenged.total, 2);
    assert.equal(report.byEventName.claim_challenged.matched, 1);
    assert.equal(report.byEventName.claim_challenged.rejected, 1);

    assert.equal(report.byEventName.deposited.total, 1);
    assert.equal(report.byEventName.deposited.matched, 0);
    assert.equal(report.byEventName.deposited.rejected, 1);
  });
});

test("runFilterDryRunReport: evaluates combined expressions and amount thresholds", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    const archive = createEventArchive({ dir: archiveDir });

    const events = [
      // claim_created in "crypto"
      makeDummyEvent(1, "claim_created", { claimId: 1, category: "crypto" }),
      // claim_created in "sports"
      makeDummyEvent(2, "claim_created", { claimId: 2, category: "sports" }),
      // claim_challenged: meets threshold (20 USDC > 10 USDC) and condition (claimId == 1)
      makeDummyEvent(3, "claim_challenged", { claimId: 1, challenger: "G...", stake: 200_000_000n }),
      // claim_challenged: meets threshold (20 USDC > 10 USDC) but fails condition (claimId != 1)
      makeDummyEvent(4, "claim_challenged", { claimId: 2, challenger: "G...", stake: 200_000_000n }),
      // claim_challenged: fails threshold (5 USDC < 10 USDC)
      makeDummyEvent(5, "claim_challenged", { claimId: 1, challenger: "G...", stake: 50_000_000n }),
    ];

    await archive.append(events);
    await archive.close();

    const report = await runFilterDryRunReport({
      archiveDir,
      filter: {
        expression: "claim_challenged where claimId == 1",
        thresholds: {
          marketChallenge: 100_000_000n, // 10 USDC
        },
      },
    });

    assert.equal(report.totalEvents, 5);
    assert.equal(report.matchedEvents, 1); // event 3
    assert.equal(report.rejectedEvents, 4);

    assert.equal(report.rejectionReasons.name_mismatch, 2); // events 1, 2
    assert.equal(report.rejectionReasons.threshold_unmet, 1); // event 5
    assert.equal(report.rejectionReasons.condition_unmet, 1); // event 4
  });
});

test("runFilterDryRunReport: rejects invalid expressions using production FilterParseError", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    await mkdir(archiveDir, { recursive: true });

    await assert.rejects(
      async () => {
        await runFilterDryRunReport({
          archiveDir,
          filter: {
            expression: "invalid_event_name where x > 1",
          },
        });
      },
      (err) => {
        assert.ok(err instanceof FilterParseError);
        assert.match(err.message, /Unknown event name "invalid_event_name"/);
        return true;
      },
    );
  });
});

test("runFilterDryRunReport: handles malformed archive record cleanly", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("events-archive");
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      path.join(archiveDir, "events-broken.jsonl"),
      '{"invalid json line\n',
      "utf8",
    );

    // Default readArchive throws MalformedArchiveRecordError
    await assert.rejects(
      async () => {
        await runFilterDryRunReport({
          archiveDir,
          filter: { expression: "claim_created" },
        });
      },
      (err) => {
        assert.ok(err instanceof MalformedArchiveRecordError);
        return true;
      },
    );
  });
});

test("formatFilterDryRunReport: renders human-readable plain text summary", () => {
  const dummyReport = {
    totalEvents: 10,
    matchedEvents: 4,
    rejectedEvents: 6,
    rejectionReasons: {
      name_mismatch: 3,
      condition_unmet: 2,
      threshold_unmet: 1,
      unknown_payload: 0,
      malformed: 0,
    },
    byEventName: {
      claim_created: { total: 4, matched: 1, rejected: 3 },
      claim_challenged: { total: 6, matched: 3, rejected: 3 },
    },
    expressionsEvaluated: ["claim_challenged where stake >= 10 USDC"],
    thresholdsEvaluated: { marketChallenge: 100000000n },
    executedAt: "2026-11-19T12:00:00.000Z",
  };

  const text = formatFilterDryRunReport(dummyReport);
  assert.match(text, /=== Filter Dry-Run Report ===/);
  assert.match(text, /Total Events Evaluated: 10/);
  assert.match(text, /Matched: 4 \(40%\)/);
  assert.match(text, /Rejected: 6 \(60%\)/);
  assert.match(text, /name_mismatch: 3/);
  assert.match(text, /condition_unmet: 2/);
  assert.match(text, /threshold_unmet: 1/);
  assert.match(text, /claim_created: 4 total/);
});
