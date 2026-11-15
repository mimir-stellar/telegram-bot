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
  validateContractId,
} from "./client.js";
import {
  buildRawEvent,
  decodeEvent,
  dedupeEvents,
  isAdminPayload,
  RawEventError,
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
import { revivePayload } from "./scan-reviver.js";

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

export interface ReplayReport {
  format: "mimir-replay-v1";
  network: string;
  rpcUrl: string;
  archive?: string | undefined;
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

// ── Offline Scanner Archive schema & validation ───────────────────────────────

export type ReplayArchiveProblem =
  | "unreadable-archive"
  | "malformed-json"
  | "invalid-schema"
  | "network-mismatch"
  | "passphrase-mismatch"
  | "contract-mismatch";

/**
 * Bounded error raised when a scanner archive fails schema or network identity
 * validation prior to offline replay processing.
 */
export class ReplayArchiveValidationError extends Error {
  readonly problem: ReplayArchiveProblem;

  constructor(problem: ReplayArchiveProblem, message: string) {
    super(message);
    this.name = "ReplayArchiveValidationError";
    this.problem = problem;
  }
}

export interface ScannerArchiveRawEvent {
  id: string;
  ledger: number;
  topic: string[];
  value?: string | undefined;
  contractId?: string | undefined;
  txHash?: string | undefined;
  ledgerClosedAt?: string | undefined;
  transactionIndex?: number | null | undefined;
  operationIndex?: number | null | undefined;
  inSuccessfulContractCall?: boolean | null | undefined;
  pagingToken?: string | undefined;
}

export interface ScannerArchiveDecodedEvent {
  ledger: number;
  txHash?: string | undefined;
  eventId: string;
  at?: number | undefined;
  version?: string | undefined;
  eventType?: string | undefined;
  transactionIndex?: number | null | undefined;
  operationIndex?: number | null | undefined;
  inSuccessfulContractCall?: boolean | null | undefined;
  summary?: string | undefined;
  payload: DecodedEvent["payload"];
}

export interface ScannerArchiveTarget {
  source: ContractSource;
  contractId: string;
  version?: string | undefined;
  cursor?: string | null | undefined;
  truncated?: boolean | undefined;
  rawEvents?: ScannerArchiveRawEvent[] | undefined;
  events?: ScannerArchiveDecodedEvent[] | undefined;
}

export interface ScannerArchiveFile {
  format: "mimir-scan-archive-v1" | "mimir-scan-v1";
  version?: 1 | undefined;
  network: string;
  networkPassphrase?: string | undefined;
  rpcUrl?: string | undefined;
  ledgers: {
    oldest: number;
    latest: number;
  };
  targets: ScannerArchiveTarget[];
}

export interface ValidatedScannerArchive {
  readonly format: "mimir-scan-archive-v1" | "mimir-scan-v1";
  readonly version: 1;
  readonly network: string;
  readonly ledgers: {
    readonly oldest: number;
    readonly latest: number;
  };
  readonly targets: ReadonlyMap<ContractSource, ValidatedArchiveTarget>;
}

interface ValidatedArchiveTarget {
  readonly source: ContractSource;
  readonly contractId: string;
  readonly version: string;
  readonly cursor: string | null;
  readonly truncated: boolean;
  readonly rawEvents: readonly rpc.Api.EventResponse[] | null;
  readonly decodedEvents: readonly DecodedEvent[] | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedArchiveText(value: unknown, max = 64): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "(empty)";
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Construct a canonical `mimir-scan-archive-v1` offline scanner archive object.
 */
export function createScannerArchive(input: {
  network: string;
  networkPassphrase?: string | undefined;
  oldestLedger: number;
  latestLedger: number;
  targets: ScannerArchiveTarget[];
}): ScannerArchiveFile {
  return {
    format: "mimir-scan-archive-v1",
    version: 1,
    network: input.network,
    ...(input.networkPassphrase !== undefined
      ? { networkPassphrase: input.networkPassphrase }
      : {}),
    ledgers: {
      oldest: input.oldestLedger,
      latest: input.latestLedger,
    },
    targets: input.targets,
  };
}

/**
 * Enforce archive schema identity (`mimir-scan-archive-v1` or `mimir-scan-v1`),
 * network identity (`network` and optional `networkPassphrase`), contract ID
 * alignment, and per-event structural integrity BEFORE any replay processing.
 */
export function validateScannerArchive(
  rawArchive: unknown,
  config: Pick<
    StellarConfig,
    "networkPassphrase" | "marketContractId" | "squadContractId"
  > &
    Partial<Pick<StellarConfig, "network">>,
): ValidatedScannerArchive {
  if (!isPlainRecord(rawArchive)) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive must be a JSON object; got ${rawArchive === null ? "null" : typeof rawArchive}`,
    );
  }

  const format = rawArchive.format;
  if (format !== "mimir-scan-archive-v1" && format !== "mimir-scan-v1") {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `unsupported scanner archive format "${boundedArchiveText(format)}" ` +
        `(expected "mimir-scan-archive-v1" or "mimir-scan-v1")`,
    );
  }

  if (format === "mimir-scan-archive-v1") {
    if (rawArchive.version !== 1) {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        `scanner archive format "mimir-scan-archive-v1" requires version 1; got ${boundedArchiveText(rawArchive.version)}`,
      );
    }
  } else if (rawArchive.version !== undefined && rawArchive.version !== 1) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive format "mimir-scan-v1" version must be 1 when present; got ${boundedArchiveText(rawArchive.version)}`,
    );
  }

  if (
    format === "mimir-scan-v1" &&
    (typeof rawArchive.rpcUrl !== "string" || rawArchive.rpcUrl.trim().length === 0)
  ) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive "mimir-scan-v1" is missing a valid string "rpcUrl" field`,
    );
  }

  const archiveNetwork = rawArchive.network;
  if (typeof archiveNetwork !== "string" || archiveNetwork.trim().length === 0) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive is missing a valid non-empty "network" string`,
    );
  }

  const expectedNetwork = networkLabel(config as StellarConfig);
  if (archiveNetwork.trim() !== expectedNetwork) {
    throw new ReplayArchiveValidationError(
      "network-mismatch",
      `scanner archive network "${boundedArchiveText(archiveNetwork)}" does not match configured network "${expectedNetwork}"`,
    );
  }

  if (rawArchive.networkPassphrase !== undefined) {
    if (
      typeof rawArchive.networkPassphrase !== "string" ||
      rawArchive.networkPassphrase.trim().length === 0
    ) {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        `scanner archive "networkPassphrase" must be a non-empty string when present`,
      );
    }
    if (rawArchive.networkPassphrase !== config.networkPassphrase) {
      throw new ReplayArchiveValidationError(
        "passphrase-mismatch",
        `scanner archive networkPassphrase does not match configured passphrase ` +
          `(configured=${config.networkPassphrase.length} chars, archive=${rawArchive.networkPassphrase.length} chars)`,
      );
    }
  }

  const ledgers = rawArchive.ledgers;
  if (!isPlainRecord(ledgers)) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive is missing a valid "ledgers" object`,
    );
  }
  const oldest = ledgers.oldest;
  const latest = ledgers.latest;
  if (!isNonNegativeInt(oldest) || !isNonNegativeInt(latest) || oldest > latest) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive "ledgers" bounds are invalid (oldest=${boundedArchiveText(oldest)}, latest=${boundedArchiveText(latest)})`,
    );
  }

  if (!Array.isArray(rawArchive.targets)) {
    throw new ReplayArchiveValidationError(
      "invalid-schema",
      `scanner archive "targets" must be an array`,
    );
  }

  const validatedTargets = new Map<ContractSource, ValidatedArchiveTarget>();

  for (let i = 0; i < rawArchive.targets.length; i++) {
    const t = rawArchive.targets[i];
    if (!isPlainRecord(t)) {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        `scanner archive targets[${i}] must be an object`,
      );
    }
    const source = t.source;
    if (source !== "market" && source !== "squad") {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        `scanner archive targets[${i}].source must be "market" or "squad"; got "${boundedArchiveText(source)}"`,
      );
    }
    if (validatedTargets.has(source)) {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        `scanner archive contains duplicate target entry for "${source}"`,
      );
    }

    try {
      validateContractId(t.contractId, `targets[${i}].contractId`);
    } catch (err) {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        err instanceof Error ? err.message : "invalid contractId in scanner archive",
      );
    }
    const contractId = (t.contractId as string).trim();
    const expectedContractId =
      source === "market" ? config.marketContractId : config.squadContractId;
    if (contractId !== expectedContractId) {
      throw new ReplayArchiveValidationError(
        "contract-mismatch",
        `scanner archive ${source} contractId does not match configured ${source} contractId`,
      );
    }

    const hasRawEvents = t.rawEvents !== undefined;
    const hasDecodedEvents = t.events !== undefined;
    if (!hasRawEvents && !hasDecodedEvents) {
      throw new ReplayArchiveValidationError(
        "invalid-schema",
        `scanner archive targets[${i}] (${source}) must provide "rawEvents" or "events"`,
      );
    }

    let builtRawEvents: rpc.Api.EventResponse[] | null = null;
    if (hasRawEvents) {
      if (!Array.isArray(t.rawEvents)) {
        throw new ReplayArchiveValidationError(
          "invalid-schema",
          `scanner archive targets[${i}].rawEvents must be an array`,
        );
      }
      builtRawEvents = [];
      for (let j = 0; j < t.rawEvents.length; j++) {
        const rawEv = t.rawEvents[j];
        if (!isPlainRecord(rawEv)) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].rawEvents[${j}] must be an object`,
          );
        }
        if (typeof rawEv.id !== "string" || rawEv.id.trim().length === 0) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].rawEvents[${j}] is missing a valid string "id"`,
          );
        }
        if (!isNonNegativeInt(rawEv.ledger)) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].rawEvents[${j}] is missing a valid non-negative "ledger"`,
          );
        }
        if (rawEv.ledger < oldest || rawEv.ledger > latest) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].rawEvents[${j}] ledger (${rawEv.ledger}) falls outside archive ledgers [${oldest}, ${latest}]`,
          );
        }
        if (
          rawEv.contractId !== undefined &&
          rawEv.contractId !== contractId
        ) {
          throw new ReplayArchiveValidationError(
            "contract-mismatch",
            `scanner archive targets[${i}].rawEvents[${j}] contractId does not match target contractId`,
          );
        }
        try {
          const built = buildRawEvent({
            topic: rawEv.topic as string[],
            value: rawEv.value as string | undefined,
            contractId,
            ledger: rawEv.ledger,
            txHash: typeof rawEv.txHash === "string" ? rawEv.txHash : "",
            ledgerClosedAt:
              typeof rawEv.ledgerClosedAt === "string" ? rawEv.ledgerClosedAt : "",
            id: rawEv.id,
          });
          const extended = built as unknown as Record<string, unknown>;
          if (
            typeof rawEv.transactionIndex === "number" &&
            Number.isSafeInteger(rawEv.transactionIndex)
          ) {
            extended.transactionIndex = rawEv.transactionIndex;
          }
          if (
            typeof rawEv.operationIndex === "number" &&
            Number.isSafeInteger(rawEv.operationIndex)
          ) {
            extended.operationIndex = rawEv.operationIndex;
          }
          if (typeof rawEv.inSuccessfulContractCall === "boolean") {
            extended.inSuccessfulContractCall = rawEv.inSuccessfulContractCall;
          }
          if (typeof rawEv.pagingToken === "string") {
            extended.pagingToken = rawEv.pagingToken;
          }
          builtRawEvents.push(built);
        } catch (err) {
          const reason =
            err instanceof RawEventError || err instanceof Error
              ? boundedArchiveText(err.message, 120)
              : "malformed raw XDR event";
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].rawEvents[${j}] invalid XDR: ${reason}`,
          );
        }
      }
    }

    let revivedEvents: DecodedEvent[] | null = null;
    if (!hasRawEvents && hasDecodedEvents) {
      if (!Array.isArray(t.events)) {
        throw new ReplayArchiveValidationError(
          "invalid-schema",
          `scanner archive targets[${i}].events must be an array`,
        );
      }
      revivedEvents = [];
      const version =
        typeof t.version === "string" && t.version.trim().length > 0
          ? t.version.trim()
          : "v1";
      for (let j = 0; j < t.events.length; j++) {
        const ev = t.events[j];
        if (!isPlainRecord(ev)) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].events[${j}] must be an object`,
          );
        }
        if (typeof ev.eventId !== "string" || ev.eventId.trim().length === 0) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].events[${j}] is missing a valid string "eventId"`,
          );
        }
        if (!isNonNegativeInt(ev.ledger)) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].events[${j}] is missing a valid non-negative "ledger"`,
          );
        }
        if (ev.ledger < oldest || ev.ledger > latest) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].events[${j}] ledger (${ev.ledger}) falls outside archive ledgers [${oldest}, ${latest}]`,
          );
        }
        if (!isPlainRecord(ev.payload) || typeof ev.payload.name !== "string" || ev.payload.name.trim().length === 0) {
          throw new ReplayArchiveValidationError(
            "invalid-schema",
            `scanner archive targets[${i}].events[${j}] is missing a valid payload object`,
          );
        }
        const payload = revivePayload(ev.payload as DecodedEvent["payload"]);
        revivedEvents.push({
          source,
          contractId,
          version: typeof ev.version === "string" && ev.version.trim() ? ev.version.trim() : version,
          ledger: ev.ledger,
          txHash: typeof ev.txHash === "string" ? ev.txHash : "",
          at: typeof ev.at === "number" && Number.isFinite(ev.at) ? ev.at : 0,
          eventId: ev.eventId,
          eventType: typeof ev.eventType === "string" ? ev.eventType : "contract",
          transactionIndex:
            typeof ev.transactionIndex === "number" && Number.isSafeInteger(ev.transactionIndex)
              ? ev.transactionIndex
              : null,
          operationIndex:
            typeof ev.operationIndex === "number" && Number.isSafeInteger(ev.operationIndex)
              ? ev.operationIndex
              : null,
          inSuccessfulContractCall:
            typeof ev.inSuccessfulContractCall === "boolean"
              ? ev.inSuccessfulContractCall
              : true,
          payload,
        });
      }
    }

    validatedTargets.set(source, {
      source,
      contractId,
      version:
        typeof t.version === "string" && t.version.trim().length > 0
          ? t.version.trim()
          : "v1",
      cursor: typeof t.cursor === "string" ? t.cursor : null,
      truncated: t.truncated === true,
      rawEvents: builtRawEvents,
      decodedEvents: revivedEvents,
    });
  }

  return {
    format,
    version: 1,
    network: expectedNetwork,
    ledgers: { oldest, latest },
    targets: validatedTargets,
  };
}

/**
 * Load and validate a scanner archive JSON file from disk before any replay
 * processing begins.
 */
export async function loadValidatedScannerArchive(
  filePath: string,
  config: Pick<
    StellarConfig,
    "networkPassphrase" | "marketContractId" | "squadContractId"
  > &
    Partial<Pick<StellarConfig, "network">>,
): Promise<ValidatedScannerArchive> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    throw new ReplayArchiveValidationError(
      "unreadable-archive",
      `cannot read scanner archive "${path.basename(filePath)}": ${boundedArchiveText(err instanceof Error ? err.message : err, 100)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    throw new ReplayArchiveValidationError(
      "malformed-json",
      `malformed JSON in scanner archive "${path.basename(filePath)}": ${boundedArchiveText(err instanceof Error ? err.message : err, 100)}`,
    );
  }

  return validateScannerArchive(parsed, config);
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
 * Offline replay of a single contract target from an already-validated scanner
 * archive (`mimir-scan-archive-v1` or `mimir-scan-v1`), executing XDR decoding
 * (for `rawEvents`), deduplication, range/cursor filtering, admin/unknown/cap
 * disposition, and formatting/dispatch with zero RPC calls.
 */
async function replayContractFromArchive(
  validatedArchive: ValidatedScannerArchive,
  target: WatchTarget,
  opts: ReplayOptions,
  send: ((text: string, source?: ContractSource) => Promise<void>) | undefined,
  config: StellarConfig | BotConfig,
  progress: (...args: unknown[]) => void,
): Promise<ReplayTargetResult> {
  const toLedger = opts.to ?? null;
  const cap = opts.cap ?? (isBotConfig(config) ? config.maxNotificationsPerCycle : 20);
  const showLog = (opts.show ?? 0) > 0 || opts.dryRun === true;

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

  const window = validateLedgerWindow({
    oldestLedger: validatedArchive.ledgers.oldest,
    latestLedger: validatedArchive.ledgers.latest,
  });

  const isResuming = !!opts.targetProgress;
  let lastProcessedEventId: string | null = opts.targetProgress?.lastProcessedEventId ?? null;
  let lastEventLedger: number | null = opts.targetProgress?.lastEventLedger ?? null;
  let resumedSkippedEvents = 0;

  let startLedger: number | null = null;
  let startCursor: string | undefined;
  let startClamped = false;

  if (isResuming && opts.targetProgress?.cursor) {
    startCursor = opts.targetProgress.cursor;
    const cursorLedger = eventCursorLedger(startCursor);
    if (cursorLedger !== null) {
      startLedger = cursorLedger;
    }
  } else {
    const fromValue = opts.from;
    if (typeof fromValue === "string" && /^\d+-\d+$/.test(fromValue)) {
      startCursor = fromValue;
      const cursorLedger = eventCursorLedger(startCursor);
      if (cursorLedger !== null) {
        if (cursorLedger > window.latestLedger) {
          throw new Error(
            `cursor ledger ${cursorLedger} is ahead of archive latest ledger ${window.latestLedger}`,
          );
        }
        startLedger = Math.max(cursorLedger, window.oldestLedger);
        startClamped = cursorLedger < window.oldestLedger;
      }
    } else {
      const requestedLedger =
        typeof fromValue === "number" ? fromValue : parseInt(String(fromValue), 10);
      if (!Number.isFinite(requestedLedger) || requestedLedger < 1) {
        throw new Error(`invalid --from value: ${String(fromValue)}`);
      }
      const clamped = clampStartLedger(requestedLedger, window);
      startLedger = clamped.startLedger;
      startClamped = clamped.clamped;
      if (startClamped) {
        progress(
          `[replay] ${target.source}: --from ${requestedLedger} is below archive floor; ` +
            `clamped up to ${startLedger}`,
        );
      }
    }
  }

  let effectiveTo = toLedger;
  if (effectiveTo !== null && effectiveTo > window.latestLedger) {
    progress(
      `[replay] ${target.source}: --to ${effectiveTo} is ahead of archive latest ledger; ` +
        `clamped to ${window.latestLedger}`,
    );
    effectiveTo = window.latestLedger;
  }

  const dedupCapacity = isBotConfig(config) ? config.dedupWindow : 256;
  const dedup = opts.targetProgress?.recentEventIds
    ? EventDedupWindow.fromJSON(opts.targetProgress.recentEventIds, dedupCapacity)
    : new EventDedupWindow(dedupCapacity);

  let sent = opts.targetProgress?.eventsSent ?? 0;
  let skipped = opts.targetProgress?.eventsSkipped ?? 0;
  let capped = opts.targetProgress?.eventsCapped ?? 0;
  let adminLogged = opts.targetProgress?.adminLogged ?? 0;
  let duplicates = opts.targetProgress?.duplicates ?? 0;
  let failedSends = opts.targetProgress?.failedSends ?? 0;
  let totalProcessedEvents = opts.targetProgress?.eventsProcessed ?? 0;

  const archiveTarget = validatedArchive.targets.get(target.source);
  const decodedCandidates: DecodedEvent[] = [];

  if (archiveTarget) {
    if (archiveTarget.rawEvents) {
      for (const raw of archiveTarget.rawEvents) {
        const key = eventKey(raw);
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
          decodedCandidates.push(
            decodeEvent(target.source, raw, archiveTarget.version),
          );
        } else {
          duplicates += 1;
        }
      }
    } else if (archiveTarget.decodedEvents) {
      for (const decoded of archiveTarget.decodedEvents) {
        const key = eventKey(decoded);
        if (
          isResuming &&
          ((key !== null && key === lastProcessedEventId) ||
            (key !== null && dedup.has(key)) ||
            decoded.eventId === lastProcessedEventId)
        ) {
          resumedSkippedEvents += 1;
          duplicates += 1;
          continue;
        }
        if (dedup.add(key)) {
          decodedCandidates.push(decoded);
        } else {
          duplicates += 1;
        }
      }
    }
  }

  const filteredEvents = sortEvents(
    dedupeEvents(
      decodedCandidates.filter((e) => {
        if (startLedger !== null && e.ledger < startLedger) return false;
        if (effectiveTo !== null && e.ledger > effectiveTo) return false;
        return true;
      }),
    ),
  );

  totalProcessedEvents += filteredEvents.length;

  const botToken = isBotConfig(config) ? config.botToken : undefined;
  const errorMsg = (err: unknown): string =>
    safeErrorMessage(err, botToken ? [botToken] : []);
  const eventLog: ReplayEventSummary[] = [];

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
        text = isBotConfig(config)
          ? formatEvent(config, event)
          : `[${event.source}] ${event.payload.name} at ledger ${event.ledger}`;
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

  const finalPages = (opts.targetProgress?.pagesProcessed ?? 0) + (archiveTarget ? 1 : 0);
  const lastCursor =
    archiveTarget?.cursor ??
    (filteredEvents.length > 0
      ? filteredEvents[filteredEvents.length - 1]!.eventId
      : (opts.targetProgress?.cursor ?? null));
  const truncated = archiveTarget?.truncated === true;

  if (opts.onPageComplete) {
    await opts.onPageComplete({
      contractId: target.contractId,
      cursor: lastCursor,
      lastEventLedger,
      lastProcessedEventId,
      recentEventIds: dedup.toJSON(),
      pagesProcessed: finalPages,
      eventsProcessed: totalProcessedEvents,
      eventsSent: sent,
      eventsSkipped: skipped,
      eventsCapped: capped,
      adminLogged,
      duplicates,
      completed: !truncated,
      failedSends,
    });
  }

  progress(
    `[replay] ${target.source}: offline archive events=${totalProcessedEvents} sent=${sent} ` +
      `skipped=${skipped} capped=${capped} admin=${adminLogged} duplicates=${duplicates} ` +
      `truncated=${truncated}` +
      (resumedSkippedEvents > 0 ? ` resumedSkipped=${resumedSkippedEvents}` : ""),
  );

  return {
    source: target.source,
    contractId: target.contractId,
    fromLedger: startLedger ?? window.oldestLedger,
    toLedger: effectiveTo,
    startLedger: isResuming ? null : startLedger,
    startClamped: isResuming ? false : startClamped,
    pages: finalPages,
    events: totalProcessedEvents,
    sent,
    skipped,
    capped,
    adminLogged,
    duplicates,
    truncated,
    lastEventLedger,
    cursor: lastCursor,
    eventLog: showLog ? eventLog : [],
    resumedSkippedEvents,
    lastProcessedEventId,
    failedSends,
  };
}

/**
 * Programmatic offline replay entry point: validates the archive's schema and
 * network identity against `deps.config` before running decode and filtering
 * without any RPC client.
 */
export async function replayFromArchive(
  archiveInput: unknown,
  opts: Partial<ReplayOptions> = {},
  deps: {
    config: StellarConfig | BotConfig;
    send?: ((text: string, source?: ContractSource) => Promise<void>) | undefined;
    progress?: ((...args: unknown[]) => void) | undefined;
    archiveLabel?: string | undefined;
  },
): Promise<ReplayReport> {
  const validated = validateScannerArchive(archiveInput, deps.config);
  const progress = deps.progress ?? (() => {});
  const dryRun = opts.dryRun ?? !deps.send;
  const fromValue =
    opts.from !== undefined ? opts.from : Math.max(1, validated.ledgers.oldest);
  const toLedger = opts.to;
  const requestedContracts: ContractSource[] = opts.contracts ?? ["market", "squad"];

  const allTargets: WatchTarget[] = [
    { source: "market", contractId: deps.config.marketContractId },
    { source: "squad", contractId: deps.config.squadContractId },
  ];
  const targets = allTargets.filter((t) => requestedContracts.includes(t.source));

  const targetResults: ReplayTargetResult[] = [];
  for (const target of targets) {
    const res = await replayContractFromArchive(
      validated,
      target,
      {
        ...opts,
        from: fromValue,
        to: toLedger,
        dryRun,
        contracts: requestedContracts,
      },
      dryRun ? undefined : deps.send,
      deps.config,
      progress,
    );
    targetResults.push(res);
  }

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

  const parsedFrom =
    typeof fromValue === "number"
      ? fromValue
      : /^\d+$/.test(String(fromValue).trim())
        ? parseInt(String(fromValue).trim(), 10)
        : (targetResults[0]?.fromLedger ?? validated.ledgers.oldest);

  return {
    format: "mimir-replay-v1",
    network: validated.network,
    rpcUrl: deps.config.rpcUrl,
    ...(deps.archiveLabel !== undefined ? { archive: deps.archiveLabel } : {}),
    fromLedger: parsedFrom,
    toLedger: toLedger ?? validated.ledgers.latest,
    dryRun,
    targets: targetResults,
    totals,
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
  const archivePath = flag("archive");
  const hasArchiveFlag = argv.includes("--archive");
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

  if (hasArchiveFlag && !archivePath) {
    console.error("[replay] error: --archive <path> requires a file path");
    return { report: null, exitCode: 2 };
  }

  if (!fromRaw && !archivePath) {
    console.error("[replay] error: --from <ledger|cursor> is required");
    console.error("Usage: npm run replay -- --from <ledger> [--to <ledger>] [--archive <path>] [--send] [--dry-run] [--contract market|squad] [--pages N] [--cap N] [--show N] [--json] [--mock] [--progress-file <path>] [--rpm N]");
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
  if (fromRaw !== undefined && !/^\d+-\d+$/.test(fromRaw)) {
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

  const network = networkLabel(config);

  // ── Validate offline scanner archive (if --archive is specified) ──────────

  let validatedArchive: ValidatedScannerArchive | null = null;
  if (archivePath) {
    try {
      validatedArchive = await loadValidatedScannerArchive(archivePath, config);
    } catch (err: unknown) {
      console.error(
        `[replay] archive error: ${err instanceof Error ? err.message : safeErr(err)}`,
      );
      return { report: null, exitCode: 2 };
    }
  }

  const effectiveFromRaw =
    fromRaw ?? String(Math.max(1, validatedArchive?.ledgers.oldest ?? 1));
  if (fromLedger === undefined && fromRaw === undefined && validatedArchive) {
    fromLedger = Math.max(1, validatedArchive.ledgers.oldest);
  }
  if (fromLedger !== undefined && toLedger !== undefined && toLedger < fromLedger) {
    console.error(`[replay] error: --to ${toLedger} is before --from ${fromLedger}`);
    return { report: null, exitCode: 2 };
  }

  const server = validatedArchive
    ? null
    : (overrideDeps.server ?? createRpcServer(config));

  if (!asJson) {
    progress(
      validatedArchive
        ? `[replay] network   ${network} · archive ${archivePath} (offline)`
        : `[replay] network   ${network} · rpc ${config.rpcUrl}`,
    );
    progress(
      `[replay] from      ${effectiveFromRaw}${toLedger !== undefined ? `  to ${toLedger}` : validatedArchive ? `  to ${validatedArchive.ledgers.latest} (archive)` : "  (to chain tip)"}`,
    );
    progress(`[replay] mode      ${dryRun ? "dry-run (use --send to deliver to Telegram)" : "SEND"}`);
    if (progressFile) progress(`[replay] progress  ${progressFile}`);
    if (rpm !== undefined && !validatedArchive) progress(`[replay] rpm       ${rpm}`);
  } else {
    progress(
      `replay ${network} from=${effectiveFromRaw} to=${toLedger ?? (validatedArchive ? validatedArchive.ledgers.latest : "tip")} mode=${dryRun ? "dry-run" : "send"}` +
        (archivePath ? ` archive=${archivePath}` : "") +
        (progressFile ? ` progress=${progressFile}` : "") +
        (rpm !== undefined && !validatedArchive ? ` rpm=${rpm}` : ""),
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
  const budget =
    rpm !== undefined && !validatedArchive
      ? new RpcBudgetTracker(rpm, sleep, now)
      : undefined;

  // ── Load or initialize progress file ──────────────────────────────────────

  let progressData: ReplayProgressFile | null = null;
  if (progressFile) {
    try {
      progressData = await loadAndValidateProgressFile(progressFile, {
        from: effectiveFromRaw,
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
            from: normalizeRangeFrom(effectiveFromRaw),
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
      const replayOpts: ReplayOptions = {
        from: effectiveFromRaw,
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
      };
      const result = validatedArchive
        ? await replayContractFromArchive(
            validatedArchive,
            target,
            replayOpts,
            dryRun ? undefined : send,
            config,
            progress,
          )
        : await replayContract(
            server!,
            target,
            replayOpts,
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
    ...(archivePath ? { archive: archivePath } : {}),
    fromLedger: fromLedger ?? 0,
    toLedger: toLedger ?? (validatedArchive ? validatedArchive.ledgers.latest : null),
    dryRun,
    targets: targetResults,
    totals,
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
