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

export const MIN_CHAT_DIGEST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_CHAT_DIGEST_INTERVAL_MS = MS_PER_WEEK; // 7 days
export const DEFAULT_MAX_CHAT_DIGEST_DESTINATIONS = 200;

export interface ChatDigestBounds {
  minIntervalMs?: number;
  maxIntervalMs?: number;
}

export interface ChatDigestPreference {
  destination: string;
  mode: "interval" | "schedule" | "immediate";
  intervalMs?: number;
  schedule?: Schedule;
  spec: string;
}

const DESTINATION_CHAT_ID_RE = /^(?:-?[1-9]\d{0,19}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

const INTERVAL_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60 * 1_000,
  h: 60 * 60 * 1_000,
  d: MS_PER_DAY,
  w: MS_PER_WEEK,
};

export function validateDestinationChatId(destination: string): string {
  if (typeof destination !== "string") {
    throw new ScheduleParseError("Destination chat ID must be a string");
  }
  const trimmed = destination.trim();
  if (!DESTINATION_CHAT_ID_RE.test(trimmed)) {
    throw new ScheduleParseError(
      `Invalid destination chat ID "${destination}": expected non-zero numeric ID or @channel handle`,
    );
  }
  return trimmed;
}

function resolveIntervalBounds(bounds: ChatDigestBounds = {}): {
  minIntervalMs: number;
  maxIntervalMs: number;
} {
  const minIntervalMs = bounds.minIntervalMs ?? MIN_CHAT_DIGEST_INTERVAL_MS;
  const maxIntervalMs = bounds.maxIntervalMs ?? MAX_CHAT_DIGEST_INTERVAL_MS;
  if (
    !Number.isInteger(minIntervalMs) ||
    !Number.isInteger(maxIntervalMs) ||
    minIntervalMs < 1_000 ||
    maxIntervalMs < minIntervalMs
  ) {
    throw new ScheduleParseError(
      `Invalid chat digest interval bounds [${minIntervalMs}, ${maxIntervalMs}]`,
    );
  }
  return { minIntervalMs, maxIntervalMs };
}

/**
 * Validate a bounded per-destination digest interval in milliseconds.
 */
export function parseChatDigestIntervalMs(
  spec: number | string,
  bounds: ChatDigestBounds = {},
): number {
  const { minIntervalMs, maxIntervalMs } = resolveIntervalBounds(bounds);
  let intervalMs: number;

  if (typeof spec === "number") {
    if (!Number.isInteger(spec)) {
      throw new ScheduleParseError("Digest interval must be an integer number of milliseconds");
    }
    intervalMs = spec;
  } else if (typeof spec === "string") {
    const raw = spec.trim().replace(/^every@/i, "").trim();
    const match = /^(\d+)(ms|s|m|h|d|w)?$/i.exec(raw);
    if (!match) {
      throw new ScheduleParseError(
        `Invalid digest interval "${spec}": expected duration such as "every@15m", "1h", or "1d"`,
      );
    }
    const count = Number(match[1]);
    const unit = (match[2] ?? "ms").toLowerCase();
    const mult = INTERVAL_UNIT_MS[unit];
    if (!Number.isFinite(count) || mult === undefined) {
      throw new ScheduleParseError(`Invalid digest interval "${spec}"`);
    }
    intervalMs = count * mult;
  } else {
    throw new ScheduleParseError("Digest interval must be a string or millisecond integer");
  }

  if (intervalMs < minIntervalMs || intervalMs > maxIntervalMs) {
    throw new ScheduleParseError(
      `Digest interval ${intervalMs}ms is outside allowed bounds [${minIntervalMs}ms, ${maxIntervalMs}ms]`,
    );
  }
  return intervalMs;
}

/**
 * Parse and validate a per-chat digest scheduling preference (`"immediate"`,
 * `"daily@HH:mm"`, `"weekly@day HH:mm"`, `"every@<duration>"`, or integer `ms`).
 */
export function parseChatDigestPreference(
  destination: string,
  spec: number | string,
  bounds: ChatDigestBounds = {},
): ChatDigestPreference {
  const validDest = validateDestinationChatId(destination);
  const { minIntervalMs, maxIntervalMs } = resolveIntervalBounds(bounds);

  if (typeof spec === "string") {
    const trimmed = spec.trim();
    if (/^immediate$/i.test(trimmed)) {
      return { destination: validDest, mode: "immediate", spec: "immediate" };
    }
    if (/^(?:daily|weekly)@/i.test(trimmed)) {
      const schedule = parseSchedule(trimmed);
      const effectiveSpan = schedule.kind === "weekly" ? MS_PER_WEEK : MS_PER_DAY;
      if (effectiveSpan < minIntervalMs || effectiveSpan > maxIntervalMs) {
        throw new ScheduleParseError(
          `Schedule "${trimmed}" (${effectiveSpan}ms) is outside allowed bounds [${minIntervalMs}ms, ${maxIntervalMs}ms]`,
        );
      }
      return {
        destination: validDest,
        mode: "schedule",
        schedule,
        spec: trimmed.toLowerCase(),
      };
    }
  }

  const intervalMs = parseChatDigestIntervalMs(spec, { minIntervalMs, maxIntervalMs });
  const canonicalSpec =
    typeof spec === "string" && spec.trim().length > 0
      ? spec.trim().toLowerCase()
      : `${intervalMs}ms`;
  return {
    destination: validDest,
    mode: "interval",
    intervalMs,
    spec: canonicalSpec,
  };
}

/**
 * Compute the next UTC millisecond timestamp when `preference` is due to flush,
 * or `null` when `preference.mode === "immediate"`.
 */
export function nextChatDigestFlushMs(
  preference: ChatDigestPreference,
  lastFlushMs: number | null,
  nowMs: number,
): number | null {
  if (!Number.isFinite(nowMs)) {
    throw new ScheduleParseError("nowMs must be a finite number");
  }
  if (preference.mode === "immediate") return null;
  const anchor = lastFlushMs ?? nowMs;
  if (preference.mode === "schedule" && preference.schedule) {
    return nextRun(preference.schedule, anchor);
  }
  if (preference.mode === "interval" && preference.intervalMs !== undefined) {
    return anchor + preference.intervalMs;
  }
  throw new ScheduleParseError(`Malformed chat digest preference for ${preference.destination}`);
}

export interface PersistedChatDigestEntry {
  spec: string;
  lastFlushMs: number | null;
}

export class FileChatDigestPreferencesStore {
  private readonly bounds: ChatDigestBounds;
  private readonly maxDestinations: number;

  constructor(
    private readonly filePath: string,
    options: ChatDigestBounds & { maxDestinations?: number } = {},
  ) {
    this.bounds = {
      minIntervalMs: options.minIntervalMs,
      maxIntervalMs: options.maxIntervalMs,
    };
    this.maxDestinations = Math.max(
      1,
      options.maxDestinations ?? DEFAULT_MAX_CHAT_DIGEST_DESTINATIONS,
    );
  }

  async load(): Promise<Map<string, { preference: ChatDigestPreference; lastFlushMs: number | null }>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
      throw err;
    }
    const trimmed = raw.trim();
    if (!trimmed) return new Map();

    const parsed = JSON.parse(trimmed) as {
      version?: unknown;
      chats?: Record<string, PersistedChatDigestEntry>;
    };
    if (parsed?.version !== 1 || typeof parsed.chats !== "object" || parsed.chats === null) {
      throw new ScheduleParseError("Unsupported chat digest preferences file schema");
    }

    const entries = Object.entries(parsed.chats);
    if (entries.length > this.maxDestinations) {
      throw new ScheduleParseError(
        `Chat digest preferences count (${entries.length}) exceeds limit (${this.maxDestinations})`,
      );
    }

    const result = new Map<
      string,
      { preference: ChatDigestPreference; lastFlushMs: number | null }
    >();
    for (const [dest, item] of entries) {
      const preference = parseChatDigestPreference(dest, item.spec, this.bounds);
      const lastFlushMs =
        typeof item.lastFlushMs === "number" && Number.isFinite(item.lastFlushMs)
          ? item.lastFlushMs
          : null;
      result.set(preference.destination, { preference, lastFlushMs });
    }
    return result;
  }

  async setPreference(
    destination: string,
    spec: number | string,
    seededAtMs: number | null = null,
  ): Promise<ChatDigestPreference> {
    const preference = parseChatDigestPreference(destination, spec, this.bounds);
    const current = await this.load();
    if (!current.has(preference.destination) && current.size >= this.maxDestinations) {
      throw new ScheduleParseError(
        `Cannot exceed maximum configured chat digest destinations (${this.maxDestinations})`,
      );
    }
    const existing = current.get(preference.destination);
    current.set(preference.destination, {
      preference,
      lastFlushMs: seededAtMs ?? existing?.lastFlushMs ?? null,
    });
    await this.persist(current);
    return preference;
  }

  async recordFlush(destination: string, flushedAtMs: number): Promise<void> {
    const validDest = validateDestinationChatId(destination);
    const current = await this.load();
    const existing = current.get(validDest);
    if (!existing) return;
    existing.lastFlushMs = flushedAtMs;
    await this.persist(current);
  }

  private async persist(
    map: Map<string, { preference: ChatDigestPreference; lastFlushMs: number | null }>,
  ): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const chats: Record<string, PersistedChatDigestEntry> = {};
    for (const [dest, value] of map.entries()) {
      chats[dest] = {
        spec: value.preference.spec,
        lastFlushMs: value.lastFlushMs,
      };
    }
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, chats }, null, 2)}\n`, "utf-8");
    await fs.rename(tmp, this.filePath);
  }
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
