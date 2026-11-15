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

export type DigestPageStatus =
  | "pending"
  | "in_flight"
  | "confirmed"
  | "uncertain"
  | "failed";

export interface DigestPageOutcome {
  digestId: string;
  destination: string;
  pageIndex: number;
  totalPages: number;
  pageHash: string;
  status: DigestPageStatus;
  attempts: number;
  updatedAt: number;
  error?: string;
}

export interface PersistedDigestRun {
  digestId: string;
  scheduledAtMs?: number;
  totalPages: number;
  pageHashes: string[];
  /** Retained only while `pending` or `failed` pages remain for crash recovery. */
  pages?: string[];
  destinations: Record<string, DigestPageOutcome[]>;
  uncertainReported?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DigestRecoveryStore {
  loadRuns(): Promise<PersistedDigestRun[]>;
  /**
   * Load runs on process startup, promoting any interrupted `in_flight` page
   * outcomes to `uncertain` and persisting the transition before returning.
   */
  loadForRecovery(nowMs?: number): Promise<PersistedDigestRun[]>;
  saveRun(run: PersistedDigestRun): Promise<void>;
}

export const DEFAULT_DIGEST_RECOVERY_MAX_RUNS = 32;

function isSettledDigestRun(run: PersistedDigestRun): boolean {
  for (const outcomes of Object.values(run.destinations)) {
    for (const outcome of outcomes) {
      if (
        outcome.status === "pending" ||
        outcome.status === "in_flight" ||
        outcome.status === "failed"
      ) {
        return false;
      }
    }
  }
  return true;
}

export class FileDigestRecoveryStore implements DigestRecoveryStore {
  private readonly maxRuns: number;

  constructor(
    private readonly filePath: string,
    options: { maxRuns?: number } = {},
  ) {
    this.maxRuns = Math.max(1, options.maxRuns ?? DEFAULT_DIGEST_RECOVERY_MAX_RUNS);
  }

  async loadRuns(): Promise<PersistedDigestRun[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    const trimmed = raw.trim();
    if (trimmed === "") return [];
    try {
      const parsed = JSON.parse(trimmed) as { version?: unknown; runs?: unknown };
      if (parsed?.version !== 1 || !Array.isArray(parsed.runs)) {
        await this.quarantineCorrupt();
        return [];
      }
      return parsed.runs as PersistedDigestRun[];
    } catch {
      await this.quarantineCorrupt();
      return [];
    }
  }

  async loadForRecovery(nowMs: number = Date.now()): Promise<PersistedDigestRun[]> {
    const runs = await this.loadRuns();
    let mutated = false;
    for (const run of runs) {
      for (const outcomes of Object.values(run.destinations)) {
        for (const outcome of outcomes) {
          if (outcome.status === "in_flight") {
            outcome.status = "uncertain";
            outcome.updatedAt = nowMs;
            outcome.error =
              outcome.error ?? "process restarted before send confirmation";
            run.uncertainReported = false;
            run.updatedAt = nowMs;
            mutated = true;
          }
        }
      }
    }
    if (mutated) {
      await this.persistRuns(runs);
    }
    return runs;
  }

  async saveRun(run: PersistedDigestRun): Promise<void> {
    const runs = await this.loadRuns();
    const idx = runs.findIndex((existing) => existing.digestId === run.digestId);
    if (idx >= 0) {
      runs[idx] = run;
    } else {
      runs.push(run);
    }
    const bounded = this.compactRuns(runs);
    await this.persistRuns(bounded);
  }

  private compactRuns(runs: PersistedDigestRun[]): PersistedDigestRun[] {
    if (runs.length <= this.maxRuns) return runs;
    const result = [...runs];
    while (result.length > this.maxRuns) {
      const settledIdx = result.findIndex((candidate) => isSettledDigestRun(candidate));
      if (settledIdx >= 0) {
        result.splice(settledIdx, 1);
      } else {
        result.shift();
      }
    }
    return result;
  }

  private async persistRuns(runs: PersistedDigestRun[]): Promise<void> {
    const dir = dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const payload = `${JSON.stringify({ version: 1, runs }, null, 2)}\n`;
    const handle = await fs.open(tmp, "w");
    try {
      await handle.writeFile(payload, "utf-8");
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    await fs.rename(tmp, this.filePath);
  }

  private async quarantineCorrupt(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${this.filePath}.corrupt.${stamp}`;
    try {
      await fs.rename(this.filePath, target);
      console.warn(
        `[digest-recovery] quarantined unreadable state file to ${target}; starting empty`,
      );
    } catch {
      // Ignore race if file disappeared before quarantine rename.
    }
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
