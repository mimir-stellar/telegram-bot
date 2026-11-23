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

import { createHash } from "node:crypto";
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

// ── Replay report types ───────────────────────────────────────────────────────

/** POSIX exit code for SIGINT-cancelled replay (128 + SIGINT(2)). */
export const EXIT_REPLAY_CANCELLED = 130;

export type ReplayRunStatus = "completed" | "cancelled" | "failed";

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
  /** True when stopped because the configured --max-events budget was reached before completion. */
  budgetExhausted?: boolean | undefined;
  /** True when the target completed its entire requested range. */
  completed?: boolean | undefined;
}

export interface ReplayReport {
  format: "mimir-replay-v1";
  network: string;
  rpcUrl: string;
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
  lastCommittedOutputEventId?: string | null | undefined;
  committedOutputRecords?: number | undefined;
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

// ── Event-Count Budget Tracker ───────────────────────────────────────────────

export class EventBudgetTracker {
  readonly limit: number;
  private usedCount: number = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--max-events must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
  }

  get used(): number {
    return this.usedCount;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.usedCount);
  }

  get exhausted(): boolean {
    return this.usedCount >= this.limit;
  }

  consume(): boolean {
    if (this.usedCount >= this.limit) return false;
    this.usedCount += 1;
    return true;
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
  /** Path to an optional JSONL output file for committed event records. */
  outputFile?: string | undefined;
  /** Event IDs already committed in an existing output file (to avoid duplicates on resume). */
  committedOutputIds?: ReadonlySet<string> | undefined;
  /** Initial count of committed output records for this target. */
  initialCommittedOutputCount?: number | undefined;
  /** Initial last committed output event ID for this target. */
  initialLastCommittedOutputEventId?: string | null | undefined;
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
  /** Sleeper function for deterministic rate-limit / delay tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Timestamp provider for deterministic rate-limit / delay tests. */
  now?: (() => number) | undefined;
  /** Optional cancellation signal for testing SIGINT / abort handling. */
  signal?: AbortSignal | undefined;
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

export interface PreparedReplayOutput {
  committedEventIds: Set<string>;
  committedEventIdsBySource: Partial<Record<ContractSource, Set<string>>>;
  lastCommittedEventId: string | null;
  lastCommittedEventIdBySource: Partial<Record<ContractSource, string>>;
  committedCount: number;
  committedCountBySource: Partial<Record<ContractSource, number>>;
  trimmedTrailingBytes: number;
}

/**
 * Inspect an existing replay output JSONL file before resuming:
 * - Preserves all fully committed newline-terminated JSON records without truncating them.
 * - Trims any incomplete or corrupt trailing fragment left by an interrupted write.
 * - Rejects corrupt records in the middle of the file.
 */
export async function prepareReplayOutputFile(filePath: string): Promise<PreparedReplayOutput> {
  const committedEventIds = new Set<string>();
  const committedEventIdsBySource: Partial<Record<ContractSource, Set<string>>> = {};
  const lastCommittedEventIdBySource: Partial<Record<ContractSource, string>> = {};
  const committedCountBySource: Partial<Record<ContractSource, number>> = {};
  let lastCommittedEventId: string | null = null;
  let committedCount = 0;

  let buf: Buffer;
  try {
    buf = await readFile(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(path.dirname(filePath), { recursive: true });
      return {
        committedEventIds,
        committedEventIdsBySource,
        lastCommittedEventId,
        lastCommittedEventIdBySource,
        committedCount,
        committedCountBySource,
        trimmedTrailingBytes: 0,
      };
    }
    throw new Error(`cannot read output file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  let validEndOffset = 0;
  let lineStart = 0;
  let lineNumber = 0;

  while (lineStart < buf.length) {
    const newlineIdx = buf.indexOf(0x0a, lineStart);
    if (newlineIdx === -1) {
      // Unterminated trailing fragment from an interrupted write.
      break;
    }

    lineNumber += 1;
    const rawLine = buf.subarray(lineStart, newlineIdx).toString("utf8").replace(/\r$/, "");
    const nextStart = newlineIdx + 1;

    if (rawLine.trim().length === 0) {
      validEndOffset = nextStart;
      lineStart = nextStart;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch (err: unknown) {
      // If this is the final line in the file, treat it as an interrupted write and trim it.
      if (nextStart >= buf.length) {
        break;
      }
      throw new Error(
        `corrupt output record at line ${lineNumber} in "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!parsed || typeof parsed !== "object" || typeof (parsed as { eventId?: unknown }).eventId !== "string") {
      if (nextStart >= buf.length) {
        break;
      }
      throw new Error(`invalid output record schema at line ${lineNumber} in "${filePath}"`);
    }

    const rec = parsed as Partial<ReplayOutputRecord>;
    const eventId = rec.eventId as string;
    committedEventIds.add(eventId);
    lastCommittedEventId = eventId;
    committedCount += 1;

    if (rec.source === "market" || rec.source === "squad") {
      let set = committedEventIdsBySource[rec.source];
      if (!set) {
        set = new Set<string>();
        committedEventIdsBySource[rec.source] = set;
      }
      set.add(eventId);
      lastCommittedEventIdBySource[rec.source] = eventId;
      committedCountBySource[rec.source] = (committedCountBySource[rec.source] ?? 0) + 1;
    }

    validEndOffset = nextStart;
    lineStart = nextStart;
  }

  const trimmedTrailingBytes = buf.length - validEndOffset;
  if (trimmedTrailingBytes > 0) {
    await truncate(filePath, validEndOffset);
  }

  return {
    committedEventIds,
    committedEventIdsBySource,
    lastCommittedEventId,
    lastCommittedEventIdBySource,
    committedCount,
    committedCountBySource,
    trimmedTrailingBytes,
  };
}

async function defaultWriteOutputLine(filePath: string, line: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const fh = await open(filePath, "a");
  try {
    await fh.write(line, null, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
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

    if (opts.signal?.aborted) {
      pagesInThisRun -= 1;
      cancelled = true;
      break;
    }

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
          text = isBotConfig(config) ? formatEvent(config, event) : `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
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

    if (!stoppedMidPage && eventBudget?.exhausted && !isFinalPage) {
      budgetExhausted = true;
    }

    completed = isFinalPage && !truncated && !budgetExhausted;

    // Persist checkpoint after each completed page
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
        completed,
        budgetExhausted,
        failedSends,
        lastCommittedOutputEventId,
        committedOutputRecords,
      });
    }

    if (isFinalPage || stoppedByToLedger || budgetExhausted) {
      break;
    }
  }

  const finalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;

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
    startClamped: usedStartClamped,
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
  const outputFile = flag("output-file") ?? flag("out");
  const rpmRaw = flag("rpm");
  const maxEventsRaw = flag("max-events");
  const progress = overrideDeps.progress ?? (asJson ? console.error.bind(console) : console.log.bind(console));
  const safeErr = (err: unknown): string => safeErrorMessage(err, []);

  if (!fromRaw) {
    console.error("[replay] error: --from <ledger|cursor> is required");
    console.error("Usage: npm run replay -- --from <ledger> [--to <ledger>] [--send] [--dry-run] [--contract market|squad] [--pages N] [--cap N] [--show N] [--json] [--mock] [--progress-file <path>] [--rpm N] [--max-events N]");
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
    if (outputFile) progress(`[replay] output    ${outputFile}`);
    if (rpm !== undefined) progress(`[replay] rpm       ${rpm}`);
    if (maxEvents !== undefined) progress(`[replay] maxEvents ${maxEvents}`);
  } else {
    progress(
      `replay ${network} from=${fromRaw} to=${toLedger ?? "tip"} mode=${dryRun ? "dry-run" : "send"}` +
        (progressFile ? ` progress=${progressFile}` : "") +
        (rpm !== undefined ? ` rpm=${rpm}` : "") +
        (maxEvents !== undefined ? ` maxEvents=${maxEvents}` : ""),
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
        from: fromRaw,
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
            from: normalizeRangeFrom(fromRaw),
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
          from: fromRaw,
          to: toLedger,
          maxPages,
          cap,
          show,
          dryRun,
          contracts: requestedContracts,
          progressFile,
          outputFile,
          committedOutputIds: targetCommittedIds,
          initialCommittedOutputCount: targetCommittedCount,
          initialLastCommittedOutputEventId: targetLastCommittedId,
          rpm,
          maxEvents,
          eventBudget,
          targetProgress,
          onOutputRecord,
          onPageComplete,
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
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, scanJsonReplacer, 2) + "\n");
  } else if (wasCancelled) {
    progress(
      `[replay] cancelled  resumable=${isResumable} events=${totals.events} sent=${totals.sent} ` +
        `skipped=${totals.skipped} capped=${totals.capped} admin=${totals.adminLogged} duplicates=${totals.duplicates}`,
    );
  } else {
    progress(
      `[replay] done  events=${totals.events} sent=${totals.sent} skipped=${totals.skipped} ` +
        `capped=${totals.capped} admin=${totals.adminLogged} duplicates=${totals.duplicates}` +
        ` completed=${allCompleted} budgetExhausted=${anyBudgetExhausted}` +
        ((totals.resumedSkippedEvents ?? 0) > 0 ? ` resumedSkipped=${totals.resumedSkippedEvents}` : ""),
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
