/**
 * The poll loop: read new contract events, notify, persist the cursor.
 *
 * ── Failure policy ───────────────────────────────────────────────────────────
 *
 * This process is meant to stay up for weeks. Nothing in one cycle may end it
 * *unless* a supervisor is present and the failure count crosses the configured
 * threshold, at which point a deliberate exit (code 3) hands control back to
 * the supervisor for a clean restart with fresh connections and reset state.
 *
 *  - A failed RPC call fails ONE contract's scan for ONE cycle. Its cursor is
 *    left untouched, so the next cycle picks up exactly where it stopped.
 *  - Each contract is paced independently. A slow or failing contract does not
 *    block the scanning of other contracts.
 *  - A scan cursor is committed after its returned page has been processed,
 *    even when delivery was partial. Unknown events, the per-cycle cap, and
 *    exhausted Telegram retries are deliberate drops. Holding the cursor back
 *    would turn a broken token or chat into an infinite replay, and recovery
 *    would flood the channel. Notifications are lossy by design; the chain
 *    remains the record.
 *  - A cursor file that cannot be read or fails schema validation is
 *    quarantined beside the live path (`*.corrupt.<timestamp>`) and treated as
 *    a cold start; one that cannot be written is logged, and the in-memory
 *    cursor keeps working until the next restart.
 *  - Legacy (unversioned / flat) cursor files are migrated in-place to the
 *    current versioned schema on load; unknown future versions are rejected
 *    so a downgrade cannot silently mis-read a newer file.
 *  - A second process that tries to start against the same lock file is refused
 *    up front. Concurrent instances would race the cursor and double-notify.
 *  - A graceful shutdown (`poller.shutdown()`) stops scheduling, drops the
 *    notifications that have not been sent yet, waits a bounded time for the
 *    in-flight cycle, and flushes cursors that are still only in memory. The
 *    process then exits with the file matching what a restart resumes from.
 *  - A cursor that fell below the RPC's retained window ("stale cursor") is
 *    rewound to the retained floor once a fresh `getHealth()` *proves* the
 *    cursor sits below it. Everything below the floor is already gone, so
 *    keeping the cursor would fail every scan forever; rewinding resumes from
 *    the oldest ledger the RPC still serves. The rewind is bounded (at most
 *    `MAX_FLOOR_REWINDS` consecutive attempts, then an operator must act) and
 *    never guesses: an opaque cursor, an ahead-of-tip cursor, or a window that
 *    cannot be read is left untouched and the bounded RPC error is surfaced.
 *    The miss below the floor is logged as a bounded ledger count, never as a
 *    remote payload.
 *
 * ── Event ordering ─────────────────────────────────────────────────────────
 *
 * Events are notified in deterministic chain order (ledger → transaction
 * index → operation index → RPC paging token), not in RPC array order, so a
 * page split or a retry never reorders the channel. Within one scan,
 * duplicate paging tokens (the RPC may repeat a page-boundary event) notify
 * once. Restarting replays nothing already consumed: the persisted cursor is
 * the only resume token, in the same `version: 1` format as before.
 */

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

import type { rpc } from "@stellar/stellar-sdk";

import {
  ActivityBaseline,
  type ActivityBaselineOptions,
  type ActivityBaselineSnapshot,
} from "./activity-baseline.js";
import type { Metrics } from "./metrics.js";
import {
  NotificationAge,
  type NotificationAgeSummary,
  type NotificationIngestionMark,
} from "./stellar/metrics.js";
import type { SendExtra } from "./bot.js";
import { createCategoryCounter } from "./commands/categories.js";
import { appendAuditFile, auditEntry, createAuditLog, type AuditLog } from "./audit.js";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, type BotConfig } from "./config.js";
import { EventDedupWindow } from "./dedup.js";
import {
  createDeadLetterQueue,
  DEAD_LETTER_MAX_AGE_MS,
  DEAD_LETTER_MAX_ATTEMPTS,
  DEAD_LETTER_MAX_ENTRIES,
  type DeadLetterStats,
} from "./deadLetter.js";
import {
  createSendJournal,
  type OrphanDecision,
  type OrphanedJournalEntry,
  type SendJournal,
} from "./notifications/send-journal.js";
import { InvalidDeliveryResultError } from "./notifications/notifier.js";
import {
  acquireInstanceLock,
  InstanceLockError,
  type InstanceLockHandle,
} from "./instanceLock.js";
import {
  clip,
  explorerKeyboard,
  formatDigestPages,
  formatEvent,
  formatPlainTextEvent,
  safeErrorMessage,
} from "./notifications/format.js";
import {
  createDigestCheckpoint,
  DEFAULT_DIGEST_MAX_PENDING,
  type DigestCheckpoint,
} from "./notifications/digest-checkpoint.js";
import {
  createScheduler,
  type Scheduler,
  type SchedulerClock,
} from "./notifications/schedule.js";
import { formatSuppressedRepeats, LogSampler } from "./log-sampler.js";
import { Logger } from "./logger.js";
import { isNotificationAllowed } from "./notifications/featureFlags.js";
import { classifyPermanentSendError } from "./notifications/notifier.js";
import { buildStatusSnapshot, writeStatusFile, type StatusSnapshot } from "./status.js";
import { normalizeRpcEndpoint, validateLedgerWindow, type LedgerWindow } from "./stellar/client.js";
import {
  DEFAULT_CIRCUIT_COOLDOWN_MS,
  DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  RpcCircuitBreaker,
  type CircuitBreakerState,
} from "./stellar/rpc-guard.js";
import { LedgerCache } from "./stellar/ledger-cache.js";
import {
  RpcLatencyHistogram,
  type RpcLatencySnapshot,
} from "./stellar/metrics.js";
import {
  eventCursorLedger,
  readContractEvents,
  resumeCursorProblem,
  type WatchTarget,
} from "./stellar/events.js";
import {
  isAdminPayload,
  normalizeContractVersion,
  toAdminAuditRecord,
  isContractVersionSupported,
  validateDecoderCombinations,
  getDecoderCapabilityReport,
  type ContractSource,
  type DecodedEvent,
  type DecoderCapabilityReport,
} from "./stellar/decode.js";
import { RecentEventStore, type CanonicalEventSummary } from "./commands/events.js";

export interface TargetState {
  source: ContractSource;
  contractId: string;
  version: string;
  /** Whether the configured contract version is supported by the decoder subsystem. */
  supportedVersion?: boolean;
  /** Duration of this target's most recent attempted fetch-decode-send cycle. */
  lastCycleMs: number;
  /** Longest attempted cycle for this target since process start. */
  maxCycleMs: number;
  cursor: string | null;
  /** Highest ledger an event was seen in, from this run or the cursor file. */
  lastEventLedger: number | null;
  /**
   * Set only while this target is resuming from the RPC's retained floor after
   * a stale cursor: the ledger the next scan starts from instead of `cursor`.
   * Cleared once a scan returns a fresh resume cursor, and persisted so a
   * restart mid-rewind keeps reading from the floor rather than cold-starting.
   */
  rewindFromLedger: number | null;
  /** RPC has rejected this target's cursor as stale; clears after a successful scan. */
  cursorStale: boolean;
  /**
   * Ledgers whose events were lost when a stale cursor was rewound to the
   * retained floor. `0` until a restart gap is detected for this target.
   */
  gapLedgers: number;
  /**
   * When this target's stale cursor was last rewound to the floor, or `null`
   * if that has never happened for this target.
   */
  cursorResetAt: number | null;
  /**
   * A cursor is persisted but no ledger can be read out of it. The position
   * is left untouched — the RPC's token is opaque by design, so failing to
   * read a ledger from it here is not evidence the RPC will reject it — and
   * it is surfaced so "cannot be placed" and "inside the window" never
   * look alike.
   */
  cursorUnreadable: boolean;
  lastError: string | null;
  /**
   * Consecutive successful cycles in which this target's cursor did not move
   * while the cursor was still behind the tip. Reset the moment the cursor
   * advances or catches up, so sitting idle at the tip never counts.
   */
  cyclesWithoutAdvance: number;
  /** True once {@link CURSOR_STALL_CYCLES} non-advancing cycles have fired. */
  cursorStalled: boolean;
  /** Number of consecutive RPC failures for this specific target. */
  consecutiveFailures: number;
  /** Timestamp (unix ms) before which this target will skip RPC scanning. */
  nextEligibleAt: number | null;
  /** Bounded description of this target's most recent send timeout, when tracked. */
  lastSendTimeout?: string | null;
  /** Newest event observed for this target since start, for `/last-event`. */
  lastEvent?: DecodedEvent | null;
}

/**
 * A resume position that fell out of the RPC's retained window: the events
 * between the cursor and the retained floor are gone for good.
 */
export interface RestartGap {
  /** When the gap was detected. */
  at: number;
  source: ContractSource;
  /** Ledger the persisted cursor pointed at. */
  cursorLedger: number;
  /** The RPC's retained floor at detection time. */
  oldestLedger: number;
  /** Ledgers whose events are unrecoverable (`oldestLedger - cursorLedger`). */
  missedLedgers: number;
}

/**
 * Format an unrecoverable restart gap alert for the operator as plain text.
 */
export function formatRestartGapAlert(gap: {
  source: ContractSource;
  cursorLedger: number;
  oldestLedger: number;
}): string {
  return (
    `[Restart Gap Alert] Unrecoverable restart gap detected for ${gap.source}.\n` +
    `Missed ledger range: ${gap.cursorLedger} to ${gap.oldestLedger}.\n` +
    `Suggested replay command: npm run replay -- --from ${gap.oldestLedger} --contract ${gap.source} --send`
  );
}

export type PollerPauseResult = "paused" | "already-paused" | "stopped";
export type PollerResumeResult = "resumed" | "already-running" | "stopped";

export interface PollerCounters {
  cycles: number;
  notificationsSent: number;
  notificationsFailed: number;
  eventsSkipped: number;
}

/**
 * Per-target summary fields included in the structured `cycle_summary` log entry.
 *
 * Stable field names (documented for log consumers and alerts):
 * - `source`: `"market" | "squad"` — contract target identifier
 * - `fetched`: number of events returned by the RPC scan for this target in the cycle
 * - `decoded`: number of fetched events with a known decoded payload (`payload.name !== "unknown"`)
 * - `sent`: number of notifications delivered to Telegram for this target in the cycle
 * - `skipped`: number of events skipped for this target in the cycle
 * - `cursorLedger`: ledger number parsed from the target's cursor at the end of the cycle
 *   (`null` when no cursor is held or the cursor is opaque; never the raw cursor string)
 */
export interface CycleTargetSummary {
  source: ContractSource;
  fetched: number;
  decoded: number;
  sent: number;
  skipped: number;
  cursorLedger: number | null;
}

/**
 * Structured JSON fields emitted by `Logger.info("poller", ...)` at the end of each poll cycle.
 *
 * Stable field names (documented for log consumers and alerts):
 * - `action`: always `"cycle_summary"`
 * - `cycle`: 1-based poll cycle number (`PollerStatus.cycles`)
 * - `durationMs`: elapsed duration of the cycle in milliseconds
 * - `targets`: per-target summary keyed by `ContractSource` (`market`, `squad`)
 * - `suppressed`: number of idle-cycle summary lines suppressed in the previous `LogSampler` window
 */
export interface CycleSummaryFields {
  action: "cycle_summary";
  cycle: number;
  durationMs: number;
  targets: Record<ContractSource, CycleTargetSummary>;
  suppressed: number;
}

/** Current on-disk counters schema version. */
export const COUNTERS_SCHEMA_VERSION = 1 as const;

export interface CountersFile {
  version: typeof COUNTERS_SCHEMA_VERSION;
  updatedAt: string;
  contracts: {
    marketContractId: string;
    squadContractId: string;
  };
  counters: PollerCounters;
}

export interface PollerStatus {
  running: boolean;
  /** Operator pause only prevents new cycles; an in-flight cycle may finish. */
  paused: boolean;
  /**
   * A graceful shutdown is in progress: no new cycle starts and notifications
   * that have not been sent yet are dropped rather than retried.
   */
  stopping: boolean;
  /**
   * Chain clock: unix ms close time of the newest chain event this poller has
   * observed. `null` before the first scan returns one.
   *
   * The chain is the source of truth, so this only ever advances from a
   * `ledgerClosedAt` the RPC actually reported. A quiet page, a failed scan, a
   * Telegram outage or an open circuit breaker leaves the last observed value
   * in place: the skew against the local clock then grows on its own, which is
   * exactly what an operator needs to see during a long outage. It is saved
   * with the cursors so a restart resumes the same clock instead of going back
   * to `unknown`.
   */
  chainClockAt: number | null;
  startedAt: number;
  cycles: number;
  /** Correlation ID for the most recently started poll cycle. */
  lastCorrelationId: string | null;
  lastPollAt: number | null;
  lastSuccessAt: number | null;
  latestLedger: number | null;
  oldestLedger: number | null;
  notificationsSent: number;
  notificationsFailed: number;
  /** End-to-end notification age (ledger close -> confirmed send) summary. */
  notificationAge?: NotificationAgeSummary;
  /** Never attempted (unknown, malformed or over the per-cycle cap). */
  eventsSkipped: number;
  /** Counter values accumulated since this process started. */
  sinceStart?: PollerCounters;
  /** Cumulative counter values persisted across restarts for the current contract IDs. */
  cumulative?: PollerCounters;
  /** Cumulative empty getEvents pages across all successful target scans. */
  emptyPages: number;
  /** Cumulative pages walked across all successful target scans. */
  pagesScanned: number;
  /**
   * Rolling comparison of this cycle's event count against recent complete
   * cycles. Updated only when every target was scanned, so a partial cycle is
   * never mistaken for a quiet chain.
   */
  activityBaseline?: ActivityBaselineSnapshot;
  /** Empty pages in the most recent completed cycle (all targets). */
  lastCycleEmptyPages: number;
  /** Pages walked in the most recent completed cycle (all targets). */
  lastCyclePages: number;
  /** Not attempted because a graceful shutdown started first. */
  notificationsDropped: number;
  /** Events suppressed because they had already been processed (dedup). */
  eventsDeduplicated: number;
  /** Cursors automatically rewound to the RPC's retained floor this run. */
  cursorRewinds: number;
  /** Restart gaps detected this run: one per cursor found below the floor. */
  restartGaps: number;
  /** Details of the most recent restart gap, or `null` when none was seen. */
  lastRestartGap: RestartGap | null;
  consecutiveFailures: number;
  lastError: { at: number; message: string } | null;
  /**
   * Chain-tip cache counters for this process. Reset never zeroes them, so they
   * describe the whole run: `hits` should be `cycles × (targets - 1)` while the
   * cache is doing its job.
   */
  ledgerCache: { hits: number; misses: number };
  /** Absolute path of the exclusive instance lock, or null before acquire. */
  lockFile: string | null;
  /** Pid recorded in the lock while this process holds it. */
  lockPid: number | null;
  /** In-memory cursor state is newer than the persisted file. */
  pendingFlush: boolean;
  lastFlushAt: number | null;
  /**
   * Repetitive error lines withheld by the sampler since start. They are
   * summarized in the log rather than dropped; surfaced here for `/status`.
   */
  suppressedLogs: number;
  /** Dead-letter queue counters (see src/deadLetter.ts). */
  deadLetter: DeadLetterStats;
  /** Fixed-provider, fixed-bucket RPC latency snapshot for `/metrics`. */
  rpcLatency?: RpcLatencySnapshot;
  /** Telegram sends abandoned by the per-send timeout, when tracked. */
  sendTimeouts?: number;
  /** Bounded description of the most recent send timeout, when tracked. */
  lastSendTimeout?: string | null;
  /** Result of the startup persistent-volume probe, when reported. */
  persistentVolumeAvailable?: boolean;
  persistentVolumeError?: string | null;
  /** Structured diagnostic for the most recent cursor load failure, if any. */
  cursorLoadError?: CursorLoadError | null;
  targets: TargetState[];
  /** Bounded category counts derived from observed claim_created events. */
  categories?: Record<string, number>;
  /** SHA-256 digest of the SBOM generated for this deployment image. */
  sbomDigest: string | null;
  /** RPC circuit breaker state */
  circuitBreaker: {
    open: boolean;
    openedAt: number | null;
    failureCount: number;
    lastFailureAt: number | null;
    /** Endpoint-specific circuit state (`"closed" | "open" | "half-open"`). */
    state?: CircuitBreakerState;
    /** Normalized RPC endpoint key tracked by this circuit breaker. */
    endpoint?: string;
    /** Number of bounded half-open recovery probes currently in flight. */
    probesInFlight?: number;
  };
}

/** Current on-disk cursor schema. Bump when the shape of `targets` changes. */
export const CURSOR_SCHEMA_VERSION = 1 as const;

/** Maximum number of cursor recovery records retained in the cursor file. */
export const MAX_CURSOR_RECOVERY_HISTORY = 20 as const;

/** Bounded set of reasons a cursor recovery record can carry. */
export type CursorRecoveryReason = "floor_rewind" | "restore" | "quarantine";

/** Minimal cursor position snapshot (never includes event IDs, payloads, or secrets). */
export interface CursorRecoveryPosition {
  cursor: string | null;
  lastEventLedger: number | null;
  rewindFromLedger?: number | null;
}

/** One bounded recovery history record persisted in the cursor file. */
export interface CursorRecoveryRecord {
  /** ISO-8601 UTC timestamp of when the recovery occurred. */
  at: string;
  /** Bounded recovery reason. */
  reason: CursorRecoveryReason;
  /** Target source when a single target was recovered (e.g. floor_rewind). */
  source?: string;
  /** Target positions before recovery. */
  before: Record<string, CursorRecoveryPosition>;
  /** Target positions after recovery. */
  after: Record<string, CursorRecoveryPosition>;
}

export interface CursorFile {
  version: typeof CURSOR_SCHEMA_VERSION;
  updatedAt: string;
  /**
   * Newest observed chain close time (unix ms). Optional and additive: files
   * written before this field existed load as `null`, and older builds ignore
   * it, so the on-disk format stays version 1 either way.
   */
  chainClockAt?: number | null;
  /** Optional network identifier for backup ownership validation. */
  network?: string;
  targets: Record<string, CursorTarget>;
  /**
   * Bounded history of cursor recovery actions (floor rewinds, operator
   * restores, and corrupt-file quarantines), oldest first. Optional and
   * additive: files written before this field existed load with an empty
   * history, and older builds ignore it.
   */
  recoveryHistory?: CursorRecoveryRecord[];
}

interface CursorTarget {
  cursor: string | null;
  lastEventLedger: number | null;
  /** Optional contract identifier for backup ownership validation. */
  contractId?: string;
  /**
   * Recently processed event ids, oldest first. Additive and bounded: older
   * cursor files without it load as an empty window, and new files stay small
   * because the window never grows past `EVENT_DEDUP_WINDOW`.
   */
  recentEventIds?: string[];
  /**
   * Additive and transient: present only while a target is resuming from the
   * RPC's retained floor after a stale cursor. Older builds ignore it, and a
   * malformed value is dropped rather than costing an operator their position.
   */
  rewindFromLedger?: number | null;
  /**
   * SHA-256 fingerprint binding this target's cursor to a specific Stellar
   * network passphrase and contract id. Additive: older cursor files without
   * it are migrated on startup or via `npm run cursor -- migrate`.
   */
  fingerprint?: string;
}

/**
 * Compute a deterministic SHA-256 fingerprint binding a persisted cursor target
 * to its Stellar network passphrase and contract id.
 */
export function computeCursorTargetFingerprint(
  networkPassphrase: string,
  contractId: string,
): string {
  return createHash("sha256")
    .update(`${networkPassphrase}\0${contractId}`)
    .digest("hex");
}

export type CursorTargetEntry = CursorTarget;

/** Where a loaded cursor document came from before normalisation. */
export type CursorSchemaSource =
  | "v1"
  | "legacy-unversioned"
  | "legacy-flat"
  | "legacy-string-map";

export interface CursorMigrateResult {
  file: CursorFile;
  /** True when the on-disk document was rewritten into the current schema. */
  migrated: boolean;
  source: CursorSchemaSource;
}

/**
 * Bounds for a chain close time. Stellar launched in 2015 and the year 2100 is
 * far past this network's horizon, so anything outside that window is a
 * malformed `ledgerClosedAt` rather than chain data. The bound matters because
 * the chain clock is monotonic and persisted: one bogus future value would
 * otherwise be reported for the rest of the process's life, and then survive a
 * restart through the cursor file.
 */
const CHAIN_CLOCK_MIN_MS = Date.UTC(2015, 0, 1);
const CHAIN_CLOCK_MAX_MS = Date.UTC(2100, 0, 1);

function isPlausibleChainClock(ms: number): boolean {
  return Number.isFinite(ms) && ms >= CHAIN_CLOCK_MIN_MS && ms <= CHAIN_CLOCK_MAX_MS;
}

/**
 * Shape check for a saved chain clock: a positive, safe, unix-ms timestamp
 * inside the plausible window above.
 *
 * Anything else (a hand-edited file, an older writer, a truncated write) is
 * dropped and the cursors are kept — a cosmetic field must never cost an
 * operator their resume position. Files written before this field existed
 * are `undefined` and load as `null`, i.e. "no chain clock observed yet".
 */
function parseChainClock(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  return isPlausibleChainClock(value) ? value : null;
}

/**
 * Shape check for a saved floor-rewind position: a positive, safe ledger
 * sequence, or `null` when the target is not resuming from a rewind.
 *
 * Like the chain clock, a malformed value (hand-edited file, truncated write)
 * is dropped rather than failing validation: a transient resume hint must never
 * cost an operator their resume position. Files written before this field
 * existed are `undefined` and load as "no rewind pending".
 */
function parseRewindFromLedger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

const VALID_RECOVERY_REASONS = new Set<CursorRecoveryReason>([
  "floor_rewind",
  "restore",
  "quarantine",
]);

function parseRecoveryPosition(value: unknown): CursorRecoveryPosition | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  let cursor: string | null = null;
  if (obj.cursor === null || obj.cursor === undefined) {
    cursor = null;
  } else if (typeof obj.cursor === "string") {
    if (obj.cursor.length > 256) return null;
    cursor = obj.cursor.length > 0 ? obj.cursor : null;
  } else {
    return null;
  }

  let lastEventLedger: number | null = null;
  if (obj.lastEventLedger === null || obj.lastEventLedger === undefined) {
    lastEventLedger = null;
  } else if (
    typeof obj.lastEventLedger === "number" &&
    Number.isSafeInteger(obj.lastEventLedger) &&
    obj.lastEventLedger >= 0
  ) {
    lastEventLedger = obj.lastEventLedger;
  } else {
    return null;
  }

  const rewindFromLedger = parseRewindFromLedger(obj.rewindFromLedger);
  return {
    cursor,
    lastEventLedger,
    ...(rewindFromLedger !== null ? { rewindFromLedger } : {}),
  };
}

function parseRecoveryPositionMap(value: unknown): Record<string, CursorRecoveryPosition> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, CursorRecoveryPosition> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0 || key.length > 64) return null;
    const pos = parseRecoveryPosition(entry);
    if (pos === null) return null;
    out[key] = pos;
  }
  return out;
}

function sanitizeRecoveryRecord(value: unknown): CursorRecoveryRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.at !== "string" ||
    obj.at.length === 0 ||
    obj.at.length > 64 ||
    Number.isNaN(Date.parse(obj.at))
  ) {
    return null;
  }
  if (typeof obj.reason !== "string" || !VALID_RECOVERY_REASONS.has(obj.reason as CursorRecoveryReason)) {
    return null;
  }
  if (obj.source !== undefined && (typeof obj.source !== "string" || obj.source.length === 0 || obj.source.length > 64)) {
    return null;
  }
  const before = parseRecoveryPositionMap(obj.before);
  const after = parseRecoveryPositionMap(obj.after);
  if (before === null || after === null) return null;

  return {
    at: obj.at,
    reason: obj.reason as CursorRecoveryReason,
    ...(typeof obj.source === "string" ? { source: obj.source } : {}),
    before,
    after,
  };
}

/**
 * Parse and bound a persisted `recoveryHistory` array. Malformed entries are
 * dropped rather than failing cursor load — recovery metadata must never cost
 * an operator their resume position — and any unknown fields (such as event
 * payloads or secrets) are stripped.
 */
export function parseRecoveryHistory(
  value: unknown,
  maxEntries: number = MAX_CURSOR_RECOVERY_HISTORY,
): CursorRecoveryRecord[] {
  if (!Array.isArray(value) || maxEntries <= 0) return [];
  const valid: CursorRecoveryRecord[] = [];
  for (const item of value) {
    const clean = sanitizeRecoveryRecord(item);
    if (clean !== null) valid.push(clean);
  }
  return valid.length > maxEntries ? valid.slice(-maxEntries) : valid;
}

/**
 * Snapshot only the position metadata (cursor, lastEventLedger, optional
 * rewindFromLedger) for a map of targets, excluding event IDs, payloads, and
 * secrets.
 */
export function snapshotCursorPositions(
  targets: Record<string, Pick<CursorTarget, "cursor" | "lastEventLedger" | "rewindFromLedger">>,
): Record<string, CursorRecoveryPosition> {
  const out: Record<string, CursorRecoveryPosition> = {};
  for (const [source, target] of Object.entries(targets)) {
    out[source] = {
      cursor: target.cursor ?? null,
      lastEventLedger: target.lastEventLedger ?? null,
      ...(typeof target.rewindFromLedger === "number"
        ? { rewindFromLedger: target.rewindFromLedger }
        : {}),
    };
  }
  return out;
}

/**
 * Append a recovery record to an existing history, sanitizing all fields and
 * retaining at most `maxEntries` most-recent records.
 */
export function appendCursorRecoveryHistory(
  history: readonly CursorRecoveryRecord[] | undefined,
  record: CursorRecoveryRecord,
  maxEntries: number = MAX_CURSOR_RECOVERY_HISTORY,
): CursorRecoveryRecord[] {
  const existing = parseRecoveryHistory(history ?? [], maxEntries);
  const clean = sanitizeRecoveryRecord(record);
  if (clean === null || maxEntries <= 0) return existing;
  const combined = [...existing, clean];
  return combined.length > maxEntries ? combined.slice(-maxEntries) : combined;
}

/** Tuning knobs for Telegram delivery; defaults suit production, tests shrink them. */
export interface SendOptions {
  sendSpacingMs?: number;
  maxSendRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Per-attempt timeout for a single Telegram send, in milliseconds. A send
   * that does not settle within this window is treated as a failed attempt so
   * one hung HTTP request cannot stall the whole poll cycle. Defaults to
   * {@link DEFAULT_SEND_TIMEOUT_MS}.
   */
  sendTimeoutMs?: number;
}

/**
 * Default per-attempt Telegram send timeout. Chosen to be comfortably longer
 * than a healthy Telegram round trip but short enough that a hung socket is
 * abandoned well before the next poll cycle would be due.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 15_000 as const;

/**
 * How many ledgers a cursor can lag behind the retained floor before the poller
 * warns. Events in the gap are already gone — this threshold makes the operator
 * aware before the lag grows indefinitely.
 *
 * 10 % of the approximate Testnet window (~120 960 ledgers ≈ a week).
 */
const STALE_CURSOR_LEDGER_LAG = 12_096;

/**
 * Consecutive-failure thresholds at which a structured warning is emitted.
 * The thresholds are deliberately non-linear so that short transient glitches
 * (1–4 cycles) are silent, a medium outage (5+) is visible, and a long outage
 * (10+) is highlighted loudly.
 */
const CONSECUTIVE_FAILURE_THRESHOLDS = [5, 10, 25, 50, 100];

export interface PollerDeps {
  config: BotConfig;
  server: rpc.Server;
  /**
   * Optional metrics registry. When provided, the poller increments counters
   * on every observable event. When absent (e.g. in tests that don't need it),
   * the poller behaves identically but emits no metrics.
   */
  metrics?: Metrics | undefined;
  /**
   * Sends one already-formatted MarkdownV2 message to the chat routed for
   * `source`, with the event's explorer button when `extra.reply_markup` is
   * set. May reject.
   */
  send: (text: string, source?: ContractSource, extra?: SendExtra) => Promise<void>;
  /** Receives each decoded event read from the chain, before delivery is attempted. */
  onDecodedEvent?: ((event: DecodedEvent) => void) | undefined;
  /**
   * Optional direct notification hook for the operator (e.g. restart gaps).
   * Plain-text message sent to the operator's private chat.
   */
  notifyOperator?: ((text: string) => Promise<void>) | undefined;
  /**
   * Operator audit trail. A fresh one is created when omitted, so the poller
   * keeps working in callers that do not care about auditing (tests, tooling).
   */
  audit?: AuditLog | undefined;
  /**
   * Append flushed audit entries to `config.auditFile` each cycle. Enabled by
   * default; disable for in-memory-only auditing (ephemeral tooling, tests).
   */
  persistAudit?: boolean | undefined;
  sendOptions?: SendOptions;
  /** Per-target RPC backoff configuration */
  targetBackoffOptions?: TargetBackoffOptions;
  /** Circuit breaker configuration */
  circuitBreakerOptions?: CircuitBreakerOptions;
  /**
   * Explicit recovery policy for orphaned send-journal entries whose route was
   * removed or whose network identity changed. When omitted, orphaned entries
   * are skipped (never silently replayed).
   */
  onOrphanedJournalEntry?: (
    orphan: OrphanedJournalEntry,
  ) => OrphanDecision | Promise<OrphanDecision>;
  /**
   * Tuning for the rolling activity baseline. Defaults are production values;
   * tests can shrink the window to observe a comparison quickly.
   */
  activityBaselineOptions?: ActivityBaselineOptions;
  /** Clock behind every timestamp this poller reports. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Monotonic clock (ms) used to measure in-process duration from event ingestion
   * to confirmed send. Defaults to `() => performance.now()`.
   */
  monotonicNow?: () => number;
  /**
   * Async delay used for send-spacing and retry back-off.
   * Defaults to a real `setTimeout`-based sleep. Inject a no-op in tests to
   * avoid waiting for real wall-clock time.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Optional clock for the scheduled digest timer (tests inject a fake clock). */
  schedulerClock?: SchedulerClock;
}

export interface ShutdownOptions {
  /**
   * Milliseconds to wait for an in-flight cycle before flushing anyway.
   * Defaults to `config.shutdownTimeoutMs`; `0` does not wait at all.
   */
  timeoutMs?: number;
}

export interface ShutdownResult {
  /** False when a cycle was still running when the wait budget expired. */
  drained: boolean;
  /**
   * False only when state was pending and the write failed. True also when
   * there was nothing to flush — the file then already matches memory.
   */
  flushed: boolean;
  /** Milliseconds spent draining and flushing, on this poller's clock. */
  waitedMs: number;
}

export interface TargetBackoffOptions {
  /** Initial backoff delay in ms after first RPC failure for a target. Defaults to the poll interval. */
  initialBackoffMs?: number;
  /** Maximum backoff delay in ms for a target. Defaults to 60_000ms. */
  maxBackoffMs?: number;
  /** Exponential backoff factor. Defaults to 2. */
  backoffFactor?: number;
}

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** Milliseconds to wait before attempting a bounded half-open recovery probe */
  cooldownMs?: number;
  /** Maximum concurrent recovery probes allowed while half-open (defaults to 1) */
  maxHalfOpenProbes?: number;
}

/** Default maximum backoff in milliseconds for per-target RPC backoff. */
const DEFAULT_TARGET_MAX_BACKOFF_MS = 60_000;

/** Default backoff factor for per-target RPC backoff. */
const DEFAULT_TARGET_BACKOFF_FACTOR = 2;

/** Telegram tolerates ~20 messages/minute to one chat; stay under it. */
const DEFAULT_SEND_SPACING_MS = 1_500;

/**
 * Successful cycles with an unchanged cursor, while still behind the tip,
 * before a stall is reported. At the default 30s interval this is ~2.5 minutes
 * without progress — long enough that a burst of quiet ledgers is not a stall,
 * short enough that an operator hears about a wedged `getEvents` walk quickly.
 */
export const CURSOR_STALL_CYCLES = 5;

/**
 * Minimum tip-minus-cursor ledger gap for an unchanged cursor to count as
 * stalled. A gap of 0–1 is a bot sitting on the tip between ledgers, which is
 * the healthy idle case.
 */
export const CURSOR_STALL_MIN_LAG_LEDGERS = 2;

/** Maximum number of retry attempts for a single Telegram send. */
const DEFAULT_MAX_SEND_RETRIES = 3;

/** Initial backoff in milliseconds for Telegram send retries. */
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;

/** Maximum backoff in milliseconds for Telegram send retries. */
const DEFAULT_MAX_BACKOFF_MS = 10_000;

/** Maximum time to back off based on Retry-After (1 hour). */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export function extractRetryAfterMs(
  err: unknown,
  maxBackoffMs: number = MAX_RETRY_AFTER_MS,
): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as any;

  let rawRetryAfter: unknown = null;

  if (typeof e.parameters?.retry_after === "number") {
    rawRetryAfter = e.parameters.retry_after;
  } else {
    const headers = e.response?.headers || e.headers;
    if (headers) {
      if (typeof headers.get === "function") {
        rawRetryAfter = headers.get("retry-after") || headers.get("Retry-After");
      } else {
        rawRetryAfter = headers["retry-after"] || headers["Retry-After"];
      }
    }
  }

  const clamped = parseRetryAfterHeaderMs(rawRetryAfter, maxBackoffMs);
  return clamped !== null && clamped > 0 ? clamped : null;
}
/**
 * Consecutive automatic floor rewinds allowed for one target before the poller
 * stops and leaves the decision to an operator. One rewind is the normal case;
 * a repeat means the walk never came back inside the retained window, so a
 * misbehaving or lying RPC cannot make the poller rewind forever.
 */
const MAX_FLOOR_REWINDS = 3;

/**
 * Where a persisted cursor sits relative to the RPC's retained window.
 *
 * Exactly *at* the floor is inside the window: that ledger is still retained.
 * A token that packs no real ledger (Stellar ledgers start at 1, so a TOID
 * that decodes to 0 is not a position) is unreadable rather than "at ledger
 * 0", because only positive evidence justifies moving a cursor.
 */
export type CursorWindowVerdict =
  | { status: "no-cursor" }
  | { status: "unknown-floor" }
  | { status: "unreadable"; cursor: string }
  | { status: "inside"; cursorLedger: number; behind: number }
  | { status: "stale"; cursorLedger: number; missedLedgers: number };

export function classifyCursorWindow(
  cursor: string | null,
  oldestLedger: number | null,
): CursorWindowVerdict {
  if (cursor === null || cursor === "") return { status: "no-cursor" };
  if (oldestLedger === null || !Number.isFinite(oldestLedger) || oldestLedger <= 0) {
    return { status: "unknown-floor" };
  }

  const cursorLedger = eventCursorLedger(cursor);
  if (cursorLedger === null || cursorLedger <= 0) {
    return { status: "unreadable", cursor };
  }

  if (cursorLedger < oldestLedger) {
    return { status: "stale", cursorLedger, missedLedgers: oldestLedger - cursorLedger };
  }
  return { status: "inside", cursorLedger, behind: cursorLedger - oldestLedger };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wait for `promise`, resolving `false` if `timeoutMs` elapses first.
 *
 * Used by shutdown so a wedged read or a Telegram retry loop can never hold the
 * process open past the operator's budget. The timer is always cleared, so an
 * early settle never keeps the event loop alive.
 */
function withinDeadline(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(false), timeoutMs);
    const settled = () => {
      clearTimeout(deadline);
      resolve(true);
    };
    void promise.then(settled, settled);
  });
}


export type CursorLoadErrorKind = "permission" | "io" | "corrupt";

export type CursorDiagnosticCode =
  | "CURSOR_NOT_FOUND"
  | "CURSOR_PERMISSION_DENIED"
  | "CURSOR_IO_ERROR"
  | "CURSOR_CORRUPT_JSON";

export interface CursorLoadError {
  kind: CursorLoadErrorKind;
  code: CursorDiagnosticCode;
  errno?: string | undefined;
  message: string;
}

const PERMISSION_ERRNO_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export function classifyCursorFsError(err: unknown): {
  kind: "not_found" | "permission" | "io";
  errnoCode: string | undefined;
  diagnosticCode: Exclude<CursorDiagnosticCode, "CURSOR_CORRUPT_JSON">;
} {
  const errnoCode =
    err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
  if (errnoCode === "ENOENT") {
    return { kind: "not_found", errnoCode, diagnosticCode: "CURSOR_NOT_FOUND" };
  }
  if (errnoCode && PERMISSION_ERRNO_CODES.has(errnoCode)) {
    return { kind: "permission", errnoCode, diagnosticCode: "CURSOR_PERMISSION_DENIED" };
  }
  return { kind: "io", errnoCode, diagnosticCode: "CURSOR_IO_ERROR" };
}

/** Stable quarantine path next to the live cursor file (never overwrites). */
export function cursorQuarantinePath(cursorFile: string, at: Date = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${cursorFile}.corrupt.${stamp}`;
}

/**
 * Read-only preview of where a cursor recovery would move one target.
 *
 * Built only from state the poller already holds (the persisted cursor and the
 * last retained window it observed). It performs no RPC call and no chain
 * write, so it is safe to show an operator before they act.
 */
export interface CursorRecoveryPreview {
  source: ContractSource;
  /** Current persisted position, or `null` when none is held. */
  oldCursorLedger: number | null;
  /** Ledger the next scan would resume from if recovery ran now. */
  proposedLedger: number | null;
  /** Oldest ledger the RPC was last observed to retain. */
  retainedFloor: number | null;
  /** Newest ledger the RPC was last observed to hold. */
  retainedTip: number | null;
  /** Estimated unrecoverable ledger range `[from, to)`, or `null` when none. */
  missedRange: { from: number; to: number } | null;
  verdict: CursorWindowVerdict["status"];
}

export function previewCursorRecovery(
  source: ContractSource,
  cursor: string | null,
  window: { oldestLedger: number | null; latestLedger: number | null },
): CursorRecoveryPreview {
  const verdict = classifyCursorWindow(cursor, window.oldestLedger);
  const oldCursorLedger =
    cursor === null ? null : eventCursorLedger(cursor);
  const retainedFloor = window.oldestLedger;
  const retainedTip = window.latestLedger;

  if (verdict.status === "stale") {
    return {
      source,
      oldCursorLedger,
      proposedLedger: retainedFloor,
      retainedFloor,
      retainedTip,
      missedRange: { from: verdict.cursorLedger, to: verdict.cursorLedger + verdict.missedLedgers },
      verdict: verdict.status,
    };
  }

  return {
    source,
    oldCursorLedger,
    proposedLedger: oldCursorLedger,
    retainedFloor,
    retainedTip,
    missedRange: null,
    verdict: verdict.status,
  };
}

/** Human-readable, bounded preview for the cursor CLI. Never prints raw tokens. */
export function formatCursorRecoveryPreview(preview: CursorRecoveryPreview): string {
  const fmt = (n: number | null): string => (n === null ? "unknown" : String(n));
  const lines = [
    `[cursor-preview] ${preview.source}: ${preview.verdict}`,
    `  old position:   ledger ${fmt(preview.oldCursorLedger)}`,
    `  proposed:       ledger ${fmt(preview.proposedLedger)}`,
    `  retained window: ${fmt(preview.retainedFloor)}..${fmt(preview.retainedTip)}`,
  ];
  if (preview.missedRange !== null) {
    lines.push(
      `  estimated missed ledger range: ${preview.missedRange.from}..${preview.missedRange.to} (not recoverable)`,
    );
  } else {
    lines.push("  estimated missed ledger range: none");
  }
  lines.push("  no changes were made (preview only)");
  return lines.join("\n");
}

function isNullOrString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullOrNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Strict schema check for persisted cursor state.
 * Valid JSON with the wrong shape is treated as corrupt so we never resume
 * from a half-understood file.
 */
export function isValidCursorFile(value: unknown): value is CursorFile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) return false;
  if (obj.updatedAt !== undefined && typeof obj.updatedAt !== "string") return false;
  if (obj.targets === null || typeof obj.targets !== "object" || Array.isArray(obj.targets)) {
    return false;
  }
  for (const entry of Object.values(obj.targets as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const saved = entry as Record<string, unknown>;
    if (!isNullOrString(saved.cursor)) return false;
    if (!isNullOrNumber(saved.lastEventLedger)) return false;
    if (
      saved.fingerprint !== undefined &&
      (typeof saved.fingerprint !== "string" || saved.fingerprint.length === 0)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Raised when a raw JSON cursor file defines the same target key more than once.
 * `JSON.parse()` silently uses last-key-wins semantics, which would otherwise
 * drop an earlier target's cursor position without warning.
 */
export class DuplicateCursorTargetError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`duplicate target definition in cursor file: "${target}"`);
    this.name = "DuplicateCursorTargetError";
    this.target = target;
  }
}

function skipJsonWhitespace(raw: string, pos: number): number {
  let i = pos;
  while (i < raw.length) {
    const ch = raw.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      i += 1;
    } else {
      break;
    }
  }
  return i;
}

function readJsonString(raw: string, pos: number): { value: string; nextPos: number } {
  let i = pos + 1;
  while (i < raw.length) {
    const ch = raw.charCodeAt(i);
    if (ch === 0x5c) {
      // Backslash escape: skip the escaped character.
      i += 2;
      continue;
    }
    if (ch === 0x22) {
      const end = i + 1;
      return { value: JSON.parse(raw.slice(pos, end)) as string, nextPos: end };
    }
    i += 1;
  }
  return { value: "", nextPos: i };
}

function skipJsonValue(raw: string, pos: number): number {
  let i = skipJsonWhitespace(raw, pos);
  if (i >= raw.length) return i;
  const ch = raw[i];
  if (ch === '"') {
    return readJsonString(raw, i).nextPos;
  }
  if (ch === "{") {
    i = skipJsonWhitespace(raw, i + 1);
    if (raw[i] === "}") return i + 1;
    while (i < raw.length) {
      i = skipJsonWhitespace(raw, i);
      i = readJsonString(raw, i).nextPos;
      i = skipJsonWhitespace(raw, i);
      if (raw[i] === ":") i += 1;
      i = skipJsonValue(raw, i);
      i = skipJsonWhitespace(raw, i);
      if (raw[i] === ",") {
        i += 1;
        continue;
      }
      if (raw[i] === "}") return i + 1;
      break;
    }
    return i;
  }
  if (ch === "[") {
    i = skipJsonWhitespace(raw, i + 1);
    if (raw[i] === "]") return i + 1;
    while (i < raw.length) {
      i = skipJsonValue(raw, i);
      i = skipJsonWhitespace(raw, i);
      if (raw[i] === ",") {
        i += 1;
        continue;
      }
      if (raw[i] === "]") return i + 1;
      break;
    }
    return i;
  }
  // Number, true, false, or null.
  while (i < raw.length) {
    const c = raw[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === "}" || c === "]") {
      break;
    }
    i += 1;
  }
  return i;
}

function scanJsonObjectEntries(
  raw: string,
  startPos: number,
  onEntry: (key: string, valuePos: number) => void,
): number {
  let i = skipJsonWhitespace(raw, startPos);
  if (raw[i] !== "{") return skipJsonValue(raw, i);
  i = skipJsonWhitespace(raw, i + 1);
  if (raw[i] === "}") return i + 1;

  while (i < raw.length) {
    i = skipJsonWhitespace(raw, i);
    const { value: key, nextPos } = readJsonString(raw, i);
    i = skipJsonWhitespace(raw, nextPos);
    if (raw[i] === ":") i += 1;
    const valuePos = skipJsonWhitespace(raw, i);
    onEntry(key, valuePos);
    i = skipJsonValue(raw, valuePos);
    i = skipJsonWhitespace(raw, i);
    if (raw[i] === ",") {
      i += 1;
      continue;
    }
    if (raw[i] === "}") return i + 1;
    break;
  }
  return i;
}

/**
 * Scan a valid JSON cursor document for duplicate target definitions before
 * trusting the object produced by `JSON.parse()`.
 *
 * Covers:
 * - Duplicate target keys inside the `targets` object (v1 and legacy-unversioned)
 * - Duplicate `"targets"` blocks at the root object
 * - Duplicate target keys at the root object in legacy flat / string-map files
 */
function assertNoDuplicateCursorTargets(raw: string, parsedRoot: Record<string, unknown>): void {
  const rootPos = skipJsonWhitespace(raw, 0);
  if (raw[rootPos] !== "{") return;

  const hasTargetsKey = "targets" in parsedRoot;
  const hasVersionKey = "version" in parsedRoot;
  const seenRootKeys = new Set<string>();

  scanJsonObjectEntries(raw, rootPos, (key, valuePos) => {
    if (key === "targets") {
      if (seenRootKeys.has("targets")) {
        throw new DuplicateCursorTargetError("targets");
      }
      seenRootKeys.add("targets");
      if (raw[valuePos] === "{") {
        const seenTargets = new Set<string>();
        scanJsonObjectEntries(raw, valuePos, (targetKey) => {
          if (seenTargets.has(targetKey)) {
            throw new DuplicateCursorTargetError(targetKey);
          }
          seenTargets.add(targetKey);
        });
      }
      return;
    }

    if (!hasTargetsKey && !hasVersionKey && key !== "updatedAt") {
      if (seenRootKeys.has(key)) {
        throw new DuplicateCursorTargetError(key);
      }
    }
    seenRootKeys.add(key);
  });
}

/** Parse + validate a cursor file body; throws on JSON or schema failure. */
export function parseCursorFile(raw: string): CursorFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isValidCursorFile(parsed)) {
    throw new Error("failed schema validation (expected version 1 with targets map)");
  }
  assertNoDuplicateCursorTargets(raw, parsed as unknown as Record<string, unknown>);

  const targets: Record<string, CursorTarget> = {};
  for (const [source, target] of Object.entries(parsed.targets)) {
    if (
      target.cursor !== null &&
      (target.cursor.length === 0 || target.cursor.length > 256)
    ) {
      throw new Error(`invalid cursor value for ${source}`);
    }
    if (
      target.lastEventLedger !== null &&
      (!Number.isSafeInteger(target.lastEventLedger) || target.lastEventLedger < 0)
    ) {
      throw new Error(`invalid last event ledger for ${source}`);
    }
    targets[source] = {
      cursor: target.cursor,
      lastEventLedger: target.lastEventLedger,
      // The dedup window is part of the cursor file: a restart must not
      // re-notify the boundary event the inclusive cursor hands back.
      // Additive field: only present when the file carried it.
      ...(Array.isArray(target.recentEventIds)
        ? { recentEventIds: target.recentEventIds.filter((id) => typeof id === "string") }
        : {}),
      // Transient resume hint: carried through only when it parses.
      ...(parseRewindFromLedger(target.rewindFromLedger) !== null
        ? { rewindFromLedger: parseRewindFromLedger(target.rewindFromLedger) }
        : {}),
      ...(typeof target.fingerprint === "string" && target.fingerprint.length > 0
        ? { fingerprint: target.fingerprint }
        : {}),
    };
  }

  const recoveryHistory =
    parsed.recoveryHistory !== undefined
      ? parseRecoveryHistory(parsed.recoveryHistory)
      : [];

  return {
    version: 1,
    updatedAt: parsed.updatedAt ?? "",
    // Additive field: only present when the file carried it.
    ...(parsed.chainClockAt !== undefined ? { chainClockAt: parseChainClock(parsed.chainClockAt) } : {}),
    targets,
    ...(recoveryHistory.length > 0 ? { recoveryHistory } : {}),
  };
}

/**
 * Move a corrupt cursor file aside so the next save starts clean and operators
 * can inspect the bad file. Returns the quarantine path, or null if rename failed.
 */
export async function quarantineCorruptCursorFile(
  cursorFile: string,
  reason: string,
  at: Date = new Date(),
): Promise<string | null> {
  const dest = cursorQuarantinePath(cursorFile, at);
  try {
    await rename(cursorFile, dest);
    Logger.warn(
      "poller",
      `[poller] cursor file unreadable, starting cold: quarantined it to ${dest} (${reason})`,
      { action: "cursor_quarantined", cursorFile, quarantined: dest, reason },
    );
    return dest;
  } catch (err) {
    Logger.warn(
      "poller",
      `[poller] cursor file unreadable, starting cold: could not quarantine ${cursorFile}: ` +
        `${safeErrorMessage(err, [])}; the file was left in place (${reason})`,
      {
        action: "cursor_quarantine_failed",
        cursorFile,
        reason,
        error: safeErrorMessage(err, []),
      },
    );
    return null;
  }
}


function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTargetEntry(value: unknown, label: string): CursorTargetEntry {
  if (typeof value === "string") {
    return { cursor: value.length > 0 ? value : null, lastEventLedger: null };
  }
  if (!isPlainObject(value)) {
    throw new Error(`${label}: target entry must be an object or cursor string`);
  }

  let cursor: string | null = null;
  if (value.cursor === null || value.cursor === undefined) {
    cursor = null;
  } else if (typeof value.cursor === "string") {
    if (value.cursor.length > 256) throw new Error(`${label}: cursor is implausibly long`);
    cursor = value.cursor.length > 0 ? value.cursor : null;
  } else {
    throw new Error(`${label}: cursor must be a string or null`);
  }

  let lastEventLedger: number | null = null;
  if (value.lastEventLedger === null || value.lastEventLedger === undefined) {
    lastEventLedger = null;
  } else if (
    typeof value.lastEventLedger === "number" &&
    Number.isSafeInteger(value.lastEventLedger) &&
    value.lastEventLedger >= 0
  ) {
    lastEventLedger = value.lastEventLedger;
  } else {
    throw new Error(`${label}: lastEventLedger must be an integer or null (non-negative)`);
  }

  // The dedup window and the floor-rewind hint are additive: carried through
  // only when the file had them.
  const recent = value.recentEventIds;
  const rewindFromLedger = parseRewindFromLedger(value.rewindFromLedger);
  let fingerprint: string | undefined;
  if (value.fingerprint !== undefined) {
    if (typeof value.fingerprint !== "string" || value.fingerprint.length === 0) {
      throw new Error(`${label}: fingerprint must be a non-empty string`);
    }
    fingerprint = value.fingerprint;
  }
  return {
    cursor,
    lastEventLedger,
    ...(contractId !== undefined ? { contractId } : {}),
    ...(Array.isArray(recent)
      ? { recentEventIds: recent.filter((id): id is string => typeof id === "string") }
      : {}),
    ...(rewindFromLedger !== null ? { rewindFromLedger } : {}),
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
}

function normalizeTargets(
  targets: Record<string, unknown>,
  label: string,
): Record<string, CursorTargetEntry> {
  const out: Record<string, CursorTargetEntry> = {};
  for (const [source, saved] of Object.entries(targets)) {
    out[source] = normalizeTargetEntry(saved, `${label}.targets.${source}`);
  }
  return out;
}

/**
 * Detect whether a top-level object looks like a flat legacy cursor map
 * (`{ market: { cursor, lastEventLedger }, squad: ... }` or string values)
 * rather than the versioned `{ version, targets }` envelope.
 */
function looksLikeFlatLegacyTargets(parsed: Record<string, unknown>): boolean {
  if ("targets" in parsed || "version" in parsed) return false;
  const keys = Object.keys(parsed);
  if (keys.length === 0) return false;
  // Ignore purely metadata-looking keys if somehow present alone.
  const dataKeys = keys.filter((k) => k !== "updatedAt");
  if (dataKeys.length === 0) return false;
  return dataKeys.every((key) => {
    const value = parsed[key];
    return typeof value === "string" || isPlainObject(value);
  });
}

/**
 * Parse a cursor file document and migrate any supported legacy shape into the
 * current versioned schema. Throws on malformed JSON payloads or unknown
 * future schema versions (the caller quarantines the file and cold-starts).
 */
export function parseAndMigrateCursorFile(
  raw: string,
  options: { now?: () => Date } = {},
): CursorMigrateResult {
  const parsedUnknown: unknown = JSON.parse(raw);
  if (!isPlainObject(parsedUnknown)) {
    throw new Error("cursor file root must be a JSON object");
  }
  const parsed = parsedUnknown;
  assertNoDuplicateCursorTargets(raw, parsed);
  const nowIso = (options.now ?? (() => new Date()))().toISOString();

  // ── Current versioned schema ───────────────────────────────────────────────
  if (parsed.version === CURSOR_SCHEMA_VERSION) {
    if (!isPlainObject(parsed.targets)) {
      throw new Error("cursor file v1: targets field missing or not an object");
    }
    const targets = normalizeTargets(parsed.targets, "cursor file v1");
    const updatedAt =
      typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
        ? parsed.updatedAt
        : nowIso;
    const file: CursorFile = { version: CURSOR_SCHEMA_VERSION, updatedAt, targets };
    if (parsed.chainClockAt !== undefined) file.chainClockAt = parseChainClock(parsed.chainClockAt);
    if (parsed.recoveryHistory !== undefined) {
      const recoveryHistory = parseRecoveryHistory(parsed.recoveryHistory);
      if (recoveryHistory.length > 0) file.recoveryHistory = recoveryHistory;
    }
    return {
      file,
      migrated: typeof parsed.updatedAt !== "string" || parsed.updatedAt.length === 0,
      source: "v1",
    };
  }

  // ── Unknown future / invalid version ─────────────────────────────────────
  if ("version" in parsed && parsed.version !== undefined && parsed.version !== null) {
    throw new Error(
      `cursor file: unsupported schema version ${String(parsed.version)} ` +
        `(this build understands version ${CURSOR_SCHEMA_VERSION})`,
    );
  }

  // ── Legacy: unversioned envelope with `targets` ────────────────────────────
  if (isPlainObject(parsed.targets)) {
    const targets = normalizeTargets(parsed.targets, "legacy-unversioned");
    return {
      file: { version: CURSOR_SCHEMA_VERSION, updatedAt: nowIso, targets },
      migrated: true,
      source: "legacy-unversioned",
    };
  }

  // ── Legacy: flat map of target → entry or cursor string ────────────────────
  if (looksLikeFlatLegacyTargets(parsed)) {
    const { updatedAt: _ignored, ...flat } = parsed;
    const allStrings = Object.values(flat).every((v) => typeof v === "string");
    const targets = normalizeTargets(flat, allStrings ? "legacy-string-map" : "legacy-flat");
    return {
      file: { version: CURSOR_SCHEMA_VERSION, updatedAt: nowIso, targets },
      migrated: true,
      source: allStrings ? "legacy-string-map" : "legacy-flat",
    };
  }

  throw new Error("cursor file: unrecognised shape (expected versioned targets map)");
}

/** Compute a stable SHA-256 hex digest of raw cursor file contents for CAS checks. */
export function cursorDigest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export type CursorCasResult =
  | { ok: true; digest: string | null }
  | {
      ok: false;
      conflict: true;
      expected: string | null;
      actual: string | null;
      reason: string;
    };

/**
 * Compare-and-swap check for a cursor file against an expected SHA-256 digest
 * (or `null` when the file is expected to be absent). When `expectedDigest` is
 * `undefined`, no CAS precondition was requested and the check succeeds.
 */
export function checkCursorCas(
  currentRaw: string | null,
  expectedDigest: string | null | undefined,
): CursorCasResult {
  const actual = currentRaw === null ? null : cursorDigest(currentRaw);
  if (expectedDigest === undefined) {
    return { ok: true, digest: actual };
  }
  if (actual !== expectedDigest) {
    return {
      ok: false,
      conflict: true,
      expected: expectedDigest,
      actual,
      reason:
        expectedDigest === null
          ? "file exists on disk (expected absent)"
          : actual === null
            ? "file is missing on disk (expected existing content)"
            : `digest mismatch (expected ${expectedDigest.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
    };
  }
  return { ok: true, digest: actual };
}

/** Build the on-disk payload the poller always writes. */
export function buildCursorFile(
  targets: Iterable<{
    source: string;
    cursor: string | null;
    lastEventLedger: number | null;
    recentEventIds?: string[];
    rewindFromLedger?: number | null;
    fingerprint?: string;
  }>,
  updatedAt: string,
  chainClockAt?: number | null,
  recoveryHistory?: readonly CursorRecoveryRecord[],
): CursorFile {
  const boundedHistory =
    recoveryHistory !== undefined ? parseRecoveryHistory(recoveryHistory) : [];
  return {
    version: CURSOR_SCHEMA_VERSION,
    updatedAt,
    ...(chainClockAt !== undefined ? { chainClockAt } : {}),
    targets: Object.fromEntries(
      [...targets].map((t) => [
        t.source,
        {
          cursor: t.cursor,
          lastEventLedger: t.lastEventLedger,
          ...(t.recentEventIds !== undefined ? { recentEventIds: t.recentEventIds } : {}),
          // Only a live rewind is persisted; a finished target drops the field
          // so an ordinary cursor file is byte-for-byte unchanged.
          ...(typeof t.rewindFromLedger === "number"
            ? { rewindFromLedger: t.rewindFromLedger }
            : {}),
          ...(t.fingerprint !== undefined ? { fingerprint: t.fingerprint } : {}),
        } satisfies CursorTarget,
      ]),
    ),
    ...(boundedHistory.length > 0 ? { recoveryHistory: boundedHistory } : {}),
  };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict schema check for persisted poller counters.
 */
export function isValidCountersFile(value: unknown): value is CountersFile {
  if (!isPlainObject(value)) return false;
  if (value.version !== COUNTERS_SCHEMA_VERSION) return false;
  if (typeof value.updatedAt !== "string") return false;
  if (!isPlainObject(value.contracts)) return false;
  if (
    typeof value.contracts.marketContractId !== "string" ||
    value.contracts.marketContractId.length === 0
  ) {
    return false;
  }
  if (
    typeof value.contracts.squadContractId !== "string" ||
    value.contracts.squadContractId.length === 0
  ) {
    return false;
  }
  if (!isPlainObject(value.counters)) return false;
  return (
    isNonNegativeSafeInteger(value.counters.cycles) &&
    isNonNegativeSafeInteger(value.counters.notificationsSent) &&
    isNonNegativeSafeInteger(value.counters.notificationsFailed) &&
    isNonNegativeSafeInteger(value.counters.eventsSkipped)
  );
}

/** Parse + validate a counters file body; throws on JSON or schema failure. */
export function parseCountersFile(raw: string): CountersFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error("counters file root must be a JSON object");
  }
  if ("version" in parsed && parsed.version !== COUNTERS_SCHEMA_VERSION) {
    throw new Error(
      `counters file: unsupported schema version ${String(parsed.version)} ` +
        `(this build understands version ${COUNTERS_SCHEMA_VERSION})`,
    );
  }
  if (!isValidCountersFile(parsed)) {
    throw new Error("failed schema validation (expected version 1 with contracts and counters)");
  }
  return {
    version: COUNTERS_SCHEMA_VERSION,
    updatedAt: parsed.updatedAt,
    contracts: {
      marketContractId: parsed.contracts.marketContractId,
      squadContractId: parsed.contracts.squadContractId,
    },
    counters: {
      cycles: parsed.counters.cycles,
      notificationsSent: parsed.counters.notificationsSent,
      notificationsFailed: parsed.counters.notificationsFailed,
      eventsSkipped: parsed.counters.eventsSkipped,
    },
  };
}

/** Build the on-disk counters payload. */
export function buildCountersFile(
  contracts: { marketContractId: string; squadContractId: string },
  counters: PollerCounters,
  updatedAt: string,
): CountersFile {
  return {
    version: COUNTERS_SCHEMA_VERSION,
    updatedAt,
    contracts: {
      marketContractId: contracts.marketContractId,
      squadContractId: contracts.squadContractId,
    },
    counters: {
      cycles: counters.cycles,
      notificationsSent: counters.notificationsSent,
      notificationsFailed: counters.notificationsFailed,
      eventsSkipped: counters.eventsSkipped,
    },
  };
}

/** Timeout for each RPC scan request */
const SCAN_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (timer.unref) { timer.unref(); }
    Promise.resolve(promise)
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Heuristic for a cursor older than the RPC's retained event window. The RPC
 * rejects such reads (cursor/ledger/retention errors) instead of returning an
 * empty page. Matched only to log an actionable, bounded hint — the cursor is
 * still left untouched so no events are silently skipped.
 */
function isStaleCursorError(message: string): boolean {
  return /cursor|oldest[-_ ]?ledger|start[-_ ]?ledger|retention|not (?:found|available)|out[-_ ]?of[-_ ]?range|ledger.*(?:too old|before|below)/i.test(
    message,
  );
}


/** Minimal RPC health surface used at boot (fakeable in tests). */
export interface RpcHealthProbe {
  getHealth: () => Promise<{
    status: string;
    latestLedger: number;
    oldestLedger: number;
  }>;
}

export interface StartupHealthOptions {
  /** Wall-clock budget for retries from the first attempt. */
  deadlineMs: number;
  /** Delay between failed attempts (capped by remaining deadline). */
  retryMs: number;
  /** Optional clock for deterministic tests. */
  now?: () => number;
  /** Optional sleeper for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retry `getHealth()` until it succeeds or the deadline elapses.
 *
 * Used at process startup so a briefly unavailable RPC (deploy race, Testnet
 * blip) does not fail the whole boot, while a permanently wrong URL still
 * surfaces within a bounded window. Never logs tokens or full remote bodies.
 */
export async function waitForStartupHealth(
  rpc: RpcHealthProbe,
  options: StartupHealthOptions,
): Promise<{
  status: string;
  latestLedger: number;
  oldestLedger: number;
  attempts: number;
}> {
  const now = options.now ?? Date.now;
  const sleepFn = options.sleep ?? defaultSleep;
  const deadlineMs = Math.max(0, options.deadlineMs);
  const retryMs = Math.max(0, options.retryMs);
  const startedAt = now();
  const deadlineAt = startedAt + deadlineMs;

  let attempts = 0;
  let lastError: unknown;

  while (true) {
    attempts += 1;
    try {
      const health = await rpc.getHealth();
      if (attempts > 1) {
        console.log(
          `[poller] startup RPC health ok after ${attempts} attempt(s) ` +
            `(${Math.max(0, now() - startedAt)}ms): status=${health.status} ` +
            `ledgers ${health.oldestLedger}..${health.latestLedger}`,
        );
      }
      return {
        status: health.status,
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        attempts,
      };
    } catch (err) {
      lastError = err;
      const remaining = deadlineAt - now();
      if (remaining <= 0 || retryMs <= 0) {
        break;
      }
      const waitMs = Math.min(retryMs, remaining);
      console.warn(
        `[poller] startup RPC health attempt ${attempts} failed; ` +
          `retrying in ${waitMs}ms (deadline ${deadlineMs}ms): ${safeErrorMessage(err)}`,
      );
      await sleepFn(waitMs);
      if (now() >= deadlineAt) {
        break;
      }
    }
  }

  throw new Error(
    `RPC startup health check failed after ${attempts} attempt(s) ` +
      `within ${deadlineMs}ms deadline: ${safeErrorMessage(lastError)}`,
  );
}


/**
 * Sends a message with bounded exponential backoff.
 *
 * If the Telegram API is temporarily unavailable (rate limit, network error,
 * or bad token), we retry a few times with increasing delays. This prevents
 * transient failures from dropping notifications while avoiding infinite
 * retries that would block the poller loop.
 *
 * `shouldRetry` is the shutdown escape hatch: once a graceful shutdown starts
 * the drain must stay bounded, so a failing send gives up on its first error
 * instead of sleeping through another backoff step.
 */
async function sendWithRetry(
  send: (text: string, previewsEnabled?: boolean) => Promise<void>,
  text: string,
  botToken: string,
  opts?: SendOptions,
  shouldRetry: () => boolean = () => true,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  let attempt = 0;
  const maxRetries = opts?.maxSendRetries ?? DEFAULT_MAX_SEND_RETRIES;
  let backoff = opts?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoff = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  while (true) {
    try {
      await withTimeout(
        send(text),
        opts?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
        "Telegram send",
      );
      return;
    } catch (err) {
      if (classifyPermanentSendError(err) !== null) {
        throw err; // Permanent Telegram error: bypass transient retry loop
      }
      attempt++;
      const retryAfterMs = extractRetryAfterMs(err);
      if (attempt >= maxRetries || !shouldRetry() || isForumTopicClosed(err)) {
        throw err; // Exhausted retries, shutdown in progress, or a permanent route failure
      }

      const delay = retryAfterMs !== null ? retryAfterMs : backoff;

      console.warn(
        `[poller] send attempt ${attempt} failed, retrying in ${delay}ms: ` +
          safeErrorMessage(err, [botToken]),
      );
      await sleep(delay);
      // Exponential backoff with cap
      backoff = Math.min(backoff * 2, maxBackoff);
    }
  }
}

export function buildDigests(
  events: DecodedEvent[],
  config: BotConfig,
  formatFn: (config: BotConfig, event: DecodedEvent) => string | null,
): { text: string; count: number; skipped: number }[] {
  const digests: { text: string; count: number; skipped: number }[] = [];
  let currentText = "";
  let currentCount = 0;
  let currentSkipped = 0;

  for (const event of events) {
    if (event.payload.name === "unknown") {
      currentSkipped += 1;
      continue;
    }

    const text = formatFn(config, event);
    if (text === null) {
      currentSkipped += 1;
      continue;
    }

    const separator = currentText ? "\n\n" : "";
    if (currentText.length + separator.length + text.length > 4000) {
      digests.push({ text: currentText, count: currentCount, skipped: currentSkipped });
      currentText = text;
      currentCount = 1;
      currentSkipped = 0;
    } else {
      currentText += separator + text;
      currentCount += 1;
    }
  }

  if (currentText || currentSkipped > 0) {
    digests.push({ text: currentText, count: currentCount, skipped: currentSkipped });
  }

  return digests;
}

export function createPoller(deps: PollerDeps) {
  const notifiedGaps = new Set<string>();
  const { config, server, send } = deps;
  const metrics = deps.metrics;
  // One histogram per poller. When the standalone metrics server is enabled it
  // owns the same recorder, so both /metrics endpoints report identical data.
  const rpcLatency = metrics?.rpcLatency ?? new RpcLatencyHistogram();
  const audit: AuditLog = deps.audit ?? createAuditLog();
  const sendSpacing =
    deps.sendOptions?.sendSpacingMs ?? config.interSendDelayMs ?? DEFAULT_SEND_SPACING_MS;
  // Per-attempt send budget: explicit option, then config (TELEGRAM_SEND_TIMEOUT_MS,
  // or the `sendTimeoutMs` alias hand-built configs use), then the default.
  const sendOptions: SendOptions = {
    ...deps.sendOptions,
    sendTimeoutMs:
      deps.sendOptions?.sendTimeoutMs ??
      config.sendTimeoutMs ??
      config.telegramSendTimeoutMs ??
      DEFAULT_SEND_TIMEOUT_MS,
  };
  const now = deps.now ?? Date.now;
  const hasCustomWallClock = deps.now !== undefined;
  const hasCustomMonotonicClock = deps.monotonicNow !== undefined;
  const notificationAge = new NotificationAge(deps.monotonicNow ?? (() => performance.now()));
  const sleep = deps.sleep ?? defaultSleep;
  const activityBaseline = new ActivityBaseline(deps.activityBaselineOptions);
  const targetInitialBackoff = deps.targetBackoffOptions?.initialBackoffMs ?? config.pollIntervalMs;
  const targetMaxBackoff = deps.targetBackoffOptions?.maxBackoffMs ?? DEFAULT_TARGET_MAX_BACKOFF_MS;
  const targetBackoffFactor = deps.targetBackoffOptions?.backoffFactor ?? DEFAULT_TARGET_BACKOFF_FACTOR;
  const circuitThreshold = deps.circuitBreakerOptions?.failureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
  const circuitCooldown = deps.circuitBreakerOptions?.cooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
  const rpcEndpoint = normalizeRpcEndpoint(config.rpcUrl);
  const circuitBreaker = new RpcCircuitBreaker({
    failureThreshold: circuitThreshold,
    cooldownMs: circuitCooldown,
    maxHalfOpenProbes: deps.circuitBreakerOptions?.maxHalfOpenProbes,
    now,
  });
  const errorMessage = (err: unknown): string => safeErrorMessage(err, [config.botToken]);

  // One key per failure source: a broken market contract must not silence the
  // squad contract's errors, and a flapping one must not reset the other.
  const errorSampler = new LogSampler({
    maxPerWindow: config.logSampleMaxPerWindow,
    windowMs: config.logSampleWindowMs,
    now,
  });

  /**
   * Print a repetitive error through the sampler. The first
   * `LOG_SAMPLE_MAX_PER_WINDOW` lines per key and window are printed verbatim;
   * repeats are counted; the line that opens the next window carries the number
   * it held back, so a suppressed run is always reported.
   */
  const logSampledError = (key: string, line: string, fields?: Record<string, unknown>): void => {
    const sample = errorSampler.record(key);
    if (!sample.log) return;
    Logger.error(
      "poller",
      `${line}${formatSuppressedRepeats(sample.suppressed, errorSampler.windowMs)}`,
      fields,
    );
  };
  const boundedLabel = (value: unknown, max = 120): string => {
    const compact = String(value).replace(/\s+/g, " ").trim() || "unknown";
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
  };
  const cursorPreview = (cursor: string | null): string => {
    if (cursor === null) return "none";
    const ledger = eventCursorLedger(cursor);
    return ledger !== null ? `ledger:${ledger}` : "opaque";
  };

  const targets: WatchTarget[] = [
    {
      source: "market",
      contractId: config.marketContractId,
      version: config.marketContractVersion,
    },
    {
      source: "squad",
      contractId: config.squadContractId,
      version: config.squadContractVersion,
    },
  ];

  const state = new Map<ContractSource, TargetState>(
    targets.map((t) => [
      t.source,
      {
        source: t.source,
        contractId: t.contractId,
        version: normalizeContractVersion(t.version),
        supportedVersion: isContractVersionSupported(t.source, t.version),
        lastCycleMs: 0,
        maxCycleMs: 0,
        cursor: null,
        lastEventLedger: null,
        rewindFromLedger: null,
        cursorStale: false,
        gapLedgers: 0,
        cursorResetAt: null,
        cursorUnreadable: false,
        lastError: null,
        cyclesWithoutAdvance: 0,
        cursorStalled: false,
        consecutiveFailures: 0,
        nextEligibleAt: null,
      },
    ]),
  );

  const recentEvents = new RecentEventStore();

  // Per-contract consecutive floor-rewind budget. Kept out of `TargetState` so
  // status output stays plain data. It resets only when a scan comes back
  // inside the retained window, so an RPC that keeps handing back a
  // below-floor cursor cannot make the poller rewind forever.
  const rewindAttempts = new Map<ContractSource, number>(
    targets.map((t) => [t.source, 0]),
  );

  /** Bounded history of cursor recovery actions persisted alongside cursors. */
  let recoveryHistory: CursorRecoveryRecord[] = [];

  // Per-contract redelivery guard. Kept out of `TargetState` so status output
  // stays plain data; the window is internal bookkeeping.
  const dedup = new Map<ContractSource, EventDedupWindow>(
    targets.map((t) => [t.source, new EventDedupWindow(config.dedupWindow)]),
  );

  // The queue is opt-in by config, like `shutdownTimeoutMs`: a hand-built
  // config that predates the setting (tests, tooling) must keep main's
  // drop-and-count behaviour, with no file access at all.
  const deadLetterEnabled =
    typeof config.deadLetterFile === "string" && config.deadLetterFile.length > 0;
  const deadLetter = createDeadLetterQueue({
    filePath: deadLetterEnabled ? (config.deadLetterFile as string) : null,
    maxEntries: config.deadLetterMax ?? DEAD_LETTER_MAX_ENTRIES,
    maxAttempts: config.deadLetterMaxAttempts ?? DEAD_LETTER_MAX_ATTEMPTS,
    maxAgeMs: config.deadLetterMaxAgeMs ?? DEAD_LETTER_MAX_AGE_MS,
    // A Telegram error embeds the token in its request URL, and the queue is
    // the last place it belongs.
    secrets: [config.botToken],
    networkPassphrase: config.networkPassphrase,
    now,
  });

  // Scheduled digests are opt-in via DIGEST_SCHEDULE. When unset, the poller
  // delivers each event immediately with zero digest file I/O.
  const digestScheduleSpec =
    typeof config.digestSchedule === "string" && config.digestSchedule.trim().length > 0
      ? config.digestSchedule.trim()
      : null;
  const digestCheckpoint: DigestCheckpoint | null = digestScheduleSpec
    ? createDigestCheckpoint({
        filePath:
          typeof config.digestCheckpointFile === "string" &&
          config.digestCheckpointFile.length > 0
            ? config.digestCheckpointFile
            : null,
        maxPending: config.digestMaxPending ?? DEFAULT_DIGEST_MAX_PENDING,
        now,
      })
    : null;
  const digestScheduler: Scheduler | null =
    digestScheduleSpec && digestCheckpoint
      ? createScheduler({
          schedule: digestScheduleSpec,
          clock: deps.schedulerClock,
          lastRunStore: digestCheckpoint,
          run: async () => {
            const pending = digestCheckpoint.snapshotPending();
            if (pending.length === 0) return;
            const chunks = formatDigestPages(pending, { grouped: true });
            if (chunks.length === 0) return;
            try {
              for (const chunk of chunks) {
                await sendWithRetry(
                  (message) => send(message, undefined),
                  chunk,
                  config.botToken,
                  sendOptions,
                  () => !status.stopping,
                  sleep,
                );
                recordSentIncrement();
                metrics?.notificationsSent.inc();
              }
            } catch (err) {
              recordFailedIncrement();
              metrics?.notificationsFailed.inc();
              Logger.error(
                "poller",
                `[poller] scheduled digest send failed (${pending.length} pending event(s) kept): ` +
                  errorMessage(err),
                {
                  action: "digest_send_failed",
                  pendingCount: pending.length,
                  error: errorMessage(err),
                },
              );
              throw err;
            }
            await digestCheckpoint.acknowledgeSent(new Set(pending.map((e) => e.eventId)));
          },
        })
      : null;

  /** Crash-safe send journal: intent before a send, done after. */
  const sendJournalEnabled =
    typeof config.sendJournalFile === "string" && config.sendJournalFile.length > 0;
  let sendJournal: SendJournal | null = null;
  if (sendJournalEnabled) {
    sendJournal = createSendJournal({
      filePath: config.sendJournalFile,
      now,
      secrets: config.botToken ? [config.botToken] : [],
    });
  }

  /** Event ids that may already have been sent (crash recovery); never re-notified. */
  const maybeSent = new Set<string>();

  /** Mirror the queue's counters into the status this poller reports. */
  function refreshDeadLetterStatus(): void {
    status.deadLetter = deadLetter.stats();
  }

  const categoryCounter = createCategoryCounter({ config });

  const sinceStartCounters: PollerCounters = {
    cycles: 0,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
  };

  const status: PollerStatus = {
    running: false,
    paused: false,
    stopping: false,
    chainClockAt: null,
    startedAt: 0,
    cycles: 0,
    lastCorrelationId: null,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    notificationAge: notificationAge.summary(),
    eventsSkipped: 0,
    sinceStart: { ...sinceStartCounters },
    cumulative: {
      cycles: 0,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
    },
    emptyPages: 0,
    pagesScanned: 0,
    activityBaseline: activityBaseline.snapshot(),
    lastCycleEmptyPages: 0,
    lastCyclePages: 0,
    notificationsDropped: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    rpcLatency: rpcLatency.snapshot(),
    eventsDeduplicated: 0,
    cursorRewinds: 0,
    restartGaps: 0,
    lastRestartGap: null,
    consecutiveFailures: 0,
    lastError: null,
    ledgerCache: { hits: 0, misses: 0 },
    lockFile: null,
    lockPid: null,
    pendingFlush: false,
    lastFlushAt: null,
    suppressedLogs: 0,
    unsupportedVersions: validateDecoderCombinations(targets).map((f) => ({
      source: f.source,
      version: f.version ?? "",
      fallback: f.fallbackVersion,
      reason: f.reason,
    })),
    targets: [],
    sbomDigest: null,
    circuitBreaker: {
      open: false,
      openedAt: null,
      failureCount: 0,
      lastFailureAt: null,
      state: "closed",
      endpoint: rpcEndpoint,
      probesInFlight: 0,
    },
  };

  function syncCircuitBreakerStatus(): void {
    const snap = circuitBreaker.snapshot(rpcEndpoint);
    status.circuitBreaker.open = snap.open;
    status.circuitBreaker.openedAt = snap.openedAt;
    status.circuitBreaker.failureCount = snap.failureCount;
    status.circuitBreaker.lastFailureAt = snap.lastFailureAt;
    status.circuitBreaker.state = snap.state;
    status.circuitBreaker.endpoint = snap.endpoint;
    status.circuitBreaker.probesInFlight = snap.probesInFlight;
  }

  function syncCounterSnapshots(): void {
    status.sinceStart = { ...sinceStartCounters };
    status.cumulative = {
      cycles: status.cycles,
      notificationsSent: status.notificationsSent,
      notificationsFailed: status.notificationsFailed,
      eventsSkipped: status.eventsSkipped,
    };
  }

  // One chain tip per poll cycle. An infinite TTL plus a `reset()` at the top
  // of each cycle means the tip is fetched exactly once per cycle however many
  // targets are watched, without a wall-clock expiry landing mid-cycle.
  const ledgerCache = new LedgerCache({ ttlMs: Number.POSITIVE_INFINITY });

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let paused = false;
  let inFlight = false;
  let resumePending = false;
  let instanceLock: InstanceLockHandle | null = null;
  /** Set when load migrates a legacy file so the first save rewrites disk ASAP. */
  let pendingRewrite = false;
  let countersDirty = false;

  // Hand-built configs (tests, embedders) may not set a counters file.
  const countersFile =
    typeof config.countersFile === "string" && config.countersFile.length > 0
      ? config.countersFile
      : "";

  async function releaseInstanceLock(): Promise<void> {
    const lock = instanceLock;
    if (!lock) return;
    instanceLock = null;
    status.lockPid = null;
    await lock.release();
    console.log(`[poller] instance lock released`);
  }
  /** Resolves when the current cycle (including its cursor write) is done. */
  let cycleSettled: Promise<void> | null = null;
  let settleCycle: (() => void) | null = null;

  function beginCycleTracking(): void {
    cycleSettled = new Promise<void>((resolve) => {
      settleCycle = resolve;
    });
  }

  function endCycleTracking(): void {
    const settle = settleCycle;
    settleCycle = null;
    cycleSettled = null;
    settle?.();
  }

  // ── Counter persistence ────────────────────────────────────────────────────

  function resetCumulativeCounters(): void {
    status.cycles = sinceStartCounters.cycles;
    status.notificationsSent = sinceStartCounters.notificationsSent;
    status.notificationsFailed = sinceStartCounters.notificationsFailed;
    status.eventsSkipped = sinceStartCounters.eventsSkipped;
    syncCounterSnapshots();
  }

  async function loadCounters(): Promise<void> {
    if (!countersFile) return;
    let raw: string;
    try {
      raw = await readFile(countersFile, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        resetCumulativeCounters();
        return;
      }
      Logger.warn(
        "poller",
        `[poller] could not read counters file at ${countersFile}: ${errorMessage(err)}; starting fresh`,
        { action: "counters_read_failed", countersFile, error: errorMessage(err) },
      );
      resetCumulativeCounters();
      return;
    }

    let parsed: CountersFile;
    try {
      parsed = parseCountersFile(raw);
    } catch (err) {
      const reason = errorMessage(err);
      Logger.warn(
        "poller",
        `[poller] counters file at ${countersFile} is corrupt or invalid (${reason}); starting fresh`,
        { action: "counters_corrupt", countersFile, reason },
      );
      resetCumulativeCounters();
      countersDirty = true;
      return;
    }

    if (
      parsed.contracts.marketContractId !== config.marketContractId ||
      parsed.contracts.squadContractId !== config.squadContractId
    ) {
      Logger.warn(
        "poller",
        `[poller] counters file contract ids changed ` +
          `(market ${parsed.contracts.marketContractId} -> ${config.marketContractId}, ` +
          `squad ${parsed.contracts.squadContractId} -> ${config.squadContractId}); ` +
          `starting fresh and resetting counters to 0`,
        {
          action: "counters_contract_changed",
          countersFile,
          previousMarketContractId: parsed.contracts.marketContractId,
          marketContractId: config.marketContractId,
          previousSquadContractId: parsed.contracts.squadContractId,
          squadContractId: config.squadContractId,
        },
      );
      resetCumulativeCounters();
      countersDirty = true;
      return;
    }

    status.cycles = parsed.counters.cycles + sinceStartCounters.cycles;
    status.notificationsSent =
      parsed.counters.notificationsSent + sinceStartCounters.notificationsSent;
    status.notificationsFailed =
      parsed.counters.notificationsFailed + sinceStartCounters.notificationsFailed;
    status.eventsSkipped = parsed.counters.eventsSkipped + sinceStartCounters.eventsSkipped;
    syncCounterSnapshots();
    countersDirty = false;
    Logger.info(
      "poller",
      `[poller] restored counters from ${countersFile}: ` +
        `cycles=${status.cycles} sent=${status.notificationsSent} ` +
        `failed=${status.notificationsFailed} skipped=${status.eventsSkipped}`,
      {
        action: "counters_restored",
        countersFile,
        counters: { ...status.cumulative },
      },
    );
  }

  async function saveCounters(reason: "cycle" | "shutdown"): Promise<boolean> {
    if (!countersFile) return true;
    syncCounterSnapshots();
    const payload = buildCountersFile(
      {
        marketContractId: config.marketContractId,
        squadContractId: config.squadContractId,
      },
      status.cumulative ?? {
        cycles: status.cycles,
        notificationsSent: status.notificationsSent,
        notificationsFailed: status.notificationsFailed,
        eventsSkipped: status.eventsSkipped,
      },
      new Date(now()).toISOString(),
    );

    try {
      await mkdir(path.dirname(countersFile), { recursive: true });
      const tmp = `${countersFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, countersFile);
      countersDirty = false;
      return true;
    } catch (err) {
      Logger.error(
        "poller",
        `[poller] could not persist counters (${reason}): ${errorMessage(err)}`,
        { action: "counters_persist_failed", reason, countersFile, error: errorMessage(err) },
      );
      return false;
    }
  }

  // ── Cursor persistence ─────────────────────────────────────────────────────

  async function loadCursors(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(config.cursorFile, "utf8");
    } catch (err) {
      const classified = classifyCursorFsError(err);
      if (classified.kind === "not_found") {
        status.cursorLoadError = null;
        console.log(
          `[poller] no cursor file at ${config.cursorFile}; cold start ` +
            `${config.startLookbackLedgers} ledgers behind the tip`,
        );
        return;
      }

      const detail = errorMessage(err);
      const isPermission = classified.kind === "permission";
      const action = isPermission ? "cursor_permission_denied" : "cursor_read_failed";
      const msg = isPermission
        ? `[poller] [${classified.diagnosticCode}] cursor directory or file permission failure reading ${config.cursorFile}` +
          `${classified.errnoCode ? ` (${classified.errnoCode})` : ""}: ${detail}; preserving existing file without quarantine`
        : `[poller] [${classified.diagnosticCode}] operational error reading cursor ${config.cursorFile}` +
          `${classified.errnoCode ? ` (${classified.errnoCode})` : ""}: ${detail}; preserving existing file without quarantine`;

      status.cursorLoadError = {
        kind: classified.kind,
        code: classified.diagnosticCode,
        ...(classified.errnoCode ? { errno: classified.errnoCode } : {}),
        message: msg,
      };

      Logger.error("poller", msg, {
        action,
        diagnosticCode: classified.diagnosticCode,
        ...(classified.errnoCode ? { errno: classified.errnoCode } : {}),
        cursorFile: config.cursorFile,
        error: detail,
      });
      return;
    }

    try {
      const result = parseAndMigrateCursorFile(raw, { now: () => new Date(now()) });
      status.cursorLoadError = null;
      const parsed = result.file;
      let fingerprintMigrated = false;
      for (const [source, saved] of Object.entries(parsed.targets)) {
        const key = source as ContractSource;
        const target = state.get(key);
        if (!target) continue;
        const expectedFingerprint = computeCursorTargetFingerprint(
          config.networkPassphrase,
          target.contractId,
        );
        if (saved.fingerprint !== undefined && saved.fingerprint !== expectedFingerprint) {
          // Network or contract configuration changed: never silently reuse an
          // incompatible cursor. Reset this target to cold start and rewrite
          // the new fingerprint before the first poll cycle.
          target.cursor = null;
          target.lastEventLedger = null;
          target.rewindFromLedger = null;
          target.cursorStale = false;
          dedup.set(key, new EventDedupWindow(config.dedupWindow));
          fingerprintMigrated = true;
          Logger.warn(
            "poller",
            `[poller] cursor target ${key} fingerprint mismatch ` +
              `(persisted ${saved.fingerprint.slice(0, 12)} != expected ${expectedFingerprint.slice(0, 12)}); ` +
              `ignoring incompatible cursor and starting cold (run 'npm run cursor -- migrate' for explicit migration)`,
            {
              action: "cursor_fingerprint_mismatch",
              source: key,
              contractId: target.contractId,
              expectedFingerprint,
              persistedFingerprint: saved.fingerprint,
              cursorFile: config.cursorFile,
            },
          );
          continue;
        }
        if (saved.fingerprint === undefined) {
          fingerprintMigrated = true;
        }
        target.cursor = saved.cursor ?? null;
        target.lastEventLedger = saved.lastEventLedger ?? null;
        // A rewind that was still pending when the process stopped resumes from
        // the same floor instead of falling back to a lookback cold start.
        target.rewindFromLedger = saved.rewindFromLedger ?? null;
        target.cursorStale = target.rewindFromLedger !== null;
        // Restore the redelivery window too. Without this a restart would
        // re-notify the last event the inclusive cursor hands back.
        dedup.set(key, EventDedupWindow.fromJSON(saved.recentEventIds, config.dedupWindow));
      }
      // Memory now equals the file; nothing is waiting to be flushed — unless
      // the file was a legacy shape or missing target fingerprints, which
      // start() rewrites before any cycle.
      status.pendingFlush = false;
      if (result.migrated || fingerprintMigrated) {
        pendingRewrite = true;
        markDirty();
        if (result.migrated) {
          console.log(
            `[poller] migrated cursor file from ${result.source} → ` +
              `schema v${CURSOR_SCHEMA_VERSION} at ${config.cursorFile}`,
          );
        } else {
          Logger.info(
            "poller",
            `[poller] bound cursor target fingerprints at ${config.cursorFile}`,
            { action: "cursor_fingerprint_migrated", cursorFile: config.cursorFile },
          );
        }
      }
      // Resume the chain clock alongside the cursors. Without this a restart
      // between two quiet scans would report `unknown` until the next event
      // happened to land, hiding a perfectly healthy (or long-stalled) chain.
      status.chainClockAt = parsed.chainClockAt ?? null;
      recoveryHistory = parsed.recoveryHistory ? [...parsed.recoveryHistory] : [];
      audit.record(
        auditEntry("cursor_loaded", {
          detail: [...state.values()].map((t) => `${t.source}@${t.cursor ?? "none"}`).join(" "),
        }),
      );
      Logger.info(
        "poller",
        `[poller] resumed from ${config.cursorFile}: ` +
          [...state.values()]
            .map((t) => `${t.source}@${cursorPreview(t.cursor)}`)
            .join(" "),
        {
          action: "resume",
          cursorFile: config.cursorFile,
          targets: [...state.values()].map((t) => ({
            source: t.source,
            cursorLedger: t.cursor ? eventCursorLedger(t.cursor) : null,
            lastEventLedger: t.lastEventLedger,
            rewindFromLedger: t.rewindFromLedger,
          })),
        },
      );
    } catch (err) {
      // Quarantine then cold-start: never wedge on a corrupt state file, and
      // keep the bad bytes for operators instead of overwriting them on save.
      const reason = errorMessage(err);
      status.cursorLoadError = {
        kind: "corrupt",
        code: "CURSOR_CORRUPT_JSON",
        message: `[poller] [CURSOR_CORRUPT_JSON] cursor file ${config.cursorFile} is corrupt: ${reason}`,
      };
      await quarantineCorruptCursorFile(config.cursorFile, reason);
      recoveryHistory = appendCursorRecoveryHistory(recoveryHistory, {
        at: new Date(now()).toISOString(),
        reason: "quarantine",
        before: {},
        after: snapshotCursorPositions(
          Object.fromEntries([...state.values()].map((t) => [t.source, t])),
        ),
      });
    }
  }

  /**
   * Record that in-memory cursor state has moved ahead of the file, so a
   * shutdown knows there is something to flush even if the cycle that moved it
   * never reaches its own write.
   */
  function markDirty(): void {
    status.pendingFlush = true;
  }

  async function saveCursors(reason: "cycle" | "shutdown" | "migration"): Promise<boolean> {
    const payload = buildCursorFile(
      [...state.values()].map((t) => ({
        source: t.source,
        cursor: t.cursor,
        lastEventLedger: t.lastEventLedger,
        recentEventIds: dedup.get(t.source)?.toJSON() ?? [],
        rewindFromLedger: t.rewindFromLedger,
        fingerprint: computeCursorTargetFingerprint(config.networkPassphrase, t.contractId),
      })),
      new Date(now()).toISOString(),
      status.chainClockAt,
      recoveryHistory,
    );

    try {
      await mkdir(path.dirname(config.cursorFile), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that sends the next start back to the beginning of the retained window.
      const tmp = `${config.cursorFile}.tmp`;
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tmp, config.cursorFile);
      // Copy the committed file to the backup. `copyFile` is not atomic
      // cross-filesystem, but the backup is always at least one generation
      // older than the primary — a crash here leaves the primary intact.
      const backupFile = `${config.cursorFile}.bak`;
      await copyFile(config.cursorFile, backupFile);
      status.pendingFlush = false;
      status.lastFlushAt = now();
      pendingRewrite = false;
      return true;
    } catch (err) {
      // `pendingFlush` is deliberately left as it was: if state was ahead of
      // the file it stays ahead, so a later cycle — or the shutdown flush —
      // retries. If nothing had changed, write-then-rename left the old file
      // intact and there is still nothing to flush.
      Logger.error(
        "poller",
        `[poller] could not persist cursor (${reason}): ${errorMessage(err)}`,
        { action: "cursor_persist_failed", reason, error: errorMessage(err) },
      );
      audit.recordError(err, "cursor_persist_failed");
      return false;
    }
  }

  // ── Stale cursor detection ─────────────────────────────────────────────────

  /**
   * Warn when a persisted cursor points to a ledger that has already fallen
   * behind the retained floor. Events in that gap will never be delivered.
   * This can happen after a long outage or an accidental ephemeral filesystem.
   */
  function checkStaleCursors(oldestLedger: number): void {
    for (const target of state.values()) {
      if (!target.cursor) continue;
      const cursorLedger = eventCursorLedger(target.cursor);
      if (cursorLedger === null) continue;

      const lag = oldestLedger - cursorLedger;
      if (lag > STALE_CURSOR_LEDGER_LAG) {
        console.warn(
          `[poller] STALE CURSOR — ${target.source} cursor is at ledger ${cursorLedger}, ` +
            `but the RPC only retains from ledger ${oldestLedger} ` +
            `(${lag} ledgers behind, ~${Math.round((lag * 5) / 60)} minutes of events lost). ` +
            `Events in the gap will not be posted. ` +
            `Delete ${config.cursorFile} to cold-start and resume from the current tip.`,
        );
        metrics?.staleCursorEvents.inc();
      }
    }
  }

  /**
   * Append buffered audit entries to the JSONL audit trail. Failure to audit
   * must never take the loop down (or even warn every cycle if the disk is
   * wedged): log once, drop the batch, keep running.
   */
  async function flushAudit(): Promise<void> {
    const pending = audit.flush();
    if (deps.persistAudit === false || pending.length === 0) return;
    // Some callers (tests, tooling) build a partial config with no auditFile.
    // In-memory auditing still works; there is simply nowhere to persist to.
    if (typeof config.auditFile !== "string" || config.auditFile === "") return;
    try {
      await appendAuditFile(config.auditFile, pending);
    } catch (err) {
      console.error(`[poller] could not append audit log: ${errorMessage(err)}`);
    }
  }

  // ── Status snapshot ────────────────────────────────────────────────────────

  /**
   * Write the machine-readable snapshot. Called after every cycle, and on
   * start/stop, so an operator reading the file always sees the last completed
   * cycle rather than a stale one from boot.
   */
  async function persistStatus(): Promise<void> {
    // Hand-built configs (tests, embedders) may not set a status file.
    if (!config.statusFile) return;
    await writeStatusFile(config.statusFile, snapshot());
  }

  function snapshot(): StatusSnapshot {
    syncCounterSnapshots();
    return buildStatusSnapshot(config, {
      ...status,
      targets: [...state.values()].map((t) => ({ ...t })),
    });
  }

  function recordCycleIncrement(): void {
    status.cycles += 1;
    sinceStartCounters.cycles += 1;
    countersDirty = true;
    syncCounterSnapshots();
  }

  function recordSentIncrement(count = 1): void {
    status.notificationsSent += count;
    sinceStartCounters.notificationsSent += count;
    countersDirty = true;
    syncCounterSnapshots();
  }

  function recordFailedIncrement(count = 1): void {
    status.notificationsFailed += count;
    sinceStartCounters.notificationsFailed += count;
    countersDirty = true;
    syncCounterSnapshots();
  }

  function recordSkippedIncrement(count = 1): void {
    status.eventsSkipped += count;
    sinceStartCounters.eventsSkipped += count;
    countersDirty = true;
    syncCounterSnapshots();
  }

  /**
   * Track whether a target's cursor is making progress.
   *
   * An unchanged cursor is only interesting when the walk is *behind* the tip:
   * a bot sitting within {@link CURSOR_STALL_MIN_LAG_LEDGERS} of `latestLedger`
   * is simply up to date, and a cold start that has not handed back a cursor yet
   * has nothing to compare against. Anything else means the RPC kept returning
   * the same resume token while the chain moved on, which is a pagination fault
   * rather than a quiet chain. The warning fires once per stall, not every cycle.
   */
  function trackCursorAdvance(
    target: TargetState,
    previousCursor: string | null,
    latestLedger: number,
  ): void {
    const cursor = target.cursor;
    if (!cursor) {
      target.cyclesWithoutAdvance = 0;
      target.cursorStalled = false;
      return;
    }

    const cursorLedger = eventCursorLedger(cursor);
    const lag = cursorLedger === null ? 0 : latestLedger - cursorLedger;
    const behindTip = lag >= CURSOR_STALL_MIN_LAG_LEDGERS;
    const advanced = previousCursor !== cursor;
    // The first cursor after a cold start is progress, not a stall.
    const firstAssignment = previousCursor === null;

    if (firstAssignment || advanced || !behindTip) {
      target.cyclesWithoutAdvance = 0;
      target.cursorStalled = false;
      return;
    }

    target.cyclesWithoutAdvance += 1;
    if (target.cyclesWithoutAdvance < CURSOR_STALL_CYCLES) return;

    if (!target.cursorStalled) {
      console.warn(
        `[poller] CURSOR STALLED — ${target.source} cursor has not advanced for ` +
          `${target.cyclesWithoutAdvance} successful cycles while ${lag} ledgers behind ` +
          `tip ${latestLedger}` +
          (cursorLedger !== null ? ` (cursor ledger ${cursorLedger})` : "") +
          `. Check RPC getEvents pagination; cursor file ${config.cursorFile} is intact. ` +
          `The bot will keep retrying; the chain remains the record.`,
      );
    }
    target.cursorStalled = true;
  }

  // ── One cycle ──────────────────────────────────────────────────────────────

  interface NotificationResult {
    sent: number;
    failed: number;
    skipped: number;
  }

  async function notify(
    events: DecodedEvent[],
    correlationId: string,
    ingested: NotificationIngestionMark = notificationAge.markIngested(now()),
  ): Promise<NotificationResult> {
    let sentThisCycle = 0;
    let failed = 0;
    let skipped = 0;
    let droppedForShutdown = 0;
    let capLogged = false;

    for (const event of events) {
      metrics?.eventsDecoded.inc();
      categoryCounter.record(event);

      if (isAdminPayload(event.payload)) {
        recordSkippedIncrement();
        metrics?.eventsSkipped.inc();
        skipped += 1;
        const adminAudit = toAdminAuditRecord(event, config);
        const adminPart = adminAudit?.admin ? ` admin=${boundedLabel(adminAudit.admin, 56)}` : "";
        console.log(
          `[poller] logged admin event "${boundedLabel(event.payload.name, 80)}"${adminPart} ` +
            `at ledger ${event.ledger}`,
        );
        continue;
      }

      if (event.payload.name === "unknown") {
        recordSkippedIncrement();
        metrics?.eventsSkipped.inc();
        skipped += 1;
        audit.record(
          auditEntry("event_skipped", {
            source: event.source,
            detail:
              `${event.payload.eventName} at ledger ${event.ledger}` +
              (event.payload.reason ? `: ${event.payload.reason}` : ""),
          }),
        );
        // Event name and reason come from remote contract data: bound them so
        // they cannot produce unbounded log output.
        console.log(
          `[poller] skipped ${event.source} event "${boundedLabel(event.payload.eventName, 80)}" ` +
            `at ledger ${event.ledger}` +
            (event.payload.reason ? ` (${boundedLabel(event.payload.reason, 160)})` : "") +
            ` correlation=${correlationId}`,
        );
        continue;
      }

      if (!isNotificationAllowed(config.featureFlags, event.source, event.payload.name)) {
        recordSkippedIncrement();
        metrics?.eventsSkipped.inc();
        metrics?.eventsFiltered.inc();
        metrics?.eventsFilteredFeatureFlag.inc();
        skipped += 1;
        console.log(
          `[poller] feature-flag skipped ${event.source} event "${boundedLabel(event.payload.name, 80)}" ` +
            `at ledger ${event.ledger} (NOTIFY_* flags)`,
        );
        continue;
      }

      // A shutdown keeps the drain bounded: messages that have not started are
      // dropped, counted, and left to the chain. The cursor still advances past
      // them below, so the next start does not replay them into the channel.
      if (status.stopping) {
        status.notificationsDropped += 1;
        droppedForShutdown += 1;
        continue;
      }

      // Formatting one event must never abort the rest of the batch: remote
      // event data is untrusted, so a malformed value is a skip, not a throw.
      // Only safe identifiers are logged — never the raw remote payload.
      let text: string | null;
      let extra: SendExtra | undefined;
      try {
        text = formatEvent(config, event);
        if (text !== null) {
          const reply_markup = explorerKeyboard(config, event);
          // Plain-text twin for the MarkdownV2 parse fallback in createNotifier.
          // Same event, no Markdown of any kind; the notifier sends it at most
          // once, only when Telegram rejects the entities. Cursor accounting
          // below is unchanged: either path counts as sent, neither as skipped.
          const plainText = formatPlainTextEvent(config, event);
          const eventRef = { eventId: event.eventId, ledger: event.ledger, source: event.source };
          const eventCategory =
            "category" in event.payload &&
            typeof event.payload.category === "string" &&
            event.payload.category.trim() !== ""
              ? event.payload.category
              : undefined;
          extra = {
            eventName: event.payload.name,
            ...(eventCategory ? { category: eventCategory } : {}),
            ...(reply_markup ? { reply_markup } : {}),
            ...(plainText !== null ? { plainText, eventRef } : {}),
          };
        }
      } catch (err) {
        recordSkippedIncrement();
        metrics?.eventsSkipped.inc();
        skipped += 1;
        Logger.error(
          "poller",
          `[poller] format failed for ${event.source} event at ledger ${event.ledger}: ` +
            errorMessage(err),
          {
            action: "format_failed",
            eventId: event.eventId,
            source: event.source,
            ledger: event.ledger,
            error: errorMessage(err),
          },
        );
        continue;
      }
      if (text === null) {
        recordSkippedIncrement();
        metrics?.eventsSkipped.inc();
        metrics?.eventsFiltered.inc();
        metrics?.eventsFilteredRule.inc();
        skipped += 1;
        audit.record(
          auditEntry("event_skipped", {
            source: event.source,
            detail: `${event.payload.name} at ledger ${event.ledger}: notifiable text was null`,
          }),
        );
        continue;
      }

      // Scheduled digest mode: buffer the event into the bounded checkpoint
      // instead of sending immediately; the scheduler flushes grouped digests.
      if (digestCheckpoint !== null) {
        digestCheckpoint.enqueue(event);
        continue;
      }

      if (sentThisCycle >= config.maxNotificationsPerCycle) {
        recordSkippedIncrement();
        metrics?.eventsSkipped.inc();
        skipped += 1;
        // One summary line per cycle names the knob; each drop is still logged.
        if (!capLogged) {
          capLogged = true;
          console.warn(
            `[poller] MAX_NOTIFICATIONS_PER_CYCLE cap (${config.maxNotificationsPerCycle}) reached ` +
              `this cycle — remaining events skipped. ` +
              `Raise MAX_NOTIFICATIONS_PER_CYCLE or wait for the next cycle. ` +
              `Cursor still advances; the chain is the record.`,
          );
        }
        audit.record(
          auditEntry("cap_reached", {
            source: event.source,
            detail:
              `${event.payload.name} at ledger ${event.ledger} dropped; ` +
              `cap is ${config.maxNotificationsPerCycle} per cycle`,
          }),
        );
        Logger.warn(
          "poller",
          `[poller] cycle notification cap (${config.maxNotificationsPerCycle}) reached; ` +
            `dropping ${event.payload.name} at ledger ${event.ledger} correlation=${correlationId}`,
          {
            action: "notification_cap_reached",
            maxNotificationsPerCycle: config.maxNotificationsPerCycle,
            droppedEvent: event.payload.name,
            source: event.source,
            ledger: event.ledger,
          },
        );
        continue;
      }

      // Crash recovery: an event that may already have been sent is treated as
      // committed (the existing lossy cursor-commit policy) so a crash between
      // sendMessage and the cursor commit never duplicates a notification.
      if (sendJournal && maybeSent.has(event.eventId)) {
        status.eventsSkipped += 1;
        skipped += 1;
        try {
          await sendJournal.recordDone(event.eventId);
        } catch (err) {
          console.error(
            `[poller] send journal done failed for ${event.eventId}: ${safeErrorMessage(err)}`,
          );
        }
        continue;
      }

      // Record intent before the send so a crash between sendMessage and the
      // cursor commit is detectable on restart instead of guessed at.
      if (sendJournal) {
        try {
          const textHash = createHash("sha256")
            .update(text)
            .digest("hex")
            .slice(0, 16);
          await sendJournal.recordIntent({
            id: event.eventId,
            source: event.source,
            ledger: event.ledger,
            eventName: event.payload.name,
            textHash,
            chatId: resolveRouteChatId(config, event.source),
            networkPassphrase: config.networkPassphrase,
            at: now(),
          });
        } catch (err) {
          console.error(
            `[poller] send journal intent failed for ${event.eventId}: ${safeErrorMessage(err)}`,
          );
        }
      }

      try {
        // Use bounded retry for Telegram sends to handle transient failures
        await sendWithRetry(
          (message) => send(message, event.source, extra),
          text,
          config.botToken,
          sendOptions,
          () => !status.stopping,
          sleep,
        );
        recordSentIncrement();
        metrics?.notificationsSent.inc();
        const ageMs =
          hasCustomWallClock && !hasCustomMonotonicClock
            ? notificationAge.record(event.at, Math.max(ingested.wallMs, now()))
            : notificationAge.recordFromIngestion(event.at, ingested);
        metrics?.recordNotificationAge(ageMs);
        status.notificationAge = notificationAge.summary();
        sentThisCycle += 1;
        if (sendJournal) {
          try {
            await sendJournal.recordDone(event.eventId);
          } catch (err) {
            console.error(
              `[poller] send journal done failed for ${event.eventId}: ${safeErrorMessage(err)}`,
            );
          }
        }
      } catch (err) {
        // All retries exhausted. The event still counts as failed and the cursor
        // still advances — but the message is parked instead of dropped, so a
        // transient Telegram outage costs a delay rather than the notification.
        if (sendJournal && err instanceof InvalidDeliveryResultError) {
          try {
            await sendJournal.recordInvalidResult(
              event.eventId,
              safeErrorMessage(err, [config.botToken]),
            );
          } catch (journalErr) {
            console.error(
              `[poller] send journal diagnostic failed for ${event.eventId}: ${safeErrorMessage(journalErr)}`,
            );
          }
        }
        recordFailedIncrement();
        metrics?.notificationsFailed.inc();
        failed += 1;
        audit.recordError(err, "send_failed", {
          source: event.source,
          detail: `${event.payload.name} at ledger ${event.ledger}`,
        });
        // Same routing as the notifier: a per-source chat, else the default.
        const chat =
          (event.source === "market" ? config.marketChatId : config.squadChatId) ||
          config.chatId ||
          config.chatIds?.[0];
        const permanentReason = classifyPermanentSendError(err);
        console.error(
          `[poller] send failed for ${event.payload.name} at ledger ${event.ledger}` +
            `${chat ? ` to chat ${chat}` : ""}` +
            `${permanentReason ? ` (reason=${permanentReason})` : " after retries"}: ` +
            `${errorMessage(err)} correlation=${correlationId}`,
        );
        if (isForumTopicClosed(err)) {
          // Permanent route failure: the topic is closed or deleted. Retrying
          // will produce the same 400, so the message is not parked in the DLQ.
          // The cursor still advances and the failure is counted above. The
          // operator must re-open the topic (or update the route) to restore
          // delivery; unrelated topic routes remain operational.
          console.error(
            `[poller] permanent route failure for ${event.payload.name} at ledger ${event.ledger}` +
              `${chat ? ` to chat ${chat}` : ""}: forum topic is closed or not found — ` +
              `not queuing for retry (update the route to restore delivery)`,
          );
        } else if (deadLetterEnabled) {
          await deadLetter.enqueue({
            source: event.source,
            ledger: event.ledger,
            eventName: event.payload.name,
            text,
            error: err,
          });
          refreshDeadLetterStatus();
        }
      }

      // Rate-limit spacing is the last thing a draining cycle should wait for.
      if (!status.stopping && sentThisCycle < config.maxNotificationsPerCycle && sendSpacing > 0) {
        await sleep(sendSpacing);
      }
    }

    if (droppedForShutdown > 0) {
      console.warn(
        `[poller] shutdown drain dropped ${droppedForShutdown} unsent notification(s); ` +
          `the cursor still advances so they are not replayed`,
      );
    }

    if (digestCheckpoint !== null) {
      await digestCheckpoint.flush();
    }

    return { sent: sentThisCycle, failed, skipped };
  }

  /**
   * Replay parked sends before this cycle's events so a recovered channel
   * catches up in order. Budgeted by the per-cycle cap so one recovery cannot
   * flood the chat; never throws into the cycle.
   */
  async function flushDeadLetter(): Promise<void> {
    if (!deadLetterEnabled || status.stopping) return;
    try {
      const flushed = await deadLetter.flush(async (text, entry) => {
        await sendWithRetry(
          (message) => send(message, entry.source as ContractSource),
          text,
          config.botToken,
          sendOptions,
          () => !status.stopping,
          sleep,
        );
      }, Math.max(0, config.maxNotificationsPerCycle));
      if (flushed.sent > 0) {
        recordSentIncrement(flushed.sent);
        for (let i = 0; i < flushed.sent; i += 1) metrics?.notificationsSent.inc();
      }
    } catch (err) {
      console.error(`[poller] dead-letter flush threw: ${errorMessage(err)}`);
    }
    refreshDeadLetterStatus();
  }

  /**
   * Rewind a stale cursor to the RPC's retained floor — but only when a fresh
   * `getHealth()` *proves* the cursor sits below it. Returns the floor it moved
   * the position to, or `null` when it moved nothing (no cursor, an unreadable
   * window, a position it cannot place, or a spent rewind budget), so callers
   * can report a *proven* recovery rather than an attempt.
   *
   * The floor is the oldest ledger the RPC still serves, so everything below it
   * is already unrecoverable: keeping the cursor would fail every scan forever,
   * while resuming at the floor loses nothing that is still readable. The
   * rewind never guesses — an opaque cursor, an ahead-of-tip cursor, or a
   * window that cannot be read is left untouched and the bounded RPC error is
   * surfaced. It is bounded by `MAX_FLOOR_REWINDS` per target so a misbehaving
   * RPC cannot thrash, and every line it logs is a bounded ledger number or a
   * bounded error string — never a raw payload or a token.
   */
  async function rewindFromRetainedFloor(
    target: WatchTarget,
    current: TargetState,
  ): Promise<number | null> {
    const cursor = current.cursor;
    // Nothing to rewind: a cold start or a rewind already in flight.
    if (cursor === null) return null;

    let window: LedgerWindow;
    try {
      window = validateLedgerWindow(
        await withTimeout(Promise.resolve(server.getHealth()), SCAN_TIMEOUT_MS, "RPC health"),
      );
    } catch (err) {
      console.warn(
        `[poller] ${target.source}: stale cursor; could not read the retained window to rewind ` +
          `safely (${errorMessage(err)}); cursor left unchanged`,
      );
      return null;
    }

    if (resumeCursorProblem(cursor, window) !== "cursor-before-floor") {
      // Not provably below the floor: keep the cursor. Opaque cursors land here
      // too, so an unknown cursor shape is forwarded rather than guessed at —
      // but record *why*, because "cannot be placed" and "inside the window"
      // must not look the same from `/status` or `GET /health`.
      if (eventCursorLedger(cursor) === null) current.cursorUnreadable = true;
      console.error(
        `[poller] ${target.source} cursor could not be placed below the retained floor; ` +
          `keeping it — delete ${config.cursorFile} to cold-start ` +
          `(no events are skipped until then)`,
      );
      return null;
    }

    const attempts = rewindAttempts.get(target.source) ?? 0;
    if (attempts >= MAX_FLOOR_REWINDS) {
      console.error(
        `[poller] ${target.source}: cursor is below the retained floor ${window.oldestLedger} ` +
          `and the auto-rewind budget (${MAX_FLOOR_REWINDS}) is spent; operator action required`,
      );
      return null;
    }

    const cursorLedger = eventCursorLedger(cursor);
    const missed = cursorLedger === null ? 0 : Math.max(0, window.oldestLedger - cursorLedger);
    rewindAttempts.set(target.source, attempts + 1);
    const at = now();
    const beforePosition: CursorRecoveryPosition = {
      cursor: current.cursor,
      lastEventLedger: current.lastEventLedger,
      ...(typeof current.rewindFromLedger === "number"
        ? { rewindFromLedger: current.rewindFromLedger }
        : {}),
    };
    current.cursor = null;
    current.lastEventLedger = null;
    current.rewindFromLedger = window.oldestLedger;
    recoveryHistory = appendCursorRecoveryHistory(recoveryHistory, {
      at: new Date(at).toISOString(),
      reason: "floor_rewind",
      source: target.source,
      before: { [target.source]: beforePosition },
      after: {
        [target.source]: {
          cursor: current.cursor,
          lastEventLedger: current.lastEventLedger,
          rewindFromLedger: current.rewindFromLedger,
        },
      },
    });
    // The position becomes a floor walk, so any "could not be read" flag it
    // carried is spent. The gap itself is what an operator needs, and it is
    // recorded once per occurrence: after the rewind the position *is* the
    // floor, which is inside the window, so a second report takes another
    // restart (or another outage) behind a floor that has moved on again.
    current.cursorUnreadable = false;
    current.gapLedgers = missed;
    current.cursorResetAt = at;
    status.cursorRewinds += 1;
    status.restartGaps += 1;
    status.lastRestartGap = {
      at,
      source: target.source,
      cursorLedger: cursorLedger ?? window.oldestLedger,
      oldestLedger: window.oldestLedger,
      missedLedgers: missed,
    };
    const gapKey = `${target.source}:${cursorLedger ?? window.oldestLedger}:${window.oldestLedger}`;
    if (!notifiedGaps.has(gapKey)) {
      notifiedGaps.add(gapKey);
      if (deps.notifyOperator && config.operatorTelegramUserId) {
        const alertText = formatRestartGapAlert({
          source: target.source,
          cursorLedger: cursorLedger ?? window.oldestLedger,
          oldestLedger: window.oldestLedger,
        });
        void deps.notifyOperator(alertText).catch((err) => {
          console.error(`[poller] failed to notify operator of restart gap: ${safeErrorMessage(err)}`);
        });
      }
    }
    markDirty();
    console.warn(
      `[poller] ${target.source}: restart gap — cursor at ledger ${cursorLedger} is ` +
        `${missed} ledger(s) below the retained floor; ` +
        `rewinding to the floor ${window.oldestLedger} ` +
        `(auto-rewind ${attempts + 1}/${MAX_FLOOR_REWINDS})`,
    );
    return window.oldestLedger;
  }

  /**
   * Place one target's resume position against the floor the last successful
   * scan proved, and recover when it has fallen out of the window.
   *
   * This runs *before* the scan, which is the point: the poller already reacts
   * to an RPC rejection, but a below-floor position that Soroban answers with
   * an empty page advances nothing, logs nothing and is retried every cycle
   * forever. The comparison costs one `eventCursorLedger` and no request —
   * the floor is whatever a successful scan already reported, so there is
   * nothing to guess and nothing extra to ask for — and it cannot fire for a
   * position this build cannot read.
   *
   * Recovery stays `rewindFromRetainedFloor`: it re-reads `getHealth()` and
   * refuses to move a cursor it cannot place below the floor.
   */
  async function enforceCursorWindow(
    target: WatchTarget,
    current: TargetState,
  ): Promise<void> {
    const verdict = classifyCursorWindow(current.cursor, status.oldestLedger);

    if (verdict.status === "unreadable") {
      if (!current.cursorUnreadable) {
        current.cursorUnreadable = true;
        console.warn(
          `[poller] ${current.source}: persisted cursor has no readable ledger ` +
            `position; leaving it untouched and letting the RPC accept or reject it`,
        );
      }
      return;
    }

    if (verdict.status === "no-cursor" || verdict.status === "inside") {
      // A position this build can read, inside the window: whatever could not
      // be read before is no longer the position this target holds.
      current.cursorUnreadable = false;
      return;
    }

    // `unknown-floor` is not evidence of anything, and `stale` is the gap.
    if (verdict.status !== "stale") return;
    await rewindFromRetainedFloor(target, current);
  }

  async function cycle(): Promise<number | void> {
    if (inFlight) return;
    inFlight = true;
    let explicitBackoff: number | null = null;
    beginCycleTracking();
    recordCycleIncrement();
    const correlationId = randomUUID();
    status.lastCorrelationId = correlationId;
    const currentTime = now();
    status.lastPollAt = currentTime;
    metrics?.pollCycles.inc();

    // A cycle gets a fresh view of the chain tip; every target in this cycle
    // reuses it instead of each paying for its own `getHealth()`.
    ledgerCache.reset();

    // ── Circuit breaker check ─────────────────────────────────────────────────────
    const probeDecision = circuitBreaker.allowRequest(rpcEndpoint);
    syncCircuitBreakerStatus();
    if (!probeDecision.allowed) {
      if (probeDecision.state === "open") {
        const elapsedMs = Math.max(0, circuitCooldown - probeDecision.remainingCooldownMs);
        console.log(
          `[poller] circuit breaker open for ${probeDecision.endpoint}, skipping RPC calls (${Math.round(elapsedMs / 1000)}s/${Math.round(circuitCooldown / 1000)}s elapsed)`,
        );
      } else {
        console.log(
          `[poller] circuit breaker half-open for ${probeDecision.endpoint}, skipping RPC calls (recovery probe already in flight)`,
        );
      }
      status.targets = [...state.values()].map((t) => ({ ...t }));
      inFlight = false;
      endCycleTracking();
      return;
    }
    const isHalfOpenProbe = probeDecision.isProbe;
    if (isHalfOpenProbe) {
      console.log(
        `[poller] circuit breaker cooldown elapsed for ${probeDecision.endpoint}, entering half-open state with 1 bounded recovery probe`,
      );
    }
    let probeAttempted = false;

    let anyOk = false;
    let cyclePages = 0;
    let cycleEmptyPages = 0;
    let cycleFailures = 0;
    let cycleScans = 0;
    // Events handed back by every successful scan in this cycle. Compared with
    // the rolling baseline only when every target was scanned, so a target in
    // backoff cannot make a normal cycle look quiet.
    let cycleEvents = 0;
    const cycleTargets: Record<ContractSource, CycleTargetSummary> = {
      market: {
        source: "market",
        fetched: 0,
        decoded: 0,
        sent: 0,
        skipped: 0,
        cursorLedger: state.get("market")?.cursor
          ? eventCursorLedger(state.get("market")!.cursor!)
          : null,
      },
      squad: {
        source: "squad",
        fetched: 0,
        decoded: 0,
        sent: 0,
        skipped: 0,
        cursorLedger: state.get("squad")?.cursor
          ? eventCursorLedger(state.get("squad")!.cursor!)
          : null,
      },
    };

    // Drain parked sends before this cycle's events, so a recovered channel
    // catches up in order. Budgeted like the burst below: one recovery must
    // not flood the chat.
    await flushDeadLetter();

    try {
      // Pace each contract independently: scan them sequentially but do not let
      // a failure in one block the others. This ensures that if the "squad"
      // contract is unreachable, the "market" contract is still polled.
      for (const target of targets) {
        const current = state.get(target.source);
        if (!current) continue;
        const previousFailed = current.lastError !== null;

        // Per-target RPC backoff check: skip if in backoff window
        if (current.nextEligibleAt !== null && currentTime < current.nextEligibleAt) {
          const remainingMs = current.nextEligibleAt - currentTime;
          console.log(
            `[poller] ${target.source}: skipping RPC scan (in backoff for another ${Math.ceil(remainingMs / 1000)}s)`,
          );
          continue;
        }

        if (isHalfOpenProbe) {
          probeAttempted = true;
        }

        const targetStartedAt = now();
        try {
          // Before asking for events, place the resume position against the last
          // floor a successful scan reported: below it, the events are already
          // unrecoverable whether or not the RPC says so in an error.
          await enforceCursorWindow(target, current);

          const dedupWindow = dedup.get(target.source) ?? new EventDedupWindow(0);
          const rewinding = current.rewindFromLedger !== null;
          // Read before the scan: the scan is what assigns the new cursor, and
          // an unchanged value is exactly what a stall looks like.
          const previousCursor = current.cursor;
          // Shared per-cycle tip: the first target fetches it, the rest reuse
          // it. A failed fetch is not cached, so this target fails on its own
          // and a later target still retries. Bounded by the same scan budget,
          // so a wedged `getHealth()` cannot stall the cycle.
          const tip = await withTimeout(ledgerCache.get(server), SCAN_TIMEOUT_MS, "RPC health");
          const scan = await withTimeout(
            readContractEvents(server, target, {
              ledgerTip: tip,
              // A pending floor rewind resumes by ledger, never by the stale
              // cursor the RPC already rejected (`cursor` and `startLedger` are
              // mutually exclusive in one request).
              cursor: rewinding ? undefined : current.cursor ?? undefined,
              startLedger: rewinding ? current.rewindFromLedger ?? undefined : undefined,
              lookbackLedgers:
                !rewinding && current.cursor === null ? config.startLookbackLedgers : undefined,
              seenEventIds: dedupWindow.toJSON(),
              dedupWindow: config.dedupWindow,
              maxPages: isHalfOpenProbe ? 1 : undefined,
              shouldDecode: (name) => isNotificationAllowed(config.featureFlags, target.source, name),
              rpcLatency,
            }),
            SCAN_TIMEOUT_MS,
            "RPC scan",
          );

          metrics?.rpcRequests.inc();
          // Stale-cursor check runs on every successful scan so it catches the
          // condition even when the cursor has not moved (empty pages).
          checkStaleCursors(scan.oldestLedger);
          status.latestLedger = scan.latestLedger;
          status.oldestLedger = scan.oldestLedger;
          current.lastError = null;
          current.cursorStale = false;
          current.consecutiveFailures = 0;
          current.nextEligibleAt = null;
          anyOk = true;

          cycleScans += 1;
          cycleEvents += scan.events.length;
          cyclePages += scan.pages;
          cycleEmptyPages += scan.emptyPages;
          status.pagesScanned += scan.pages;
          status.emptyPages += scan.emptyPages;

          if (previousFailed) {
            audit.record(
              auditEntry("cycle_recovered", {
                source: target.source,
                detail: `scan ok after failure; cursor ${current.cursor ?? "none"}`,
              }),
            );
          }

          if (rewinding) {
            // The walk is back from the floor: once it hands back a resume
            // cursor the transient hint is no longer needed.
            console.log(
              `[poller] ${target.source}: floor rewind resumed from ledger ` +
                `${scan.startLedger ?? "unknown"}`,
            );
            if (typeof scan.cursor === "string" && scan.cursor.length > 0) {
              current.rewindFromLedger = null;
              markDirty();
            }
          }

          // Budget reset: only a scan that lands back inside the retained
          // window counts as recovery. A cursor still below the floor keeps the
          // budget spent, so a thrashing RPC exhausts it instead of looping.
          const resumeLedger = scan.cursor ? eventCursorLedger(scan.cursor) : null;
          if (resumeLedger === null || resumeLedger >= scan.oldestLedger) {
            rewindAttempts.set(target.source, 0);
          }

          // Advance the chain clock from close times the RPC actually reported.
          // `at` is 0 when the RPC omitted `ledgerClosedAt`, which is not an
          // error, and a value outside the plausible window is malformed and must
          // never be adopted. The update is monotonic: the two contracts are
          // scanned in turn, so a rescan or reordering must never move the clock
          // backwards. A quiet or failed scan keeps the last observed value, which
          // is what makes a long outage show up as a growing skew rather than as
          // a clock that keeps time on its own.
          let implausibleCloseTime = false;
          for (const event of scan.events) {
            if (event.at === 0) continue;
            const closedAtMs = event.at * 1_000;
            if (!isPlausibleChainClock(closedAtMs)) {
              implausibleCloseTime = true;
              continue;
            }
            if (status.chainClockAt === null || closedAtMs > status.chainClockAt) {
              status.chainClockAt = closedAtMs;
              markDirty();
            }
          }
          if (implausibleCloseTime) {
            // One bounded line per target per cycle: no payload, no remote text.
            console.warn(
              `[poller] ${target.source}: ignored an implausible chain close time; chain clock unchanged`,
            );
          }

          // Reset circuit breaker on success (closes half-open probe or clears closed failures)
          const prevFailures = status.circuitBreaker.failureCount;
          const wasHalfOpen = status.circuitBreaker.state === "half-open";
          if (prevFailures > 0 || wasHalfOpen) {
            console.log(
              wasHalfOpen
                ? `[poller] half-open recovery probe succeeded for ${rpcEndpoint}, closing circuit breaker`
                : `[poller] RPC succeeded, resetting circuit breaker (was at ${prevFailures} failures)`,
            );
          }
          circuitBreaker.recordSuccess(rpcEndpoint);
          syncCircuitBreakerStatus();

          if (scan.duplicates > 0) {
            status.eventsDeduplicated += scan.duplicates;
            console.log(
              `[poller] ${target.source}: suppressed ${scan.duplicates} duplicate event(s) ` +
                `from an overlapping page or a resumed cursor`,
            );
          }

          let delivery: NotificationResult = { sent: 0, failed: 0, skipped: 0 };
          // Record what the walk read BEFORE notifying: an event is
          // "processed" once it is read, so a crash between send and save
          // cannot replay it. The keys come from the reader's own window —
          // derived from raw responses, where topic content still exists —
          // because a decoded event alone cannot always re-derive the same
          // key (it carries no `topic`), and an id-less event would otherwise
          // never be recorded.
          for (const id of scan.seenEventIds) dedupWindow.add(id);
          if (deps.onDecodedEvent !== undefined) {
            for (const event of scan.events) deps.onDecodedEvent(event);
          }
          if (scan.events.length > 0) {
            const ingested = notificationAge.markIngested(now());
            markDirty();
            delivery = await notify(scan.events, correlationId, ingested);
            const skippedText = delivery.skipped > 0 ? ` (${delivery.skipped} skipped)` : "";
            console.log(
              `[poller] ${target.source}: ${scan.events.length} event(s) ` +
                `up to ledger ${scan.lastEventLedger} in ${scan.pages} page(s)` +
                (scan.emptyPages > 0 ? ` (${scan.emptyPages} empty)` : "") +
                skippedText,
            );
          } else {
            // Always surface page telemetry: empty pages are the Soroban
            // norm, and silence on a zero-event walk hid whether the scanner
            // kept walking at all.
            console.log(
              `[poller] ${target.source}: no events in ${scan.pages} page(s) ` +
                `(${scan.emptyPages} empty)` +
                (scan.truncated ? " [truncated]" : ""),
            );
          }

          if (scan.lastEventLedger !== null && scan.lastEventLedger !== current.lastEventLedger) {
            current.lastEventLedger = scan.lastEventLedger;
            markDirty();
          }
          // The opaque cursor covers the whole returned page, so it cannot be
          // committed per event. Commit after processing the page, including
          // deliberate drops, to avoid replaying a permanent Telegram failure.
          if (scan.cursor && scan.cursor !== current.cursor) {
            current.cursor = scan.cursor;
            // The RPC accepted the resume position and moved it, so whatever
            // could not be read locally is no longer the position we hold.
            current.cursorUnreadable = false;
            markDirty();
            if (delivery.failed > 0 || delivery.skipped > 0) {
              console.warn(
                `[poller] ${target.source}: committed cursor after partial delivery ` +
                  `(sent=${delivery.sent}, failed=${delivery.failed}, skipped=${delivery.skipped})`,
              );
            }
          }

          const newest = scan.events[scan.events.length - 1];
          if (newest !== undefined) current.lastEvent = newest;
          if (scan.events.length > 0) recentEvents.record(scan.events);

          const decodedCount = scan.events.reduce(
            (acc, event) => (event.payload.name !== "unknown" ? acc + 1 : acc),
            0,
          );
          cycleTargets[target.source] = {
            source: target.source,
            fetched: scan.events.length,
            decoded: decodedCount,
            sent: delivery.sent,
            skipped: delivery.skipped,
            cursorLedger: current.cursor ? eventCursorLedger(current.cursor) : null,
          };

          trackCursorAdvance(current, previousCursor, scan.latestLedger);

          if (isHalfOpenProbe) {
            // Bounded recovery probe succeeded: leave remaining targets for the
            // next cycle so the recovering endpoint does not receive full load.
            break;
          }
        } catch (err) {
          cycleFailures++;
          metrics?.rpcErrors.inc();
          current.consecutiveFailures += 1;
          const delayMs = Math.min(
            targetInitialBackoff * Math.pow(targetBackoffFactor, current.consecutiveFailures - 1),
            targetMaxBackoff,
          );
          current.nextEligibleAt = currentTime + delayMs;
          const message = errorMessage(err);
          const staleCursor = isStaleCursorError(message);
          current.lastError = message;
          if (staleCursor) current.cursorStale = true;
          status.lastError = { at: currentTime, message: `${target.source}: ${message}` };
          audit.recordError(err, "cycle_failed", { source: target.source });
          logSampledError(
            `scan:${target.source}`,
            `[poller] ${target.source} scan failed${staleCursor ? " (stale cursor)" : ""}: ${message}`,
            {
              action: "scan_failed",
              source: target.source,
              staleCursor,
              error: message,
            },
          );
          if (staleCursor) {
            audit.record(
              auditEntry("stale_cursor", {
                source: target.source,
                detail:
                  `cursor below the RPC's retained window; ` +
                  `checking the retained floor before any rewind`,
              }),
            );
            // A stale rejection is the only hint; the rewind itself is gated on
            // a fresh getHealth() that proves the cursor is below the floor.
            // Only bounded metadata is logged — never a token or RPC payload.
            await rewindFromRetainedFloor(target, current);
          }

          cycleTargets[target.source].cursorLedger = current.cursor
            ? eventCursorLedger(current.cursor)
            : null;

          const retryAfterMs = extractRetryAfterMs(err, targetMaxBackoff);
          if (retryAfterMs !== null) {
            console.warn(`[poller] RPC requested backoff for ${retryAfterMs}ms`);
            explicitBackoff = retryAfterMs;
          }

          if (isHalfOpenProbe) {
            circuitBreaker.recordFailure(rpcEndpoint, 1);
            syncCircuitBreakerStatus();
            console.error(
              `[poller] half-open recovery probe failed for ${rpcEndpoint}, re-opening circuit breaker`,
            );
            break;
          }

          if (retryAfterMs !== null) {
            break; // Stop scanning other targets, they will likely hit the same limit
          }
        } finally {
          const measured = now() - targetStartedAt;
          const elapsed = Number.isFinite(measured) && measured > 0 ? measured : 0;
          current.lastCycleMs = elapsed;
          current.maxCycleMs = Math.max(current.maxCycleMs, elapsed);
        }
      }

      // Per-cycle page telemetry for /status (all targets in this cycle).
      status.lastCyclePages = cyclePages;
      status.lastCycleEmptyPages = cycleEmptyPages;

      // ── Circuit breaker state update ─────────────────────────────────────────────
      if (isHalfOpenProbe && !probeAttempted) {
        circuitBreaker.releaseProbe(rpcEndpoint);
        syncCircuitBreakerStatus();
      } else if (!isHalfOpenProbe && cycleFailures > 0) {
        const wasOpen = status.circuitBreaker.open;
        circuitBreaker.recordFailure(rpcEndpoint, cycleFailures);
        syncCircuitBreakerStatus();

        if (status.circuitBreaker.open && !wasOpen) {
          console.error(
            `[poller] circuit breaker opened for ${rpcEndpoint} after ${status.circuitBreaker.failureCount} failures (threshold: ${circuitThreshold})`,
          );
        }
      }

      if (anyOk) {
        status.lastSuccessAt = now();
        status.consecutiveFailures = 0;
        metrics?.consecutiveFailures.set(0);

        // Compare this cycle's activity with what recent complete cycles
        // looked like. Incomplete cycles are skipped rather than recorded at a
        // lower count: an RPC backoff is not a quiet chain.
        if (cycleScans === targets.length) {
          const comparison = activityBaseline.record(cycleEvents);
          status.activityBaseline = activityBaseline.snapshot();
          metrics?.lastCycleEvents.set(cycleEvents);
          if (comparison.mean !== null) {
            metrics?.activityBaselineEvents.set(Math.round(comparison.mean));
          }
          if (comparison.anomalous) {
            metrics?.activityAnomalies.inc();
            // Counts only: no event payloads, cursors, or RPC text. One line
            // per anomalous cycle, which is exactly when an operator wants it.
            console.warn(
              `[poller] activity ${comparison.deviation}: ${cycleEvents} event(s) this cycle ` +
                `vs baseline mean ${(comparison.mean ?? 0).toFixed(1)} ` +
                `(z=${(comparison.zScore ?? 0).toFixed(2)}, ${comparison.samples} prior cycles)`,
            );
          }
        }
      } else {
        status.consecutiveFailures += 1;
        metrics?.consecutiveFailures.set(status.consecutiveFailures);
        emitCircuitBreakerWarning();
      }

      const durationMs = Math.max(0, now() - currentTime);
      const isIdleCycle =
        cycleFailures === 0 &&
        Object.values(cycleTargets).every(
          (t) => t.fetched === 0 && t.decoded === 0 && t.sent === 0 && t.skipped === 0,
        );
      const sample = isIdleCycle ? errorSampler.record("cycle:idle") : { log: true, suppressed: 0 };
      if (sample.log) {
        const m = cycleTargets.market;
        const s = cycleTargets.squad;
        const summaryFields: CycleSummaryFields = {
          action: "cycle_summary",
          cycle: status.cycles,
          durationMs,
          targets: cycleTargets,
          suppressed: sample.suppressed,
        };
        Logger.info(
          "poller",
          `[poller] cycle #${status.cycles} in ${durationMs}ms ` +
            `market(fetched=${m.fetched} decoded=${m.decoded} sent=${m.sent} skipped=${m.skipped} cursorLedger=${m.cursorLedger ?? "none"}) ` +
            `squad(fetched=${s.fetched} decoded=${s.decoded} sent=${s.sent} skipped=${s.skipped} cursorLedger=${s.cursorLedger ?? "none"})` +
            formatSuppressedRepeats(sample.suppressed, errorSampler.windowMs),
          summaryFields as unknown as Record<string, unknown>,
        );
      }
    } finally {
      // The write and the tracking promise are what a shutdown waits for, so
      // they run even when the body above threw.
      try {
        status.targets = [...state.values()].map((t) => ({ ...t }));
        status.rpcLatency = rpcLatency.snapshot();
        await saveCounters("cycle");
        await saveCursors("cycle");
        await persistStatus();
      } finally {
        inFlight = false;
        endCycleTracking();
      }
      await flushAudit();
      if (explicitBackoff !== null) return explicitBackoff;
    }
  }

  function schedule(delayMs: number): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void loop();
    }, delayMs);
  }

  /**
   * Emit a structured warning at each consecutive-failure threshold.
   * The warning is emitted exactly once per threshold crossing (not every cycle),
   * which makes it grep-able and avoids log spam during a long outage.
   */
  function emitCircuitBreakerWarning(): void {
    const n = status.consecutiveFailures;
    if (!CONSECUTIVE_FAILURE_THRESHOLDS.includes(n)) return;

    const lastMsg = status.lastError?.message ?? "unknown";
    // Clip the error message: it could contain unbounded RPC response text.
    const safeMsg = clip(lastMsg, 200);
    console.warn(
      `[poller] CONSECUTIVE FAILURES: ${n} full cycles failed in a row. ` +
        `Last error: ${safeMsg}. ` +
        `Check RPC connectivity (${config.rpcUrl}) and Telegram bot status. ` +
        `The cursor is safe; the bot will resume automatically when the error clears.`,
    );
  }

  async function loop(): Promise<void> {
    if (stopped || paused || inFlight) return;
    let nextDelay = config.pollIntervalMs;
    try {
      const delay = await cycle();
      if (typeof delay === "number" && delay > nextDelay) {
        nextDelay = delay;
      }
    } catch (err) {
      // Belt and braces: `cycle` already swallows per-target failures, so
      // this only fires on a bug. Either way the loop survives it.
      status.consecutiveFailures += 1;
      metrics?.consecutiveFailures.set(status.consecutiveFailures);
      emitCircuitBreakerWarning();
      status.lastError = { at: now(), message: errorMessage(err) };
      audit.recordError(err, "cycle_failed");
      await flushAudit();
      logSampledError("cycle", `[poller] cycle threw: ${errorMessage(err)}`);
      inFlight = false;
    }
    if (stopped || paused) return;
    if (resumePending) {
      resumePending = false;
      schedule(0);
    } else {
      schedule(nextDelay);
    }
  }

  return {
    async start(): Promise<void> {
      // Verify persistent volume availability before touching anything else.
      // An unwritable volume is reported loudly (log, /health) but is not fatal:
      // the in-memory cursor keeps notifying, exactly like an unwritable cursor
      // file, and every cycle retries the write.
      const cursorDir = path.dirname(config.cursorFile);
      try {
        await mkdir(cursorDir, { recursive: true });
        const probeFile = path.join(cursorDir, `.volume-probe.${process.pid}.${Date.now()}`);
        await writeFile(probeFile, "", "utf8");
        await unlink(probeFile).catch(() => {});
        status.persistentVolumeAvailable = true;
        status.persistentVolumeError = null;
      } catch (err) {
        status.persistentVolumeAvailable = false;
        status.persistentVolumeError = errorMessage(err);
        Logger.error(
          "poller",
          `[poller] Persistent volume is not writable at ${cursorDir}: ${errorMessage(err)}; ` +
            `cursor state will not survive a restart until this is fixed`,
          { action: "persistent_volume_unwritable", cursorDir, error: errorMessage(err) },
        );
      }

      // Refuse a second live process before touching the cursor or Telegram.
      // Configs built without a lock path keep it next to the cursor it guards.
      const lockFile = config.lockFile ?? path.join(path.dirname(config.cursorFile), "poller.lock");
      try {
        instanceLock = await acquireInstanceLock(lockFile);
        status.lockFile = instanceLock.path;
        status.lockPid = instanceLock.payload.pid;
        console.log(
          `[poller] instance lock acquired pid=${instanceLock.payload.pid} file=${instanceLock.path}`,
        );
      } catch (err) {
        // Only a live second instance is fatal. A lock that cannot be written
        // (read-only or missing data dir) must not stop the notifier, matching
        // how an unwritable cursor file is handled.
        if (err instanceof InstanceLockError) throw err;
        console.warn(`[poller] could not take instance lock at ${lockFile}: ${errorMessage(err)}`);
      }

      await loadCursors();
      await loadCounters();
      // Parked sends from the previous run are part of this run's work.
      await deadLetter.load();
      refreshDeadLetterStatus();

      if (digestCheckpoint && digestScheduler) {
        await digestCheckpoint.load();
        await digestScheduler.start();
      }

      // Recover which notifications may already have been sent: an intent
      // without a matching done means a crash happened between sendMessage and
      // the cursor commit. Treat them as committed so a restart never duplicates
      // them (the existing lossy cursor-commit policy).
      if (sendJournal) {
        const recoveryContext = {
          resolveRouteChatId: (s: string) =>
            resolveRouteChatId(config, s === "market" || s === "squad" ? s : undefined),
          networkPassphrase: config.networkPassphrase,
        };
        const { valid, orphaned } = await sendJournal.classifyPending(recoveryContext);
        for (const entry of valid) {
          maybeSent.add(entry.id);
        }
        if (orphaned.length > 0) {
          if (deps.onOrphanedJournalEntry) {
            const recovered = await sendJournal.recoverOrphans(
              recoveryContext,
              deps.onOrphanedJournalEntry,
            );
            for (const entry of recovered.reroutedEntries) {
              maybeSent.add(entry.id);
            }
            Logger.warn(
              "poller",
              `recovered ${orphaned.length} orphaned send-journal entries ` +
                `(discarded=${recovered.discarded}, rerouted=${recovered.rerouted})`,
            );
          } else {
            Logger.warn(
              "poller",
              `skipped ${orphaned.length} orphaned send-journal entr${orphaned.length === 1 ? "y" : "ies"} ` +
                `(requires explicit discard or reroute decision): ` +
                orphaned.map((o) => `${o.entry.id}:${o.reason}`).join(", "),
            );
          }
        }
        await sendJournal.compact();
      }

      stopped = false;
      paused = false;
      status.paused = false;
      status.stopping = false;

      // Persist a migrated schema before the first cycle so a crash mid-poll
      // still leaves a versioned file behind for the next restart.
      if (pendingRewrite) {
        await saveCursors("migration");
      }
      status.running = true;
      status.startedAt = now();
      status.targets = [...state.values()].map((t) => ({ ...t }));
      Logger.info(
        "poller",
        `[poller] watching market=${config.marketContractId} (${config.marketContractVersion}) ` +
          `squad=${config.squadContractId} (${config.squadContractVersion}) ` +
          `every ${config.pollIntervalMs}ms`,
        {
          action: "start",
          marketContractId: config.marketContractId,
          squadContractId: config.squadContractId,
          pollIntervalMs: config.pollIntervalMs,
        },
      );
      // Flag unsupported contract version combinations before live polling begins.
      const unsupported = validateDecoderCombinations(targets);
      for (const flag of unsupported) {
        Logger.warn(
          "poller",
          `[poller] unsupported contract version combination: source=${flag.source} version=${flag.version} fallback=${flag.fallbackVersion}; ${flag.reason}`,
          {
            action: "unsupported_contract_version",
            source: flag.source,
            version: flag.version,
            normalizedVersion: flag.normalizedVersion,
            contractId: flag.contractId,
            fallbackVersion: flag.fallbackVersion,
            reason: flag.reason,
          },
        );
      }

      await persistStatus();
      await flushAudit();
      void loop();
    },

    /**
     * Attach the SBOM digest for operational reporting.
     * This is typically set once at startup by the deployment wrapper.
     */
    setSbomDigest(digest: string): void {
      status.sbomDigest = digest;
    },

    pause(): PollerPauseResult {
      if (stopped) return "stopped";
      if (paused) return "already-paused";
      paused = true;
      status.paused = true;
      resumePending = false;
      if (timer) clearTimeout(timer);
      timer = null;
      Logger.info("poller", "[poller] paused by operator; an in-flight cycle may finish", {
        action: "paused",
      });
      return "paused";
    },

    resume(): PollerResumeResult {
      if (stopped) return "stopped";
      if (!paused) return "already-running";
      paused = false;
      status.paused = false;
      Logger.info("poller", "[poller] resumed by operator; next cycle starts now", {
        action: "resumed",
      });
      if (inFlight) {
        resumePending = true;
      } else {
        schedule(0);
      }
      return "resumed";
    },

    /**
     * Immediate stop: no draining, no waiting on the cycle. Prefer
     * {@link shutdown}. State changes happen synchronously; the returned
     * promise only covers releasing the instance lock.
     */
    async stop(): Promise<void> {
      stopped = true;
      paused = false;
      status.paused = false;
      status.running = false;
      resumePending = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (digestScheduler) {
        await digestScheduler.stop();
      }
      if (digestCheckpoint) {
        await digestCheckpoint.flush();
      }
      // Best-effort: the process may be exiting, but a final snapshot that says
      // `running: false` is what tells a supervisor the stop was deliberate.
      void persistStatus();
      await releaseInstanceLock();
    },

    /**
     * Graceful shutdown: stop scheduling, drop what has not been sent yet, wait
     * a bounded time for the in-flight cycle, then flush cursor state.
     *
     * Bounded on purpose. The cycle can only be waiting on a read or on
     * Telegram, and both are given a deadline rather than a chance to hang the
     * deploy. Cursors only ever advance after their events were handed to
     * Telegram, so flushing at any point is safe: the file a restart resumes
     * from never skips an event the chain still has to show.
     */
    async shutdown(options: ShutdownOptions = {}): Promise<ShutdownResult> {
      // The last fallback is for configs built by callers that predate the
      // setting: "no field" must mean the default budget, not "never wait".
      const budgetMs =
        options.timeoutMs ?? config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
      const startedAt = now();
      const firstRequest = !status.stopping;

      status.stopping = true;
      stopped = true;
      paused = false;
      status.paused = false;
      resumePending = false;
      if (timer) clearTimeout(timer);
      timer = null;

      if (firstRequest) {
        console.log(
          `[poller] shutdown requested; draining in-flight work up to ${budgetMs}ms`,
        );
      }

      let drained = true;
      const inFlightCycle = cycleSettled;
      if (inFlightCycle) {
        drained = budgetMs > 0 ? await withinDeadline(inFlightCycle, budgetMs) : false;
        if (!drained) {
          console.warn(
            `[poller] cycle still in flight after ${budgetMs}ms; flushing cursors and letting it go`,
          );
        }
      }

      let flushed = true;
      if (status.pendingFlush) {
        flushed = await saveCursors("shutdown");
        console.log(
          flushed
            ? `[poller] flushed pending cursor state to ${config.cursorFile}`
            : `[poller] cursor flush failed; in-memory state kept for the next start`,
        );
      } else {
        console.log("[poller] cursor file already matches memory; nothing to flush");
      }

      if (countersDirty) {
        await saveCounters("shutdown");
      }

      if (digestScheduler) {
        await digestScheduler.stop();
      }
      if (digestCheckpoint) {
        await digestCheckpoint.flush();
      }

      status.running = false;
      await persistStatus();
      await releaseInstanceLock();
      return { drained, flushed, waitedMs: Math.max(0, now() - startedAt) };
    },

    status(): PollerStatus {
      refreshDeadLetterStatus();
      syncCounterSnapshots();
      return {
        ...status,
        sinceStart: { ...sinceStartCounters },
        cumulative: {
          cycles: status.cycles,
          notificationsSent: status.notificationsSent,
          notificationsFailed: status.notificationsFailed,
          eventsSkipped: status.eventsSkipped,
        },
        ledgerCache: ledgerCache.stats(),
        suppressedLogs: errorSampler.suppressedTotal(),
        targets: [...state.values()].map((t) => ({ ...t })),
        categories: categoryCounter.countsRecord(),
      };
    },

    /** Bounded recent canonical event summaries retained in memory for `/events`. */
    recentEvents(): readonly CanonicalEventSummary[] {
      return recentEvents.list();
    },

    /**
     * Run exactly one poll cycle and wait for it to finish.
     *
     * Intended for tests: drive the poller cycle-by-cycle without relying on
     * real timers or starting the loop. Safe to call while the loop is
     * running too — `inFlight` ensures at most one cycle at a time.
     */
    async runCycle(): Promise<void> {
      await cycle();
    },

    /**
     * Load cursor state from disk without starting the poll loop.
     *
     * Intended for tests that need to verify cursor-loading behaviour
     * (backup promotion, stale detection) without the asynchronous loop
     * race that `start()` introduces.
     */
    loadCursors,
    loadCounters,
    /** Machine-readable snapshot, same shape as the file on disk. */
    snapshot(): StatusSnapshot {
      return snapshot();
    },

    audit,

    /** Persist buffered audit entries now (used on shutdown). */
    flushAuditFile(): Promise<void> {
      return flushAudit();
    },

    /** Return decoder capability reports for each configured watch target. */
    capabilities(): DecoderCapabilityReport[] {
      return targets.map((t) => getDecoderCapabilityReport(t.source, t.version, t.contractId));
    },

    /** Run one polling cycle directly and await its completion. */
    async cycle(): Promise<void> {
      await cycle();
    },

    /** Ensure cursors are loaded and run one polling cycle directly. */
    async pollOnce(): Promise<void> {
      if (status.startedAt === 0) {
        await loadCursors();
        await loadCounters();
        status.running = true;
        status.startedAt = Date.now();
      }
      await cycle();
    },
  };
}

export { InstanceLockError };

export type Poller = ReturnType<typeof createPoller>;
