import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  AGGREGATE_CHECKPOINT_SCHEMA_VERSION,
  AggregateCheckpointError,
  IncrementalAggregator,
  createIncrementalAggregator,
  loadAggregateCheckpoint,
  loadOrCreateIncrementalAggregator,
  volumeSeries,
} from "../dist/stellar/volume-series.js";
import {
  createIncrementalAggregator as createFromLatency,
  resolutionLatency,
} from "../dist/stellar/resolution-latency.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const T0 = Math.floor(new Date("2026-10-20T10:00:00.000Z").getTime() / 1000);

function makeEvent({ eventId, ledger, at, source = "market", payload }) {
  return {
    source,
    contractId: source === "market" ? "CMARKET1" : "CSQUAD1",
    version: "v1",
    ledger,
    txHash: `tx-${eventId}`,
    at,
    eventId,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("resumes across persisted checkpoints without double-counting overlapping replay pages", async () => {
  assert.equal(createIncrementalAggregator, createFromLatency);

  await withTempDataDir(async (tmp) => {
    const checkpointFile = tmp.file("aggregate-checkpoint.json");

    const e1 = makeEvent({
      eventId: "100-1",
      ledger: 100,
      at: T0 + 120,
      payload: { name: "claim_created", claimId: 1, creator: "G1", category: "crypto", title: "C1" },
    });
    const e2 = makeEvent({
      eventId: "110-1",
      ledger: 110,
      at: T0 + 600,
      payload: { name: "claim_challenged", claimId: 1, challenger: "G2", stake: 150000000n },
    });
    const e3 = makeEvent({
      eventId: "120-1",
      ledger: 120,
      at: T0 + 3600 + 300,
      source: "squad",
      payload: { name: "deposited", marketId: 1, side: 1, participant: "G3", amount: 400000000n, shares: 400000000n },
    });
    const e4 = makeEvent({
      eventId: "130-1",
      ledger: 130,
      at: T0 + 3600 + 900,
      payload: { name: "claim_created", claimId: 2, creator: "G4", category: "macro", title: "C2" },
    });
    const e5 = makeEvent({
      eventId: "140-1",
      ledger: 140,
      at: T0 + 7200 + 120,
      payload: {
        name: "claim_resolved",
        claimId: 1,
        winnerSide: 1,
        summary: "Resolved C1",
        confidence: 100,
        evidenceHash: "aa",
      },
    });
    const e6 = makeEvent({
      eventId: "150-1",
      ledger: 150,
      at: T0 + 7200 + 600,
      payload: { name: "claim_cancelled", claimId: 2 },
    });
    const e7 = makeEvent({
      eventId: "160-1",
      ledger: 160,
      at: T0 + 7200 + 1200,
      payload: { name: "claim_challenged", claimId: 2, challenger: "G5", stake: 350000000n },
    });

    const uniqueEvents = [e1, e2, e3, e4, e5, e6, e7];

    // Batch 1 (cold start): ingest [e1, e2, e3] and persist checkpoint
    const cold = await loadOrCreateIncrementalAggregator(checkpointFile, { bucket: "hour" });
    assert.equal(cold.resumed, false);
    const stats1 = cold.aggregator.ingest([e1, e2, e3], { cursor: "120-1" });
    assert.deepEqual(stats1, { acceptedEvents: 3, duplicatesSkipped: 0, skippedWithoutAt: 0 });
    await cold.aggregator.save(checkpointFile, 1792500000000);

    // Batch 2 (resume): inclusive cursor replays [e2, e3] + new [e4, e5]
    const run2 = await loadOrCreateIncrementalAggregator(checkpointFile, { bucket: "hour" });
    assert.equal(run2.resumed, true);
    assert.equal(run2.aggregator.cursor, "120-1");
    const stats2 = run2.aggregator.ingest([e2, e3, e4, e5], { cursor: "140-1" });
    assert.deepEqual(stats2, { acceptedEvents: 2, duplicatesSkipped: 2, skippedWithoutAt: 0 });
    await run2.aggregator.save(checkpointFile, 1792500060000);

    // Batch 3 (resume): overlapping replay [e4, e5] + new [e6, e7]
    const run3 = await loadOrCreateIncrementalAggregator(checkpointFile, { bucket: "hour" });
    assert.equal(run3.resumed, true);
    assert.equal(run3.aggregator.cursor, "140-1");
    const stats3 = run3.aggregator.ingest([e4, e5, e6, e7], { cursor: "160-1" });
    assert.deepEqual(stats3, { acceptedEvents: 2, duplicatesSkipped: 2, skippedWithoutAt: 0 });
    const saved = await run3.aggregator.save(checkpointFile, 1792500120000);

    assert.equal(saved.schemaVersion, AGGREGATE_CHECKPOINT_SCHEMA_VERSION);
    assert.equal(saved.duplicatesSkipped, 4);
    assert.equal(saved.firstLedger, 100);
    assert.equal(saved.lastLedger, 160);

    // Compare incremental results against single-pass reducers over unique events
    assert.deepEqual(run3.aggregator.volumeResult(), volumeSeries(uniqueEvents, { bucket: "hour" }));
    assert.deepEqual(run3.aggregator.latencyReport(), resolutionLatency(uniqueEvents));
  });
});

test("enforces bounded buckets, open/completed claims, and dedup window in persisted state", async () => {
  await withTempDataDir(async (tmp) => {
    const checkpointFile = tmp.file("bounded-checkpoint.json");
    const agg = createIncrementalAggregator({
      bucket: "hour",
      maxBuckets: 3,
      maxOpenClaims: 2,
      maxCompletedClaims: 2,
      dedupWindow: 4,
    });

    // Feed 6 distinct hourly buckets, 4 open claims, and 4 resolved claims
    const events = [];
    for (let h = 0; h < 6; h++) {
      events.push(
        makeEvent({
          eventId: `vol-${h}`,
          ledger: 200 + h,
          at: T0 + h * 3600 + 60,
          payload: { name: "claim_challenged", claimId: 900 + h, challenger: "G1", stake: 100n },
        }),
      );
    }
    for (let c = 1; c <= 4; c++) {
      events.push(
        makeEvent({
          eventId: `open-${c}`,
          ledger: 300 + c,
          at: T0 + 5 * 3600 + c,
          payload: { name: "claim_created", claimId: c, creator: "G1", category: "crypto" },
        }),
      );
    }
    for (let r = 10; r < 14; r++) {
      events.push(
        makeEvent({
          eventId: `res-create-${r}`,
          ledger: 400 + r,
          at: T0 + 5 * 3600 + 10,
          payload: { name: "claim_created", claimId: r, creator: "G1", category: "crypto" },
        }),
        makeEvent({
          eventId: `res-done-${r}`,
          ledger: 420 + r,
          at: T0 + 5 * 3600 + 70,
          payload: {
            name: "claim_resolved",
            claimId: r,
            winnerSide: 1,
            summary: "ok",
            confidence: 100,
            evidenceHash: "ff",
          },
        }),
      );
    }

    agg.ingest(events, { cursor: "440-1" });
    await agg.save(checkpointFile);

    const persisted = await loadAggregateCheckpoint(checkpointFile);
    assert.ok(persisted.volume.buckets.length <= 3);
    assert.equal(persisted.volume.totalChallengeStake, "600");
    assert.ok(persisted.volume.evictedBuckets >= 3);
    assert.equal(persisted.latency.openClaims.length, 2);
    assert.equal(persisted.latency.evictedOpenClaims, 2);
    assert.equal(persisted.latency.resolvedClaims.length, 2);
    assert.equal(persisted.latency.evictedCompletedClaims, 2);
    assert.equal(persisted.recentEventIds.length, 4);

    const restored = IncrementalAggregator.fromCheckpoint(persisted);
    assert.ok(restored.volumeResult().buckets.length <= 3);
    assert.equal(restored.volumeResult().totalChallengeStake, "600");
  });
});

test("rejects unsupported schema versions and corrupt checkpoint payloads or quarantines on opt-in", async () => {
  await withTempDataDir(async (tmp) => {
    const badVersionFile = tmp.file("future-version.json");
    const agg = createIncrementalAggregator({ bucket: "day" });
    const cp = agg.toCheckpoint();
    await writeFile(
      badVersionFile,
      JSON.stringify({ ...cp, schemaVersion: 99 }),
      "utf8",
    );

    await assert.rejects(
      () => loadAggregateCheckpoint(badVersionFile),
      (err) => err instanceof AggregateCheckpointError && /schemaVersion/.test(err.message),
    );

    const corruptFile = tmp.file("corrupt.json");
    await writeFile(corruptFile, "{truncated-json", "utf8");

    await assert.rejects(
      () => loadOrCreateIncrementalAggregator(corruptFile, { bucket: "hour" }),
      AggregateCheckpointError,
    );

    const recovered = await loadOrCreateIncrementalAggregator(corruptFile, {
      bucket: "hour",
      quarantineOnCorrupt: true,
    });
    assert.equal(recovered.resumed, false);
    assert.ok(recovered.quarantinedPath);
    const st = await stat(recovered.quarantinedPath);
    assert.ok(st.isFile());
  });
});
