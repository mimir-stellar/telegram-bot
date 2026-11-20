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
 *   npm run replay -- --from 4226500 --jsonl             # streaming JSONL
 *   npm run replay -- --merge-chunks a.jsonl,b.jsonl     # merge chunks to JSONL
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
  type WatchTarget,
  EVENT_MAX_PAGES,
  EVENT_PAGE_LIMIT,
} from "./events.js";

// ── Replay report types ───────────────────────────────────────────────────────

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
  /** Called for each processed event when streaming (e.g. --jsonl); avoids buffering eventLog in memory. */
  onEvent?: ((entry: ReplayEventSummary) => void | Promise<void>) | undefined;
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
  /** Optional sink for streaming JSONL output (`--jsonl` / `--merge-chunks`). */
  writeJsonl?: JsonlOutputSink | undefined;
  /** Sleeper function for deterministic rate-limit / delay tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Timestamp provider for deterministic rate-limit / delay tests. */
  now?: (() => number) | undefined;
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
    if (pagesInThisRun >= maxPages) {
      truncated = true;
      break;
    }
    pagesInThisRun += 1;
    const totalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;

    if (opts.budget) await opts.budget.acquire();

    const response: rpc.Api.GetEventsResponse = cursor
      ? await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], cursor, limit: pageLimit }))
      : await (server.getEvents({ filters: [{ type: "contract", contractIds: [target.contractId] }], startLedger: firstStartLedger, limit: pageLimit }));

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
    for (const event of filteredPage) {
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

      const evKey = event.eventId || eventKey(event);
      if (evKey) {
        lastProcessedEventId = evKey;
      }
      if (event.ledger > 0 && (lastEventLedger === null || event.ledger > lastEventLedger)) {
        lastEventLedger = event.ledger;
      }
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
        completed: isFinalPage && !truncated,
        failedSends,
      });
    }

    if (isFinalPage || stoppedByToLedger) {
      break;
    }
  }

  const finalPages = (opts.targetProgress?.pagesProcessed ?? 0) + pagesInThisRun;

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

  for (const target of targets) {
    const targetProgress = progressData?.targets?.[target.source];
    const onPageComplete = progressFile
      ? async (update: ReplayProgressTarget) => {
          if (!progressData) return;
          progressData.targets[target.source] = update;
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
          rpm,
          targetProgress,
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

  const report: ReplayReport = {
    format: "mimir-replay-v1",
    network,
    rpcUrl: config.rpcUrl,
    fromLedger: fromLedger ?? 0,
    toLedger: toLedger ?? null,
    dryRun,
    targets: targetResults,
    totals,
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
