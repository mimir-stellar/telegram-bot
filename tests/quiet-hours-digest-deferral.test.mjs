import assert from "node:assert/strict";
import test from "node:test";

import {
  createQuietHoursDigestDeferral,
  DEFAULT_MAX_DEFERRED_DIGEST_ENTRIES,
} from "../dist/notifications/digest-grouping.js";
import {
  createScheduler,
  FileLastRunStore,
  nextAllowedRun,
  nextAllowedWindow,
  parseSchedule,
  ScheduleParseError,
} from "../dist/notifications/schedule.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const CREATOR = "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

function makeEvent(name, overrides = {}) {
  const ledger = overrides.ledger ?? 1_000;
  return {
    source: "market",
    contractId: "C" + "A".repeat(55),
    version: "v1",
    ledger,
    txHash: "",
    at: 1_700_000_000,
    eventId: `evt-${ledger}-${name}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name,
      claimId: 42,
      category: "crypto",
      creator: CREATOR,
    },
    ...overrides,
  };
}

async function waitUntil(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("fake clock: scheduler did not re-arm");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fakeClock(startMs) {
  let now = startMs;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimeout(cb, delay) {
      const id = nextId++;
      timers.set(id, { cb, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async advanceTo(target) {
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, t] = due[0];
        timers.delete(id);
        now = t.at;
        t.cb();
        await waitUntil(() => timers.size > 0);
      }
      now = target;
    },
  };
}

test("nextAllowedWindow and nextAllowedRun defer overnight and daytime quiet hours to the exact UTC boundary", () => {
  const overnight = { window: { start: "22:00", end: "06:00" } };
  assert.equal(
    nextAllowedWindow(overnight, Date.UTC(2026, 9, 19, 21, 59, 59)),
    Date.UTC(2026, 9, 19, 21, 59, 59),
  );
  assert.equal(
    nextAllowedWindow(overnight, Date.UTC(2026, 9, 19, 22, 0, 0)),
    Date.UTC(2026, 9, 20, 6, 0, 0),
  );
  assert.equal(
    nextAllowedWindow(overnight, Date.UTC(2026, 9, 20, 2, 15, 0)),
    Date.UTC(2026, 9, 20, 6, 0, 0),
  );
  assert.equal(
    nextAllowedWindow(overnight, Date.UTC(2026, 9, 20, 6, 0, 0)),
    Date.UTC(2026, 9, 20, 6, 0, 0),
  );

  const schedule = parseSchedule("daily@23:00");
  assert.equal(
    nextAllowedRun(schedule, Date.UTC(2026, 9, 19, 20, 0, 0), overnight),
    Date.UTC(2026, 9, 20, 6, 0, 0),
  );

  assert.throws(() => nextAllowedWindow(overnight, Number.NaN), ScheduleParseError);
});

test("createQuietHoursDigestDeferral defers eligible digests until the allowed window while keeping critical alerts immediate", () => {
  const coordinator = createQuietHoursDigestDeferral({
    policy: { window: { start: "22:00", end: "06:00" } },
    maxEntries: 3,
  });

  assert.equal(DEFAULT_MAX_DEFERRED_DIGEST_ENTRIES, 200);
  assert.equal(coordinator.maxEntries, 3);

  const quietStart = Date.UTC(2026, 9, 19, 22, 30, 0);

  // Critical alerts always bypass digest buffering immediately, even during quiet hours.
  const critical1 = makeEvent("claim_resolved", { ledger: 1001 });
  const criticalRes = coordinator.ingest(critical1, quietStart);
  assert.equal(criticalRes.decision, "immediate");
  assert.equal(criticalRes.reason, "critical");
  assert.equal(coordinator.pendingCount, 0);

  // Eligible digest events accumulate up to maxEntries.
  assert.deepEqual(coordinator.ingest(makeEvent("claim_created", { ledger: 1002 }), quietStart), {
    decision: "deferred",
    pendingCount: 1,
  });
  assert.deepEqual(
    coordinator.ingest(makeEvent("claim_challenged", { ledger: 1003 }), quietStart),
    {
      decision: "deferred",
      pendingCount: 2,
    },
  );
  assert.deepEqual(
    coordinator.ingest(
      makeEvent("deposited", {
        source: "squad",
        ledger: 1004,
        payload: { name: "deposited", marketId: 7, participant: CREATOR, amount: 500n, side: 1 },
      }),
      quietStart,
    ),
    {
      decision: "deferred",
      pendingCount: 3,
    },
  );

  // Exceeding maxEntries caps accumulated entries and tracks overflow.
  assert.deepEqual(
    coordinator.ingest(makeEvent("withdrawal", { ledger: 1005 }), quietStart),
    {
      decision: "dropped",
      reason: "max-entries",
      overflowCount: 1,
    },
  );
  assert.equal(coordinator.pendingCount, 3);
  assert.equal(coordinator.overflowCount, 1);

  // Immediate critical alerts remain operational even when the digest buffer is full!
  const criticalWhenFull = makeEvent("market_settled", { ledger: 1006 });
  assert.deepEqual(coordinator.ingest(criticalWhenFull, quietStart), {
    decision: "immediate",
    reason: "critical",
    event: criticalWhenFull,
  });

  // Attempting to flush inside quiet hours defers without consuming buffered entries.
  const held = coordinator.flushAllowed(Date.UTC(2026, 9, 20, 3, 0, 0));
  assert.equal(held.deferred, true);
  assert.equal(held.nextAllowedAtMs, Date.UTC(2026, 9, 20, 6, 0, 0));
  assert.equal(held.message, null);
  assert.equal(held.pendingCount, 3);
  assert.equal(coordinator.pendingCount, 3);

  // Once the allowed window opens at 06:00 UTC, accumulated entries flush as a grouped digest.
  const released = coordinator.flushAllowed(Date.UTC(2026, 9, 20, 6, 0, 0));
  assert.equal(released.deferred, false);
  assert.equal(released.events.length, 3);
  assert.equal(released.groups.length, 2);
  assert.equal(released.overflowCount, 1);
  assert.equal(released.pendingCount, 0);
  assert.ok(released.message !== null);
  assert.match(released.message, /\*Mimir Digest\* — 3 events in this cycle/);
  assert.match(released.message, /market:42/);
  assert.match(released.message, /1 additional event omitted \\\(digest cap 3\\\)/);

  // Subsequent flush in the allowed window is empty.
  const emptyAfter = coordinator.flushAllowed(Date.UTC(2026, 9, 20, 6, 5, 0));
  assert.equal(emptyAfter.deferred, false);
  assert.equal(emptyAfter.events.length, 0);
  assert.equal(emptyAfter.overflowCount, 0);
  assert.equal(emptyAfter.message, null);
});

test("createScheduler with quietHours defers scheduled and missed digest runs until quiet hours end", async () => {
  await withTempDataDir(async ({ file }) => {
    const store = new FileLastRunStore(file("digest-last-run.txt"));
    const quietHours = { window: { start: "22:00", end: "06:00" } };
    const deferral = createQuietHoursDigestDeferral({ policy: quietHours, maxEntries: 5 });
    const clock = fakeClock(Date.UTC(2026, 9, 19, 21, 0, 0));
    const delivered = [];

    const scheduler = createScheduler({
      schedule: "daily@23:00",
      clock,
      lastRunStore: store,
      quietHours,
      run: (atMs) => {
        const flushed = deferral.flushAllowed(atMs);
        if (!flushed.deferred && flushed.message !== null) {
          delivered.push({ atMs, message: flushed.message });
        }
      },
    });

    await scheduler.start();
    deferral.ingest(makeEvent("claim_created", { ledger: 2001 }), clock.now());

    // Advance past 23:00 UTC (scheduled boundary inside quiet hours) to 02:00 UTC: still deferred!
    await clock.advanceTo(Date.UTC(2026, 9, 20, 2, 0, 0));
    assert.equal(delivered.length, 0);
    assert.equal(deferral.pendingCount, 1);
    assert.equal(await store.read(), null);

    // Advance to 06:00 UTC (allowed window start): deferred digest fires once!
    await clock.advanceTo(Date.UTC(2026, 9, 20, 6, 0, 0));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].atMs, Date.UTC(2026, 9, 20, 6, 0, 0));
    assert.equal(deferral.pendingCount, 0);
    assert.equal(await store.read(), Date.UTC(2026, 9, 20, 6, 0, 0));
    await scheduler.stop();

    // Simulate restart during quiet hours after missing the next 23:00 UTC boundary.
    deferral.ingest(makeEvent("claim_challenged", { ledger: 2002 }), Date.UTC(2026, 9, 21, 1, 0, 0));
    const restartClock = fakeClock(Date.UTC(2026, 9, 21, 1, 0, 0));
    const restarted = createScheduler({
      schedule: "daily@23:00",
      clock: restartClock,
      lastRunStore: store,
      quietHours,
      run: (atMs) => {
        const flushed = deferral.flushAllowed(atMs);
        if (!flushed.deferred && flushed.message !== null) {
          delivered.push({ atMs, message: flushed.message });
        }
      },
    });

    await restarted.start();
    // Still inside quiet hours at 01:00 UTC: missed run must wait until 06:00 UTC.
    assert.equal(delivered.length, 1);
    await restartClock.advanceTo(Date.UTC(2026, 9, 21, 6, 0, 0));
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].atMs, Date.UTC(2026, 9, 21, 6, 0, 0));
    await restarted.stop();
  });
});

test("createQuietHoursDigestDeferral rejects invalid bounds and bad timestamps", () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => createQuietHoursDigestDeferral({ policy: { window: [22, 6] }, maxEntries: bad }),
      RangeError,
    );
  }

  const coordinator = createQuietHoursDigestDeferral({
    policy: { window: [22, 6] },
    maxEntries: 2,
    deferOnlyDuringQuietHours: true,
  });

  // Outside quiet hours with deferOnlyDuringQuietHours=true sends non-critical events immediately.
  const noonEvent = makeEvent("claim_created", { ledger: 3001 });
  assert.deepEqual(coordinator.ingest(noonEvent, "2026-10-20T12:00:00Z"), {
    decision: "immediate",
    reason: "allowed-window",
    event: noonEvent,
  });

  assert.throws(() => coordinator.flushAllowed("not-a-timestamp"), RangeError);
});
