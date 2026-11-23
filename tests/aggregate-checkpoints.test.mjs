import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  AggregateScanReducer,
  loadAggregateScanCheckpoint,
  saveAggregateScanCheckpoint,
} from "../dist/stellar/aggregate-checkpoint.js";
import {
  ResolutionLatencyCheckpointError,
  ResolutionLatencyReducer,
  loadResolutionLatencyCheckpoint,
  resolutionLatency,
  saveResolutionLatencyCheckpoint,
} from "../dist/stellar/resolution-latency.js";
import {
  VolumeSeriesCheckpointError,
  VolumeSeriesReducer,
  loadVolumeSeriesCheckpoint,
  saveVolumeSeriesCheckpoint,
  volumeSeries,
} from "../dist/stellar/volume-series.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeDecodedEvent({
  source = "market",
  contractId = "C1",
  ledger = 100,
  txHash = "0xabc",
  at = 1792500000,
  eventId = "100-1",
  payload = {},
}) {
  return {
    source,
    contractId,
    version: "v1",
    ledger,
    txHash,
    at,
    eventId,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

// ── Volume Series Checkpoints ───────────────────────────────────────────────

test("volumeSeries: checkpoint serialization, deserialization, and resume across overlapping replay pages", () => {
  // Page 1: Events 1, 2, 3
  const page1 = [
    makeDecodedEvent({
      eventId: "100-1",
      ledger: 100,
      at: 1792500000,
      payload: { name: "claim_challenged", stake: 10000000n },
    }),
    makeDecodedEvent({
      eventId: "100-2",
      ledger: 100,
      at: 1792501800,
      payload: { name: "deposited", amount: 25000000n },
    }),
    makeDecodedEvent({
      eventId: "101-1",
      ledger: 101,
      at: 1792503600, // +1 hour
      payload: { name: "claim_challenged", stake: 5000000n },
    }),
  ];

  // Page 2: Overlapping inclusive cursor contains Event 3 again, plus Events 4 and 5
  const page2 = [
    makeDecodedEvent({
      eventId: "101-1", // duplicate from inclusive cursor overlap
      ledger: 101,
      at: 1792503600,
      payload: { name: "claim_challenged", stake: 5000000n },
    }),
    makeDecodedEvent({
      eventId: "102-1",
      ledger: 102,
      at: 1792507200, // +2 hours
      payload: { name: "deposited", amount: 15000000n },
    }),
    makeDecodedEvent({
      eventId: "103-1",
      ledger: 103,
      at: 1792507500,
      payload: { name: "claim_challenged", stake: 2000000n },
    }),
  ];

  // 1. One-shot baseline without pagination/resume
  const allUniqueEvents = [page1[0], page1[1], page1[2], page2[1], page2[2]];
  const oneShotResult = volumeSeries(allUniqueEvents, { bucket: "hour" });

  // 2. Step 1: Process Page 1 and generate checkpoint
  const reducer1 = new VolumeSeriesReducer({ bucket: "hour", dedup: true });
  reducer1.addEvents(page1);
  const cp1 = reducer1.toCheckpoint();

  assert.equal(cp1.version, 1);
  assert.equal(cp1.bucket, "hour");
  assert.equal(cp1.processedEvents, 3);
  assert.equal(cp1.totalChallengeStake, "15000000");
  assert.equal(cp1.totalSquadDeposit, "25000000");

  // 3. Step 2: Resume with checkpoint on Page 2 (with overlapping event)
  const reducer2 = VolumeSeriesReducer.fromCheckpoint(cp1);
  const step2Stats = reducer2.addEvents(page2);

  assert.equal(step2Stats.duplicates, 1, "Should detect 1 overlapping duplicate event");
  assert.equal(step2Stats.processed, 2, "Should process 2 new unique events");

  const resumedResult = reducer2.toResult();

  // 4. Assert resumed result exactly matches the one-shot baseline (no double-counting)
  assert.equal(resumedResult.totalChallengeStake, oneShotResult.totalChallengeStake);
  assert.equal(resumedResult.totalSquadDeposit, oneShotResult.totalSquadDeposit);
  assert.equal(resumedResult.processedEvents, oneShotResult.processedEvents);
  assert.equal(resumedResult.buckets.length, oneShotResult.buckets.length);

  for (let i = 0; i < oneShotResult.buckets.length; i++) {
    assert.deepEqual(resumedResult.buckets[i], oneShotResult.buckets[i]);
  }
});

test("volumeSeries: atomic file persistence and reload", async () => {
  await withTempDataDir(async (tmp) => {
    const cpPath = tmp.file("volume-checkpoint.json");

    const events = [
      makeDecodedEvent({
        eventId: "200-1",
        ledger: 200,
        at: 1792500000,
        payload: { name: "claim_challenged", stake: 999999999999999999n },
      }),
    ];

    const reducer = new VolumeSeriesReducer({ bucket: "day", dedup: true });
    reducer.addEvents(events);
    const originalCp = reducer.toCheckpoint();

    await saveVolumeSeriesCheckpoint(cpPath, originalCp);
    const loadedCp = await loadVolumeSeriesCheckpoint(cpPath);

    assert.ok(loadedCp);
    assert.equal(loadedCp.version, 1);
    assert.equal(loadedCp.bucket, "day");
    assert.equal(loadedCp.totalChallengeStake, "999999999999999999");
    assert.deepEqual(loadedCp.recentEventIds, ["200-1"]);
  });
});

test("volumeSeries: bounded state limits - maxBuckets prunes oldest buckets", () => {
  const reducer = new VolumeSeriesReducer({ bucket: "hour", maxBuckets: 2, dedup: true });

  reducer.addEvent(
    makeDecodedEvent({
      eventId: "1-1",
      at: 1000 * 3600, // Hour 1000
      payload: { name: "claim_challenged", stake: 10n },
    }),
  );
  reducer.addEvent(
    makeDecodedEvent({
      eventId: "2-1",
      at: 1001 * 3600, // Hour 1001
      payload: { name: "claim_challenged", stake: 20n },
    }),
  );
  reducer.addEvent(
    makeDecodedEvent({
      eventId: "3-1",
      at: 1002 * 3600, // Hour 1002 - pushes out Hour 1000
      payload: { name: "claim_challenged", stake: 30n },
    }),
  );

  const cp = reducer.toCheckpoint();
  assert.equal(cp.buckets.length, 2, "State should be bounded to maxBuckets = 2");
  assert.equal(cp.buckets[0].startAt, 1001 * 3600);
  assert.equal(cp.buckets[1].startAt, 1002 * 3600);
});

test("volumeSeries: failure cases on corrupted or incompatible checkpoint", async () => {
  await withTempDataDir(async (tmp) => {
    // 1. Missing file returns null
    const missing = await loadVolumeSeriesCheckpoint(tmp.file("missing.json"));
    assert.equal(missing, null);

    // 2. Corrupt JSON throws VolumeSeriesCheckpointError
    const corruptPath = tmp.file("corrupt.json");
    await writeFile(corruptPath, "{ invalid json content ...", "utf8");
    await assert.rejects(
      async () => loadVolumeSeriesCheckpoint(corruptPath),
      (err) => {
        assert.ok(err instanceof VolumeSeriesCheckpointError);
        assert.match(err.message, /Malformed JSON/);
        return true;
      },
    );

    // 3. Incompatible version throws VolumeSeriesCheckpointError
    const badVerPath = tmp.file("bad-ver.json");
    await writeFile(
      badVerPath,
      JSON.stringify({
        format: "mimir-volume-series-checkpoint-v1",
        version: 99,
        bucket: "hour",
      }),
      "utf8",
    );
    await assert.rejects(
      async () => loadVolumeSeriesCheckpoint(badVerPath),
      (err) => {
        assert.ok(err instanceof VolumeSeriesCheckpointError);
        assert.match(err.message, /Incompatible volume series checkpoint format or version/);
        return true;
      },
    );

    // 4. Bucket mismatch when resuming throws VolumeSeriesCheckpointError
    const hourCp = {
      format: "mimir-volume-series-checkpoint-v1",
      version: 1,
      bucket: "hour",
      updatedAt: new Date().toISOString(),
      processedEvents: 0,
      skippedWithoutAt: 0,
      totalChallengeStake: "0",
      totalSquadDeposit: "0",
      minBucketStart: null,
      maxBucketStart: null,
      buckets: [],
      recentEventIds: [],
      dedupCapacity: 256,
    };
    assert.throws(
      () => new VolumeSeriesReducer({ bucket: "day", checkpoint: hourCp }),
      (err) => {
        assert.ok(err instanceof VolumeSeriesCheckpointError);
        assert.match(err.message, /bucket unit mismatch/);
        return true;
      },
    );
  });
});

// ── Resolution Latency Checkpoints ──────────────────────────────────────────

test("resolutionLatency: checkpoint resume pairs cross-page claims without double-counting", () => {
  // Page 1: Claims 1 & 2 created, boundary event E_B
  const page1 = [
    makeDecodedEvent({
      eventId: "10-1",
      ledger: 10,
      at: 1000,
      payload: { name: "claim_created", claimId: 1 },
    }),
    makeDecodedEvent({
      eventId: "10-2",
      ledger: 10,
      at: 1000,
      payload: { name: "claim_created", claimId: 2 },
    }),
    makeDecodedEvent({
      eventId: "15-1", // boundary event
      ledger: 15,
      at: 1030,
      payload: { name: "claim_created", claimId: 3 },
    }),
  ];

  // Page 2: Boundary event 15-1 repeated (inclusive cursor), Claim 1 resolved, Claim 2 cancelled
  const page2 = [
    makeDecodedEvent({
      eventId: "15-1", // inclusive cursor overlap
      ledger: 15,
      at: 1030,
      payload: { name: "claim_created", claimId: 3 },
    }),
    makeDecodedEvent({
      eventId: "20-1",
      ledger: 20,
      at: 1060,
      payload: { name: "claim_resolved", claimId: 1 },
    }),
    makeDecodedEvent({
      eventId: "25-1",
      ledger: 25,
      at: 1090,
      payload: { name: "claim_cancelled", claimId: 2 },
    }),
  ];

  // 1. One-shot baseline
  const uniqueEvents = [page1[0], page1[1], page1[2], page2[1], page2[2]];
  const oneShotReport = resolutionLatency(uniqueEvents);

  // 2. Incremental walk with checkpoint
  const reducer1 = new ResolutionLatencyReducer({ dedup: true });
  reducer1.addEvents(page1);
  const cp1 = reducer1.toCheckpoint();

  assert.equal(cp1.version, 1);
  assert.equal(cp1.creations.length, 3);
  assert.equal(cp1.resolutions.length, 0);

  const reducer2 = ResolutionLatencyReducer.fromCheckpoint(cp1);
  const step2Stats = reducer2.addEvents(page2);

  assert.equal(step2Stats.duplicates, 1, "Boundary event 15-1 dropped on resume");
  assert.equal(step2Stats.processed, 2, "2 events processed on page 2");

  const resumedReport = reducer2.toReport();

  // 3. Assert parity with one-shot run
  assert.equal(resumedReport.excludedCount, oneShotReport.excludedCount); // Claim 3 unresolved
  assert.equal(resumedReport.resolved.claims.length, 1);
  assert.equal(resumedReport.cancelled.claims.length, 1);

  assert.deepEqual(resumedReport.resolved.claims[0], oneShotReport.resolved.claims[0]);
  assert.deepEqual(resumedReport.cancelled.claims[0], oneShotReport.cancelled.claims[0]);
  assert.deepEqual(resumedReport.resolved.summary, oneShotReport.resolved.summary);
});

test("resolutionLatency: bounded state limits - maxPendingClaims evicts oldest creations", () => {
  const reducer = new ResolutionLatencyReducer({ maxPendingClaims: 3, dedup: true });

  for (let i = 1; i <= 5; i++) {
    reducer.addEvent(
      makeDecodedEvent({
        eventId: `${i}-1`,
        ledger: i * 10,
        at: i * 100,
        payload: { name: "claim_created", claimId: i },
      }),
    );
  }

  const cp = reducer.toCheckpoint();
  assert.equal(cp.creations.length, 3, "State should be bounded to maxPendingClaims = 3");
  // Oldest creations (1 and 2) should be evicted; 3, 4, 5 retained
  assert.deepEqual(
    cp.creations.map((c) => c[0]),
    [3, 4, 5],
  );
});

test("resolutionLatency: failure cases on corrupted checkpoint", async () => {
  await withTempDataDir(async (tmp) => {
    const corruptPath = tmp.file("bad-latency-checkpoint.json");
    await writeFile(corruptPath, "{ malformed ...", "utf8");

    await assert.rejects(
      async () => loadResolutionLatencyCheckpoint(corruptPath),
      (err) => {
        assert.ok(err instanceof ResolutionLatencyCheckpointError);
        assert.match(err.message, /Malformed JSON/);
        return true;
      },
    );
  });
});

// ── Unified AggregateScanReducer ───────────────────────────────────────────

test("AggregateScanReducer: drives multi-page scan with crash-recovery simulation", async () => {
  await withTempDataDir(async (tmp) => {
    const checkpointFile = tmp.file("aggregate-scan.json");

    // Page 1: Events at ledgers 100, 101, 102
    const page1 = [
      makeDecodedEvent({
        eventId: "100-1",
        ledger: 100,
        at: 1792500000,
        payload: { name: "claim_created", claimId: 10 },
      }),
      makeDecodedEvent({
        eventId: "101-1",
        ledger: 101,
        at: 1792500050,
        payload: { name: "claim_challenged", stake: 5000000n },
      }),
      makeDecodedEvent({
        eventId: "102-1", // boundary event
        ledger: 102,
        at: 1792500100,
        payload: { name: "deposited", amount: 10000000n },
      }),
    ];

    // Page 2: inclusive cursor overlap with 102-1, plus 103, 104
    const page2 = [
      makeDecodedEvent({
        eventId: "102-1", // boundary overlap
        ledger: 102,
        at: 1792500100,
        payload: { name: "deposited", amount: 10000000n },
      }),
      makeDecodedEvent({
        eventId: "103-1",
        ledger: 103,
        at: 1792500150,
        payload: { name: "claim_resolved", claimId: 10 },
      }),
      makeDecodedEvent({
        eventId: "104-1",
        ledger: 104,
        at: 1792503600, // +1 hour
        payload: { name: "claim_challenged", stake: 2000000n },
      }),
    ];

    // Run Stage 1: process page 1 and checkpoint
    const scanner1 = new AggregateScanReducer({
      volume: { bucket: "hour" },
      latency: true,
      metadata: { scanName: "backfill-2026" },
    });

    const p1Stats = scanner1.addPage(page1, { cursor: "cursor-page-1", ledger: 102 });
    assert.equal(p1Stats.processed, 3);
    assert.equal(p1Stats.duplicates, 0);

    const cp1 = scanner1.toCheckpoint();
    assert.equal(cp1.pagesProcessed, 1);
    assert.equal(cp1.cursor, "cursor-page-1");
    assert.equal(cp1.lastLedger, 102);

    await saveAggregateScanCheckpoint(checkpointFile, cp1);

    // Simulate crash / restart: reload checkpoint from disk
    const loadedCp = await loadAggregateScanCheckpoint(checkpointFile);
    assert.ok(loadedCp);
    assert.equal(loadedCp.metadata?.scanName, "backfill-2026");

    // Run Stage 2: resume scanner from disk checkpoint and process page 2
    const scanner2 = AggregateScanReducer.fromCheckpoint(loadedCp);
    const p2Stats = scanner2.addPage(page2, { cursor: "cursor-page-2", ledger: 104 });

    assert.equal(p2Stats.duplicates, 1, "Overlapping boundary event 102-1 dropped");
    assert.equal(p2Stats.processed, 2, "2 new events processed");

    const finalResults = scanner2.toResults();
    assert.equal(finalResults.pagesProcessed, 2);
    assert.equal(finalResults.totalDuplicates, 1);
    assert.equal(finalResults.cursor, "cursor-page-2");
    assert.equal(finalResults.lastLedger, 104);

    // Volume totals: 5000000 + 2000000 challenge stake = 7000000; deposit = 10000000 (not 20000000)
    assert.equal(finalResults.volume?.totalChallengeStake, "7000000");
    assert.equal(finalResults.volume?.totalSquadDeposit, "10000000");

    // Latency report: Claim 10 resolved
    assert.equal(finalResults.latency?.resolved.claims.length, 1);
    assert.equal(finalResults.latency?.resolved.claims[0].claimId, 10);
    assert.equal(finalResults.latency?.resolved.claims[0].duration.ledgers, 3); // 103 - 100
  });
});
