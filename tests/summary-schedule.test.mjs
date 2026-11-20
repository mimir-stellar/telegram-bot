import test from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSchedule,
  nextRun,
  nextAllowedWindowStart,
  nextAllowedRun,
  createScheduler,
  FileLastRunStore,
  ScheduleParseError,
} from "../dist/notifications/schedule.js";

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
      // Fire timers in chronological order until time is exhausted.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) break;
        const [id, t] = due[0];
        timers.delete(id);
        now = t.at;
        t.cb();
        // The scheduler's tick does real file I/O (FileLastRunStore), which a
        // couple of microtask yields cannot cover. Wait until it re-arms its
        // next timer, which it does only once the tick has finished.
        await waitUntil(() => timers.size > 0);
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}

const UTC_2024_01_01_0000 = Date.UTC(2024, 0, 1, 0, 0, 0);

test("parseSchedule parses daily and weekly", () => {
  const daily = parseSchedule("daily@09:00");
  assert.deepEqual(daily, { kind: "daily", minuteOfDay: 9 * 60 });
  const weekly = parseSchedule("weekly@mon 09:00");
  assert.deepEqual(weekly, { kind: "weekly", dayOfWeek: 1, minuteOfDay: 9 * 60 });
});

test("parseSchedule rejects invalid specs with typed errors", () => {
  for (const bad of ["", "daily", "daily@25:00", "daily@23:60", "weekly@fun 09:00", "weekly@mon", "hourly@09:00"]) {
    assert.throws(() => parseSchedule(bad), ScheduleParseError, `should reject "${bad}"`);
  }
});

test("nextRun daily rolls across day boundary", () => {
  const schedule = parseSchedule("daily@09:00");
  const now = Date.UTC(2024, 0, 1, 9, 30, 0);
  const next = nextRun(schedule, now);
  assert.strictEqual(next, Date.UTC(2024, 0, 2, 9, 0, 0));
});

test("nextRun weekly rolls across week boundary", () => {
  const schedule = parseSchedule("weekly@mon 09:00");
  // Saturday Jan 6, 2024.
  const now = Date.UTC(2024, 0, 6, 12, 0, 0);
  const next = nextRun(schedule, now);
  assert.strictEqual(next, Date.UTC(2024, 0, 8, 9, 0, 0));
});

test("nextRun returns today when boundary is in the future", () => {
  const schedule = parseSchedule("daily@09:00");
  const now = Date.UTC(2024, 0, 1, 8, 59, 0);
  assert.strictEqual(nextRun(schedule, now), Date.UTC(2024, 0, 1, 9, 0, 0));
});

test("scheduler fires at the scheduled time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-schedule-"));
  try {
    const store = new FileLastRunStore(join(dir, "last-run"));
    const clock = fakeClock(Date.UTC(2024, 0, 1, 8, 0, 0));
    const runs = [];
    const scheduler = createScheduler({
      schedule: "daily@09:00",
      clock,
      lastRunStore: store,
      run: (at) => {
        runs.push(at);
      },
    });
    await scheduler.start();
    // No recorded run yet: nothing is missed, so nothing fires before 09:00.
    assert.strictEqual(runs.length, 0);
    await clock.advanceTo(Date.UTC(2024, 0, 1, 9, 0, 0));
    assert.deepStrictEqual(runs, [Date.UTC(2024, 0, 1, 9, 0, 0)]);
    await scheduler.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scheduler fires missed run once on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-schedule-restart-"));
  try {
    const store = new FileLastRunStore(join(dir, "last-run"));
    // Simulate a run that happened two days ago.
    await store.write(Date.UTC(2024, 0, 1, 9, 0, 0));
    const clock = fakeClock(Date.UTC(2024, 0, 3, 10, 0, 0));
    const runs = [];
    const scheduler = createScheduler({
      schedule: "daily@09:00",
      clock,
      lastRunStore: store,
      run: (at) => {
        runs.push(at);
      },
    });
    await scheduler.start();
    // Advancing a full day should not produce additional runs from the missed window.
    await clock.advanceTo(Date.UTC(2024, 0, 4, 10));
    assert.strictEqual(runs.length, 2);
    await scheduler.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nextAllowedWindowStart & nextAllowedRun defer quiet-hours runs until allowed window", () => {
  const quietHours = { window: { start: 22, end: 6 } };
  const sameDayQuiet = { window: { start: "02:00", end: "06:00" } };

  // 23:00 UTC -> deferred to next day 06:00 UTC
  assert.strictEqual(
    nextAllowedWindowStart(quietHours, Date.UTC(2024, 0, 1, 23, 0, 0)),
    Date.UTC(2024, 0, 2, 6, 0, 0),
  );
  // 03:00 UTC -> deferred to same day 06:00 UTC
  assert.strictEqual(
    nextAllowedWindowStart(quietHours, Date.UTC(2024, 0, 2, 3, 0, 0)),
    Date.UTC(2024, 0, 2, 6, 0, 0),
  );
  // Same-day window 02:00-06:00 at 04:00 -> 06:00
  assert.strictEqual(
    nextAllowedWindowStart(sameDayQuiet, Date.UTC(2024, 0, 2, 4, 0, 0)),
    Date.UTC(2024, 0, 2, 6, 0, 0),
  );
  // Outside quiet hours -> unchanged
  assert.strictEqual(
    nextAllowedWindowStart(quietHours, Date.UTC(2024, 0, 2, 6, 0, 0)),
    Date.UTC(2024, 0, 2, 6, 0, 0),
  );
  // Scheduled daily@02:00 from 00:00 -> deferred to 06:00
  assert.strictEqual(
    nextAllowedRun(parseSchedule("daily@02:00"), Date.UTC(2024, 0, 2, 0, 0, 0), quietHours),
    Date.UTC(2024, 0, 2, 6, 0, 0),
  );
  // Invalid nowMs throws ScheduleParseError
  assert.throws(
    () => nextAllowedWindowStart(quietHours, Number.NaN),
    ScheduleParseError,
  );
});

test("scheduler with quietHours defers due digest until allowed window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "test-schedule-quiet-"));
  try {
    const store = new FileLastRunStore(join(dir, "last-run"));
    const clock = fakeClock(Date.UTC(2024, 0, 1, 21, 0, 0));
    const runs = [];
    const scheduler = createScheduler({
      schedule: "daily@02:00",
      quietHours: { window: { start: 22, end: 6 } },
      clock,
      lastRunStore: store,
      run: (at) => {
        runs.push(at);
      },
    });
    await scheduler.start();

    // At 02:00 UTC (inside quiet hours), digest must NOT fire yet
    await clock.advanceTo(Date.UTC(2024, 0, 2, 2, 30, 0));
    assert.strictEqual(runs.length, 0);

    // At 06:00 UTC (allowed window), deferred digest fires once
    await clock.advanceTo(Date.UTC(2024, 0, 2, 6, 0, 0));
    assert.strictEqual(runs.length, 1);
    await scheduler.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
