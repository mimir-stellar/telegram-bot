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
 *   npm run replay -- --from 4226500 --send --plan-digest <sha256>
 *                                                        # send only after sign-off
 *   npm run replay -- --from 4226500 --mock              # local mock profile
 *   npm run replay -- --archive scan.json                # offline from scanner archive
 *   npm run replay -- --archive scan.json --from 4226500 --to 4226800
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 * - Requires explicit --send to actually post to Telegram (default: dry-run).
 * - `--send` also requires `--plan-digest` matching the dry-run preview's plan
 *   digest, which binds the delivery to the reviewed range and destinations.
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

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import type { rpc } from "@stellar/stellar-sdk";

import {
  loadConfig,
  loadStellarConfig,
  networkLabel,
  type BotConfig,
  type StellarConfig,
} from "../config.js";
import { DEFAULT_DEDUP_WINDOW, EventDedupWindow, eventKey } from "../dedup.js";
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
  type ScanJsonEvent,
  type ScanJsonReport,
  type ScanJsonTarget,
  type WatchTarget,
  EVENT_MAX_PAGES,
  EVENT_PAGE_LIMIT,
} from "./events.js";
import { reviveScanReport } from "./scan-reviver.js";

// ── Replay report types ───────────────────────────────────────────────────────

/** POSIX exit code for SIGINT-cancelled replay (128 + SIGINT(2)). */
export const EXIT_REPLAY_CANCELLED = 130;

export type ReplayRunStatus = "completed" | "cancelled" | "failed";

export interface ReplayEventSummary {
  ledger: number;
  transactionIndex?: number | null | undefined;
  operationIndex?: number | null | undefined;
  txHash: string;
  eventId: string;
  name: string;
  source: ContractSource;
  sent: boolean;
  skipped: boolean;
  skipReason?: string | undefined;
}

export interface ReplayJsonlHeader {
  type: "header";
  format: "mimir-replay-jsonl-v1";
  version: 1;
  network?: string | undefined;
  rpcUrl?: string | undefined;
  fromLedger?: number | undefined;
  toLedger?: number | null | undefined;
  dryRun?: boolean | undefined;
  chunkCount?: number | undefined;
}

export interface ReplayJsonlEventRecord extends ReplayEventSummary {
  type: "event";
}

export interface ReplayJsonlSummary {
  type: "summary";
  format: "mimir-replay-jsonl-v1";
  version: 1;
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
  targets?: ReplayTargetResult[] | undefined;
}

export type ReplayJsonlRecord =
  | ReplayJsonlHeader
  | ReplayJsonlEventRecord
  | ReplayJsonlSummary;

export type JsonlOutputSink =
  | Writable
  | ((line: string) => void | Promise<void>);

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
  /** True when stopped because the configured --max-events budget was reached before completion. */
  budgetExhausted?: boolean | undefined;
  /** True when the target completed its entire requested range. */
  completed?: boolean | undefined;
}

export interface ReplayReport {
  format: "mimir-replay-v1";
  network: string;
  rpcUrl: string;
  archivePath?: string | undefined;
  fromLedger: number;
  toLedger: number | null;
  dryRun: boolean;
  maxEvents?: number | undefined;
  budgetExhausted: boolean;
  completed: boolean;
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
  /** Deterministic completeness certificate across all requested targets. */
  certificate: ReplayCompletenessCertificate;
}

// ── Signed-off replay plan ───────────────────────────────────────────────────

export interface ReplayPlanDestination {
  source: ContractSource;
  contractId: string;
}

/**
 * Reviewable replay plan: the normalized range and every contract destination
 * the run will walk, bound together by a deterministic SHA-256 digest.
 */
export interface ReplayPlan {
  format: "mimir-replay-plan-v1";
  network: string;
  /** Normalized `--from`: a ledger number or an opaque cursor token. */
  from: string;
  /** Inclusive upper bound, or null when the plan replays to the chain tip. */
  to: number | null;
  /** Selected contract sources, sorted for determinism. */
  contracts: ContractSource[];
  /** Contract destinations, sorted by source then contract id. */
  destinations: ReplayPlanDestination[];
  /** Lowercase hex SHA-256 of the canonical plan fields. */
  digest: string;
}

export interface ReplayPlanInput {
  network: string;
  from: string | number;
  to?: number | null | undefined;
  targets: readonly Pick<WatchTarget, "source" | "contractId">[];
}

function compareCodePoints(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Compute the SHA-256 plan digest over an explicit canonical form.
 *
 * The digest depends only on the plan format, network, normalized range, and
 * the sorted contract destinations — never on flag order, object key order, or
 * which of the two contracts was selected first. It deliberately excludes
 * chain-tip/clamped values so a preview digest stays valid as the chain moves.
 */
export function computeReplayPlanDigest(
  plan: Omit<ReplayPlan, "digest">,
): string {
  const destinations = plan.destinations
    .map((destination) => [destination.source, destination.contractId])
    .sort((a, b) =>
      compareCodePoints(a[0] ?? "", b[0] ?? "") ||
      compareCodePoints(a[1] ?? "", b[1] ?? ""),
    );
  const canonical = JSON.stringify([
    plan.format,
    plan.network,
    plan.from,
    plan.to,
    [...plan.contracts].sort(compareCodePoints),
    destinations,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Build a replay plan and its deterministic digest from the run's inputs. */
export function buildReplayPlan(input: ReplayPlanInput): ReplayPlan {
  const destinations: ReplayPlanDestination[] = input.targets
    .map((target) => ({ source: target.source, contractId: target.contractId }))
    .sort(
      (a, b) =>
        compareCodePoints(a.source, b.source) ||
        compareCodePoints(a.contractId, b.contractId),
    );
  const contracts = [...new Set(destinations.map((destination) => destination.source))].sort(
    compareCodePoints,
  );

  const base = {
    format: "mimir-replay-plan-v1" as const,
    network: input.network,
    from: normalizeRangeFrom(input.from),
    to: normalizeRangeTo(input.to),
    contracts,
    destinations,
  };

  return { ...base, digest: computeReplayPlanDigest(base) };
}

/** True when `value` is a lowercase hex SHA-256 plan digest. */
export function isValidReplayPlanDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

// ── Progress / Checkpoint schema ─────────────────────────────────────────────

export interface ReplayOutputRecord {
  type: "event";
  source: ContractSource;
  contractId: string;
  ledger: number;
  txHash: string;
  eventId: string;
  name: string;
  sent: boolean;
  skipped: boolean;
  skipReason?: string | undefined;
  payload: DecodedEvent["payload"];
}

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
  budgetExhausted?: boolean | undefined;
  failedSends?: number | undefined;
  observedFromLedger?: number | null | undefined;
  observedToLedger?: number | null | undefined;
  retainedFloorLedger?: number | null | undefined;
  chainTipLedger?: number | null | undefined;
  startClamped?: boolean | undefined;
}

export interface ReplayProgressFile {
  format: "mimir-replay-progress-v1";
  version: 1;
  createdAt: string;
  updatedAt: string;
  network: string;
  rpcUrl: string;
  range: {
    from: string;
    to: number | null;
  };
  contracts: ContractSource[];
  /** Normalized SHA-256 fingerprint of the replay filter set (network, range, contracts, contractIds). */
  filterFingerprint?: string | undefined;
  targets: Partial<Record<ContractSource, ReplayProgressTarget>>;
  status?: "in_progress" | "completed" | "cancelled" | undefined;
  resumable?: boolean | undefined;
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

  async acquire(): Promise<void> {
    const current = this.now();
    const elapsed = current - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < this.minIntervalMs) {
      const waitMs = this.minIntervalMs - elapsed;
      await this.sleep(waitMs);
      this.lastRequestAt = Math.max(this.now(), this.lastRequestAt + waitMs);
    } else {
      this.lastRequestAt = current;
    }
    this.requestCount += 1;
  }
}

// ── Page Ledger Boundary Consistency ─────────────────────────────────────────

export type ReplayConsistencyProblem =
  | "latest-ledger-regressed"
  | "cursor-ledger-regressed"
  | "event-ledger-regressed"
  | "cursor-behind-page-event";

/**
 * Bounded consistency error thrown when a replay RPC page reports nonmonotonic
 * ledger boundaries (regressing `latestLedger`, regressing `cursor` ledger,
 * regressing event ledgers, or a cursor behind events on the same page).
 */
export class ReplayConsistencyError extends Error {
  readonly problem: ReplayConsistencyProblem;

  constructor(problem: ReplayConsistencyProblem, message: string) {
    super(message);
    this.name = "ReplayConsistencyError";
    this.problem = problem;
  }
}

export interface ReplayPageBoundaryState {
  latestLedger: number;
  previousCursorLedger: number | null;
  lastEventLedger: number | null;
}

/**
 * Validate that a replay RPC page's ledger boundaries are monotonic with
 * respect to the previously committed replay state and within the page itself.
 *
 * Must be called before dispatching notifications or committing a checkpoint so
 * that a rejected page leaves the previously committed checkpoint unchanged.
 */
export function validateReplayPageLedgerBoundaries(
  response: rpc.Api.GetEventsResponse | null | undefined,
  state: ReplayPageBoundaryState,
): { nextCursorLedger: number | null } {
  const responseLatest = response?.latestLedger;
  if (
    typeof responseLatest === "number" &&
    Number.isSafeInteger(responseLatest) &&
    responseLatest < state.latestLedger
  ) {
    throw new ReplayConsistencyError(
      "latest-ledger-regressed",
      `replay RPC page latestLedger regressed from ${state.latestLedger} to ${responseLatest}`,
    );
  }

  const nextCursor = typeof response?.cursor === "string" ? response.cursor : "";
  const nextCursorLedger = nextCursor ? eventCursorLedger(nextCursor) : null;

  if (nextCursorLedger !== null) {
    if (
      state.previousCursorLedger !== null &&
      nextCursorLedger < state.previousCursorLedger
    ) {
      throw new ReplayConsistencyError(
        "cursor-ledger-regressed",
        `replay RPC page cursor ledger regressed from ${state.previousCursorLedger} to ${nextCursorLedger}`,
      );
    }
    if (
      state.lastEventLedger !== null &&
      nextCursorLedger < state.lastEventLedger
    ) {
      throw new ReplayConsistencyError(
        "cursor-ledger-regressed",
        `replay RPC page cursor ledger ${nextCursorLedger} regressed behind committed event ledger ${state.lastEventLedger}`,
      );
    }
  }

  const committedFloor =
    state.lastEventLedger !== null && state.previousCursorLedger !== null
      ? Math.max(state.lastEventLedger, state.previousCursorLedger)
      : (state.lastEventLedger ?? state.previousCursorLedger);

  const rawEvents = Array.isArray(response?.events) ? response.events : [];
  let prevRawLedger: number | null = null;
  let pageMaxLedger: number | null = null;

  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const ledger = (raw as { ledger?: unknown }).ledger;
    if (typeof ledger !== "number" || !Number.isSafeInteger(ledger) || ledger <= 0) {
      continue;
    }
    if (committedFloor !== null && ledger < committedFloor) {
      throw new ReplayConsistencyError(
        "event-ledger-regressed",
        `replay RPC page event ledger ${ledger} regressed behind committed boundary ${committedFloor}`,
      );
    }
    if (prevRawLedger !== null && ledger < prevRawLedger) {
      throw new ReplayConsistencyError(
        "event-ledger-regressed",
        `replay RPC page event ledgers are nonmonotonic (${prevRawLedger} followed by ${ledger})`,
      );
    }
    prevRawLedger = ledger;
    pageMaxLedger = pageMaxLedger === null ? ledger : Math.max(pageMaxLedger, ledger);
  }

  if (
    nextCursorLedger !== null &&
    pageMaxLedger !== null &&
    nextCursorLedger < pageMaxLedger
  ) {
    throw new ReplayConsistencyError(
      "cursor-behind-page-event",
      `replay RPC page cursor ledger ${nextCursorLedger} is behind page event ledger ${pageMaxLedger}`,
    );
  }

  return { nextCursorLedger };
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
  /** Path to an optional deterministic completeness certificate file. */
  certificateFile?: string | undefined;
  /** Maximum RPC requests per minute. */
  rpm?: number | undefined;
  /** Maximum events to process in this run across targets. */
  maxEvents?: number | undefined;
  /** Shared event-count budget tracker across targets. */
  eventBudget?: EventBudgetTracker | undefined;
  /** Checkpoint state for this specific target, if resuming. */
  targetProgress?: ReplayProgressTarget | undefined;
  /** Called after each event is processed when writing output records. */
  onOutputRecord?: ((record: ReplayOutputRecord, update: { lastCommittedOutputEventId: string; committedOutputRecords: number }) => Promise<void>) | undefined;
  /** Called atomically after each page is processed. */
  onPageComplete?: ((targetUpdate: ReplayProgressTarget) => Promise<void>) | undefined;
  /** Called for each processed event when streaming (e.g. --jsonl); avoids buffering eventLog in memory. */
  onEvent?: ((entry: ReplayEventSummary) => void | Promise<void>) | undefined;
  /** Global RPC budget tracker. */
  budget?: RpcBudgetTracker | undefined;
  /** Optional cancellation signal (e.g. from SIGINT handler). */
  signal?: AbortSignal | undefined;
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
  /** Optional sink for streaming JSONL output (`--jsonl` / `--merge-chunks`). */
  writeJsonl?: JsonlOutputSink | undefined;
  /** Sleeper function for deterministic rate-limit / delay tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Timestamp provider for deterministic rate-limit / delay tests. */
  now?: (() => number) | undefined;
  /** Optional cancellation signal for testing SIGINT / abort handling. */
  signal?: AbortSignal | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
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

export async function writeProgressFileAtomic(filePath: string, data: ReplayProgressFile): Promise<void> {
  await writeJsonAtomic(filePath, data);
}

export async function writeCertificateFileAtomic(
  filePath: string,
  data: ReplayCompletenessCertificate,
): Promise<void> {
  await writeJsonAtomic(filePath, data);
}

export function parseRequestedFromLedger(from: string | number): number | null {
  if (typeof from === "number") {
    return Number.isFinite(from) && from >= 1 ? from : null;
  }
  const trimmed = from.trim();
  if (/^\d+-\d+$/.test(trimmed)) {
    return eventCursorLedger(trimmed);
  }
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n >= 1 ? n : null;
  }
  return null;
}

export function buildTargetCertificate(params: {
  source: ContractSource;
  contractId: string;
  requestedFrom: string | number;
  requestedTo: number | null;
  observedFromLedger: number | null;
  observedToLedger: number | null;
  retainedFloorLedger: number | null;
  chainTipLedger: number | null;
  startClamped: boolean;
  truncated: boolean;
  pages: number;
  scanError?: string | undefined;
}): ReplayTargetCertificate {
  const requestedFromLedger = parseRequestedFromLedger(params.requestedFrom);
  const requestedRange: ReplayTargetRange = {
    from: normalizeRangeFrom(params.requestedFrom),
    fromLedger: requestedFromLedger,
    toLedger: params.requestedTo,
  };
  const observedRange: ReplayObservedRange = {
    fromLedger: params.observedFromLedger,
    toLedger: params.observedToLedger,
  };

  const gaps: ReplayCompletenessGap[] = [];

  if (params.scanError) {
    gaps.push({
      source: params.source,
      kind: "scan-error",
      fromLedger: requestedFromLedger,
      toLedger: params.requestedTo,
      reason: `scan failed: ${params.scanError}`,
    });
  }

  const pruned =
    params.startClamped ||
    (requestedFromLedger !== null &&
      params.retainedFloorLedger !== null &&
      requestedFromLedger < params.retainedFloorLedger);

  if (pruned && requestedFromLedger !== null && params.retainedFloorLedger !== null) {
    gaps.push({
      source: params.source,
      kind: "pruned-history",
      fromLedger: requestedFromLedger,
      toLedger: Math.max(requestedFromLedger, params.retainedFloorLedger - 1),
      reason: `requested start ledger ${requestedFromLedger} is below RPC retained floor ${params.retainedFloorLedger}`,
    });
  }

  const effectiveTargetTo =
    params.requestedTo !== null && params.chainTipLedger !== null
      ? Math.min(params.requestedTo, params.chainTipLedger)
      : (params.requestedTo ?? params.chainTipLedger);

  if (params.truncated && !params.scanError) {
    const gapStart =
      params.observedToLedger !== null
        ? params.observedToLedger + 1
        : params.observedFromLedger;
    gaps.push({
      source: params.source,
      kind: "truncated-pages",
      fromLedger: gapStart,
      toLedger: effectiveTargetTo,
      reason: `walk stopped after ${params.pages} page(s) before reaching ${effectiveTargetTo ?? "chain tip"}`,
    });
  }

  const beyondTip =
    params.requestedTo !== null &&
    params.chainTipLedger !== null &&
    params.requestedTo > params.chainTipLedger;

  if (beyondTip && params.chainTipLedger !== null && params.requestedTo !== null) {
    gaps.push({
      source: params.source,
      kind: "beyond-tip",
      fromLedger: params.chainTipLedger + 1,
      toLedger: params.requestedTo,
      reason: `requested end ledger ${params.requestedTo} exceeds chain tip ${params.chainTipLedger}`,
    });
  }

  const partial = Boolean(params.scanError || params.truncated || beyondTip);
  const complete = !pruned && !partial && gaps.length === 0;

  return {
    source: params.source,
    contractId: params.contractId,
    complete,
    requestedRange,
    observedRange,
    retainedFloorLedger: params.retainedFloorLedger,
    chainTipLedger: params.chainTipLedger,
    pruned,
    partial,
    gaps,
  };
}

export function buildCompletenessCertificate(params: {
  network: string;
  rpcUrl: string;
  dryRun: boolean;
  requestedFrom: string | number;
  requestedTo: number | null;
  targets: ReplayTargetCertificate[];
}): ReplayCompletenessCertificate {
  const requestedFromLedger = parseRequestedFromLedger(params.requestedFrom);
  const requestedRange: ReplayTargetRange = {
    from: normalizeRangeFrom(params.requestedFrom),
    fromLedger: requestedFromLedger,
    toLedger: params.requestedTo,
  };

  const fromLedgers = params.targets
    .map((t) => t.observedRange.fromLedger)
    .filter((v): v is number => v !== null);
  const toLedgers = params.targets
    .map((t) => t.observedRange.toLedger)
    .filter((v): v is number => v !== null);

  const observedRange: ReplayObservedRange = {
    fromLedger: fromLedgers.length > 0 ? Math.min(...fromLedgers) : null,
    toLedger: toLedgers.length > 0 ? Math.max(...toLedgers) : null,
  };

  const gaps = params.targets.flatMap((t) => t.gaps);
  const complete = params.targets.length > 0 && params.targets.every((t) => t.complete);

  const payload = {
    format: "mimir-replay-certificate-v1" as const,
    version: 1 as const,
    network: params.network,
    rpcUrl: params.rpcUrl,
    dryRun: params.dryRun,
    complete,
    requestedRange,
    observedRange,
    gaps,
    targets: params.targets,
  };

  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return {
    ...payload,
    digest,
  };
}

export function normalizeRangeFrom(from: string | number): string {
  return String(from).trim();
}

export function normalizeRangeTo(to?: number | null): number | null {
  return to !== undefined && to !== null ? to : null;
}

export interface ReplayFilterFingerprintInput {
  from: string | number;
  to?: number | null | undefined;
  contracts: ContractSource[];
  network: string;
  config: Pick<StellarConfig, "marketContractId" | "squadContractId">;
}

/**
 * Compute a deterministic, normalized SHA-256 fingerprint for the replay filter
 * set (network, range, sorted unique contracts, and their resolved contract IDs).
 *
 * Used to guard `--progress-file` resumes against accidentally reusing a
 * checkpoint created for a different filter set.
 */
export function computeReplayFilterFingerprint(input: ReplayFilterFingerprintInput): string {
  const normalizedContracts = Array.from(new Set(input.contracts)).sort();
  const contractIds: Record<string, string> = {};
  for (const source of normalizedContracts) {
    const id = source === "market" ? input.config.marketContractId : input.config.squadContractId;
    contractIds[source] = id.trim();
  }
  const canonical = {
    network: input.network.trim().toLowerCase(),
    range: {
      from: normalizeRangeFrom(input.from),
      to: normalizeRangeTo(input.to),
    },
    contracts: normalizedContracts,
    contractIds,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function loadAndValidateProgressFile(
  filePath: string,
  opts: {
    from: string | number;
    to?: number | undefined;
    contracts: ContractSource[];
    network: string;
    config: StellarConfig | BotConfig;
    outputFile?: string | undefined;
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

  // Validate normalized filter fingerprint when present
  const expectedFingerprint = computeReplayFilterFingerprint(opts);
  if (p.filterFingerprint !== undefined) {
    if (typeof p.filterFingerprint !== "string" || p.filterFingerprint.trim() === "") {
      throw new Error(
        `invalid filterFingerprint in progress file "${filePath}". ` +
          `Remove the progress file or pass a new --progress-file path to start a fresh replay.`,
      );
    }
    if (p.filterFingerprint !== expectedFingerprint) {
      const diffs: string[] = [];
      const expectedFrom = normalizeRangeFrom(opts.from);
      const fileFrom = normalizeRangeFrom(p.range?.from ?? "");
      if (expectedFrom !== fileFrom) {
        diffs.push(`from (${fileFrom || "unset"} vs ${expectedFrom})`);
      }
      const expectedTo = normalizeRangeTo(opts.to);
      const fileTo = normalizeRangeTo(p.range?.to);
      if (expectedTo !== fileTo) {
        diffs.push(`to (${fileTo ?? "tip"} vs ${expectedTo ?? "tip"})`);
      }
      if ((p.network ?? "").trim().toLowerCase() !== opts.network.trim().toLowerCase()) {
        diffs.push(`network (${p.network ?? "unset"} vs ${opts.network})`);
      }
      const fileContracts = Array.from(new Set(p.contracts ?? [])).sort().join(",");
      const expectedContracts = Array.from(new Set(opts.contracts)).sort().join(",");
      if (fileContracts !== expectedContracts) {
        diffs.push(`contracts (${fileContracts || "none"} vs ${expectedContracts || "none"})`);
      }
      const diffSummary = diffs.length > 0 ? ` (${diffs.join("; ")})` : "";
      throw new Error(
        `progress file "${filePath}" was created for a different filter set${diffSummary} ` +
          `[fingerprint ${p.filterFingerprint.slice(0, 12)} != ${expectedFingerprint.slice(0, 12)}]. ` +
          `Re-run with the original --from/--to/--contract/network settings, or use a new --progress-file path.`,
      );
    }
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

  // Validate output file if both checkpoint and CLI specify one
  if (p.outputFile && opts.outputFile && path.resolve(p.outputFile) !== path.resolve(opts.outputFile)) {
    throw new Error(
      `progress file outputFile (${p.outputFile}) does not match requested --output-file (${opts.outputFile})`,
    );
  }

  return p as ReplayProgressFile;
}

// ── Streaming JSONL chunk merge ──────────────────────────────────────────────

/** Rank a position for ordering: known indexes first (ascending), `null`/`undefined` last. */
function rankReplayPosition(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/**
 * Canonical deterministic ordering for replay event summaries, matching
 * `compareEvents` in `decode.ts`:
 * ledger → transactionIndex → operationIndex → eventId → txHash → source → name.
 */
export function compareReplayEvents(a: ReplayEventSummary, b: ReplayEventSummary): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  const txA = rankReplayPosition(a.transactionIndex);
  const txB = rankReplayPosition(b.transactionIndex);
  if (txA !== txB) return txA - txB;
  const opA = rankReplayPosition(a.operationIndex);
  const opB = rankReplayPosition(b.operationIndex);
  if (opA !== opB) return opA - opB;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

async function writeJsonlLine(sink: JsonlOutputSink, record: ReplayJsonlRecord): Promise<void> {
  const line = `${JSON.stringify(record, scanJsonReplacer)}\n`;
  if (typeof sink === "function") {
    await sink(line);
    return;
  }
  if (!sink.write(line)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        sink.off("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        sink.off("drain", onDrain);
        reject(err);
      };
      sink.once("drain", onDrain);
      sink.once("error", onError);
    });
  }
}

function toReplayEventSummary(raw: unknown, location: string): ReplayEventSummary {
  if (!raw || typeof raw !== "object") {
    throw new Error(`invalid replay chunk record at ${location}: expected a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ledger !== "number" || !Number.isFinite(obj.ledger)) {
    throw new Error(`invalid replay chunk record at ${location}: missing numeric ledger`);
  }
  if (typeof obj.name !== "string" || obj.name === "") {
    throw new Error(`invalid replay chunk record at ${location}: missing event name`);
  }
  if (obj.source !== "market" && obj.source !== "squad") {
    throw new Error(`invalid replay chunk record at ${location}: invalid source "${String(obj.source)}"`);
  }

  const entry: ReplayEventSummary = {
    ledger: obj.ledger,
    txHash: typeof obj.txHash === "string" ? obj.txHash : "",
    eventId: typeof obj.eventId === "string" ? obj.eventId : "",
    name: obj.name,
    source: obj.source,
    sent: Boolean(obj.sent),
    skipped: Boolean(obj.skipped),
  };
  if (typeof obj.transactionIndex === "number" || obj.transactionIndex === null) {
    entry.transactionIndex = obj.transactionIndex;
  }
  if (typeof obj.operationIndex === "number" || obj.operationIndex === null) {
    entry.operationIndex = obj.operationIndex;
  }
  if (typeof obj.skipReason === "string" && obj.skipReason !== "") {
    entry.skipReason = obj.skipReason;
  }
  return entry;
}

/**
 * Stream `ReplayEventSummary` records from a replay chunk file.
 *
 * Supports:
 * - Streaming JSONL (`mimir-replay-jsonl-v1` or raw `ReplayEventSummary` lines) in O(1) memory.
 * - Legacy `mimir-replay-v1` JSON report files (extracts and sorts `targets[].eventLog`).
 */
export async function* readReplayChunkFile(filePath: string): AsyncGenerator<ReplayEventSummary> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let firstNonEmptySeen = false;

  try {
    for await (const rawLine of rl) {
      lineNo += 1;
      const line = rawLine.trim();
      if (!line) continue;

      if (!firstNonEmptySeen) {
        firstNonEmptySeen = true;
        // Pretty-printed multi-line JSON report (e.g. output of `--json`)
        if (line === "{") {
          rl.close();
          stream.destroy();
          const fullText = await readFile(filePath, "utf8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(fullText);
          } catch (err) {
            throw new Error(
              `malformed JSON in replay chunk "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (!parsed || typeof parsed !== "object" || (parsed as { format?: unknown }).format !== "mimir-replay-v1") {
            throw new Error(`unsupported JSON chunk format in "${filePath}" (expected mimir-replay-v1 or JSONL)`);
          }
          const report = parsed as Partial<ReplayReport>;
          const collected: ReplayEventSummary[] = [];
          for (const target of report.targets ?? []) {
            for (const ev of target.eventLog ?? []) {
              collected.push(toReplayEventSummary(ev, `${filePath} (target ${target.source})`));
            }
          }
          collected.sort(compareReplayEvents);
          for (const ev of collected) {
            yield ev;
          }
          return;
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(
          `malformed JSON in replay chunk "${filePath}" at line ${lineNo}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error(`invalid replay chunk record at ${filePath}:${lineNo}: expected a JSON object`);
      }

      const obj = parsed as Record<string, unknown>;

      // Single-line mimir-replay-v1 JSON report
      if (obj.format === "mimir-replay-v1" && Array.isArray(obj.targets)) {
        const collected: ReplayEventSummary[] = [];
        for (const target of obj.targets as ReplayTargetResult[]) {
          for (const ev of target.eventLog ?? []) {
            collected.push(toReplayEventSummary(ev, `${filePath}:${lineNo}`));
          }
        }
        collected.sort(compareReplayEvents);
        for (const ev of collected) {
          yield ev;
        }
        continue;
      }

      // Skip JSONL header/summary envelope records
      if (obj.type === "header" || obj.type === "summary") {
        continue;
      }

      if (obj.type === undefined || obj.type === "event") {
        yield toReplayEventSummary(obj, `${filePath}:${lineNo}`);
        continue;
      }

      throw new Error(`unknown replay chunk record type "${String(obj.type)}" at ${filePath}:${lineNo}`);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export interface MergeReplayChunksOptions {
  /** Bounded dedup window capacity (default: DEFAULT_DEDUP_WINDOW = 256; 0 disables dedup). */
  dedupWindow?: number | undefined;
  /** Optional header metadata to include in the emitted header record. */
  header?: Partial<Omit<ReplayJsonlHeader, "type" | "format" | "version">> | undefined;
  /** Optional targets metadata to include in the summary record. */
  targets?: ReplayTargetResult[] | undefined;
}

/**
 * Merge multiple replay scan chunks into a single stable streaming JSONL report
 * (`mimir-replay-jsonl-v1`).
 *
 * Uses a streaming k-way merge holding at most one head event per chunk (`O(k)`
 * memory) and a bounded `EventDedupWindow` (`O(dedupWindow)` memory), so memory
 * stays bounded on arbitrarily long histories.
 *
 * Preserves canonical ordering (`compareReplayEvents`) and the canonical
 * duplicate policy (`eventKey` — first occurrence wins; events with `null` key
 * are never suppressed).
 */
export async function mergeReplayChunksToJsonl(
  chunks: ReadonlyArray<AsyncIterable<ReplayEventSummary> | Iterable<ReplayEventSummary>>,
  sink: JsonlOutputSink,
  options: MergeReplayChunksOptions = {},
): Promise<ReplayJsonlSummary> {
  const dedupCapacity = options.dedupWindow ?? DEFAULT_DEDUP_WINDOW;
  const dedup = new EventDedupWindow(dedupCapacity);

  const header: ReplayJsonlHeader = {
    type: "header",
    format: "mimir-replay-jsonl-v1",
    version: 1,
    chunkCount: chunks.length,
    ...options.header,
  };
  await writeJsonlLine(sink, header);

  const totals = {
    events: 0,
    sent: 0,
    skipped: 0,
    capped: 0,
    adminLogged: 0,
    duplicates: 0,
    failedSends: 0,
  };

  type ChunkHead = {
    iter: AsyncIterator<ReplayEventSummary> | Iterator<ReplayEventSummary>;
    value: ReplayEventSummary | null;
    done: boolean;
  };

  const heads: ChunkHead[] = [];

  try {
    for (const chunk of chunks) {
      const iter =
        Symbol.asyncIterator in chunk
          ? chunk[Symbol.asyncIterator]()
          : chunk[Symbol.iterator]();
      const first = await iter.next();
      heads.push({
        iter,
        value: first.done ? null : first.value,
        done: Boolean(first.done),
      });
    }

    for (;;) {
      let minIdx = -1;
      for (let i = 0; i < heads.length; i += 1) {
        const h = heads[i]!;
        if (h.done || h.value === null) continue;
        if (minIdx === -1 || compareReplayEvents(h.value, heads[minIdx]!.value!) < 0) {
          minIdx = i;
        }
      }

      if (minIdx === -1) break;

      const chosen = heads[minIdx]!;
      const ev = chosen.value!;

      const next = await chosen.iter.next();
      chosen.done = Boolean(next.done);
      chosen.value = next.done ? null : next.value;

      const key = eventKey({
        eventId: ev.eventId,
        ledger: ev.ledger,
        txHash: ev.txHash,
        transactionIndex: ev.transactionIndex,
        operationIndex: ev.operationIndex,
      });

      if (!dedup.add(key)) {
        totals.duplicates += 1;
        continue;
      }

      totals.events += 1;
      if (ev.sent) {
        totals.sent += 1;
      }
      if (ev.skipped) {
        if (ev.skipReason === "admin") {
          totals.adminLogged += 1;
        } else if (ev.skipReason === "cap") {
          totals.capped += 1;
        } else {
          totals.skipped += 1;
          if (ev.skipReason === "send-error") {
            totals.failedSends += 1;
          }
        }
      }

      const record: ReplayJsonlEventRecord = {
        type: "event",
        ...ev,
      };
      await writeJsonlLine(sink, record);
    }
  } finally {
    for (const h of heads) {
      if (!h.done && typeof h.iter.return === "function") {
        try {
          await h.iter.return();
        } catch {
          // Best-effort cleanup
        }
      }
    }
  }

  const summary: ReplayJsonlSummary = {
    type: "summary",
    format: "mimir-replay-jsonl-v1",
    version: 1,
    totals,
    ...(options.targets ? { targets: options.targets } : {}),
  };
  await writeJsonlLine(sink, summary);
  return summary;
}

/**
 * Merge replay scan chunk files on disk into a stable streaming JSONL report.
 */
export async function mergeReplayChunkFilesToJsonl(
  chunkPaths: readonly string[],
  sink: JsonlOutputSink,
  options: MergeReplayChunksOptions = {},
): Promise<ReplayJsonlSummary> {
  const streams = chunkPaths.map((p) => readReplayChunkFile(p));
  return mergeReplayChunksToJsonl(streams, sink, options);
}

function isBotConfig(config: StellarConfig | BotConfig): config is BotConfig {
  return "botToken" in config;
}

// ── Offline scanner archive validation & replay ──────────────────────────────

/**
 * Load and validate a `mimir-scan-v1` scanner archive before offline replay.
 * Enforces schema identity (`format === "mimir-scan-v1"`), structural integrity,
 * and network identity (`archive.network === expected.network`) before any
 * events are processed.
 */
export async function loadAndValidateScannerArchive(
  filePath: string,
  expected: {
    network: string;
  },
): Promise<ScanJsonReport> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    throw new Error(
      `cannot read archive file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let archive: ScanJsonReport;
  try {
    archive = reviveScanReport(content);
  } catch (err: unknown) {
    throw new Error(
      `invalid scanner archive "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Enforce network identity before processing any events.
  if (archive.network !== expected.network) {
    throw new Error(
      `archive network (${archive.network}) does not match configured network (${expected.network})`,
    );
  }

  // Validate ledgers metadata.
  if (
    typeof archive.ledgers.oldest !== "number" ||
    !Number.isFinite(archive.ledgers.oldest) ||
    typeof archive.ledgers.latest !== "number" ||
    !Number.isFinite(archive.ledgers.latest)
  ) {
    throw new Error(
      `invalid scanner archive "${filePath}": ledgers.oldest and ledgers.latest must be finite numbers`,
    );
  }

  // Validate each target and its events.
  for (let i = 0; i < archive.targets.length; i += 1) {
    const t = archive.targets[i] as Partial<ScanJsonTarget> | null | undefined;
    if (!t || typeof t !== "object") {
      throw new Error(`invalid scanner archive "${filePath}": target[${i}] is not an object`);
    }
    if (t.source !== "market" && t.source !== "squad") {
      throw new Error(
        `invalid scanner archive "${filePath}": target[${i}].source must be "market" or "squad", got "${String(t.source)}"`,
      );
    }
    if (typeof t.contractId !== "string" || !t.contractId.trim()) {
      throw new Error(
        `invalid scanner archive "${filePath}": target[${i}].contractId must be a non-empty string`,
      );
    }
    if (!Array.isArray(t.events)) {
      throw new Error(
        `invalid scanner archive "${filePath}": target[${i}].events must be an array`,
      );
    }
    for (let j = 0; j < t.events.length; j += 1) {
      const ev = t.events[j] as Partial<ScanJsonEvent> | null | undefined;
      if (!ev || typeof ev !== "object") {
        throw new Error(
          `invalid scanner archive "${filePath}": target[${i}].events[${j}] is not an object`,
        );
      }
      if (typeof ev.ledger !== "number" || !Number.isFinite(ev.ledger) || ev.ledger < 0) {
        throw new Error(
          `invalid scanner archive "${filePath}": target[${i}].events[${j}].ledger must be a non-negative finite number`,
        );
      }
      if (typeof ev.txHash !== "string") {
        throw new Error(
          `invalid scanner archive "${filePath}": target[${i}].events[${j}].txHash must be a string`,
        );
      }
      if (typeof ev.eventId !== "string") {
        throw new Error(
          `invalid scanner archive "${filePath}": target[${i}].events[${j}].eventId must be a string`,
        );
      }
      if (
        !ev.payload ||
        typeof ev.payload !== "object" ||
        typeof (ev.payload as { name?: unknown }).name !== "string"
      ) {
        throw new Error(
          `invalid scanner archive "${filePath}": target[${i}].events[${j}].payload must be an object with a string name`,
        );
      }
    }
  }

  return archive;
}

/**
 * Replay one contract offline from a validated `ScanJsonReport` without
 * contacting any RPC server.
 */
async function replayContractFromArchive(
  archive: ScanJsonReport,
  target: WatchTarget,
  opts: {
    fromLedger?: number | undefined;
    toLedger?: number | undefined;
    cap?: number | undefined;
    dryRun?: boolean | undefined;
    show?: number | undefined;
  },
  send: ((text: string, source?: ContractSource) => Promise<void>) | undefined,
  config: StellarConfig | BotConfig,
  progress: (...args: unknown[]) => void,
): Promise<ReplayTargetResult> {
  const cap = opts.cap ?? (isBotConfig(config) ? config.maxNotificationsPerCycle : 20);
  const showLog = (opts.show ?? 0) > 0 || opts.dryRun === true;
  const fromLedger = opts.fromLedger;
  const toLedger = opts.toLedger ?? null;

  const matchingTargets = archive.targets.filter((t) => t.source === target.source);
  const contractId = matchingTargets[0]?.contractId ?? target.contractId;
  const dedupCapacity = isBotConfig(config) ? config.dedupWindow : 256;
  const dedup = new EventDedupWindow(dedupCapacity);

  const decodedEvents: DecodedEvent[] = [];
  let duplicates = 0;

  for (const archiveTarget of matchingTargets) {
    for (const ev of archiveTarget.events) {
      const decoded: DecodedEvent = {
        source: target.source,
        contractId: archiveTarget.contractId || target.contractId,
        version: "v1",
        ledger: ev.ledger,
        txHash: ev.txHash,
        at: 0,
        eventId: ev.eventId,
        eventType: "contract",
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        payload: ev.payload,
      };
      const key = ev.eventId || eventKey(decoded);
      if (dedup.add(key)) {
        decodedEvents.push(decoded);
      } else {
        duplicates += 1;
      }
    }
  }

  const filteredEvents = sortEvents(
    dedupeEvents(
      decodedEvents.filter((e) => {
        if (fromLedger !== undefined && e.ledger < fromLedger) return false;
        if (toLedger !== null && e.ledger > toLedger) return false;
        return true;
      }),
    ),
  );

  let sent = 0;
  let skipped = 0;
  let capped = 0;
  let adminLogged = 0;
  let failedSends = 0;
  let lastEventLedger: number | null = null;
  let lastProcessedEventId: string | null = null;
  const eventLog: ReplayEventSummary[] = [];

  const botToken = isBotConfig(config) ? config.botToken : undefined;
  const errorMsg = (err: unknown): string =>
    safeErrorMessage(err, botToken ? [botToken] : []);

  for (const event of filteredEvents) {
    const entry: ReplayEventSummary = {
      ledger: event.ledger,
      txHash: event.txHash,
      eventId: event.eventId,
      name:
        event.payload.name === "unknown"
          ? `unknown:${(event.payload as { eventName?: string }).eventName ?? "?"}`
          : event.payload.name,
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
      if (showLog) eventLog.push(entry);
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
      if (showLog) eventLog.push(entry);
      continue;
    }

    if (sent >= cap) {
      capped += 1;
      entry.skipped = true;
      entry.skipReason = "cap";
      progress(
        `[replay] ${target.source}: cap (${cap}) reached — skipping "${event.payload.name}" at ledger ${event.ledger}`,
      );
      if (showLog) eventLog.push(entry);
      continue;
    }

    if (opts.dryRun !== false && !send) {
      let text: string | null = null;
      try {
        text = isBotConfig(config)
          ? formatEvent(config, event)
          : `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
      } catch {
        text = `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
      }
      progress(
        `[replay] ${target.source}: would send "${event.payload.name}" at ledger ${event.ledger}${text ? ` — ${text.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
      );
      sent += 1;
      entry.sent = true;
      if (showLog) eventLog.push(entry);
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
        if (showLog) eventLog.push(entry);
        continue;
      }

      if (text === null) {
        skipped += 1;
        entry.skipped = true;
        entry.skipReason = "null-format";
        if (showLog) eventLog.push(entry);
        continue;
      }

      try {
        await send(text, event.source);
        sent += 1;
        entry.sent = true;
      } catch (err) {
        skipped += 1;
        failedSends += 1;
        entry.skipped = true;
        entry.skipReason = "send-error";
        progress(
          `[replay] ${target.source}: send failed for "${event.payload.name}" at ledger ${event.ledger}: ` +
            errorMsg(err),
        );
      }
      if (showLog) eventLog.push(entry);
    } else {
      sent += 1;
      entry.sent = true;
      if (showLog) eventLog.push(entry);
    }

    const evKey = event.eventId || eventKey(event);
    if (evKey) {
      lastProcessedEventId = evKey;
    }
    if (event.ledger > 0 && (lastEventLedger === null || event.ledger > lastEventLedger)) {
      lastEventLedger = event.ledger;
    }
  }

  progress(
    `[replay] ${target.source}: archive events=${filteredEvents.length} sent=${sent} ` +
      `skipped=${skipped} capped=${capped} admin=${adminLogged} duplicates=${duplicates}`,
  );

  return {
    source: target.source,
    contractId,
    fromLedger: fromLedger ?? archive.ledgers.oldest ?? 0,
    toLedger: toLedger ?? archive.ledgers.latest ?? null,
    startLedger: fromLedger ?? matchingTargets[0]?.startLedger ?? null,
    startClamped: false,
    pages: 0,
    events: filteredEvents.length,
    sent,
    skipped,
    capped,
    adminLogged,
    duplicates,
    truncated: false,
    lastEventLedger,
    cursor: matchingTargets[matchingTargets.length - 1]?.cursor ?? null,
    eventLog: showLog ? eventLog : [],
    resumedSkippedEvents: 0,
    lastProcessedEventId,
    failedSends,
  };
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
  const showLog = !opts.onEvent && ((opts.show ?? 0) > 0 || opts.dryRun === true);
  const recordEvent = async (entry: ReplayEventSummary): Promise<void> => {
    if (opts.onEvent) {
      await opts.onEvent(entry);
    } else if (showLog) {
      eventLog.push(entry);
    }
  };

  // If this target was already marked completed in the progress file, skip RPC walk entirely.
  if (opts.targetProgress?.completed) {
    progress(
      `[replay] ${target.source}: already completed in progress file (pages=${opts.targetProgress.pagesProcessed} events=${opts.targetProgress.eventsProcessed} sent=${opts.targetProgress.eventsSent})`,
    );
    const savedStartClamped = opts.targetProgress.startClamped ?? false;
    const savedObservedFrom =
      opts.targetProgress.observedFromLedger ??
      parseRequestedFromLedger(opts.from) ??
      opts.targetProgress.lastEventLedger;
    const savedObservedTo =
      opts.targetProgress.observedToLedger ??
      opts.targetProgress.chainTipLedger ??
      toLedger ??
      opts.targetProgress.lastEventLedger;
    const certificate = buildTargetCertificate({
      source: target.source,
      contractId: target.contractId,
      requestedFrom: opts.from,
      requestedTo: toLedger,
      observedFromLedger: savedObservedFrom,
      observedToLedger: savedObservedTo,
      retainedFloorLedger: opts.targetProgress.retainedFloorLedger ?? null,
      chainTipLedger: opts.targetProgress.chainTipLedger ?? null,
      startClamped: savedStartClamped,
      truncated: false,
      pages: opts.targetProgress.pagesProcessed,
    });
    return {
      source: target.source,
      contractId: target.contractId,
      fromLedger: savedObservedFrom ?? opts.targetProgress.lastEventLedger ?? 0,
      toLedger,
      startLedger: savedObservedFrom,
      startClamped: savedStartClamped,
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
      budgetExhausted: false,
      completed: true,
    };
  }

  const eventBudget =
    opts.eventBudget ??
    (opts.maxEvents !== undefined ? new EventBudgetTracker(opts.maxEvents) : undefined);

  if (eventBudget?.exhausted) {
    progress(
      `[replay] ${target.source}: event budget (${eventBudget.limit}) already exhausted before starting target`,
    );
    return {
      source: target.source,
      contractId: target.contractId,
      fromLedger: opts.targetProgress?.lastEventLedger ?? 0,
      toLedger,
      startLedger: null,
      startClamped: false,
      pages: opts.targetProgress?.pagesProcessed ?? 0,
      events: opts.targetProgress?.eventsProcessed ?? 0,
      sent: opts.targetProgress?.eventsSent ?? 0,
      skipped: opts.targetProgress?.eventsSkipped ?? 0,
      capped: opts.targetProgress?.eventsCapped ?? 0,
      adminLogged: opts.targetProgress?.adminLogged ?? 0,
      duplicates: opts.targetProgress?.duplicates ?? 0,
      truncated: false,
      lastEventLedger: opts.targetProgress?.lastEventLedger ?? null,
      cursor: opts.targetProgress?.cursor ?? null,
      eventLog: [],
      resumedSkippedEvents: 0,
      lastProcessedEventId: opts.targetProgress?.lastProcessedEventId ?? null,
      failedSends: opts.targetProgress?.failedSends ?? 0,
      budgetExhausted: true,
      completed: false,
    };
  }

  // Resolve the ledger window before the first page.
  if (opts.budget) await opts.budget.acquire();
  const window = validateLedgerWindow(await server.getHealth());

  const isResuming = !!opts.targetProgress;
  const initialStartClamped = opts.targetProgress?.startClamped ?? false;
  const initialObservedFromLedger = opts.targetProgress?.observedFromLedger ?? null;
  const initialRetainedFloorLedger = opts.targetProgress?.retainedFloorLedger ?? window.oldestLedger;
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
  let lastCommittedOutputEventId: string | null =
    opts.initialLastCommittedOutputEventId ?? opts.targetProgress?.lastCommittedOutputEventId ?? null;
  let committedOutputRecords =
    opts.initialCommittedOutputCount ?? opts.targetProgress?.committedOutputRecords ?? 0;

  let lastCursor: string | null = opts.targetProgress?.cursor ?? null;
  let truncated = false;
  let cancelled = false;
  let stoppedByToLedger = false;
  let budgetExhausted = false;
  let completed = false;
  let latestLedger = window.latestLedger;
  let cursor: string | undefined = startCursor;
  let usedStartLedger: number | null = null;
  let usedStartClamped = false;
  let previousCursor = startCursor ?? "";
  let previousCursorLedger: number | null = startCursor ? eventCursorLedger(startCursor) : null;
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
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (pagesInThisRun >= maxPages) {
      truncated = true;
      break;
    }
    pagesInThisRun += 1;
    const totalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;

    if (opts.budget) await opts.budget.acquire();
    if (opts.signal?.aborted) {
      pagesInThisRun -= 1;
      cancelled = true;
      break;
    }

    const response: rpc.Api.GetEventsResponse = cursor
      ? await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], cursor, limit: pageLimit }))
      : await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], startLedger: firstStartLedger, limit: pageLimit }));

    // Reject nonmonotonic ledger boundaries before decoding, sending, or committing a checkpoint.
    const { nextCursorLedger } = validateReplayPageLedgerBoundaries(response, {
      latestLedger,
      previousCursorLedger,
      lastEventLedger,
    });

    const rawEvents = Array.isArray(response?.events) ? response.events : [];
    const pageDecoded: DecodedEvent[] = [];
    const seenInPage = new Set<string>();

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

      if (key !== null && (dedup.has(key) || seenInPage.has(key))) {
        duplicates += 1;
      } else {
        if (key !== null) seenInPage.add(key);
        pageDecoded.push(decodeEvent(target.source, raw));
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

    let stoppedMidPage = false;

    // Notify / log each event in this page
    for (const event of filteredPage) {
      if (eventBudget && !eventBudget.consume()) {
        stoppedMidPage = true;
        budgetExhausted = true;
        break;
      }

      const evKey = event.eventId || eventKey(event);
      if (evKey) {
        dedup.add(evKey);
      }
      totalProcessedEvents += 1;
      const entry: ReplayEventSummary = {
        ledger: event.ledger,
        transactionIndex: event.transactionIndex,
        operationIndex: event.operationIndex,
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
        await recordEvent(entry);
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
        await recordEvent(entry);
        continue;
      }

      if (sent >= cap) {
        capped += 1;
        entry.skipped = true;
        entry.skipReason = "cap";
        progress(
          `[replay] ${target.source}: cap (${cap}) reached — skipping "${event.payload.name}" at ledger ${event.ledger}`,
        );
        await recordEvent(entry);
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
        await recordEvent(entry);
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
          await recordEvent(entry);
          continue;
        }

        if (text === null) {
          skipped += 1;
          entry.skipped = true;
          entry.skipReason = "null-format";
          await recordEvent(entry);
          continue;
        }

        try {
          await send(text, event.source);
          sent += 1;
          entry.sent = true;
        } catch (err) {
          skipped += 1;
          failedSends += 1;
          entry.skipped = true;
          entry.skipReason = "send-error";
          progress(
            `[replay] ${target.source}: send failed for "${event.payload.name}" at ledger ${event.ledger}: ` +
              errorMsg(err),
          );
        }
        await recordEvent(entry);
      } else {
        sent += 1;
        entry.sent = true;
        await recordEvent(entry);
      }

      if (evKey) {
        lastProcessedEventId = evKey;
      }
      if (event.ledger > 0 && (lastEventLedger === null || event.ledger > lastEventLedger)) {
        lastEventLedger = event.ledger;
      }

      if (opts.onOutputRecord) {
        const recordId = evKey || `${event.txHash}:${event.ledger}`;
        if (!opts.committedOutputIds?.has(recordId)) {
          committedOutputRecords += 1;
          lastCommittedOutputEventId = recordId;
          const record: ReplayOutputRecord = {
            type: "event",
            source: event.source,
            contractId: target.contractId,
            ledger: event.ledger,
            txHash: event.txHash,
            eventId: recordId,
            name: entry.name,
            sent: entry.sent,
            skipped: entry.skipped,
            ...(entry.skipReason !== undefined ? { skipReason: entry.skipReason } : {}),
            payload: event.payload,
          };
          await opts.onOutputRecord(record, {
            lastCommittedOutputEventId: recordId,
            committedOutputRecords,
          });
        }
      }
    }

    // If cancelled mid-page, do NOT commit partial page progress to disk.
    if (cancelled || opts.signal?.aborted) {
      cancelled = true;
      pagesInThisRun -= 1;
      break;
    }

    const nextCursor = typeof response?.cursor === "string" ? response.cursor : "";
    let isFinalPage = false;

    if (stoppedMidPage) {
      // Stopped mid-page due to --max-events: rewind/anchor cursor at the last
      // processed event (if cursor-shaped) or keep previousCursor so remaining
      // events on this page are re-fetched on resume without loss.
      if (lastProcessedEventId && /^\d+-\d+$/.test(lastProcessedEventId)) {
        lastCursor = lastProcessedEventId;
      } else {
        lastCursor = previousCursor || lastCursor;
      }
      isFinalPage = false;
      stoppedByToLedger = false;
    } else if (!nextCursor || nextCursor === previousCursor) {
      isFinalPage = true;
    } else {
      lastCursor = nextCursor;
      const reached = nextCursorLedger;
      if (reached !== null && reached >= latestLedger) {
        isFinalPage = true;
      }
      if (effectiveTo !== null && reached !== null && reached > effectiveTo) {
        stoppedByToLedger = true;
        isFinalPage = true;
      }
      previousCursor = nextCursor;
      if (reached !== null) {
        previousCursorLedger = reached;
      }
      cursor = nextCursor;
    }

    if (!stoppedMidPage && eventBudget?.exhausted && !isFinalPage) {
      budgetExhausted = true;
    }

    completed = isFinalPage && !truncated && !budgetExhausted;

    // Persist checkpoint after each completed page
    if (opts.onPageComplete) {
      const pageObservedFrom =
        initialObservedFromLedger ??
        usedStartLedger ??
        startLedger ??
        (startCursor ? eventCursorLedger(startCursor) : null) ??
        firstStartLedger;
      const pageObservedTo =
        isFinalPage && !truncated
          ? (effectiveTo ?? latestLedger)
          : (eventCursorLedger(lastCursor ?? "") ?? lastEventLedger ?? pageObservedFrom);
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
        completed,
        budgetExhausted,
        failedSends,
        observedFromLedger: pageObservedFrom,
        observedToLedger: pageObservedTo,
        retainedFloorLedger: initialRetainedFloorLedger,
        chainTipLedger: latestLedger,
        startClamped: usedStartClamped || startClamped || initialStartClamped,
      });
    }

    if (isFinalPage || stoppedByToLedger || budgetExhausted) {
      break;
    }
  }

  const finalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;
  const finalStartClamped = usedStartClamped || startClamped || initialStartClamped;
  const observedFromLedger =
    initialObservedFromLedger ??
    usedStartLedger ??
    startLedger ??
    (startCursor ? eventCursorLedger(startCursor) : null) ??
    firstStartLedger;
  const observedToLedger = truncated
    ? (eventCursorLedger(lastCursor ?? "") ?? lastEventLedger ?? observedFromLedger)
    : (effectiveTo ?? latestLedger);

  const certificate = buildTargetCertificate({
    source: target.source,
    contractId: target.contractId,
    requestedFrom: opts.from,
    requestedTo: toLedger,
    observedFromLedger,
    observedToLedger,
    retainedFloorLedger: initialRetainedFloorLedger,
    chainTipLedger: latestLedger,
    startClamped: finalStartClamped,
    truncated,
    pages: finalPages,
  });

  progress(
    `[replay] ${target.source}: pages=${finalPages} events=${totalProcessedEvents} sent=${sent} ` +
      `skipped=${skipped} capped=${capped} admin=${adminLogged} duplicates=${duplicates} ` +
      `truncated=${truncated || stoppedByToLedger} budgetExhausted=${budgetExhausted}` +
      (resumedSkippedEvents > 0 ? ` resumedSkipped=${resumedSkippedEvents}` : ""),
  );

  return {
    source: target.source,
    contractId: target.contractId,
    fromLedger: usedStartLedger ?? window.oldestLedger,
    toLedger: effectiveTo,
    startLedger: usedStartLedger,
    startClamped: finalStartClamped,
    pages: finalPages,
    events: totalProcessedEvents,
    sent,
    skipped,
    capped,
    adminLogged,
    duplicates,
    truncated: truncated || stoppedByToLedger,
    lastEventLedger,
    cursor: lastCursor,
    eventLog: showLog ? eventLog : [],
    resumedSkippedEvents,
    lastProcessedEventId,
    failedSends,
    budgetExhausted,
    completed,
  };
}

/**
 * Run the replay CLI. Exported so tests can call it directly with a fake
 * server and fake send function, without spawning a subprocess.
 *
 * Returns a `ReplayReport` and the process exit code (0 = success, 1 = fatal
 * error, 2 = usage error, 130 = cancelled by SIGINT).
 */
export async function runReplayCli(opts: {
  argv?: string[];
  deps?: Partial<ReplayDeps>;
} = {}): Promise<{ report: ReplayReport | null; exitCode: 0 | 1 | 2 | 130 }> {
  const argv = opts.argv ?? process.argv;
  const overrideDeps = opts.deps ?? {};

  // ── Parse flags ────────────────────────────────────────────────────────────

  function flag(name: string): string | undefined {
    const index = argv.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const next = argv[index + 1];
    return next?.startsWith("--") ? undefined : next;
  }

  function multiFlag(name: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === `--${name}`) {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          for (const part of next.split(",")) {
            const trimmed = part.trim();
            if (trimmed) out.push(trimmed);
          }
        }
      }
    }
    return out;
  }

  function boolFlag(name: string): boolean {
    return argv.includes(`--${name}`);
  }

  const fromRaw = flag("from");
  const toRaw = flag("to");
  const archivePath = flag("archive");
  const contractFilter = flag("contract") as ContractSource | undefined;
  const maxPages = flag("pages") ? Math.max(1, Number(flag("pages"))) : EVENT_MAX_PAGES;
  const cap = flag("cap") ? Math.max(1, Number(flag("cap"))) : undefined;
  const show = flag("show") ? Math.max(0, Number(flag("show"))) : 0;
  const dryRun = !boolFlag("send"); // Default is dry-run; --send enables actual sending.
  const asJson = boolFlag("json");
  const asJsonl = boolFlag("jsonl");
  const mergeChunks = multiFlag("merge-chunks");
  const outPath = flag("out");
  const dedupWindowRaw = flag("dedup-window");
  const progressFile = flag("progress-file");
  const certificateFile = flag("certificate-file");
  const rpmRaw = flag("rpm");
  const machineOutput = asJson || asJsonl || mergeChunks.length > 0;
  const progress = overrideDeps.progress ?? (machineOutput ? console.error.bind(console) : console.log.bind(console));
  const safeErr = (err: unknown): string => safeErrorMessage(err, []);

  if (asJson && asJsonl) {
    console.error("[replay] error: --json and --jsonl are mutually exclusive");
    return { report: null, exitCode: 2 };
  }

  // Validate --dedup-window
  let dedupWindow: number | undefined;
  if (dedupWindowRaw !== undefined) {
    const n = parseInt(dedupWindowRaw, 10);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`[replay] error: --dedup-window must be a non-negative integer, got "${dedupWindowRaw}"`);
      return { report: null, exitCode: 2 };
    }
    dedupWindow = n;
  }

  // ── Merge-chunks mode (offline streaming JSONL merge) ─────────────────────

  if (mergeChunks.length > 0) {
    if (asJson) {
      console.error("[replay] error: --merge-chunks outputs streaming JSONL and cannot be combined with --json");
      return { report: null, exitCode: 2 };
    }

    let fileStream: ReturnType<typeof createWriteStream> | null = null;
    try {
      let sink: JsonlOutputSink;
      if (outPath) {
        await mkdir(path.dirname(outPath), { recursive: true });
        fileStream = createWriteStream(outPath, { encoding: "utf8" });
        sink = fileStream;
      } else {
        sink = overrideDeps.writeJsonl ?? ((line: string) => { process.stdout.write(line); });
      }

      const summary = await mergeReplayChunkFilesToJsonl(mergeChunks, sink, {
        dedupWindow,
      });

      if (fileStream) {
        await new Promise<void>((resolve, reject) => {
          fileStream!.once("error", reject);
          fileStream!.end(() => resolve());
        });
        fileStream = null;
      }

      progress(
        `[replay] merged ${mergeChunks.length} chunk(s): events=${summary.totals.events} ` +
          `sent=${summary.totals.sent} skipped=${summary.totals.skipped} ` +
          `capped=${summary.totals.capped} admin=${summary.totals.adminLogged} ` +
          `duplicates=${summary.totals.duplicates}`,
      );

      const report: ReplayReport = {
        format: "mimir-replay-v1",
        network: "merged",
        rpcUrl: "",
        fromLedger: 0,
        toLedger: null,
        dryRun: true,
        targets: [],
        totals: summary.totals,
      };
      return { report, exitCode: 0 };
    } catch (err) {
      if (fileStream) {
        fileStream.destroy();
      }
      console.error(`[replay] merge error: ${safeErr(err)}`);
      return { report: null, exitCode: 1 };
    }
  }

  if (!fromRaw) {
    console.error("[replay] error: --from <ledger|cursor> is required (or pass --merge-chunks <paths>)");
    console.error("Usage: npm run replay -- --from <ledger> [--to <ledger>] [--send] [--dry-run] [--contract market|squad] [--pages N] [--cap N] [--show N] [--json|--jsonl] [--out <path>] [--mock] [--progress-file <path>] [--rpm N]");
    console.error("       npm run replay -- --merge-chunks <file1,file2,...> [--out <path>] [--dedup-window N]");
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

  // Validate --max-events
  let maxEvents: number | undefined;
  if (boolFlag("max-events") && maxEventsRaw === undefined) {
    console.error("[replay] error: --max-events requires a positive integer value");
    return { report: null, exitCode: 2 };
  }
  if (maxEventsRaw !== undefined) {
    const n = Number(maxEventsRaw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`[replay] error: --max-events must be a positive integer, got "${maxEventsRaw}"`);
      return { report: null, exitCode: 2 };
    }
    maxEvents = n;
  }

  // Validate --from vs --to for ledger numbers (cursors are opaque).
  let fromLedger: number | undefined;
  if (fromRaw !== undefined) {
    if (!/^\d+-\d+$/.test(fromRaw)) {
      // Might be a plain ledger number.
      const n = parseInt(fromRaw, 10);
      if (Number.isFinite(n) && n >= 1) {
        fromLedger = n;
      } else if (Number.isFinite(n) && n < 1) {
        console.error(`[replay] error: --from ledger must be >= 1, got ${n}`);
        return { report: null, exitCode: 2 };
      } else if (archivePath) {
        console.error(`[replay] error: --from must be a positive ledger number or cursor when using --archive, got "${fromRaw}"`);
        return { report: null, exitCode: 2 };
      }
      // Non-numeric is fine in RPC mode, some cursors might not match our digit pattern.
    } else if (archivePath) {
      const cursorLedger = eventCursorLedger(fromRaw);
      if (cursorLedger === null || cursorLedger < 1) {
        console.error(`[replay] error: --from cursor "${fromRaw}" could not be resolved to a ledger for archive replay`);
        return { report: null, exitCode: 2 };
      }
      fromLedger = cursorLedger;
    }
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
        send = createNotifier(bot, botConfig, { requireMessageId: true });
      }
    } else {
      config = overrideDeps.config ?? loadStellarConfig();
    }
  } catch (err) {
    console.error(`[replay] config error: ${safeErr(err)}`);
    return { report: null, exitCode: 1 };
  }

  const network = networkLabel(config);

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

  // ── Signed-off plan ───────────────────────────────────────────────────────

  const plan = buildReplayPlan({
    network,
    from: fromRaw,
    to: toLedger ?? null,
    targets,
  });

  if (!dryRun && planDigestRaw !== plan.digest) {
    console.error(
      `[replay] error: plan digest mismatch — preview was ${planDigestRaw}, ` +
        `current plan is ${plan.digest}`,
    );
    console.error(
      "The range or destinations changed. Re-run the dry-run preview and review it before delivering.",
    );
    return { report: null, exitCode: 2 };
  }

  if (!asJson) {
    progress(`[replay] network   ${network} · rpc ${config.rpcUrl}`);
    progress(`[replay] from      ${fromRaw}${toLedger !== undefined ? `  to ${toLedger}` : "  (to chain tip)"}`);
    progress(`[replay] mode      ${dryRun ? "dry-run (use --send to deliver to Telegram)" : "SEND"}`);
    progress(`[replay] plan      ${plan.digest}`);
    if (progressFile) progress(`[replay] progress  ${progressFile}`);
    if (rpm !== undefined) progress(`[replay] rpm       ${rpm}`);
  } else {
    progress(
      `replay ${network} from=${fromRaw} to=${toLedger ?? "tip"} mode=${dryRun ? "dry-run" : "send"}` +
        ` plan=${plan.digest}` +
        (progressFile ? ` progress=${progressFile}` : "") +
        (rpm !== undefined ? ` rpm=${rpm}` : ""),
    );
  }

  // ── Rate limiter budget ───────────────────────────────────────────────────

  const sleep = overrideDeps.sleep ?? defaultSleep;
  const now = overrideDeps.now ?? Date.now;
  const budget = rpm !== undefined ? new RpcBudgetTracker(rpm, sleep, now) : undefined;
  const eventBudget = maxEvents !== undefined ? new EventBudgetTracker(maxEvents) : undefined;

  // ── Prepare output file (if any) & load/initialize progress file ──────────

  let preparedOutput: PreparedReplayOutput | null = null;
  if (outputFile) {
    try {
      preparedOutput = await prepareReplayOutputFile(outputFile);
      if (preparedOutput.trimmedTrailingBytes > 0) {
        progress(
          `[replay] trimmed ${preparedOutput.trimmedTrailingBytes} uncommitted trailing bytes from "${outputFile}"`,
        );
      }
      if (preparedOutput.committedCount > 0) {
        progress(
          `[replay] resuming output file "${outputFile}" (${preparedOutput.committedCount} committed records, last=${preparedOutput.lastCommittedEventId ?? "none"})`,
        );
      }
    } catch (err: unknown) {
      console.error(`[replay] error: ${err instanceof Error ? err.message : String(err)}`);
      return { report: null, exitCode: 2 };
    }
  }

  let progressData: ReplayProgressFile | null = null;
  if (progressFile) {
    const filterFingerprint = computeReplayFilterFingerprint({
      from: fromRaw,
      to: toLedger,
      contracts: requestedContracts,
      network,
      config,
    });
    try {
      progressData = await loadAndValidateProgressFile(progressFile, {
        from: fromRaw!,
        to: toLedger,
        contracts: requestedContracts,
        network,
        config,
        outputFile,
      });
      if (progressData) {
        if (!progressData.filterFingerprint) {
          progressData.filterFingerprint = filterFingerprint;
        }
        progress(`[replay] loaded progress file "${progressFile}"`);
      } else {
        progressData = {
          format: "mimir-replay-progress-v1",
          version: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          network,
          rpcUrl: config.rpcUrl,
          range: {
            from: normalizeRangeFrom(fromRaw!),
            to: normalizeRangeTo(toLedger),
          },
          contracts: requestedContracts,
          filterFingerprint,
          targets: {},
        };
      }
    } catch (err: unknown) {
      console.error(`[replay] error: ${err instanceof Error ? err.message : String(err)}`);
      return { report: null, exitCode: 2 };
    }
  }

  // ── Walk each target ───────────────────────────────────────────────────────

  let jsonlFileStream: ReturnType<typeof createWriteStream> | null = null;
  let jsonlSink: JsonlOutputSink | undefined;

  if (asJsonl) {
    try {
      if (outPath) {
        await mkdir(path.dirname(outPath), { recursive: true });
        jsonlFileStream = createWriteStream(outPath, { encoding: "utf8" });
        jsonlSink = jsonlFileStream;
      } else {
        jsonlSink = overrideDeps.writeJsonl ?? ((line: string) => { process.stdout.write(line); });
      }
      await writeJsonlLine(jsonlSink, {
        type: "header",
        format: "mimir-replay-jsonl-v1",
        version: 1,
        network,
        rpcUrl: config.rpcUrl,
        fromLedger: fromLedger ?? 0,
        toLedger: toLedger ?? null,
        dryRun,
      });
    } catch (err) {
      if (jsonlFileStream) jsonlFileStream.destroy();
      console.error(`[replay] output error: ${safeErr(err)}`);
      return { report: null, exitCode: 1 };
    }
  }

  const onEvent = jsonlSink
    ? async (entry: ReplayEventSummary) => {
        await writeJsonlLine(jsonlSink!, { type: "event", ...entry });
      }
    : undefined;

  const targetResults: ReplayTargetResult[] = [];
  let fatalError: string | undefined;
  const writeLine = overrideDeps.writeOutputLine ?? defaultWriteOutputLine;

  const cancelController = new AbortController();
  const onExternalAbort = (): void => {
    if (!cancelController.signal.aborted) {
      cancelController.abort();
    }
  };
  if (overrideDeps.signal) {
    if (overrideDeps.signal.aborted) {
      onExternalAbort();
    } else {
      overrideDeps.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
  const onSigint = (): void => {
    if (!cancelController.signal.aborted) {
      progress(`[replay] SIGINT received — stopping after committed progress`);
      cancelController.abort();
    }
  };
  process.on("SIGINT", onSigint);

    try {
      const result = await replayContract(
        server,
        target,
        {
          from: fromRaw!,
          to: toLedger,
          maxPages,
          cap,
          show,
          dryRun,
          contracts: requestedContracts,
          progressFile,
          certificateFile,
          rpm,
          maxEvents,
          eventBudget,
          targetProgress,
          onOutputRecord,
          onPageComplete,
          onEvent,
          budget,
        },
        dryRun ? undefined : send,
        config,
        progress,
      );
      targetResults.push(result);
    } catch (err) {
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
        budgetExhausted: false,
        completed: false,
      });
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

  const anyBudgetExhausted = targetResults.some((r) => r.budgetExhausted === true);
  const allCompleted =
    !fatalError &&
    !anyBudgetExhausted &&
    targetResults.length > 0 &&
    targetResults.every((r) => r.completed !== false);

  const report: ReplayReport = {
    format: "mimir-replay-v1",
    network,
    rpcUrl: config.rpcUrl,
    fromLedger: fromLedger ?? 0,
    toLedger: toLedger ?? null,
    dryRun,
    ...(maxEvents !== undefined ? { maxEvents } : {}),
    budgetExhausted: anyBudgetExhausted,
    completed: allCompleted,
    targets: targetResults,
    totals,
    certificate,
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, scanJsonReplacer, 2) + "\n");
  } else if (asJsonl && jsonlSink) {
    try {
      await writeJsonlLine(jsonlSink, {
        type: "summary",
        format: "mimir-replay-jsonl-v1",
        version: 1,
        totals,
        targets: targetResults,
      });
      if (jsonlFileStream) {
        await new Promise<void>((resolve, reject) => {
          jsonlFileStream!.once("error", reject);
          jsonlFileStream!.end(() => resolve());
        });
        jsonlFileStream = null;
      }
    } catch (err) {
      if (jsonlFileStream) jsonlFileStream.destroy();
      console.error(`[replay] output error: ${safeErr(err)}`);
      return { report, exitCode: 1 };
    }
  } else {
    progress(
      `[replay] done  events=${totals.events} sent=${totals.sent} skipped=${totals.skipped} ` +
        `capped=${totals.capped} admin=${totals.adminLogged} duplicates=${totals.duplicates}` +
        ` completed=${allCompleted} budgetExhausted=${anyBudgetExhausted}` +
        ((totals.resumedSkippedEvents ?? 0) > 0 ? ` resumedSkipped=${totals.resumedSkippedEvents}` : ""),
    );
    progress(
      `[replay] certificate  complete=${certificate.complete} gaps=${certificate.gaps.length} digest=${certificate.digest.slice(0, 12)}`,
    );
  }

  return {
    report,
    exitCode: wasCancelled ? EXIT_REPLAY_CANCELLED : fatalError ? 1 : 0,
  };
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
