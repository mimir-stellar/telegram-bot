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

import type { Stats } from "node:fs";
import { appendFile, mkdir, readFile, realpath, rename, stat, truncate, unlink, writeFile } from "node:fs/promises";
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
}

export interface ReplayOutputRecord {
  format: "mimir-replay-output-v1";
  sequence: number;
  source: ContractSource;
  contractId: string;
  ledger: number;
  txHash: string;
  eventId: string;
  dedupKey: string;
  name: string;
  sent: boolean;
  skipped: boolean;
  skipReason?: string | undefined;
}

export interface ReplayOutputCheckpoint {
  path: string;
  committedRecords: number;
  committedBytes: number;
  lastCommittedSequence: number;
  lastCommittedEventId: string | null;
  lastCommittedSource: ContractSource | null;
  lastCommittedLedger: number | null;
}

export interface ReplayReport {
  format: "mimir-replay-v1";
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
  output?: {
    path: string;
    committedRecords: number;
    committedBytes: number;
    lastCommittedEventId: string | null;
    repairedTrailingBytes: number;
  } | undefined;
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
  /** Event keys already dispatched to `send` prior to an interrupted output write. */
  deliveredEventIds?: string[] | undefined;
  /** Last output record eventId durably committed for this target. */
  lastCommittedOutputEventId?: string | null | undefined;
  /** Number of output records durably committed for this target. */
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
  /** Checkpoint of the last fully committed output record when --output is active. */
  output?: ReplayOutputCheckpoint | undefined;
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

// ── Core replay function ──────────────────────────────────────────────────────

interface ReplayOutputJournal {
  readonly filePath: string;
  commitRecord(record: Omit<ReplayOutputRecord, "format" | "sequence">): Promise<ReplayOutputRecord>;
  snapshot(): ReplayOutputCheckpoint;
}

class OutputWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OutputWriteError";
  }
}

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
  /** Path to an optional JSONL replay output file. */
  outputFile?: string | undefined;
  /** Maximum RPC requests per minute. */
  rpm?: number | undefined;
  /** Checkpoint state for this specific target, if resuming. */
  targetProgress?: ReplayProgressTarget | undefined;
  /** Called atomically after each page is processed. */
  onPageComplete?: ((targetUpdate: ReplayProgressTarget) => Promise<void>) | undefined;
  /** Called when an output write fails mid-page so the last committed record is checkpointed. */
  onOutputInterrupted?: ((targetUpdate: ReplayProgressTarget) => Promise<void>) | undefined;
  /** Active output journal for streaming committed event records. */
  outputJournal?: ReplayOutputJournal | undefined;
  /** Global RPC budget tracker. */
  budget?: RpcBudgetTracker | undefined;
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
  /** Injectable output record writer for deterministic interrupted-write tests. */
  appendOutputRecord?: ((
    filePath: string,
    serializedLine: string,
    record: ReplayOutputRecord,
  ) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const defaultAppendOutputRecord = async (
  filePath: string,
  serializedLine: string,
): Promise<void> => {
  await appendFile(filePath, serializedLine, "utf8");
};

async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function pathsReferToSameTarget(left: string, right: string): Promise<boolean> {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  if (resolvedLeft === resolvedRight) return true;
  if (process.platform === "win32" && resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()) {
    return true;
  }
  const [leftStat, rightStat] = await Promise.all([statOrNull(resolvedLeft), statOrNull(resolvedRight)]);
  if (!leftStat || !rightStat) return false;
  if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino && leftStat.ino !== 0) {
    return true;
  }
  const [realLeft, realRight] = await Promise.all([realpath(resolvedLeft), realpath(resolvedRight)]);
  return process.platform === "win32"
    ? realLeft.toLowerCase() === realRight.toLowerCase()
    : realLeft === realRight;
}

function isValidOutputRecord(value: unknown, expectedSequence: number): value is ReplayOutputRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<ReplayOutputRecord>;
  return (
    r.format === "mimir-replay-output-v1" &&
    typeof r.sequence === "number" &&
    r.sequence === expectedSequence &&
    (r.source === "market" || r.source === "squad") &&
    typeof r.contractId === "string" &&
    typeof r.ledger === "number" &&
    typeof r.txHash === "string" &&
    typeof r.eventId === "string" &&
    typeof r.dedupKey === "string" &&
    typeof r.name === "string" &&
    typeof r.sent === "boolean" &&
    typeof r.skipped === "boolean"
  );
}

/**
 * Inspect an incremental JSONL output file against an optional checkpoint and,
 * when `repair !== false`, trim ONLY uncommitted torn trailing bytes while
 * preserving every valid committed `mimir-replay-output-v1` record.
 */
export async function inspectAndRecoverOutputFile(
  filePath: string,
  checkpoint?: ReplayOutputCheckpoint | undefined,
  options: { repair?: boolean } = {},
): Promise<{
  records: ReplayOutputRecord[];
  committedBytes: number;
  repairedTrailingBytes: number;
}> {
  const repair = options.repair !== false;
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (checkpoint && checkpoint.committedRecords > 0) {
        throw new Error(
          `output file "${filePath}" is missing, expected ${checkpoint.committedRecords} committed record(s) from progress checkpoint`,
        );
      }
      if (repair) {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, "", "utf8");
      }
      return { records: [], committedBytes: 0, repairedTrailingBytes: 0 };
    }
    throw new Error(`cannot read output file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const records: ReplayOutputRecord[] = [];
  let offset = 0;
  let repairedTrailingBytes = 0;
  const minCommitted = checkpoint?.committedRecords ?? 0;

  while (offset < raw.length) {
    const nl = raw.indexOf(0x0a, offset);
    if (nl === -1) {
      // Unterminated trailing fragment from an interrupted write.
      repairedTrailingBytes = raw.length - offset;
      break;
    }

    const lineEnd = nl > offset && raw[nl - 1] === 0x0d ? nl - 1 : nl;
    const lineText = raw.subarray(offset, lineEnd).toString("utf8");
    let parsed: unknown;
    let valid = false;
    try {
      parsed = JSON.parse(lineText);
      valid = isValidOutputRecord(parsed, records.length + 1);
    } catch {
      valid = false;
    }

    if (valid) {
      records.push(parsed as ReplayOutputRecord);
      offset = nl + 1;
      continue;
    }

    if (records.length === 0 || records.length < minCommitted) {
      throw new Error(
        `output file "${filePath}" has invalid or corrupt record at line ${records.length + 1}; refusing to truncate committed or unrecognized data`,
      );
    }

    // Corrupt uncommitted tail strictly beyond the last valid committed record.
    repairedTrailingBytes = raw.length - offset;
    break;
  }

  if (records.length < minCommitted) {
    throw new Error(
      `output file "${filePath}" has ${records.length} committed record(s), fewer than checkpointed ${minCommitted}`,
    );
  }

  if (checkpoint && checkpoint.committedRecords > 0) {
    const checkpointedRecord = records[checkpoint.committedRecords - 1];
    if (!checkpointedRecord || checkpointedRecord.eventId !== checkpoint.lastCommittedEventId) {
      throw new Error(
        `output file "${filePath}" record #${checkpoint.committedRecords} (${checkpointedRecord?.eventId ?? "missing"}) ` +
          `does not match checkpointed lastCommittedEventId (${checkpoint.lastCommittedEventId ?? "null"})`,
      );
    }
  }

  if (repair && repairedTrailingBytes > 0) {
    await truncate(filePath, offset);
  }

  return {
    records,
    committedBytes: offset,
    repairedTrailingBytes,
  };
}

function reconcileProgressWithCommittedOutput(
  progressData: ReplayProgressFile,
  records: readonly ReplayOutputRecord[],
  committedBytes: number,
  outputPath: string,
  config: StellarConfig | BotConfig,
): boolean {
  const previouslyCheckpointed = progressData.output?.committedRecords ?? 0;
  let changed = !progressData.output || progressData.output.committedBytes !== committedBytes;

  if (records.length > previouslyCheckpointed) {
    changed = true;
    const dedupCapacity = isBotConfig(config) ? config.dedupWindow : 256;
    for (let i = previouslyCheckpointed; i < records.length; i += 1) {
      const rec = records[i];
      if (!rec) continue;
      const contractId =
        rec.source === "market" ? config.marketContractId : config.squadContractId;
      const existing: ReplayProgressTarget = progressData.targets[rec.source] ?? {
        contractId,
        cursor: null,
        lastEventLedger: null,
        lastProcessedEventId: null,
        recentEventIds: [],
        pagesProcessed: 0,
        eventsProcessed: 0,
        eventsSent: 0,
        eventsSkipped: 0,
        eventsCapped: 0,
        adminLogged: 0,
        duplicates: 0,
        completed: false,
        failedSends: 0,
        deliveredEventIds: [],
        lastCommittedOutputEventId: null,
        committedOutputRecords: 0,
      };

      const window = EventDedupWindow.fromJSON(existing.recentEventIds, dedupCapacity);
      window.add(rec.dedupKey);

      existing.eventsProcessed += 1;
      if (rec.sent) {
        existing.eventsSent += 1;
      } else if (rec.skipReason === "admin") {
        existing.adminLogged += 1;
      } else if (rec.skipReason === "cap") {
        existing.eventsCapped += 1;
      } else if (rec.skipped) {
        existing.eventsSkipped += 1;
        if (rec.skipReason === "send-error") {
          existing.failedSends = (existing.failedSends ?? 0) + 1;
        }
      }

      existing.lastProcessedEventId = rec.dedupKey || rec.eventId;
      if (rec.ledger > 0 && (existing.lastEventLedger === null || rec.ledger > existing.lastEventLedger)) {
        existing.lastEventLedger = rec.ledger;
      }
      existing.recentEventIds = window.toJSON();
      existing.lastCommittedOutputEventId = rec.eventId;
      existing.committedOutputRecords = (existing.committedOutputRecords ?? 0) + 1;
      progressData.targets[rec.source] = existing;
    }
  }

  const last = records.length > 0 ? records[records.length - 1] : undefined;
  progressData.output = {
    path: path.resolve(outputPath),
    committedRecords: records.length,
    committedBytes,
    lastCommittedSequence: records.length,
    lastCommittedEventId: last?.eventId ?? null,
    lastCommittedSource: last?.source ?? null,
    lastCommittedLedger: last?.ledger ?? null,
  };

  return changed;
}

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
    outputFile?: string | undefined;
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

  // Validate output binding if present
  if (p.output !== undefined) {
    if (!opts.outputFile) {
      throw new Error(
        `progress file "${filePath}" tracks output file "${p.output.path}"; pass --output "${p.output.path}" to resume`,
      );
    }
    const savedOut = path.resolve(p.output.path);
    const requestedOut = path.resolve(opts.outputFile);
    const sameOut =
      process.platform === "win32"
        ? savedOut.toLowerCase() === requestedOut.toLowerCase()
        : savedOut === requestedOut;
    if (!sameOut) {
      throw new Error(
        `progress file output path (${p.output.path}) does not match requested --output (${opts.outputFile})`,
      );
    }
  } else if (opts.outputFile) {
    const alreadyProcessed = Object.values(p.targets ?? {}).some(
      (t) => (t?.eventsProcessed ?? 0) > 0,
    );
    if (alreadyProcessed) {
      throw new Error(
        `progress file "${filePath}" was created without --output; cannot attach --output mid-replay`,
      );
    }
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
  const seenDedup = opts.targetProgress?.recentEventIds
    ? EventDedupWindow.fromJSON(opts.targetProgress.recentEventIds, dedupCapacity)
    : new EventDedupWindow(dedupCapacity);
  const committedDedup = opts.targetProgress?.recentEventIds
    ? EventDedupWindow.fromJSON(opts.targetProgress.recentEventIds, dedupCapacity)
    : new EventDedupWindow(dedupCapacity);
  const deliveredSet = new Set<string>(opts.targetProgress?.deliveredEventIds ?? []);

  let pagesInThisRun = 0;
  let pagesCompletedInThisRun = 0;
  let sent = opts.targetProgress?.eventsSent ?? 0;
  let skipped = opts.targetProgress?.eventsSkipped ?? 0;
  let capped = opts.targetProgress?.eventsCapped ?? 0;
  let adminLogged = opts.targetProgress?.adminLogged ?? 0;
  let duplicates = opts.targetProgress?.duplicates ?? 0;
  let failedSends = opts.targetProgress?.failedSends ?? 0;
  let totalProcessedEvents = opts.targetProgress?.eventsProcessed ?? 0;
  let lastCommittedOutputEventId: string | null =
    opts.targetProgress?.lastCommittedOutputEventId ?? null;
  let committedOutputRecords = opts.targetProgress?.committedOutputRecords ?? 0;

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

  const buildTargetCheckpoint = (completedPages: number, completed: boolean): ReplayProgressTarget => ({
    contractId: target.contractId,
    cursor: lastCursor,
    lastEventLedger,
    lastProcessedEventId,
    recentEventIds: committedDedup.toJSON(),
    pagesProcessed: completedPages,
    eventsProcessed: totalProcessedEvents,
    eventsSent: sent,
    eventsSkipped: skipped,
    eventsCapped: capped,
    adminLogged,
    duplicates,
    completed,
    failedSends,
    ...(deliveredSet.size > 0 ? { deliveredEventIds: [...deliveredSet] } : {}),
    ...(opts.outputJournal
      ? {
          lastCommittedOutputEventId,
          committedOutputRecords,
        }
      : {}),
  });

  if (isResuming) {
    progress(
      `[replay] ${target.source}: resuming from cursor ${cursor ?? "start"} ` +
        `(lastEventId=${lastProcessedEventId ?? "none"}, pages=${opts.targetProgress?.pagesProcessed ?? 0}, sent=${sent}, skipped=${skipped})`,
    );
  }

  for (;;) {
    if (pagesInThisRun >= maxPages) {
      truncated = true;
      break;
    }
    pagesInThisRun += 1;
    const basePages = opts.targetProgress?.pagesProcessed ?? 0;

    if (opts.budget) await opts.budget.acquire();

    const response: rpc.Api.GetEventsResponse = cursor
      ? await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], cursor, limit: pageLimit }))
      : await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], startLedger: firstStartLedger, limit: pageLimit }));

    const rawEvents = Array.isArray(response?.events) ? response.events : [];
    const pageDecoded: DecodedEvent[] = [];
    const rawKeyByDecoded = new WeakMap<DecodedEvent, string | null>();

    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object") continue;
      const key = eventKey(raw);

      // On resume, skip events that were already accounted for in the checkpoint
      if (
        isResuming &&
        ((key !== null && key === lastProcessedEventId) ||
          (key !== null && seenDedup.has(key)) ||
          (typeof raw.id === "string" && raw.id === lastProcessedEventId))
      ) {
        resumedSkippedEvents += 1;
        duplicates += 1;
        continue;
      }

      if (seenDedup.add(key)) {
        const decoded = decodeEvent(target.source, raw);
        rawKeyByDecoded.set(decoded, key);
        pageDecoded.push(decoded);
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

    // Notify / log each event in this page
    for (const event of filteredPage) {
      const evKey = rawKeyByDecoded.get(event) ?? (event.eventId || eventKey(event));
      const entry: ReplayEventSummary = {
        ledger: event.ledger,
        txHash: event.txHash,
        eventId: event.eventId,
        name: event.payload.name === "unknown" ? `unknown:${(event.payload as { eventName?: string }).eventName ?? "?"}` : event.payload.name,
        source: event.source,
        sent: false,
        skipped: false,
      };

      let deltaSent = 0;
      let deltaSkipped = 0;
      let deltaCapped = 0;
      let deltaAdminLogged = 0;
      let deltaFailedSends = 0;
      let deliveredInThisStep = false;

      if (isAdminPayload(event.payload)) {
        deltaAdminLogged = 1;
        entry.skipped = true;
        entry.skipReason = "admin";
        progress(
          `[replay] ${target.source}: logged admin event "${event.payload.name}" at ledger ${event.ledger}`,
        );
      } else if (event.payload.name === "unknown") {
        deltaSkipped = 1;
        entry.skipped = true;
        entry.skipReason = "unknown";
        const reason = (event.payload as { reason?: string }).reason;
        progress(
          `[replay] ${target.source}: skipped unknown event "${(event.payload as { eventName?: string }).eventName ?? "?"}" at ledger ${event.ledger}` +
            (reason ? ` (${reason})` : ""),
        );
      } else if (sent >= cap) {
        deltaCapped = 1;
        entry.skipped = true;
        entry.skipReason = "cap";
        progress(
          `[replay] ${target.source}: cap (${cap}) reached — skipping "${event.payload.name}" at ledger ${event.ledger}`,
        );
      } else if (opts.dryRun !== false && !send) {
        let text: string | null = null;
        try {
          text = isBotConfig(config) ? formatEvent(config, event) : `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
        } catch {
          text = `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
        }
        progress(
          `[replay] ${target.source}: would send "${event.payload.name}" at ledger ${event.ledger}${text ? ` — ${text.replace(/\s+/g, " ").slice(0, 80)}` : ""}`,
        );
        deltaSent = 1;
        entry.sent = true;
      } else if (send) {
        if (evKey && deliveredSet.has(evKey)) {
          // Notification was already delivered prior to an interrupted output write.
          deltaSent = 1;
          entry.sent = true;
        } else {
          let text: string | null = null;
          let formatFailed = false;
          try {
            if (isBotConfig(config)) {
              text = formatEvent(config, event);
            } else {
              text = `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
            }
          } catch (err) {
            formatFailed = true;
            deltaSkipped = 1;
            entry.skipped = true;
            entry.skipReason = "format-error";
            progress(
              `[replay] ${target.source}: format failed for "${event.payload.name}" at ledger ${event.ledger}: ` +
                errorMsg(err),
            );
          }

          if (!formatFailed) {
            if (text === null) {
              deltaSkipped = 1;
              entry.skipped = true;
              entry.skipReason = "null-format";
            } else {
              try {
                await send(text, event.source);
                deltaSent = 1;
                entry.sent = true;
                deliveredInThisStep = true;
              } catch (err) {
                deltaSkipped = 1;
                deltaFailedSends = 1;
                entry.skipped = true;
                entry.skipReason = "send-error";
                progress(
                  `[replay] ${target.source}: send failed for "${event.payload.name}" at ledger ${event.ledger}: ` +
                    errorMsg(err),
                );
              }
            }
          }
        }
      } else {
        deltaSent = 1;
        entry.sent = true;
      }

      if (opts.outputJournal) {
        if (deliveredInThisStep && evKey) {
          deliveredSet.add(evKey);
        }
        try {
          const committed = await opts.outputJournal.commitRecord({
            source: event.source,
            contractId: target.contractId,
            ledger: event.ledger,
            txHash: event.txHash,
            eventId: event.eventId,
            dedupKey: evKey ?? event.eventId,
            name: entry.name,
            sent: entry.sent,
            skipped: entry.skipped,
            ...(entry.skipReason !== undefined ? { skipReason: entry.skipReason } : {}),
          });
          lastCommittedOutputEventId = committed.eventId;
          committedOutputRecords += 1;
          if (evKey) {
            deliveredSet.delete(evKey);
          }
        } catch (err) {
          if (opts.onOutputInterrupted) {
            await opts.onOutputInterrupted(
              buildTargetCheckpoint(basePages + pagesCompletedInThisRun, false),
            );
          }
          throw err instanceof OutputWriteError
            ? err
            : new OutputWriteError(errorMsg(err), { cause: err });
        }
      }

      totalProcessedEvents += 1;
      sent += deltaSent;
      skipped += deltaSkipped;
      capped += deltaCapped;
      adminLogged += deltaAdminLogged;
      failedSends += deltaFailedSends;
      if (showLog) eventLog.push(entry);

      if (evKey) {
        committedDedup.add(evKey);
        if (! entry.skipped || (entry.skipReason !== "admin" && entry.skipReason !== "unknown" && entry.skipReason !== "cap" && entry.skipReason !== "format-error" && entry.skipReason !== "null-format")) {
          lastProcessedEventId = evKey;
        }
      }
      if (event.ledger > 0 && (lastEventLedger === null || event.ledger > lastEventLedger)) {
        lastEventLedger = event.ledger;
      }
    }

    for (const k of seenDedup.toJSON()) {
      committedDedup.add(k);
    }
    pagesCompletedInThisRun += 1;
    const totalPages = basePages + pagesCompletedInThisRun;

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
    if (opts.onPageComplete) {
      await opts.onPageComplete(buildTargetCheckpoint(totalPages, isFinalPage && !truncated));
    }

    if (isFinalPage || stoppedByToLedger) {
      break;
    }
  }

  const finalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesCompletedInThisRun;

  progress(
    `[replay] ${target.source}: pages=${finalPages} events=${totalProcessedEvents} sent=${sent} ` +
      `skipped=${skipped} capped=${capped} admin=${adminLogged} duplicates=${duplicates} ` +
      `truncated=${truncated || stoppedByToLedger}` +
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
  };
}

/**
 * Run the replay CLI. Exported so tests can call it directly with a fake
 * server and fake send function, without spawning a subprocess.
 *
 * Returns a `ReplayReport` and the process exit code (0 = success, 1 = fatal
 * error, 2 = usage error).
 */
export async function runReplayCli(opts: {
  argv?: string[];
  deps?: Partial<ReplayDeps>;
} = {}): Promise<{ report: ReplayReport | null; exitCode: 0 | 1 | 2 }> {
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
  const hasOutputFlag = boolFlag("output") || boolFlag("out");
  const outputFile = flag("output") ?? flag("out");
  const rpmRaw = flag("rpm");
  const progress = overrideDeps.progress ?? (asJson ? console.error.bind(console) : console.log.bind(console));
  const safeErr = (err: unknown): string => safeErrorMessage(err, []);

  if (!fromRaw) {
    console.error("[replay] error: --from <ledger|cursor> is required");
    console.error("Usage: npm run replay -- --from <ledger> [--to <ledger>] [--send] [--dry-run] [--contract market|squad] [--pages N] [--cap N] [--show N] [--json] [--output <path>] [--mock] [--progress-file <path>] [--rpm N]");
    return { report: null, exitCode: 2 };
  }

  if (hasOutputFlag && (!outputFile || outputFile.trim().length === 0)) {
    console.error("[replay] error: --output requires a file path");
    return { report: null, exitCode: 2 };
  }

  if (outputFile && progressFile) {
    try {
      if (await pathsReferToSameTarget(outputFile, progressFile)) {
        console.error("[replay] error: --output and --progress-file must not point to the same file");
        return { report: null, exitCode: 2 };
      }
    } catch (err: unknown) {
      console.error(`[replay] error: ${safeErr(err)}`);
      return { report: null, exitCode: 2 };
    }
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
    if (outputFile) progress(`[replay] output    ${outputFile}`);
    if (progressFile) progress(`[replay] progress  ${progressFile}`);
    if (rpm !== undefined) progress(`[replay] rpm       ${rpm}`);
  } else {
    progress(
      `replay ${network} from=${fromRaw} to=${toLedger ?? "tip"} mode=${dryRun ? "dry-run" : "send"}` +
        (outputFile ? ` output=${outputFile}` : "") +
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

  // ── Load or initialize progress file & output journal ─────────────────────

  let progressData: ReplayProgressFile | null = null;
  if (progressFile) {
    try {
      progressData = await loadAndValidateProgressFile(progressFile, {
        from: fromRaw,
        to: toLedger,
        contracts: requestedContracts,
        outputFile,
        network,
        config,
      });
      if (progressData) {
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
          targets: {},
        };
      }
    } catch (err: unknown) {
      console.error(`[replay] error: ${err instanceof Error ? err.message : String(err)}`);
      return { report: null, exitCode: 2 };
    }
  }

  const appendWriter = overrideDeps.appendOutputRecord ?? defaultAppendOutputRecord;
  let outputJournal: ReplayOutputJournal | undefined;
  let repairedTrailingBytes = 0;

  if (outputFile) {
    const resolvedOutputPath = path.resolve(outputFile);
    let currentSequence = 0;
    let currentBytes = 0;
    let lastRecord: ReplayOutputRecord | undefined;

    try {
      if (progressData && progressFile) {
        const recovered = await inspectAndRecoverOutputFile(
          resolvedOutputPath,
          progressData.output,
          { repair: true },
        );
        repairedTrailingBytes = recovered.repairedTrailingBytes;
        currentSequence = recovered.records.length;
        currentBytes = recovered.committedBytes;
        lastRecord = recovered.records[recovered.records.length - 1];

        const reconciled = reconcileProgressWithCommittedOutput(
          progressData,
          recovered.records,
          recovered.committedBytes,
          resolvedOutputPath,
          config,
        );
        if (repairedTrailingBytes > 0) {
          progress(
            `[replay] output: repaired ${repairedTrailingBytes} uncommitted trailing byte(s) in "${outputFile}" ` +
              `(preserved ${currentSequence} committed record(s))`,
          );
        }
        if (reconciled || repairedTrailingBytes > 0) {
          progressData.updatedAt = new Date().toISOString();
          await writeProgressFileAtomic(progressFile, progressData);
        }
      } else {
        await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
        await writeFile(resolvedOutputPath, "", "utf8");
      }
    } catch (err: unknown) {
      console.error(`[replay] error: ${err instanceof Error ? err.message : String(err)}`);
      return { report: null, exitCode: 2 };
    }

    outputJournal = {
      filePath: resolvedOutputPath,
      async commitRecord(partial): Promise<ReplayOutputRecord> {
        const nextSequence = currentSequence + 1;
        const fullRecord: ReplayOutputRecord = {
          format: "mimir-replay-output-v1",
          sequence: nextSequence,
          ...partial,
        };
        const serializedLine = `${JSON.stringify(fullRecord, scanJsonReplacer)}\n`;
        try {
          await appendWriter(resolvedOutputPath, serializedLine, fullRecord);
        } catch (err: unknown) {
          throw new OutputWriteError(
            `interrupted output write at record #${nextSequence} (${fullRecord.eventId}): ` +
              (err instanceof Error ? err.message : String(err)),
            { cause: err },
          );
        }
        currentSequence = nextSequence;
        currentBytes += Buffer.byteLength(serializedLine, "utf8");
        lastRecord = fullRecord;
        if (progressData) {
          progressData.output = this.snapshot();
        }
        return fullRecord;
      },
      snapshot(): ReplayOutputCheckpoint {
        return {
          path: resolvedOutputPath,
          committedRecords: currentSequence,
          committedBytes: currentBytes,
          lastCommittedSequence: currentSequence,
          lastCommittedEventId: lastRecord?.eventId ?? null,
          lastCommittedSource: lastRecord?.source ?? null,
          lastCommittedLedger: lastRecord?.ledger ?? null,
        };
      },
    };
  }

  // ── Walk each target ───────────────────────────────────────────────────────

  const targetResults: ReplayTargetResult[] = [];
  let fatalError: string | undefined;

  for (const target of targets) {
    const targetProgress = progressData?.targets?.[target.source];
    const persistTargetUpdate = progressFile
      ? async (update: ReplayProgressTarget) => {
          if (!progressData) return;
          progressData.targets[target.source] = update;
          if (outputJournal) {
            progressData.output = outputJournal.snapshot();
          }
          progressData.updatedAt = new Date().toISOString();
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
          outputFile,
          rpm,
          targetProgress,
          onPageComplete: persistTargetUpdate,
          onOutputInterrupted: persistTargetUpdate,
          outputJournal,
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
      });
      if (err instanceof OutputWriteError) {
        break;
      }
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

  const outputSnapshot = outputJournal?.snapshot();
  const report: ReplayReport = {
    format: "mimir-replay-v1",
    network,
    rpcUrl: config.rpcUrl,
    fromLedger: fromLedger ?? 0,
    toLedger: toLedger ?? null,
    dryRun,
    targets: targetResults,
    totals,
    ...(outputSnapshot
      ? {
          output: {
            path: outputSnapshot.path,
            committedRecords: outputSnapshot.committedRecords,
            committedBytes: outputSnapshot.committedBytes,
            lastCommittedEventId: outputSnapshot.lastCommittedEventId,
            repairedTrailingBytes,
          },
        }
      : {}),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(report, scanJsonReplacer, 2) + "\n");
  } else {
    progress(
      `[replay] done  events=${totals.events} sent=${totals.sent} skipped=${totals.skipped} ` +
        `capped=${totals.capped} admin=${totals.adminLogged} duplicates=${totals.duplicates}` +
        ((totals.resumedSkippedEvents ?? 0) > 0 ? ` resumedSkipped=${totals.resumedSkippedEvents}` : ""),
    );
  }

  return { report, exitCode: fatalError ? 1 : 0 };
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
