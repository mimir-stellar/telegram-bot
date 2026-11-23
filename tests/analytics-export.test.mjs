import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAnalyticsExportCli } from "../dist/analytics-export-cli.js";
import {
  ANALYTICS_SUMMARY_SCHEMA,
  ANALYTICS_SUMMARY_SCHEMA_VERSION,
  buildAnalyticsSummary,
  serializeAnalyticsSummary,
} from "../dist/stellar/analytics-export.js";
import { validate } from "./helpers/json-schema-lite.mjs";

const schema = JSON.parse(
  readFileSync(new URL("../docs/schemas/analytics-summary.schema.json", import.meta.url), "utf8"),
);

// 2026-10-20T00:00:00Z
const DAY0 = 1792454400;

function ev({ name, ledger, at, ...payload }) {
  return {
    source: name === "deposited" ? "squad" : "market",
    contractId: "C1",
    version: "v1",
    ledger,
    txHash: `tx-${ledger}`,
    at,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: { name, ...payload },
  };
}

/** Archived events: as written to JSONL, so i128 amounts are strings. */
function fixture() {
  return [
    ev({ name: "claim_created", ledger: 100, at: DAY0 + 60, claimId: 1 }),
    ev({ name: "claim_challenged", ledger: 110, at: DAY0 + 3600, claimId: 1, stake: "50000000" }),
    ev({ name: "deposited", ledger: 120, at: DAY0 + 7200, amount: "120000000" }),
    ev({ name: "claim_resolved", ledger: 160, at: DAY0 + 360, claimId: 1 }),
    ev({ name: "claim_created", ledger: 200, at: DAY0 + 86400 * 2, claimId: 2 }),
    ev({ name: "claim_cancelled", ledger: 230, at: DAY0 + 86400 * 2 + 150, claimId: 2 }),
    // Still open: counted as excluded, makes the summary incomplete.
    ev({ name: "claim_created", ledger: 240, at: DAY0 + 86400 * 2 + 200, claimId: 3 }),
  ];
}

test("analytics summary carries schema id, version and units", () => {
  const s = buildAnalyticsSummary(fixture(), { bucket: "day" });
  assert.equal(s.schema, ANALYTICS_SUMMARY_SCHEMA);
  assert.equal(s.schema, "mimir.analytics-summary");
  assert.equal(s.schemaVersion, ANALYTICS_SUMMARY_SCHEMA_VERSION);
  assert.equal(s.schemaVersion, 1);
  assert.deepEqual(s.units, {
    amount: "base_units",
    timestamp: "unix_seconds",
    duration: ["seconds", "ledgers"],
    bucket: "day",
    percentile: "nearest_rank",
  });
});

test("analytics summary validates against docs/schemas/analytics-summary.schema.json", () => {
  for (const events of [fixture(), []]) {
    for (const bucket of ["hour", "day"]) {
      const doc = JSON.parse(serializeAnalyticsSummary(buildAnalyticsSummary(events, { bucket })));
      assert.deepEqual(validate(schema, doc), [], `bucket=${bucket} events=${events.length}`);
    }
  }
});

test("analytics summary reports bounds, totals and latency", () => {
  const s = buildAnalyticsSummary(fixture(), { bucket: "day" });

  assert.deepEqual(s.input.ledgerBounds, { firstLedger: 100, lastLedger: 240 });
  assert.equal(s.input.timeBounds.firstAt, DAY0 + 60);
  assert.equal(s.input.timeBounds.lastAt, DAY0 + 86400 * 2 + 200);
  assert.equal(s.input.timeBounds.firstAtIso, "2026-10-20T00:01:00.000Z");

  // Three contiguous day buckets; the middle one is zero-filled. endAt is exclusive.
  assert.deepEqual(s.volume.bounds, { startAt: DAY0, endAt: DAY0 + 86400 * 3, bucketCount: 3 });
  assert.equal(s.volume.buckets[1].eventCount, 0);
  assert.deepEqual(s.volume.totals, { challengeStake: "50000000", squadDeposit: "120000000" });
  assert.equal(typeof s.volume.buckets[0].challengeStake, "string");

  assert.deepEqual(s.latency.resolved, {
    count: 1,
    p50: { seconds: 300, ledgers: 60 },
    p90: { seconds: 300, ledgers: 60 },
    max: { seconds: 300, ledgers: 60 },
  });
  assert.equal(s.latency.cancelled.count, 1);
  assert.deepEqual(s.latency.cancelled.max, { seconds: 150, ledgers: 30 });
});

test("completeness flags an open claim and dropped records", () => {
  const s = buildAnalyticsSummary(
    [...fixture(), null, { payload: null }, ev({ name: "deposited", ledger: 300, at: Number.NaN, amount: "1" })],
    { bucket: "day" },
  );
  assert.equal(s.input.records, 10);
  assert.equal(s.input.malformed, 2);
  assert.equal(s.input.missingTime, 1);
  assert.deepEqual(s.latency.completeness, { pairedClaims: 2, excludedClaims: 1, complete: false });
  assert.equal(s.volume.completeness.processedEvents, 7);
  assert.equal(s.volume.completeness.complete, true);
  assert.equal(s.complete, false);

  // The dropped NaN deposit must not reach the totals.
  assert.equal(s.volume.totals.squadDeposit, "120000000");
});

test("a fully paired, clean input is complete", () => {
  const events = fixture().filter((e) => e.payload.claimId !== 3);
  const s = buildAnalyticsSummary(events, { bucket: "hour" });
  assert.equal(s.latency.completeness.complete, true);
  assert.equal(s.complete, true);
});

test("empty input gives null bounds and zero totals", () => {
  for (const input of [[], null, undefined]) {
    const s = buildAnalyticsSummary(input, { bucket: "hour" });
    assert.equal(s.input.timeBounds, null);
    assert.equal(s.input.ledgerBounds, null);
    assert.equal(s.volume.bounds, null);
    assert.deepEqual(s.volume.buckets, []);
    assert.deepEqual(s.volume.totals, { challengeStake: "0", squadDeposit: "0" });
    assert.equal(s.latency.resolved.p50, null);
    assert.equal(s.complete, true);
  }
});

test("output is byte-identical for identical input, in any order", () => {
  const a = serializeAnalyticsSummary(buildAnalyticsSummary(fixture(), { bucket: "hour" }));
  const b = serializeAnalyticsSummary(buildAnalyticsSummary(fixture(), { bucket: "hour" }));
  const reversed = serializeAnalyticsSummary(
    buildAnalyticsSummary(fixture().reverse(), { bucket: "hour" }),
  );
  assert.equal(a, b);
  assert.equal(a, reversed);
  assert.ok(a.endsWith("}\n"));
  assert.ok(!/generatedAt|"now"/.test(a), "no wall-clock fields");
});

test("rejects an invalid bucket", () => {
  assert.throws(() => buildAnalyticsSummary([], { bucket: "week" }), /Invalid bucket unit/);
});

test("CLI exports an archive deterministically and validates flags", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-analytics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, "archive");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(archive);
  // CRLF on purpose: archives may be written on either line ending.
  await writeFile(
    path.join(archive, "events-2026-10-20.jsonl"),
    fixture().map((e) => JSON.stringify(e)).join("\r\n") + "\r\n",
  );

  const outFile = path.join(dir, "summary.json");
  const io = { out: "", err: "", stdout(s) { this.out += s; }, stderr(s) { this.err += s; } };
  assert.equal(await runAnalyticsExportCli(["--archive", archive, "--bucket", "hour", "--out", outFile], io), 0);
  const first = await readFile(outFile, "utf8");

  const io2 = { out: "", err: "", stdout(s) { this.out += s; }, stderr(s) { this.err += s; } };
  assert.equal(await runAnalyticsExportCli(["--archive", archive, "--bucket", "hour"], io2), 0);
  assert.equal(io2.out, first);
  assert.equal(JSON.parse(first).volume.totals.challengeStake, "50000000");

  const bad = { out: "", err: "", stdout(s) { this.out += s; }, stderr(s) { this.err += s; } };
  assert.equal(await runAnalyticsExportCli(["--archive", archive, "--bucket", "week"], bad), 2);
  assert.equal(await runAnalyticsExportCli([], bad), 2);
  assert.equal(await runAnalyticsExportCli(["--archive", path.join(dir, "missing")], bad), 1);
});
