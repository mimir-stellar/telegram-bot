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

/**
 * Explicit start-inclusive, end-exclusive (`[periodStartUtc, periodEndUtc)`) UTC
 * period metadata attached to scheduled digest exports.
 */
export interface DigestPeriodBounds {
  /** Inclusive period start as UTC epoch milliseconds. */
  periodStartMs: number;
  /** Exclusive period end as UTC epoch milliseconds. */
  periodEndMs: number;
  /** Inclusive period start formatted in canonical ISO-8601 UTC (`...Z`). */
  periodStartUtc: string;
  /** Exclusive period end formatted in canonical ISO-8601 UTC (`...Z`). */
  periodEndUtc: string;
  /** Half-open boundary contract (`[start, end)`). */
  inclusivity: "[start, end)";
  /** Canonical zone identifier (`"UTC"`). */
  timezone: "UTC";
}

const EXPLICIT_UTC_ISO_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(?:Z|\+00:00)$/;

/**
 * Parse an explicit UTC boundary timestamp (`number` epoch ms or strict ISO-8601
 * UTC string ending in `Z` / `+00:00`), rejecting timezone-ambiguous strings.
 */
export function parseUtcBoundaryMs(value: number | string, label = "boundary"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new ScheduleParseError(`${label} must be a finite integer UTC millisecond timestamp`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = EXPLICIT_UTC_ISO_RE.exec(trimmed);
    if (!match) {
      throw new ScheduleParseError(
        `${label} "${value}" must be an explicit UTC ISO-8601 timestamp ending in Z or +00:00`,
      );
    }
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) {
      throw new ScheduleParseError(`${label} "${value}" is not a valid calendar UTC timestamp`);
    }
    const canonical = new Date(ms).toISOString();
    if (!canonical.startsWith(`${match[1]}T${match[2]}`)) {
      throw new ScheduleParseError(`${label} "${value}" is not a valid calendar UTC timestamp`);
    }
    return ms;
  }
  throw new ScheduleParseError(`${label} must be a UTC timestamp number or ISO-8601 UTC string`);
}

/** Format an integer UTC millisecond timestamp as canonical ISO-8601 UTC (`...Z`). */
export function formatUtcBoundary(timestampMs: number): string {
  const ms = parseUtcBoundaryMs(timestampMs, "timestampMs");
  return new Date(ms).toISOString();
}

/**
 * Construct validated start-inclusive, end-exclusive UTC digest period bounds.
 */
export function createDigestPeriodBounds(
  start: number | string,
  end: number | string,
): DigestPeriodBounds {
  const periodStartMs = parseUtcBoundaryMs(start, "periodStart");
  const periodEndMs = parseUtcBoundaryMs(end, "periodEnd");
  if (periodEndMs <= periodStartMs) {
    throw new ScheduleParseError(
      `Digest periodEnd (${periodEndMs}) must be strictly greater than periodStart (${periodStartMs})`,
    );
  }
  return {
    periodStartMs,
    periodEndMs,
    periodStartUtc: new Date(periodStartMs).toISOString(),
    periodEndUtc: new Date(periodEndMs).toISOString(),
    inclusivity: "[start, end)",
    timezone: "UTC",
  };
}

/**
 * Compute the `[periodStart, periodEnd)` UTC window ending at `periodEnd` for a
 * daily (`24h`) or weekly (`7d`) schedule without consulting host local time.
 */
export function digestPeriodForSchedule(
  scheduleInput: Schedule | string,
  periodEnd: number | string,
): DigestPeriodBounds {
  const schedule =
    typeof scheduleInput === "string" ? parseSchedule(scheduleInput) : scheduleInput;
  const endMs = parseUtcBoundaryMs(periodEnd, "periodEnd");
  const spanMs = schedule.kind === "weekly" ? MS_PER_WEEK : MS_PER_DAY;
  return createDigestPeriodBounds(endMs - spanMs, endMs);
}

/**
 * Evaluate half-open `[periodStartMs, periodEndMs)` membership for an event timestamp.
 */
export function isWithinDigestPeriod(
  timestamp: number,
  bounds: Pick<DigestPeriodBounds, "periodStartMs" | "periodEndMs">,
  unit: "seconds" | "ms" = "seconds",
): boolean {
  if (!Number.isFinite(timestamp)) return false;
  const tsMs = unit === "seconds" ? timestamp * 1000 : timestamp;
  return tsMs >= bounds.periodStartMs && tsMs < bounds.periodEndMs;
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
