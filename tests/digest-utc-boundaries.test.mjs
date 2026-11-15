import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  exportDigest,
  serializeDigestExport,
} from "../dist/notifications/digest-grouping.js";
import { formatDigest } from "../dist/notifications/format.js";
import {
  ScheduleParseError,
  createDigestPeriodBounds,
  digestPeriodForSchedule,
  isWithinDigestPeriod,
  parseUtcBoundaryMs,
} from "../dist/notifications/schedule.js";

function makeEvent({
  ledger = 1000,
  eventId = `${ledger}-0`,
  at = 1_763_193_600,
  claimId = 42n,
  name = "claim_created",
} = {}) {
  return {
    source: "market",
    contractId: "CDUMMY00000000000000000000000000000000000000000000000000",
    version: "v1",
    ledger,
    txHash: "a".repeat(64),
    at,
    eventId,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId,
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      category: "crypto",
    },
  };
}

test("exportDigest records start-inclusive and end-exclusive UTC boundaries without overlap", () => {
  const startSec = 1_763_193_600; // 2025-11-15T08:00:00.000Z
  const endSec = 1_763_280_000; // 2025-11-16T08:00:00.000Z
  const nextEndSec = 1_763_366_400; // 2025-11-17T08:00:00.000Z

  const beforeStart = makeEvent({ ledger: 99, eventId: "99-0", at: startSec - 1, claimId: 1n });
  const atStart = makeEvent({ ledger: 100, eventId: "100-0", at: startSec, claimId: 2n });
  const middle = makeEvent({ ledger: 101, eventId: "101-0", at: startSec + 3600, claimId: 2n, name: "claim_challenged" });
  const atEnd = makeEvent({ ledger: 102, eventId: "102-0", at: endSec, claimId: 3n });

  const events = [beforeStart, atStart, middle, atEnd];

  const first = exportDigest(events, {
    periodStart: "2025-11-15T08:00:00Z",
    periodEnd: "2025-11-16T08:00:00+00:00",
  });

  assert.equal(first.periodStartUtc, "2025-11-15T08:00:00.000Z");
  assert.equal(first.periodEndUtc, "2025-11-16T08:00:00.000Z");
  assert.equal(first.periodStartMs, startSec * 1000);
  assert.equal(first.periodEndMs, endSec * 1000);
  assert.equal(first.inclusivity, "[start, end)");
  assert.equal(first.timezone, "UTC");
  assert.equal(first.eventCount, 2);
  assert.equal(first.groups.length, 1);
  assert.deepEqual(
    first.groups[0].events.map((e) => e.eventId),
    ["100-0", "101-0"],
  );

  // Adjacent [end, nextEnd) captures `atEnd` exactly once with zero overlap.
  const second = exportDigest(events, {
    schedule: "daily@08:00",
    periodEnd: nextEndSec * 1000,
  });
  assert.equal(second.periodStartUtc, first.periodEndUtc);
  assert.equal(second.eventCount, 1);
  assert.deepEqual(
    second.groups[0].events.map((e) => e.eventId),
    ["102-0"],
  );
  assert.equal(isWithinDigestPeriod(startSec, first, "seconds"), true);
  assert.equal(isWithinDigestPeriod(endSec, first, "seconds"), false);
});

test("digestPeriodForSchedule and formatDigest preserve compatibility and render explicit UTC bounds", () => {
  const weekly = digestPeriodForSchedule("weekly@mon 08:00", "2025-11-17T08:00:00.000Z");
  assert.equal(weekly.periodStartUtc, "2025-11-10T08:00:00.000Z");
  assert.equal(weekly.periodEndUtc, "2025-11-17T08:00:00.000Z");

  const ev = makeEvent({ ledger: 500, eventId: "500-0", at: 1_763_193_600 });
  const unchangedFlat = formatDigest([ev]);
  assert.equal(
    unchangedFlat,
    "*Mimir Digest* — 1 events in this cycle\n\n· mimir\\-market `claim\\_created` at ledger 500",
  );

  const withBounds = formatDigest([ev], { grouped: true, periodBounds: weekly });
  assert.ok(withBounds.includes("_Period \\(UTC\\): \\[2025\\-11\\-10T08:00:00\\.000Z, 2025\\-11\\-17T08:00:00\\.000Z\\)_"));
});

test("rejects timezone-ambiguous, non-UTC, impossible, and inverted period boundaries", () => {
  for (const invalid of [
    "2025-11-15T08:00:00", // missing offset (host-TZ dependent)
    "2025-11-15T08:00:00+02:00", // non-UTC offset
    "2025-11-15T08:00:00-00:00", // RFC 3339 unknown local offset
    "2025-02-30T08:00:00Z", // impossible rollover date
    "",
  ]) {
    assert.throws(() => parseUtcBoundaryMs(invalid), ScheduleParseError);
  }

  assert.throws(() => parseUtcBoundaryMs(123.45), ScheduleParseError);
  assert.throws(
    () => createDigestPeriodBounds("2025-11-16T08:00:00Z", "2025-11-16T08:00:00Z"),
    ScheduleParseError,
  );
  assert.throws(
    () => createDigestPeriodBounds("2025-11-17T08:00:00Z", "2025-11-16T08:00:00Z"),
    ScheduleParseError,
  );
  assert.throws(() => exportDigest([], {}), TypeError);
});

test("serialized digest exports remain byte-for-byte identical across host time zones", () => {
  const groupingUrl = new URL("../dist/notifications/digest-grouping.js", import.meta.url).href;
  const formatUrl = new URL("../dist/notifications/format.js", import.meta.url).href;
  const probeScript = `
    const { exportDigest, serializeDigestExport } = await import(${JSON.stringify(groupingUrl)});
    const { formatDigest } = await import(${JSON.stringify(formatUrl)});
    const events = [
      {
        source: "market",
        contractId: "CDUMMY00000000000000000000000000000000000000000000000000",
        version: "v1",
        ledger: 200,
        txHash: "${"b".repeat(64)}",
        at: 1762066800,
        eventId: "200-0",
        eventType: "contract",
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        payload: {
          name: "claim_created",
          claimId: 9n,
          creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          category: "macro",
        },
      },
    ];
    const exported = exportDigest(events, {
      schedule: "daily@08:00",
      periodEnd: "2025-11-02T08:00:00Z",
    });
    const rendered = formatDigest(events, { grouped: true, periodBounds: exported });
    process.stdout.write(JSON.stringify({ json: serializeDigestExport(exported), rendered }));
  `;

  const zones = [
    "UTC",
    "Pacific/Kiritimati",
    "America/St_Johns",
    "Asia/Kathmandu",
    "America/New_York",
  ];
  const outputs = zones.map((tz) => {
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `probe failed for TZ=${tz}: ${res.stderr}`);
    return res.stdout;
  });

  for (let i = 1; i < outputs.length; i += 1) {
    assert.equal(outputs[i], outputs[0], `mismatch for TZ=${zones[i]}`);
  }

  const parsed = JSON.parse(outputs[0]);
  const exported = JSON.parse(parsed.json);
  assert.equal(exported.periodStartUtc, "2025-11-01T08:00:00.000Z");
  assert.equal(exported.periodEndUtc, "2025-11-02T08:00:00.000Z");
  assert.equal(exported.eventCount, 1);
  assert.equal(
    serializeDigestExport(
      exportDigest([makeEvent({ ledger: 200, eventId: "200-0", at: 1_762_066_800, claimId: 9n })], {
        schedule: "daily@08:00",
        periodEnd: "2025-11-02T08:00:00Z",
      }),
    ).includes('"timezone": "UTC"'),
    true,
  );
});
