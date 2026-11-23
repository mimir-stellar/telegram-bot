import { promises as fs } from "node:fs";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { DigestPeriodCompleteness } from "./digest-grouping.js";

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

/**
 * Bounds for per-destination digest intervals. A digest interval must be at
 * least one minute and at most one week so a misconfigured destination cannot
 * either spam every poll cycle or silently stall for months.
 */
export const MIN_DIGEST_INTERVAL_MS = 60 * 1000;
export const MAX_DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Validate a digest interval (in milliseconds) for a destination.
 * Throws {@link ScheduleParseError} when the value is non-finite, non-integer,
 * or outside [MIN_DIGEST_INTERVAL_MS, MAX_DIGEST_INTERVAL_MS].
 */
export function validateDigestIntervalMs(intervalMs: number): number {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || !Number.isInteger(intervalMs)) {
    throw new ScheduleParseError("Digest interval must be a finite integer number of milliseconds");
  }
  if (intervalMs < MIN_DIGEST_INTERVAL_MS || intervalMs > MAX_DIGEST_INTERVAL_MS) {
    throw new ScheduleParseError(
      `Digest interval ${intervalMs}ms is out of bounds: must be between ${MIN_DIGEST_INTERVAL_MS}ms (1 minute) and ${MAX_DIGEST_INTERVAL_MS}ms (1 week)`,
    );
  }
  return intervalMs;
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

export interface UtcPeriod {
  /** Inclusive start of the UTC period in epoch milliseconds. */
  startMs: number;
  /** Exclusive end of the UTC period in epoch milliseconds. */
  endMs: number;
  /** ISO-8601 UTC timestamp for `startMs`. */
  startIso: string;
  /** ISO-8601 UTC timestamp for `endMs`. */
  endIso: string;
}

/**
 * Compute the explicit UTC period `[startMs, endMs)` containing `atMs` for
 * the given `schedule` (start-inclusive, end-exclusive).
 *
 * All calculations use UTC epoch milliseconds and ISO-8601 UTC strings so
 * results are deterministic across host time zones.
 */
export function utcPeriodFor(schedule: Schedule, atMs: number): UtcPeriod {
  if (!Number.isFinite(atMs)) {
    throw new ScheduleParseError("atMs must be a finite number");
  }
  const dayStart = startOfUtcDay(atMs);
  let startMs: number;
  let endMs: number;

  if (schedule.kind === "daily") {
    const todayRun = dayStart + schedule.minuteOfDay * 60 * 1000;
    if (todayRun <= atMs) {
      startMs = todayRun;
      endMs = todayRun + MS_PER_DAY;
    } else {
      startMs = todayRun - MS_PER_DAY;
      endMs = todayRun;
    }
  } else {
    const targetDay = schedule.dayOfWeek;
    if (targetDay === undefined) {
      throw new ScheduleParseError("Weekly schedule is missing dayOfWeek");
    }
    const currentDay = utcWeekday(atMs);
    const dayDelta = (targetDay - currentDay + 7) % 7;
    const candidate = dayStart + dayDelta * MS_PER_DAY + schedule.minuteOfDay * 60 * 1000;
    if (candidate <= atMs) {
      startMs = candidate;
      endMs = candidate + MS_PER_WEEK;
    } else {
      startMs = candidate - MS_PER_WEEK;
      endMs = candidate;
    }
  }

  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
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

export interface ScheduledRunContext {
  /**
   * True when this run was triggered on `start()` to catch up after a restart
   * missed one or more scheduled boundaries; false for normal on-time ticks.
   */
  afterRestart: boolean;
  /**
   * Digest period completeness metadata derived from scheduler state.
   * Marked incomplete with reason `"restart"` when `afterRestart` is true.
   */
  completeness: DigestPeriodCompleteness;
}

export interface SchedulerOptions {
  schedule: Schedule | string;
  run: (atMs: number, context: ScheduledRunContext) => Promise<void> | void;
  clock?: SchedulerClock;
  lastRunStore: LastRunStore;
  digestStore?: DigestDeliveryStore;
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
  const { run, lastRunStore, quietHours } = options;

  let timer: unknown = null;
  let stopped = true;
  let chain = Promise.resolve();

  const scheduleNext = (deferredAtMs?: number) => {
    const now = clock.now();
    const next =
      deferredAtMs !== undefined && quietHours
        ? nextAllowedWindowStart(quietHours, deferredAtMs)
        : nextAllowedRun(schedule, now, quietHours);
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
    let deferredAtMs: number | undefined;
    try {
      const now = clock.now();
      const last = await lastRunStore.read();
      // Fire at most once for any missed runs since the last recorded run.
      // With no recorded run there is nothing missed: a first start waits for
      // the next boundary instead of firing early (and then again at it).
      const shouldFire = last === null ? atBoundary : nextRun(schedule, last) <= now;
      if (shouldFire) {
        const afterRestart = !atBoundary;
        const context: ScheduledRunContext = {
          afterRestart,
          completeness: afterRestart
            ? { complete: false, reasons: ["restart"] }
            : { complete: true, reasons: [] },
        };
        await run(nextRun(schedule, last ?? now - 1), context);
        await lastRunStore.write(now);
      }
    } catch (err) {
      console.error("[scheduler] run failed:", err);
    } finally {
      if (!stopped) {
        scheduleNext(deferredAtMs);
      }
    }
  };

  return {
    async start() {
      if (!stopped) return;
      stopped = false;
      if (options.digestStore) {
        try {
          const incomplete = await options.digestStore.loadIncompleteDigests();
          if (incomplete.length > 0) {
            console.warn(
              `[scheduler] found ${incomplete.length} partially delivered digest(s) after restart: ${incomplete.join(", ")}`,
            );
          }
        } catch (err) {
          console.error("[scheduler] failed to inspect incomplete digests:", err);
        }
      }
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

// ── Multi-Page Digest Delivery & Recovery ─────────────────────────────────────

/**
 * Status of a single page delivery to a destination.
 *
 * - `pending`: Delivery has not yet been attempted.
 * - `in_flight`: Intent persisted to disk and send is currently in progress.
 * - `confirmed`: Send acknowledged and confirmed on disk.
 * - `uncertain`: Send was in_flight when the process crashed/restarted; delivery outcome is unconfirmed.
 * - `failed`: Send threw an error.
 */
export type PageOutcomeStatus = "pending" | "in_flight" | "confirmed" | "uncertain" | "failed";

export interface PageOutcomeRecord {
  digestId: string;
  destination: string;
  pageIndex: number;
  totalPages: number;
  status: PageOutcomeStatus;
  at: number;
  error?: string;
}

export interface UncertainSend {
  digestId: string;
  destination: string;
  pageIndex: number;
  totalPages: number;
  at: number;
}

export interface DigestDeliveryReport {
  digestId: string;
  totalPages: number;
  destinations: string[];
  skippedConfirmed: Array<{ destination: string; pageIndex: number }>;
  uncertainSends: UncertainSend[];
  deliveredPages: Array<{ destination: string; pageIndex: number }>;
  failedPages: Array<{ destination: string; pageIndex: number; error: string }>;
  completed: boolean;
}

export interface DigestJournalEntry {
  kind: "intent" | "confirmed" | "failed" | "completed";
  digestId: string;
  destination?: string;
  pageIndex?: number;
  totalPages?: number;
  error?: string;
  at: number;
}

export interface DigestDeliveryStore {
  recordPageIntent(entry: {
    digestId: string;
    destination: string;
    pageIndex: number;
    totalPages: number;
    at?: number;
  }): Promise<void>;

  recordPageConfirmed(entry: {
    digestId: string;
    destination: string;
    pageIndex: number;
    totalPages: number;
    at?: number;
  }): Promise<void>;

  recordPageFailed(entry: {
    digestId: string;
    destination: string;
    pageIndex: number;
    totalPages: number;
    error: string;
    at?: number;
  }): Promise<void>;

  loadDigestOutcomes(digestId: string): Promise<Map<string, Map<number, PageOutcomeRecord>>>;

  loadIncompleteDigests(): Promise<string[]>;

  markDigestComplete(digestId: string): Promise<void>;

  stats?(): Promise<{ entries: number; bytes: number }>;

  compact?(): Promise<void>;
}

export interface FileDigestDeliveryStoreOptions {
  filePath: string;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
}

export const DEFAULT_DIGEST_DELIVERY_MAX_ENTRIES = 2_000;
export const DEFAULT_DIGEST_DELIVERY_MAX_BYTES = 2_000_000;

export class FileDigestDeliveryStore implements DigestDeliveryStore {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: FileDigestDeliveryStoreOptions | string) {
    if (typeof options === "string") {
      this.filePath = options;
      this.maxEntries = DEFAULT_DIGEST_DELIVERY_MAX_ENTRIES;
      this.maxBytes = DEFAULT_DIGEST_DELIVERY_MAX_BYTES;
      this.now = Date.now;
    } else {
      this.filePath = options.filePath;
      this.maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_DIGEST_DELIVERY_MAX_ENTRIES);
      this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_DIGEST_DELIVERY_MAX_BYTES);
      this.now = options.now ?? Date.now;
    }
    this.dir = path.dirname(this.filePath);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async append(entry: DigestJournalEntry): Promise<void> {
    await this.ensureDir();
    const handle = await open(this.filePath, "a");
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async readLines(): Promise<DigestJournalEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    const out: DigestJournalEntry[] = [];
    for (const ln of raw.split("\n")) {
      const trimmed = ln.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as DigestJournalEntry);
      } catch {
        // Skip corrupt or torn lines safely
      }
    }
    return out;
  }

  private async persist(entries: DigestJournalEntry[]): Promise<void> {
    await this.ensureDir();
    const tmp = `${this.filePath}.tmp`;
    const handle = await open(tmp, "w");
    try {
      for (const entry of entries) {
        await handle.write(`${JSON.stringify(entry)}\n`);
      }
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(tmp, this.filePath);
    try {
      const dirHandle = await open(this.dir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => {});
      }
    } catch {
      // Best-effort directory sync
    }
  }

  async recordPageIntent(entry: {
    digestId: string;
    destination: string;
    pageIndex: number;
    totalPages: number;
    at?: number;
  }): Promise<void> {
    await this.append({
      kind: "intent",
      digestId: entry.digestId,
      destination: entry.destination,
      pageIndex: entry.pageIndex,
      totalPages: entry.totalPages,
      at: entry.at ?? this.now(),
    });
  }

  async recordPageConfirmed(entry: {
    digestId: string;
    destination: string;
    pageIndex: number;
    totalPages: number;
    at?: number;
  }): Promise<void> {
    await this.append({
      kind: "confirmed",
      digestId: entry.digestId,
      destination: entry.destination,
      pageIndex: entry.pageIndex,
      totalPages: entry.totalPages,
      at: entry.at ?? this.now(),
    });
  }

  async recordPageFailed(entry: {
    digestId: string;
    destination: string;
    pageIndex: number;
    totalPages: number;
    error: string;
    at?: number;
  }): Promise<void> {
    await this.append({
      kind: "failed",
      digestId: entry.digestId,
      destination: entry.destination,
      pageIndex: entry.pageIndex,
      totalPages: entry.totalPages,
      error: entry.error,
      at: entry.at ?? this.now(),
    });
  }

  async loadDigestOutcomes(digestId: string): Promise<Map<string, Map<number, PageOutcomeRecord>>> {
    const entries = await this.readLines();
    const outcomes = new Map<string, Map<number, PageOutcomeRecord>>();
    let isCompleted = false;

    for (const entry of entries) {
      if (entry.digestId !== digestId) continue;
      if (entry.kind === "completed") {
        isCompleted = true;
        continue;
      }

      const destination = entry.destination;
      const pageIndex = entry.pageIndex;
      if (typeof destination !== "string" || typeof pageIndex !== "number") continue;

      let destMap = outcomes.get(destination);
      if (!destMap) {
        destMap = new Map<number, PageOutcomeRecord>();
        outcomes.set(destination, destMap);
      }

      if (entry.kind === "intent") {
        if (!destMap.has(pageIndex)) {
          destMap.set(pageIndex, {
            digestId,
            destination,
            pageIndex,
            totalPages: entry.totalPages ?? 0,
            status: "uncertain",
            at: entry.at,
          });
        }
      } else if (entry.kind === "confirmed") {
        destMap.set(pageIndex, {
          digestId,
          destination,
          pageIndex,
          totalPages: entry.totalPages ?? 0,
          status: "confirmed",
          at: entry.at,
        });
      } else if (entry.kind === "failed") {
        destMap.set(pageIndex, {
          digestId,
          destination,
          pageIndex,
          totalPages: entry.totalPages ?? 0,
          status: "failed",
          error: entry.error,
          at: entry.at,
        });
      }
    }

    if (isCompleted) {
      for (const destMap of outcomes.values()) {
        for (const rec of destMap.values()) {
          rec.status = "confirmed";
        }
      }
    }

    return outcomes;
  }

  async loadIncompleteDigests(): Promise<string[]> {
    const entries = await this.readLines();
    const allDigests = new Set<string>();
    const completedDigests = new Set<string>();

    for (const entry of entries) {
      if (entry.digestId) {
        allDigests.add(entry.digestId);
        if (entry.kind === "completed") {
          completedDigests.add(entry.digestId);
        }
      }
    }

    const incomplete: string[] = [];
    for (const id of allDigests) {
      if (!completedDigests.has(id)) {
        incomplete.push(id);
      }
    }
    return incomplete;
  }

  async stats(): Promise<{ entries: number; bytes: number }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { entries: 0, bytes: 0 };
      }
      throw err;
    }
    let entries = 0;
    for (const ln of raw.split("\n")) {
      if (ln.trim() !== "") entries += 1;
    }
    return { entries, bytes: Buffer.byteLength(raw, "utf-8") };
  }

  async markDigestComplete(digestId: string): Promise<void> {
    await this.append({
      kind: "completed",
      digestId,
      at: this.now(),
    });
    const s = await this.stats();
    if (s.entries > this.maxEntries || s.bytes > this.maxBytes) {
      await this.compact();
    }
  }

  async compact(): Promise<void> {
    const entries = await this.readLines();
    const completedDigests = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "completed") {
        completedDigests.add(entry.digestId);
      }
    }
    const retained = entries.filter((e) => !completedDigests.has(e.digestId));
    await this.persist(retained);
  }
}

export interface MultiPageDigestPayload<T = string> {
  id: string;
  pages: readonly T[];
}

export interface DeliverMultiPageDigestOptions<T = string> {
  digest: MultiPageDigestPayload<T>;
  destinations: readonly string[];
  store: DigestDeliveryStore;
  sendPage: (destination: string, page: T, pageIndex: number, totalPages: number) => Promise<void>;
  onUncertainSend?: (uncertain: UncertainSend) => void | Promise<void>;
  now?: () => number;
}

/**
 * Deliver a multi-page digest across one or more destinations with crash-safe recovery.
 *
 * Page-level outcomes are recorded per destination before and after each send.
 * On restart:
 * - Confirmed pages are skipped and never resent.
 * - Uncertain sends (in-flight when the process terminated) are reported and not duplicated.
 * - Unsent/pending pages are delivered.
 */
export async function deliverMultiPageDigest<T = string>(
  options: DeliverMultiPageDigestOptions<T>,
): Promise<DigestDeliveryReport> {
  const { digest, destinations, store, sendPage, onUncertainSend } = options;
  const now = options.now ?? Date.now;
  const totalPages = digest.pages.length;

  const report: DigestDeliveryReport = {
    digestId: digest.id,
    totalPages,
    destinations: [...destinations],
    skippedConfirmed: [],
    uncertainSends: [],
    deliveredPages: [],
    failedPages: [],
    completed: false,
  };

  if (totalPages === 0 || destinations.length === 0) {
    if (totalPages === 0 && destinations.length > 0) {
      await store.markDigestComplete(digest.id);
    }
    report.completed = true;
    return report;
  }

  const outcomes = await store.loadDigestOutcomes(digest.id);

  for (const destination of destinations) {
    const destOutcomes = outcomes.get(destination);

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const priorOutcome = destOutcomes?.get(pageIndex);

      if (priorOutcome?.status === "confirmed") {
        report.skippedConfirmed.push({ destination, pageIndex });
        continue;
      }

      if (priorOutcome?.status === "uncertain") {
        const uncertain: UncertainSend = {
          digestId: digest.id,
          destination,
          pageIndex,
          totalPages,
          at: priorOutcome.at,
        };
        report.uncertainSends.push(uncertain);
        if (onUncertainSend) {
          await onUncertainSend(uncertain);
        }
        continue;
      }

      const page = digest.pages[pageIndex];
      if (page === undefined) continue;

      await store.recordPageIntent({
        digestId: digest.id,
        destination,
        pageIndex,
        totalPages,
        at: now(),
      });

      try {
        await sendPage(destination, page, pageIndex, totalPages);
        await store.recordPageConfirmed({
          digestId: digest.id,
          destination,
          pageIndex,
          totalPages,
          at: now(),
        });
        report.deliveredPages.push({ destination, pageIndex });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await store.recordPageFailed({
          digestId: digest.id,
          destination,
          pageIndex,
          totalPages,
          error: errorMsg,
          at: now(),
        });
        report.failedPages.push({ destination, pageIndex, error: errorMsg });
      }
    }
  }

  if (report.failedPages.length === 0) {
    await store.markDigestComplete(digest.id);
    report.completed = true;
  }

  return report;
}

export interface RecoverMultiPageDigestOptions<T = string> {
  digest: MultiPageDigestPayload<T>;
  destinations: readonly string[];
  store: DigestDeliveryStore;
  sendPage?: (destination: string, page: T, pageIndex: number, totalPages: number) => Promise<void>;
  onUncertainSend?: (uncertain: UncertainSend) => void | Promise<void>;
  now?: () => number;
}

/**
 * Recover a partially delivered multi-page digest after restart.
 *
 * If `sendPage` is provided, resumes delivering remaining pages while skipping
 * confirmed pages and reporting uncertain sends. If omitted, performs a non-sending
 * inspection of the recovery state.
 */
export async function recoverMultiPageDigest<T = string>(
  options: RecoverMultiPageDigestOptions<T>,
): Promise<DigestDeliveryReport> {
  if (options.sendPage) {
    return deliverMultiPageDigest({
      digest: options.digest,
      destinations: options.destinations,
      store: options.store,
      sendPage: options.sendPage,
      onUncertainSend: options.onUncertainSend,
      now: options.now,
    });
  }

  const { digest, destinations, store, onUncertainSend } = options;
  const totalPages = digest.pages.length;
  const outcomes = await store.loadDigestOutcomes(digest.id);

  const report: DigestDeliveryReport = {
    digestId: digest.id,
    totalPages,
    destinations: [...destinations],
    skippedConfirmed: [],
    uncertainSends: [],
    deliveredPages: [],
    failedPages: [],
    completed: false,
  };

  let allConfirmed = true;

  for (const destination of destinations) {
    const destOutcomes = outcomes.get(destination);

    for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
      const prior = destOutcomes?.get(pageIndex);
      if (prior?.status === "confirmed") {
        report.skippedConfirmed.push({ destination, pageIndex });
      } else if (prior?.status === "uncertain") {
        allConfirmed = false;
        const unc: UncertainSend = {
          digestId: digest.id,
          destination,
          pageIndex,
          totalPages,
          at: prior.at,
        };
        report.uncertainSends.push(unc);
        if (onUncertainSend) {
          await onUncertainSend(unc);
        }
      } else {
        allConfirmed = false;
        if (prior?.status === "failed") {
          report.failedPages.push({ destination, pageIndex, error: prior.error ?? "unknown error" });
        }
      }
    }
  }

  report.completed = allConfirmed && totalPages > 0 && destinations.length > 0;
  return report;
}
