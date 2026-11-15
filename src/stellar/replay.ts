/**
 * Cursor-range replay: read events from a ledger range and optionally send
 * Telegram notifications for them.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   npm run replay -- --from 4226500 --to 4226800
 *   npm run replay -- --from 4226500                     # to = chain tip
 *   npm run replay -- --from <cursor> --to 4226800       # cursor as start
 *   npm run replay -- --from 4226500 --dry-run           # log only, no send
 *   npm run replay -- --from 4226500 --contract market   # one contract only
 *   npm run replay -- --from 4226500 --json              # machine-readable
 *   npm run replay -- --from 4226500 --send              # send to Telegram
 *   npm run replay -- --from 4226500 --mock              # local mock profile
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * - Requires explicit --send to actually post to Telegram (default: dry-run).
 * - `--from` below the RPC's retained floor is clamped with a warning.
 * - `--to` above the chain tip is clamped to the tip.
 * - `--to` before `--from` is a usage error (exit 2).
 * - Bounded per contract by `--cap` (default: MAX_NOTIFICATIONS_PER_CYCLE).
 * - Admin events are logged, not sent.
 * - Unknown events are logged, not sent.
 * - Never logs bot token or private keys.
 * - Progress goes to stderr; `--json` stdout is a single JSON document.
 *
 * ── Cursor behaviour ─────────────────────────────────────────────────────────
 *
 * This command reads events but NEVER writes a cursor file. Replay is
 * one-shot: it ends when it has walked the range. The live poller's cursor
 * state is untouched.
 *
 * After each page the cursor ledger is checked. If it exceeds `--to`, the walk
 * stops early — no new pages are fetched, and the run reports the last ledger
 * that was within the range.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { rpc } from "@stellar/stellar-sdk";

import {
  loadConfig,
  loadStellarConfig,
  networkLabel,
  type BotConfig,
  type StellarConfig,
} from "../config.js";
import { EventDedupWindow, eventKey } from "../dedup.js";
import {
  formatEvent,
  safeErrorMessage,
} from "../notifications/format.js";
import {
  validateLedgerWindow,
  clampStartLedger,
  createRpcServer,
} from "./client.js";
import {
  decodeEvent,
  dedupeEvents,
  isAdminPayload,
  sortEvents,
  type ContractSource,
  type DecodedEvent,
} from "./decode.js";
import {
  eventCursorLedger,
  scanJsonReplacer,
  type WatchTarget,
  EVENT_MAX_PAGES,
  EVENT_PAGE_LIMIT,
} from "./events.js";

// ── Exit codes & cancellation ────────────────────────────────────────────────

export const REPLAY_EXIT_OK = 0;
export const REPLAY_EXIT_ERROR = 1;
export const REPLAY_EXIT_USAGE = 2;
/** Standard POSIX `128 + SIGINT(2)` exit code for operator-cancelled replay runs. */
export const REPLAY_EXIT_CANCELLED = 130;

export type ReplayExitCode =
  | typeof REPLAY_EXIT_OK
  | typeof REPLAY_EXIT_ERROR
  | typeof REPLAY_EXIT_USAGE
  | typeof REPLAY_EXIT_CANCELLED;

export type ReplayRunStatus = "completed" | "cancelled" | "failed";
export type ReplayProgressStatus = "in_progress" | "completed" | "cancelled";

export class ReplayCancelledError extends Error {
  readonly signal: string;
  readonly committedTarget?: ReplayTargetResult | undefined;

  constructor(signal = "SIGINT", committedTarget?: ReplayTargetResult) {
    super(`Replay cancelled (${signal})`);
    this.name = "ReplayCancelledError";
    this.signal = signal;
    this.committedTarget = committedTarget;
  }
}

// ── Replay report types ───────────────────────────────────────────────────────

export interface ReplayEventSummary {
  ledger: number;
  txHash: string;
  eventId: string;
  name: string;
  source: ContractSource;
  sent: boolean;
  skipped: boolean;
  skipReason?: string | undefined;
}

export interface ReplayTargetResult {
  source: ContractSource;
  contractId: string;
  fromLedger: number;
  toLedger: number | null;
  /** Actual ledger the walk started from (may be clamped). */
  startLedger: number | null;
  startClamped: boolean;
  pages: number;
  events: number;
  sent: number;
  skipped: number;
  capped: number;
  adminLogged: number;
  duplicates: number;
  truncated: boolean;
  lastEventLedger: number | null;
  /** Last cursor seen in the walk (for --json inspection). */
  cursor: string | null;
  /** Individual event dispositions (included when --show > 0 or --json). */
  eventLog: ReplayEventSummary[];
  /** Events skipped because they were already accounted for in a resumed checkpoint. */
  resumedSkippedEvents?: number | undefined;
  /** Last processed event id in this run or checkpoint. */
  lastProcessedEventId?: string | null | undefined;
  /** Failed send attempts (counted under skipped, never sent). */
  failedSends?: number | undefined;
  /** True when the walk stopped early due to SIGINT / cancellation. */
  cancelled?: boolean | undefined;
  /** True when this target has remaining work that can be resumed. */
  resumable?: boolean | undefined;
}

export interface ReplayReport {
  format: "mimir-replay-v1";
  status?: ReplayRunStatus | undefined;
  cancelled?: boolean | undefined;
  resumable?: boolean | undefined;
  network: string;
  rpcUrl: string;
  fromLedger: number;
  toLedger: number | null;
  dryRun: boolean;
  targets: ReplayTargetResult[];
  /** Total across all targets. */
  totals: {
    events: number;
    sent: number;
    skipped: number;
    capped: number;
    adminLogged: number;
    duplicates: number;
    resumedSkippedEvents?: number | undefined;
    failedSends?: number | undefined;
  };
}

// ── Progress / Checkpoint schema ─────────────────────────────────────────────

export interface ReplayProgressTarget {
  contractId: string;
  cursor: string | null;
  lastEventLedger: number | null;
  lastProcessedEventId: string | null;
  recentEventIds: string[];
  pagesProcessed: number;
  eventsProcessed: number;
  eventsSent: number;
  eventsSkipped: number;
  eventsCapped: number;
  adminLogged: number;
  duplicates: number;
  completed: boolean;
  failedSends?: number | undefined;
}

export interface ReplayProgressFile {
  format: "mimir-replay-progress-v1";
  version: 1;
  status?: ReplayProgressStatus | undefined;
  resumable?: boolean | undefined;
  cancelledAt?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
  network: string;
  rpcUrl: string;
  range: {
    from: string;
    to: number | null;
  };
  contracts: ContractSource[];
  targets: Partial<Record<ContractSource, ReplayProgressTarget>>;
}

// ── RPC Request Budget Tracker ───────────────────────────────────────────────

export class RpcBudgetTracker {
  private readonly minIntervalMs: number;
  private lastRequestAt: number = 0;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private requestCount: number = 0;

  constructor(rpm: number, sleep: (ms: number) => Promise<void>, now: () => number) {
    if (!Number.isFinite(rpm) || rpm <= 0) {
      throw new Error(`--rpm must be a positive number, got ${rpm}`);
    }
    this.minIntervalMs = Math.ceil(60_000 / rpm);
    this.sleep = sleep;
    this.now = now;
  }

  get totalRequests(): number {
    return this.requestCount;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new ReplayCancelledError(
        typeof signal.reason === "string" ? signal.reason : "SIGINT",
      );
    }
    const current = this.now();
    const elapsed = current - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < this.minIntervalMs) {
      const waitMs = this.minIntervalMs - elapsed;
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            reject(
              new ReplayCancelledError(
                typeof signal.reason === "string" ? signal.reason : "SIGINT",
              ),
            );
          };
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
          this.sleep(waitMs).then(
            () => {
              signal.removeEventListener("abort", onAbort);
              if (!settled) {
                settled = true;
                resolve();
              }
            },
            (err) => {
              signal.removeEventListener("abort", onAbort);
              if (!settled) {
                settled = true;
                reject(err);
              }
            },
          );
        });
      } else {
        await this.sleep(waitMs);
      }
      this.lastRequestAt = Math.max(this.now(), this.lastRequestAt + waitMs);
    } else {
      this.lastRequestAt = current;
    }
    this.requestCount += 1;
  }
}

// ── Core replay function ──────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Start of the replay range. Either a ledger number or an opaque cursor. */
  from: string | number;
  /** End of the replay range. Defaults to the chain tip. */
  to?: number | undefined;
  /** Which contracts to scan. Defaults to both. */
  contracts?: ContractSource[] | undefined;
  /** Walk at most this many pages per contract. Defaults to EVENT_MAX_PAGES. */
  maxPages?: number | undefined;
  /** Limit the walk to this many events returned per page. */
  pageLimit?: number | undefined;
  /**
   * Maximum notifications per contract per replay run. Defaults to
   * config.maxNotificationsPerCycle when config is a BotConfig, else 20.
   */
  cap?: number | undefined;
  /**
   * When true, decode events and compute what would be sent, but call
   * `send` only when actually set. Separate from `send` so callers can
   * inject a fake sender for testing while still exercising formatting.
   */
  dryRun?: boolean | undefined;
  /** Include individual event dispositions in the report. */
  show?: number | undefined;
  /** Path to an optional progress/checkpoint file. */
  progressFile?: string | undefined;
  /** Maximum RPC requests per minute. */
  rpm?: number | undefined;
  /** Checkpoint state for this specific target, if resuming. */
  targetProgress?: ReplayProgressTarget | undefined;
  /** Called atomically after each page is processed. */
  onPageComplete?: ((targetUpdate: ReplayProgressTarget) => Promise<void>) | undefined;
  /** Global RPC budget tracker. */
  budget?: RpcBudgetTracker | undefined;
  /** Cancellation signal (aborted on SIGINT or programmatic cancellation). */
  signal?: AbortSignal | undefined;
}

export interface ReplaySignalSource {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export interface ReplayDeps {
  config: StellarConfig | BotConfig;
  server: rpc.Server;
  /**
   * Called for each event the replay would notify on (after all skip checks).
   * When omitted the replay runs in dry-run mode: events are decoded and
   * counted but nothing is dispatched.
   *
   * Signature matches the poller's send function so tests can inject either.
   */
  send?: ((text: string, source?: ContractSource) => Promise<void>) | undefined;
  /**
   * Progress output. Defaults to `console.error` so it never corrupts a
   * `--json` pipe. For human-readable mode it may be `console.log`.
   */
  progress?: ((...args: unknown[]) => void) | undefined;
  /** Sleeper function for deterministic rate-limit / delay tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Timestamp provider for deterministic rate-limit / delay tests. */
  now?: (() => number) | undefined;
  /** Optional AbortSignal for programmatic cancellation. */
  signal?: AbortSignal | undefined;
  /** Signal emitter to subscribe to SIGINT (defaults to `process`). */
  signalSource?: ReplaySignalSource | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function writeProgressFileAtomic(filePath: string, data: ReplayProgressFile): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

export function normalizeRangeFrom(from: string | number): string {
  return String(from).trim();
}

export function normalizeRangeTo(to?: number | null): number | null {
  return to !== undefined && to !== null ? to : null;
}

export async function loadAndValidateProgressFile(
  filePath: string,
  opts: {
    from: string | number;
    to?: number | undefined;
    contracts: ContractSource[];
    network: string;
    config: StellarConfig | BotConfig;
  },
): Promise<ReplayProgressFile | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`cannot read progress file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    throw new Error(`malformed JSON in progress file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`progress file "${filePath}" does not contain a JSON object`);
  }

  const p = parsed as Partial<ReplayProgressFile>;
  if (p.format !== "mimir-replay-progress-v1" || p.version !== 1) {
    throw new Error(`incompatible progress file format or version in "${filePath}" (expected mimir-replay-progress-v1 v1)`);
  }

  // Validate range
  const expectedFrom = normalizeRangeFrom(opts.from);
  const fileFrom = normalizeRangeFrom(p.range?.from ?? "");
  if (expectedFrom !== fileFrom) {
    throw new Error(`progress file range.from (${fileFrom}) does not match requested --from (${expectedFrom})`);
  }

  const expectedTo = normalizeRangeTo(opts.to);
  const fileTo = normalizeRangeTo(p.range?.to);
  if (expectedTo !== fileTo) {
    throw new Error(`progress file range.to (${fileTo ?? "tip"}) does not match requested --to (${expectedTo ?? "tip"})`);
  }

  // Validate network
  if (p.network !== opts.network) {
    throw new Error(`progress file network (${p.network}) does not match requested network (${opts.network})`);
  }

  // Validate contracts
  const fileContracts = (p.contracts ?? []).slice().sort().join(",");
  const expectedContracts = opts.contracts.slice().sort().join(",");
  if (fileContracts !== expectedContracts) {
    throw new Error(`progress file contracts (${fileContracts}) do not match requested contracts (${expectedContracts})`);
  }

  // Validate contract IDs
  if (p.targets?.market && p.targets.market.contractId !== opts.config.marketContractId) {
    throw new Error(`progress file market contractId does not match current config`);
  }
  if (p.targets?.squad && p.targets.squad.contractId !== opts.config.squadContractId) {
    throw new Error(`progress file squad contractId does not match current config`);
  }

  return p as ReplayProgressFile;
}

function isBotConfig(config: StellarConfig | BotConfig): config is BotConfig {
  return "botToken" in config;
}

/**
 * Scan one contract over a ledger range and return a result report.
 * Does NOT write cursor files; does NOT touch the live poller state.
 */
async function replayContract(
  server: rpc.Server,
  target: WatchTarget,
  opts: ReplayOptions,
  send: ((text: string, source?: ContractSource) => Promise<void>) | undefined,
  config: StellarConfig | BotConfig,
  progress: (...args: unknown[]) => void,
): Promise<ReplayTargetResult> {
  const maxPages = opts.maxPages ?? EVENT_MAX_PAGES;
  const pageLimit = opts.pageLimit ?? EVENT_PAGE_LIMIT;
  const toLedger = opts.to ?? null;
  const cap = opts.cap ?? (isBotConfig(config) ? config.maxNotificationsPerCycle : 20);
  const showLog = (opts.show ?? 0) > 0 || opts.dryRun === true;

  // If this target was already marked completed in the progress file, skip RPC walk entirely.
  if (opts.targetProgress?.completed) {
    progress(
      `[replay] ${target.source}: already completed in progress file (pages=${opts.targetProgress.pagesProcessed} events=${opts.targetProgress.eventsProcessed} sent=${opts.targetProgress.eventsSent})`,
    );
    return {
      source: target.source,
      contractId: target.contractId,
      fromLedger: opts.targetProgress.lastEventLedger ?? 0,
      toLedger,
      startLedger: null,
      startClamped: false,
      pages: opts.targetProgress.pagesProcessed,
      events: opts.targetProgress.eventsProcessed,
      sent: opts.targetProgress.eventsSent,
      skipped: opts.targetProgress.eventsSkipped,
      capped: opts.targetProgress.eventsCapped,
      adminLogged: opts.targetProgress.adminLogged,
      duplicates: opts.targetProgress.duplicates,
      truncated: false,
      lastEventLedger: opts.targetProgress.lastEventLedger,
      cursor: opts.targetProgress.cursor,
      eventLog: [],
      resumedSkippedEvents: opts.targetProgress.eventsProcessed,
      lastProcessedEventId: opts.targetProgress.lastProcessedEventId,
      failedSends: opts.targetProgress.failedSends ?? 0,
      cancelled: false,
      resumable: false,
    };
  }

  let committedSnapshot = {
    pages: opts.targetProgress?.pagesProcessed ?? 0,
    events: opts.targetProgress?.eventsProcessed ?? 0,
    sent: opts.targetProgress?.eventsSent ?? 0,
    skipped: opts.targetProgress?.eventsSkipped ?? 0,
    capped: opts.targetProgress?.eventsCapped ?? 0,
    adminLogged: opts.targetProgress?.adminLogged ?? 0,
    duplicates: opts.targetProgress?.duplicates ?? 0,
    failedSends: opts.targetProgress?.failedSends ?? 0,
    resumedSkippedEvents: 0,
    lastEventLedger: opts.targetProgress?.lastEventLedger ?? null,
    lastProcessedEventId: opts.targetProgress?.lastProcessedEventId ?? null,
    cursor: opts.targetProgress?.cursor ?? null,
    startLedger: null as number | null,
    startClamped: false,
    eventLog: [] as ReplayEventSummary[],
  };

  const parsedFallbackFrom =
    typeof opts.from === "number"
      ? opts.from
      : /^\d+$/.test(String(opts.from).trim())
        ? parseInt(String(opts.from).trim(), 10)
        : (opts.targetProgress?.lastEventLedger ?? 0);

  const buildCommittedCancelledResult = (
    fromFallback: number,
    effectiveToBound: number | null,
  ): ReplayTargetResult => ({
    source: target.source,
    contractId: target.contractId,
    fromLedger: committedSnapshot.startLedger ?? fromFallback,
    toLedger: effectiveToBound,
    startLedger: committedSnapshot.startLedger,
    startClamped: committedSnapshot.startClamped,
    pages: committedSnapshot.pages,
    events: committedSnapshot.events,
    sent: committedSnapshot.sent,
    skipped: committedSnapshot.skipped,
    capped: committedSnapshot.capped,
    adminLogged: committedSnapshot.adminLogged,
    duplicates: committedSnapshot.duplicates,
    truncated: true,
    lastEventLedger: committedSnapshot.lastEventLedger,
    cursor: committedSnapshot.cursor,
    eventLog: showLog ? [...committedSnapshot.eventLog] : [],
    resumedSkippedEvents: committedSnapshot.resumedSkippedEvents,
    lastProcessedEventId: committedSnapshot.lastProcessedEventId,
    failedSends: committedSnapshot.failedSends,
    cancelled: true,
    resumable: true,
  });

  const checkCancelled = (fromFallback: number, effectiveToBound: number | null): void => {
    if (opts.signal?.aborted) {
      const sig = typeof opts.signal.reason === "string" ? opts.signal.reason : "SIGINT";
      throw new ReplayCancelledError(
        sig,
        buildCommittedCancelledResult(fromFallback, effectiveToBound),
      );
    }
  };

  checkCancelled(parsedFallbackFrom, toLedger);

  // Resolve the ledger window before the first page.
  try {
    if (opts.budget) await opts.budget.acquire(opts.signal);
  } catch (err) {
    if (err instanceof ReplayCancelledError) {
      throw new ReplayCancelledError(
        err.signal,
        buildCommittedCancelledResult(parsedFallbackFrom, toLedger),
      );
    }
    throw err;
  }
  checkCancelled(parsedFallbackFrom, toLedger);
  const window = validateLedgerWindow(await server.getHealth());
  checkCancelled(parsedFallbackFrom || window.oldestLedger, toLedger);

  const isResuming = !!opts.targetProgress;
  let lastProcessedEventId: string | null = opts.targetProgress?.lastProcessedEventId ?? null;
  let lastEventLedger: number | null = opts.targetProgress?.lastEventLedger ?? null;
  let resumedSkippedEvents = 0;

  // Resolve the starting position.
  let startLedger: number | null = null;
  let startCursor: string | undefined;
  let startClamped = false;

  if (isResuming && opts.targetProgress?.cursor) {
    startCursor = opts.targetProgress.cursor;
  } else {
    const fromValue = opts.from;
    if (typeof fromValue === "string" && /^\d+-\d+$/.test(fromValue)) {
      // Looks like a cursor token.
      startCursor = fromValue;
    } else {
      const requestedLedger = typeof fromValue === "number" ? fromValue : parseInt(String(fromValue), 10);
      if (!Number.isFinite(requestedLedger) || requestedLedger < 1) {
        throw new Error(`invalid --from value: ${String(fromValue)}`);
      }
      const clamped = clampStartLedger(requestedLedger, window);
      startLedger = clamped.startLedger;
      startClamped = clamped.clamped;
      if (startClamped) {
        progress(
          `[replay] ${target.source}: --from ${requestedLedger} is below the retained floor; ` +
            `clamped up to ${startLedger}`,
        );
      }
    }
  }

  // Validate --to against the window.
  let effectiveTo = toLedger;
  if (effectiveTo !== null && effectiveTo > window.latestLedger) {
    progress(
      `[replay] ${target.source}: --to ${effectiveTo} is ahead of the chain tip; ` +
        `clamped to ${window.latestLedger}`,
    );
    effectiveTo = window.latestLedger;
  }

  const dedupCapacity = isBotConfig(config) ? config.dedupWindow : 256;
  const dedup = opts.targetProgress?.recentEventIds
    ? EventDedupWindow.fromJSON(opts.targetProgress.recentEventIds, dedupCapacity)
    : new EventDedupWindow(dedupCapacity);

  let pagesInThisRun = 0;
  let sent = opts.targetProgress?.eventsSent ?? 0;
  let skipped = opts.targetProgress?.eventsSkipped ?? 0;
  let capped = opts.targetProgress?.eventsCapped ?? 0;
  let adminLogged = opts.targetProgress?.adminLogged ?? 0;
  let duplicates = opts.targetProgress?.duplicates ?? 0;
  let failedSends = opts.targetProgress?.failedSends ?? 0;
  let totalProcessedEvents = opts.targetProgress?.eventsProcessed ?? 0;

  let lastCursor: string | null = opts.targetProgress?.cursor ?? null;
  let truncated = false;
  let stoppedByToLedger = false;
  let latestLedger = window.latestLedger;
  let cursor: string | undefined = startCursor;
  let usedStartLedger: number | null = null;
  let usedStartClamped = false;
  let previousCursor = startCursor ?? "";
  const eventLog: ReplayEventSummary[] = [];

  const firstStartLedger = startLedger ?? window.oldestLedger;

  const botToken = isBotConfig(config) ? config.botToken : undefined;
  const errorMsg = (err: unknown): string =>
    safeErrorMessage(err, botToken ? [botToken] : []);

  if (isResuming) {
    progress(
      `[replay] ${target.source}: resuming from cursor ${cursor ?? "start"} ` +
        `(lastEventId=${lastProcessedEventId ?? "none"}, pages=${opts.targetProgress?.pagesProcessed ?? 0}, sent=${sent}, skipped=${skipped})`,
    );
  }

  for (;;) {
    checkCancelled(usedStartLedger ?? firstStartLedger, effectiveTo);
    if (pagesInThisRun >= maxPages) {
      truncated = true;
      break;
    }
    pagesInThisRun += 1;
    const totalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;

    try {
      if (opts.budget) await opts.budget.acquire(opts.signal);
    } catch (err) {
      if (err instanceof ReplayCancelledError) {
        throw new ReplayCancelledError(
          err.signal,
          buildCommittedCancelledResult(usedStartLedger ?? firstStartLedger, effectiveTo),
        );
      }
      throw err;
    }
    checkCancelled(usedStartLedger ?? firstStartLedger, effectiveTo);

    const response: rpc.Api.GetEventsResponse = cursor
      ? await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], cursor, limit: pageLimit }))
      : await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], startLedger: firstStartLedger, limit: pageLimit }));

    checkCancelled(usedStartLedger ?? firstStartLedger, effectiveTo);

    const rawEvents = Array.isArray(response?.events) ? response.events : [];
    const pageDecoded: DecodedEvent[] = [];

    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object") continue;
      const key = eventKey(raw);

      // On resume, skip events that were already accounted for in the checkpoint
      if (
        isResuming &&
        ((key !== null && key === lastProcessedEventId) ||
          (key !== null && dedup.has(key)) ||
          (typeof raw.id === "string" && raw.id === lastProcessedEventId))
      ) {
        resumedSkippedEvents += 1;
        duplicates += 1;
        continue;
      }

      if (dedup.add(key)) {
        pageDecoded.push(decodeEvent(target.source, raw));
      } else {
        duplicates += 1;
      }
    }

    if (pagesInThisRun === 1 && !isResuming) {
      usedStartLedger = startLedger;
      usedStartClamped = startClamped;
    }
    latestLedger = response?.latestLedger ?? latestLedger;

    // Filter to the requested ledger range, deduplicate, and sort
    const filteredPage = sortEvents(
      dedupeEvents(
        pageDecoded.filter((e) => {
          if (startLedger !== null && e.ledger < startLedger) return false;
          if (effectiveTo !== null && e.ledger > effectiveTo) return false;
          return true;
        }),
      ),
    );

    totalProcessedEvents += filteredPage.length;

    // Notify / log each event in this page
    const pageEventLog: ReplayEventSummary[] = [];
    for (const event of filteredPage) {
      checkCancelled(usedStartLedger ?? firstStartLedger, effectiveTo);
      const entry: ReplayEventSummary = {
        ledger: event.ledger,
        txHash: event.txHash,
        eventId: event.eventId,
        name: event.payload.name === "unknown" ? `unknown:${(event.payload as { eventName?: string }).eventName ?? "?"}` : event.payload.name,
        source: event.source,
        sent: false,
        skipped: false,
      };

      if (isAdminPayload(event.payload)) {
        adminLogged += 1;
        entry.skipped = true;
        entry.skipReason = "admin";
        progress(
          `[replay] ${target.source}: logged admin event "${event.payload.name}" at ledger ${event.ledger}`,
        );
        if (showLog) pageEventLog.push(entry);
        continue;
      }

      if (event.payload.name === "unknown") {
        skipped += 1;
        entry.skipped = true;
        entry.skipReason = "unknown";
        const reason = (event.payload as { reason?: string }).reason;
        progress(
          `[replay] ${target.source}: skipped unknown event "${(event.payload as { eventName?: string }).eventName ?? "?"}" at ledger ${event.ledger}` +
            (reason ? ` (${reason})` : ""),
        );
        if (showLog) pageEventLog.push(entry);
        continue;
      }

      if (sent >= cap) {
        capped += 1;
        entry.skipped = true;
        entry.skipReason = "cap";
        progress(
          `[replay] ${target.source}: cap (${cap}) reached — skipping "${event.payload.name}" at ledger ${event.ledger}`,
        );
        if (showLog) pageEventLog.push(entry);
        continue;
      }

      if (opts.dryRun !== false && !send) {
        let text: string | null = null;
        try {
          text = isBotConfig(config) ? formatEvent(config, event) : `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
        } catch {
          text = `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
        }
        progress(
          `[replay] ${target.source}: would send "${event.payload.name}" at ledger ${event.ledger}${text ? ` — ${text.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
        );
        sent += 1;
        entry.sent = true;
        if (showLog) pageEventLog.push(entry);
      } else if (send) {
        let text: string | null = null;
        try {
          if (isBotConfig(config)) {
            text = formatEvent(config, event);
          } else {
            text = `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
          }
        } catch (err) {
          skipped += 1;
          entry.skipped = true;
          entry.skipReason = "format-error";
          progress(
            `[replay] ${target.source}: format failed for "${event.payload.name}" at ledger ${event.ledger}: ` +
              errorMsg(err),
          );
          if (showLog) pageEventLog.push(entry);
          continue;
        }

        if (text === null) {
          skipped += 1;
          entry.skipped = true;
          entry.skipReason = "null-format";
          if (showLog) pageEventLog.push(entry);
          continue;
        }

        try {
          await send(text, event.source);
          sent += 1;
          entry.sent = true;
        } catch (err) {
          if (err instanceof ReplayCancelledError) {
            throw new ReplayCancelledError(
              err.signal,
              buildCommittedCancelledResult(usedStartLedger ?? firstStartLedger, effectiveTo),
            );
          }
          skipped += 1;
          failedSends += 1;
          entry.skipped = true;
          entry.skipReason = "send-error";
          progress(
            `[replay] ${target.source}: send failed for "${event.payload.name}" at ledger ${event.ledger}: ` +
              errorMsg(err),
          );
        }
        if (showLog) pageEventLog.push(entry);
      } else {
        sent += 1;
        entry.sent = true;
        if (showLog) pageEventLog.push(entry);
      }

      const evKey = event.eventId || eventKey(event);
      if (evKey) {
        lastProcessedEventId = evKey;
      }
      if (event.ledger > 0 && (lastEventLedger === null || event.ledger > lastEventLedger)) {
        lastEventLedger = event.ledger;
      }

      checkCancelled(usedStartLedger ?? firstStartLedger, effectiveTo);
    }

    if (showLog) {
      eventLog.push(...pageEventLog);
    }

    const nextCursor = typeof response?.cursor === "string" ? response.cursor : "";
    let isFinalPage = false;

    if (!nextCursor || nextCursor === previousCursor) {
      isFinalPage = true;
    } else {
      lastCursor = nextCursor;
      const reached = eventCursorLedger(nextCursor);
      if (reached !== null && reached >= latestLedger) {
        isFinalPage = true;
      }
      if (effectiveTo !== null && reached !== null && reached > effectiveTo) {
        stoppedByToLedger = true;
        isFinalPage = true;
      }
      previousCursor = nextCursor;
      cursor = nextCursor;
    }

    // Persist checkpoint after each completed page
    const pageCompleted = isFinalPage && !truncated;
    if (opts.onPageComplete) {
      await opts.onPageComplete({
        contractId: target.contractId,
        cursor: lastCursor,
        lastEventLedger,
        lastProcessedEventId,
        recentEventIds: dedup.toJSON(),
        pagesProcessed: totalPages,
        eventsProcessed: totalProcessedEvents,
        eventsSent: sent,
        eventsSkipped: skipped,
        eventsCapped: capped,
        adminLogged,
        duplicates,
        completed: pageCompleted,
        failedSends,
      });
    }

    committedSnapshot = {
      pages: totalPages,
      events: totalProcessedEvents,
      sent,
      skipped,
      capped,
      adminLogged,
      duplicates,
      failedSends,
      resumedSkippedEvents,
      lastEventLedger,
      lastProcessedEventId,
      cursor: lastCursor,
      startLedger: usedStartLedger,
      startClamped: usedStartClamped,
      eventLog: showLog ? [...eventLog] : [],
    };

    if (isFinalPage || stoppedByToLedger) {
      break;
    }
  }

  const finalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;
  const isTruncated = truncated || stoppedByToLedger;

  progress(
    `[replay] ${target.source}: pages=${finalPages} events=${totalProcessedEvents} sent=${sent} ` +
      `skipped=${skipped} capped=${capped} admin=${adminLogged} duplicates=${duplicates} ` +
      `truncated=${isTruncated}` +
      (resumedSkippedEvents > 0 ? ` resumedSkipped=${resumedSkippedEvents}` : ""),
  );

  return {
    source: target.source,
    contractId: target.contractId,
    fromLedger: usedStartLedger ?? window.oldestLedger,
    toLedger: effectiveTo,
    startLedger: usedStartLedger,
    startClamped: usedStartClamped,
    pages: finalPages,
    events: totalProcessedEvents,
    sent,
    skipped,
    capped,
    adminLogged,
    duplicates,
    truncated: isTruncated,
    lastEventLedger,
    cursor: lastCursor,
    eventLog: showLog ? eventLog : [],
    resumedSkippedEvents,
    lastProcessedEventId,
    failedSends,
    cancelled: false,
    resumable: truncated,
  };
}

/**
 * Run the replay CLI. Exported so tests can call it directly with a fake
 * server and fake send function, without spawning a subprocess.
 *
 * Returns a `ReplayReport` and the process exit code (`0` = completed,
 * `1` = fatal runtime error, `2` = usage error, `130` = cancelled via SIGINT).
 */
export async function runReplayCli(opts: {
  argv?: string[];
  deps?: Partial<ReplayDeps>;
} = {}): Promise<{ report: ReplayReport | null; exitCode: ReplayExitCode }> {
  const argv = opts.argv ?? process.argv;
  const overrideDeps = opts.deps ?? {};

  // ── Parse flags ────────────────────────────────────────────────────────────

  function flag(name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    return next?.startsWith("--") ? undefined : next;
  }

  function boolFlag(name: string): boolean {
    return argv.includes(`--${name}`);
  }

  const fromRaw = flag("from");
  const toRaw = flag("to");
  const contractFilter = flag("contract") as ContractSource | undefined;
  const maxPages = flag("pages") ? Math.max(1, Number(flag("pages"))) : EVENT_MAX_PAGES;
  const cap = flag("cap") ? Math.max(1, Number(flag("cap"))) : undefined;
  const show = flag("show") ? Math.max(0, Number(flag("show"))) : 0;
  const dryRun = !boolFlag("send"); // Default is dry-run; --send enables actual sending.
  const asJson = boolFlag("json");
  const progressFile = flag("progress-file");
  const rpmRaw = flag("rpm");
  const progress = overrideDeps.progress ?? (asJson ? console.error.bind(console) : console.log.bind(console));
  const safeErr = (err: unknown): string => safeErrorMessage(err, []);

  if (!fromRaw) {
    console.error("[replay] error: --from <ledger|cursor> is required");
    console.error("Usage: npm run replay -- --from <ledger> [--to <ledger>] [--send] [--dry-run] [--contract market|squad] [--pages N] [--cap N] [--show N] [--json] [--mock] [--progress-file <path>] [--rpm N]");
    return { report: null, exitCode: 2 };
  }

  // Validate --contract
  if (contractFilter && contractFilter !== "market" && contractFilter !== "squad") {
    console.error(`[replay] error: --contract must be "market" or "squad", got "${contractFilter}"`);
    return { report: null, exitCode: 2 };
  }

  // Validate --to
  let toLedger: number | undefined;
  if (toRaw !== undefined) {
    const n = parseInt(toRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error(`[replay] error: --to must be a positive ledger number, got "${toRaw}"`);
      return { report: null, exitCode: 2 };
    }
    toLedger = n;
  }

  // Validate --rpm
  let rpm: number | undefined;
  if (rpmRaw !== undefined) {
    const n = Number(rpmRaw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`[replay] error: --rpm must be a positive number, got "${rpmRaw}"`);
      return { report: null, exitCode: 2 };
    }
    rpm = n;
  }

  // Validate --from vs --to for ledger numbers (cursors are opaque).
  let fromLedger: number | undefined;
  if (!/^\d+-\d+$/.test(fromRaw)) {
    // Might be a plain ledger number.
    const n = parseInt(fromRaw, 10);
    if (Number.isFinite(n) && n >= 1) {
      fromLedger = n;
    } else if (Number.isFinite(n) && n < 1) {
      console.error(`[replay] error: --from ledger must be >= 1, got ${n}`);
      return { report: null, exitCode: 2 };
    }
    // Non-numeric is fine, some cursors might not match our digit pattern.
  }

  if (fromLedger !== undefined && toLedger !== undefined && toLedger < fromLedger) {
    console.error(`[replay] error: --to ${toLedger} is before --from ${fromLedger}`);
    return { report: null, exitCode: 2 };
  }

  // ── Load config ────────────────────────────────────────────────────────────

  // Apply --mock before config load.
  if (boolFlag("mock") && !process.env.MIMIR_PROFILE?.trim()) {
    process.env.MIMIR_PROFILE = "mock";
  }

  let config: StellarConfig | BotConfig;
  let send: ((text: string, source?: ContractSource) => Promise<void>) | undefined;

  try {
    if (!dryRun) {
      // --send mode needs full bot config for Telegram credentials — unless the
      // caller injected a config (test harness) in which case we trust that.
      const botConfig = (overrideDeps.config as BotConfig | undefined) ?? loadConfig();
      config = botConfig;
      if (overrideDeps.send) {
        send = overrideDeps.send;
      } else {
        // Import grammy only when actually sending.
        const { Bot } = await import("grammy");
        const { createNotifier } = await import("../bot.js");
        const bot = new Bot(botConfig.botToken);
        send = createNotifier(bot, botConfig);
      }
    } else {
      config = overrideDeps.config ?? loadStellarConfig();
    }
  } catch (err) {
    console.error(`[replay] config error: ${safeErr(err)}`);
    return { report: null, exitCode: 1 };
  }

  const server = overrideDeps.server ?? createRpcServer(config);
  const network = networkLabel(config);

  if (!asJson) {
    progress(`[replay] network   ${network} · rpc ${config.rpcUrl}`);
    progress(`[replay] from      ${fromRaw}${toLedger !== undefined ? `  to ${toLedger}` : "  (to chain tip)"}`);
    progress(`[replay] mode      ${dryRun ? "dry-run (use --send to deliver to Telegram)" : "SEND"}`);
    if (progressFile) progress(`[replay] progress  ${progressFile}`);
    if (rpm !== undefined) progress(`[replay] rpm       ${rpm}`);
  } else {
    progress(
      `replay ${network} from=${fromRaw} to=${toLedger ?? "tip"} mode=${dryRun ? "dry-run" : "send"}` +
        (progressFile ? ` progress=${progressFile}` : "") +
        (rpm !== undefined ? ` rpm=${rpm}` : ""),
    );
  }

  // ── Build target list ─────────────────────────────────────────────────────

  const allTargets: WatchTarget[] = [
    { source: "market", contractId: config.marketContractId },
    { source: "squad", contractId: config.squadContractId },
  ];
  const targets = contractFilter
    ? allTargets.filter((t) => t.source === contractFilter)
    : allTargets;

  const requestedContracts: ContractSource[] = contractFilter
    ? [contractFilter]
    : ["market", "squad"];

  // ── Rate limiter budget ───────────────────────────────────────────────────

  const sleep = overrideDeps.sleep ?? defaultSleep;
  const now = overrideDeps.now ?? Date.now;
  const budget = rpm !== undefined ? new RpcBudgetTracker(rpm, sleep, now) : undefined;

  // ── Load or initialize progress file ──────────────────────────────────────

  let progressData: ReplayProgressFile | null = null;
  if (progressFile) {
    try {
      progressData = await loadAndValidateProgressFile(progressFile, {
        from: fromRaw,
        to: toLedger,
        contracts: requestedContracts,
        network,
        config,
      });
      if (progressData) {
        progress(`[replay] loaded progress file "${progressFile}"`);
      } else {
        const nowIso = new Date(now()).toISOString();
        progressData = {
          format: "mimir-replay-progress-v1",
          version: 1,
          status: "in_progress",
          resumable: true,
          cancelledAt: null,
          createdAt: nowIso,
          updatedAt: nowIso,
          network,
          rpcUrl: config.rpcUrl,
          range: {
            from: normalizeRangeFrom(fromRaw),
            to: normalizeRangeTo(toLedger),
          },
          contracts: requestedContracts,
          targets: {},
        };
      }
    } catch (err: unknown) {
      console.error(`[replay] error: ${err instanceof Error ? err.message : String(err)}`);
      return { report: null, exitCode: REPLAY_EXIT_USAGE };
    }
  }

  // ── Cancellation wiring (SIGINT + optional AbortSignal) ───────────────────

  const abortController = new AbortController();
  const signalSource: ReplaySignalSource = overrideDeps.signalSource ?? process;
  let cancelSignalName: string | null = null;

  const triggerCancel = (reason: string) => {
    if (!abortController.signal.aborted) {
      cancelSignalName = reason;
      abortController.abort(reason);
    }
  };

  const onSigint = () => triggerCancel("SIGINT");
  const onExternalAbort = () => {
    const extReason =
      typeof overrideDeps.signal?.reason === "string"
        ? overrideDeps.signal.reason
        : "SIGINT";
    triggerCancel(extReason);
  };

  signalSource.on("SIGINT", onSigint);
  if (overrideDeps.signal) {
    if (overrideDeps.signal.aborted) {
      onExternalAbort();
    } else {
      overrideDeps.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  // ── Walk each target ───────────────────────────────────────────────────────

  const targetResults: ReplayTargetResult[] = [];
  let fatalError: string | undefined;
  let cancelled = false;

  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const targetProgress = progressData?.targets?.[target.source];
      const onPageComplete = progressFile
        ? async (update: ReplayProgressTarget) => {
            if (!progressData) return;
            progressData.targets[target.source] = update;
            progressData.status = "in_progress";
            progressData.resumable = true;
            progressData.cancelledAt = null;
            progressData.updatedAt = new Date(now()).toISOString();
            await writeProgressFileAtomic(progressFile, progressData);
          }
        : undefined;

      try {
        const result = await replayContract(
          server,
          target,
          {
            from: fromRaw,
            to: toLedger,
            maxPages,
            cap,
            show,
            dryRun,
            contracts: requestedContracts,
            progressFile,
            rpm,
            targetProgress,
            onPageComplete,
            budget,
            signal: abortController.signal,
          },
          dryRun ? undefined : send,
          config,
          progress,
        );
        targetResults.push(result);
      } catch (err) {
        if (err instanceof ReplayCancelledError) {
          cancelled = true;
          cancelSignalName = err.signal || cancelSignalName || "SIGINT";
          if (err.committedTarget) {
            targetResults.push(err.committedTarget);
          }
          // Record committed-only summaries for any subsequent unstarted targets
          for (let k = i + 1; k < targets.length; k++) {
            const rem = targets[k]!;
            const remProg = progressData?.targets?.[rem.source];
            targetResults.push({
              source: rem.source,
              contractId: rem.contractId,
              fromLedger: remProg?.lastEventLedger ?? fromLedger ?? 0,
              toLedger: toLedger ?? null,
              startLedger: null,
              startClamped: false,
              pages: remProg?.pagesProcessed ?? 0,
              events: remProg?.eventsProcessed ?? 0,
              sent: remProg?.eventsSent ?? 0,
              skipped: remProg?.eventsSkipped ?? 0,
              capped: remProg?.eventsCapped ?? 0,
              adminLogged: remProg?.adminLogged ?? 0,
              duplicates: remProg?.duplicates ?? 0,
              truncated: !remProg?.completed,
              lastEventLedger: remProg?.lastEventLedger ?? null,
              cursor: remProg?.cursor ?? null,
              eventLog: [],
              resumedSkippedEvents: remProg?.eventsProcessed ?? 0,
              lastProcessedEventId: remProg?.lastProcessedEventId ?? null,
              failedSends: remProg?.failedSends ?? 0,
              cancelled: !remProg?.completed,
              resumable: !remProg?.completed,
            });
          }
          break;
        }

        const msg = safeErr(err);
        progress(`[replay] ${target.source}: scan failed: ${msg}`);
        fatalError = msg;
        targetResults.push({
          source: target.source,
          contractId: target.contractId,
          fromLedger: fromLedger ?? 0,
          toLedger: toLedger ?? null,
          startLedger: null,
          startClamped: false,
          pages: 0,
          events: 0,
          sent: 0,
          skipped: 0,
          capped: 0,
          adminLogged: 0,
          duplicates: 0,
          truncated: false,
          lastEventLedger: null,
          cursor: null,
          eventLog: [],
          cancelled: false,
          resumable: true,
        });
      }
    }
  } finally {
    signalSource.off("SIGINT", onSigint);
    if (overrideDeps.signal) {
      overrideDeps.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  // ── Flush final or cancelled progress state (committed progress only) ─────

  if (progressFile && progressData) {
    const nowIso = new Date(now()).toISOString();
    if (cancelled) {
      progressData.status = "cancelled";
      progressData.resumable = true;
      progressData.cancelledAt = nowIso;
      progressData.updatedAt = nowIso;
      await writeProgressFileAtomic(progressFile, progressData);
    } else if (!fatalError) {
      const allCompleted = targets.every(
        (t) => progressData?.targets?.[t.source]?.completed === true,
      );
      progressData.status = allCompleted ? "completed" : "in_progress";
      progressData.resumable = !allCompleted;
      progressData.cancelledAt = null;
      progressData.updatedAt = nowIso;
      await writeProgressFileAtomic(progressFile, progressData);
    }
  }

  // ── Build report ───────────────────────────────────────────────────────────

  const totals = targetResults.reduce(
    (acc, r) => ({
      events: acc.events + r.events,
      sent: acc.sent + r.sent,
      skipped: acc.skipped + r.skipped,
      capped: acc.capped + r.capped,
      adminLogged: acc.adminLogged + r.adminLogged,
      duplicates: acc.duplicates + r.duplicates,
      resumedSkippedEvents: (acc.resumedSkippedEvents ?? 0) + (r.resumedSkippedEvents ?? 0),
      failedSends: (acc.failedSends ?? 0) + (r.failedSends ?? 0),
    }),
    {
      events: 0,
      sent: 0,
      skipped: 0,
      capped: 0,
      adminLogged: 0,
      duplicates: 0,
      resumedSkippedEvents: 0,
      failedSends: 0,
    },
  );

  const runStatus: ReplayRunStatus = cancelled
    ? "cancelled"
    : fatalError
      ? "failed"
      : "completed";
  const isResumable =
    cancelled ||
    Boolean(fatalError) ||
    targetResults.some((r) => r.resumable === true);

  const report: ReplayReport = {
    format: "mimir-replay-v1",
    status: runStatus,
    cancelled,
    resumable: isResumable,
    network,
    rpcUrl: config.rpcUrl,
    fromLedger: fromLedger ?? 0,
    toLedger: toLedger ?? null,
    dryRun,
    targets: targetResults,
    totals,
  };

  if (asJson) {
    if (cancelled) {
      progress(
        `[replay] cancelled (${cancelSignalName ?? "SIGINT"}) — status=cancelled resumable=true` +
          (progressFile ? ` progress=${progressFile}` : ""),
      );
    }
    process.stdout.write(JSON.stringify(report, scanJsonReplacer, 2) + "\n");
  } else if (cancelled) {
    progress(
      `[replay] cancelled (${cancelSignalName ?? "SIGINT"}) — status=cancelled resumable=true ` +
        `committedEvents=${totals.events} committedSent=${totals.sent}` +
        (progressFile ? ` progress=${progressFile}` : ""),
    );
  } else {
    progress(
      `[replay] done  events=${totals.events} sent=${totals.sent} skipped=${totals.skipped} ` +
        `capped=${totals.capped} admin=${totals.adminLogged} duplicates=${totals.duplicates}` +
        ((totals.resumedSkippedEvents ?? 0) > 0 ? ` resumedSkipped=${totals.resumedSkippedEvents}` : ""),
    );
  }

  if (cancelled) {
    return { report, exitCode: REPLAY_EXIT_CANCELLED };
  }
  return { report, exitCode: fatalError ? REPLAY_EXIT_ERROR : REPLAY_EXIT_OK };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
//
// Only runs when this file is invoked directly, not when imported by tests or
// other modules. The entrypoint file `src/replay-cli.ts` is the npm script
// target; this file exposes `runReplayCli` for testing.

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void runReplayCli().then(({ exitCode }) => {
    if (exitCode !== 0) process.exit(exitCode);
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
