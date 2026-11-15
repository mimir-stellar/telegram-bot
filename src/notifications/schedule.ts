import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export type ScheduleKind = "daily" | "weekly";

export interface Schedule {
  kind: ScheduleKind;
  /** Minutes since midnight UTC (0-999). */
  minuteOfDay: number;
  /** 0 = Sunday ... 6 = Saturday. Only set for weekly schedules. */
  dayOfWeek?: number;
}

export class ScheduleParseError extends Error {
  readonly code = "SCHEDULE_PARSE_ERROR" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScheduleParseError";
  }
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

function parseTimeOfDay(time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) {
    throw new ScheduleParseError(
      `Invalid time "${time}": expected HH:mm in 24h UTC format`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new ScheduleParseError(
      `Invalid time "${time}": hour must be 0-23 and minute 0-59`,
    );
  }
  return hour * 60 + minute;
}

function parseWeekday(token: string): number {
  const key = token.toLowerCase();
  const day = WEEKDAYS[key];
  if (day === undefined) {
    throw new ScheduleParseError(
      `Invalid weekday "${token}": expected one of sun, mon, tue, wed, thu, fri, sat`,
    );
  }
  return day;
}

export function parseSchedule(spec: string): Schedule {
  if (typeof spec !== "string") {
    throw new ScheduleParseError("Schedule spec must be a string");
  }
  const trimmed = spec.trim();
  const daily = /^daily@(.+)$/i.exec(trimmed);
  if (daily && daily[1]) {
    return { kind: "daily", minuteOfDay: parseTimeOfDay(daily[1].trim()) };
  }
  const weekly = /^weekly@([A-Za-z]{3})\s+(.+)$/.exec(trimmed);
  if (weekly) {
    return {
      kind: "weekly",
      dayOfWeek: parseWeekday(weekly[1]!),
      minuteOfDay: parseTimeOfDay(weekly[2]!.trim()),
    };
  }
  throw new ScheduleParseError(
    `Unsupported schedule "${spec}": expected "daily@HH:mm" or "weekly@day HH:mm"`,
  );
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / MS_PER_DAY) * MS_PER_DAY;
}

function utcWeekday(ms: number): number {
  // Jan 1, 1970 was a Thursday (3).
  const daysSinceEpoch = Math.floor(ms / MS_PER_DAY);
  return (((daysSinceEpoch + 4) % 7) + 7) % 7;
}

export function nextRun(schedule: Schedule, nowMs: number): number {
  if (!Number.isFinite(nowMs)) {
    throw new ScheduleParseError("nowMs must be a finite number");
  }
  const dayStart = startOfUtcDay(nowMs);
  const todayRun = dayStart + schedule.minuteOfDay * 60 * 1000;
  if (schedule.kind === "daily") {
    return todayRun > nowMs ? todayRun : todayRun + MS_PER_DAY;
  }
  const targetDay = schedule.dayOfWeek;
  if (targetDay === undefined) {
    throw new ScheduleParseError("Weekly schedule is missing dayOfWeek");
  }
  const currentDay = utcWeekday(nowMs);
  const dayDelta = (targetDay - currentDay + 7) % 7;
  const candidate = dayStart + dayDelta * MS_PER_DAY + schedule.minuteOfDay * 60 * 1000;
  return candidate > nowMs ? candidate : candidate + MS_PER_WEEK;
}

export type DigestIncompletenessReason =
  | "rpc_gap"
  | "restart"
  | "rpc_error"
  | "cursor_reset";

export interface DigestPeriodGapRange {
  fromLedger: number;
  toLedger: number;
  source?: string;
}

export interface DigestPeriodCompletenessInput {
  complete?: boolean;
  reasons?: readonly DigestIncompletenessReason[];
  missedLedgers?: number;
  gaps?: readonly DigestPeriodGapRange[];
}

export interface DigestPeriodCompleteness {
  complete: boolean;
  status: "complete" | "incomplete";
  reasons: DigestIncompletenessReason[];
  missedLedgers: number;
  gaps: DigestPeriodGapRange[];
}

const VALID_INCOMPLETENESS_REASONS: ReadonlySet<string> = new Set([
  "rpc_gap",
  "restart",
  "rpc_error",
  "cursor_reset",
]);

/**
 * Normalize and validate digest period completeness metadata. Any recorded
 * reason, gap range, or positive `missedLedgers` count forces `incomplete`
 * status so a partial period can never masquerade as complete.
 */
export function normalizeDigestCompleteness(
  input: DigestPeriodCompletenessInput = {},
): DigestPeriodCompleteness {
  const seenReasons = new Set<DigestIncompletenessReason>();
  for (const reason of input.reasons ?? []) {
    if (!VALID_INCOMPLETENESS_REASONS.has(reason)) {
      throw new ScheduleParseError(`Unsupported digest incompleteness reason "${String(reason)}"`);
    }
    seenReasons.add(reason);
  }

  const gaps: DigestPeriodGapRange[] = [];
  let derivedMissed = 0;
  for (const gap of input.gaps ?? []) {
    if (
      !Number.isInteger(gap.fromLedger) ||
      !Number.isInteger(gap.toLedger) ||
      gap.fromLedger < 0 ||
      gap.toLedger < gap.fromLedger
    ) {
      throw new ScheduleParseError(
        `Invalid ledger gap range [${gap.fromLedger}, ${gap.toLedger}]`,
      );
    }
    gaps.push({
      fromLedger: gap.fromLedger,
      toLedger: gap.toLedger,
      ...(gap.source ? { source: gap.source } : {}),
    });
    derivedMissed += gap.toLedger - gap.fromLedger + 1;
  }

  if (gaps.length > 0) {
    seenReasons.add("rpc_gap");
  }

  if (input.missedLedgers !== undefined) {
    if (!Number.isInteger(input.missedLedgers) || input.missedLedgers < 0) {
      throw new ScheduleParseError("missedLedgers must be a non-negative integer");
    }
    if (input.missedLedgers > 0 && seenReasons.size === 0) {
      seenReasons.add("rpc_gap");
    }
  }

  const missedLedgers = Math.max(input.missedLedgers ?? 0, derivedMissed);
  const explicitlyIncomplete = input.complete === false;
  if (explicitlyIncomplete && seenReasons.size === 0) {
    seenReasons.add("restart");
  }

  const reasons = [...seenReasons];
  const complete = !explicitlyIncomplete && reasons.length === 0 && missedLedgers === 0;
  return {
    complete,
    status: complete ? "complete" : "incomplete",
    reasons,
    missedLedgers,
    gaps,
  };
}

export interface DigestPeriodTracker {
  recordRpcGap(gap?: {
    fromLedger?: number;
    toLedger?: number;
    missedLedgers?: number;
    source?: string;
  }): void;
  recordRestart(): void;
  recordRpcError(): void;
  recordCursorReset(): void;
  snapshot(): DigestPeriodCompleteness;
  reset(): void;
}

/**
 * Stateful tracker accumulating RPC gaps, restarts, scan errors, or cursor
 * resets observed within the active scheduled digest period.
 */
export function createDigestPeriodTracker(): DigestPeriodTracker {
  let reasons = new Set<DigestIncompletenessReason>();
  let missedLedgers = 0;
  let gaps: DigestPeriodGapRange[] = [];

  return {
    recordRpcGap(gap = {}) {
      reasons.add("rpc_gap");
      if (gap.fromLedger !== undefined && gap.toLedger !== undefined) {
        const validated = normalizeDigestCompleteness({
          gaps: [
            {
              fromLedger: gap.fromLedger,
              toLedger: gap.toLedger,
              source: gap.source,
            },
          ],
        });
        gaps.push(...validated.gaps);
        missedLedgers += validated.missedLedgers;
        return;
      }
      if (gap.missedLedgers !== undefined) {
        if (!Number.isInteger(gap.missedLedgers) || gap.missedLedgers < 0) {
          throw new ScheduleParseError("missedLedgers must be a non-negative integer");
        }
        missedLedgers += gap.missedLedgers;
      }
    },
    recordRestart() {
      reasons.add("restart");
    },
    recordRpcError() {
      reasons.add("rpc_error");
    },
    recordCursorReset() {
      reasons.add("cursor_reset");
    },
    snapshot() {
      return normalizeDigestCompleteness({
        reasons: [...reasons],
        missedLedgers,
        gaps,
      });
    },
    reset() {
      reasons = new Set();
      missedLedgers = 0;
      gaps = [];
    },
  };
}

export interface LastRunStore {
  read(): Promise<number | null>;
  write(timestampMs: number): Promise<void>;
}

export class FileLastRunStore implements LastRunStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<number | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw err;
    }
  }

  async write(timestampMs: number): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, String(timestampMs), "utf-8");
  }
}

export interface SchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (cb, delayMs) => setTimeout(cb, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SchedulerOptions {
  schedule: Schedule | string;
  run: (atMs: number) => Promise<void> | void;
  clock?: SchedulerClock;
  lastRunStore: LastRunStore;
}

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const schedule =
    typeof options.schedule === "string"
      ? parseSchedule(options.schedule)
      : options.schedule;
  const clock = options.clock ?? systemClock;
  const { run, lastRunStore } = options;

  let timer: unknown = null;
  let stopped = true;
  let chain = Promise.resolve();

  const scheduleNext = () => {
    const now = clock.now();
    const next = nextRun(schedule, now);
    const delay = Math.max(0, next - now);
    timer = clock.setTimeout(() => {
      void tick(true);
    }, delay);
  };

  // `atBoundary` is true when the timer fired at a scheduled time and false
  // for the check made on start().
  const tick = async (atBoundary: boolean) => {
    if (stopped) return;
    timer = null;
    try {
      const now = clock.now();
      const last = await lastRunStore.read();
      // Fire at most once for any missed runs since the last recorded run.
      // With no recorded run there is nothing missed: a first start waits for
      // the next boundary instead of firing early (and then again at it).
      const shouldFire = last === null ? atBoundary : nextRun(schedule, last) <= now;
      if (shouldFire) {
        await run(nextRun(schedule, last ?? now - 1));
        await lastRunStore.write(now);
      }
    } catch (err) {
      console.error("[scheduler] run failed:", err);
    } finally {
      if (!stopped) {
        scheduleNext();
      }
    }
  };

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      chain = chain.then(() => tick(false));
      await chain;
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clock.clearTimeout(timer);
        timer = null;
      }
      await chain.catch(() => undefined);
    },
  };
}
