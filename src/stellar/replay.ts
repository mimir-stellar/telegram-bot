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
  DEFAULT_FEATURE_FLAGS,
  isNotificationAllowed,
  type NotificationFeatureFlags,
} from "../notifications/featureFlags.js";
import {
  eventAllowedByCategory,
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

export interface NormalizedReplayFilterSet {
  contracts: ContractSource[];
  eventNames: string[];
  categories: string[];
  featureFlags: {
    enabled: boolean;
    market: boolean;
    squad: boolean;
  };
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
  /** Canonicalized filter configuration active when this progress file was created. */
  filters?: NormalizedReplayFilterSet | undefined;
  /** Deterministic SHA-256 fingerprint of {@link filters}. */
  filterFingerprint?: string | undefined;
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
  /** Optional allowlist of decoded event names (case-insensitive). Empty means all. */
  eventNames?: readonly string[] | undefined;
  /** Optional allowlist of claim categories (case-insensitive). Empty means all. */
  categories?: readonly string[] | undefined;
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

function normalizeStringList(values?: readonly string[] | null): string[] {
  if (!values || values.length === 0) return [];
  const out = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    for (const token of raw.split(/[\s,]+/)) {
      const cleaned = token.trim().toLowerCase();
      if (cleaned.length > 0) out.add(cleaned);
    }
  }
  return [...out].sort();
}

function normalizeContractList(contracts?: readonly ContractSource[] | null): ContractSource[] {
  if (!contracts || contracts.length === 0) return [];
  const valid = new Set<ContractSource>();
  for (const c of contracts) {
    if (c === "market" || c === "squad") valid.add(c);
  }
  return [...valid].sort();
}

export function normalizeReplayFilterSet(input: {
  contracts: readonly ContractSource[];
  eventNames?: readonly string[] | undefined;
  categories?: readonly string[] | undefined;
  featureFlags?: Partial<NotificationFeatureFlags> | undefined;
}): NormalizedReplayFilterSet {
  const flags = input.featureFlags ?? DEFAULT_FEATURE_FLAGS;
  return {
    contracts: normalizeContractList(input.contracts),
    eventNames: normalizeStringList(input.eventNames),
    categories: normalizeStringList(input.categories),
    featureFlags: {
      enabled: flags.enabled ?? DEFAULT_FEATURE_FLAGS.enabled,
      market: flags.market ?? DEFAULT_FEATURE_FLAGS.market,
      squad: flags.squad ?? DEFAULT_FEATURE_FLAGS.squad,
    },
  };
}

export function computeReplayFilterFingerprint(filters: NormalizedReplayFilterSet): string {
  const canonical = JSON.stringify({
    version: 1,
    contracts: normalizeContractList(filters.contracts),
    eventNames: normalizeStringList(filters.eventNames),
    categories: normalizeStringList(filters.categories),
    featureFlags: {
      enabled: Boolean(filters.featureFlags.enabled),
      market: Boolean(filters.featureFlags.market),
      squad: Boolean(filters.featureFlags.squad),
    },
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function formatFilterSummary(filters: NormalizedReplayFilterSet): string {
  const contracts = filters.contracts.join(",") || "none";
  const events = filters.eventNames.length > 0 ? filters.eventNames.join(",") : "*";
  const categories = filters.categories.length > 0 ? filters.categories.join(",") : "*";
  const ff = filters.featureFlags;
  return (
    `contracts=[${contracts}] events=[${events}] categories=[${categories}] ` +
    `flags=(enabled=${ff.enabled},market=${ff.market},squad=${ff.squad})`
  );
}

function describeFilterDifferences(
  saved: NormalizedReplayFilterSet,
  expected: NormalizedReplayFilterSet,
): string[] {
  const diffs: string[] = [];
  if (saved.contracts.join(",") !== expected.contracts.join(",")) {
    diffs.push(`contracts (${saved.contracts.join(",") || "none"} vs ${expected.contracts.join(",") || "none"})`);
  }
  if (saved.eventNames.join(",") !== expected.eventNames.join(",")) {
    diffs.push(
      `events (${saved.eventNames.join(",") || "all"} vs ${expected.eventNames.join(",") || "all"})`,
    );
  }
  if (saved.categories.join(",") !== expected.categories.join(",")) {
    diffs.push(
      `categories (${saved.categories.join(",") || "all"} vs ${expected.categories.join(",") || "all"})`,
    );
  }
  const sff = saved.featureFlags;
  const eff = expected.featureFlags;
  if (sff.enabled !== eff.enabled || sff.market !== eff.market || sff.squad !== eff.squad) {
    diffs.push(
      `featureFlags (enabled=${sff.enabled},market=${sff.market},squad=${sff.squad} vs ` +
        `enabled=${eff.enabled},market=${eff.market},squad=${eff.squad})`,
    );
  }
  return diffs;
}

export async function loadAndValidateProgressFile(
  filePath: string,
  opts: {
    from: string | number;
    to?: number | undefined;
    contracts: ContractSource[];
    eventNames?: readonly string[] | undefined;
    categories?: readonly string[] | undefined;
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

  // Validate normalized filter set and filter fingerprint
  const configCategories = "notificationCategories" in opts.config ? opts.config.notificationCategories : undefined;
  const configFeatureFlags = "featureFlags" in opts.config ? opts.config.featureFlags : undefined;
  const expectedFilters = normalizeReplayFilterSet({
    contracts: opts.contracts,
    eventNames: opts.eventNames,
    categories: opts.categories ?? configCategories,
    featureFlags: configFeatureFlags,
  });
  const expectedFingerprint = computeReplayFilterFingerprint(expectedFilters);

  const savedFilters = p.filters
    ? normalizeReplayFilterSet({
        contracts: p.filters.contracts ?? p.contracts ?? [],
        eventNames: p.filters.eventNames,
        categories: p.filters.categories,
        featureFlags: p.filters.featureFlags,
      })
    : normalizeReplayFilterSet({
        contracts: p.contracts ?? [],
      });

  const computedSavedFingerprint = computeReplayFilterFingerprint(savedFilters);
  if (p.filterFingerprint !== undefined) {
    if (typeof p.filterFingerprint !== "string" || !p.filterFingerprint.startsWith("sha256:")) {
      throw new Error(
        `progress file "${filePath}" has an invalid filterFingerprint; ` +
          `delete the corrupt progress file or choose a new --progress-file path`,
      );
    }
    if (p.filters !== undefined && p.filterFingerprint !== computedSavedFingerprint) {
      throw new Error(
        `progress file "${filePath}" filterFingerprint (${p.filterFingerprint}) does not match its recorded filters (${computedSavedFingerprint}); ` +
          `refusing resume — use a fresh --progress-file path or restore the unmodified progress file`,
      );
    }
  }

  const effectiveFileFingerprint = p.filterFingerprint ?? computedSavedFingerprint;
  if (effectiveFileFingerprint !== expectedFingerprint) {
    const diffs = describeFilterDifferences(savedFilters, expectedFilters);
    const diffText =
      diffs.length > 0
        ? diffs.join("; ")
        : `fingerprint (${effectiveFileFingerprint} vs ${expectedFingerprint})`;
    throw new Error(
      `progress file "${filePath}" was created for a different filter set: ${diffText}. ` +
        `Expected ${formatFilterSummary(savedFilters)} (${effectiveFileFingerprint}), ` +
        `got ${formatFilterSummary(expectedFilters)} (${expectedFingerprint}). ` +
        `Re-run with the original filter flags/environment or pass a new --progress-file path.`,
    );
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
  const activeEventNameSet = new Set(normalizeStringList(opts.eventNames));
  const activeCategories = normalizeStringList(
    opts.categories ?? ("notificationCategories" in config ? config.notificationCategories : undefined),
  );
  const activeFeatureFlags =
    "featureFlags" in config && config.featureFlags !== undefined
      ? config.featureFlags
      : DEFAULT_FEATURE_FLAGS;

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

      if (activeEventNameSet.size > 0 && !activeEventNameSet.has(event.payload.name.toLowerCase())) {
        skipped += 1;
        entry.skipped = true;
        entry.skipReason = "event-filter";
        progress(
          `[replay] ${target.source}: skipped "${event.payload.name}" at ledger ${event.ledger} (event filter)`,
        );
        if (showLog) eventLog.push(entry);
        continue;
      }

      if (!isNotificationAllowed(activeFeatureFlags, event.source, event.payload.name)) {
        skipped += 1;
        entry.skipped = true;
        entry.skipReason = "feature-flag";
        progress(
          `[replay] ${target.source}: skipped "${event.payload.name}" at ledger ${event.ledger} (feature flag)`,
        );
        if (showLog) eventLog.push(entry);
        continue;
      }

      if (
        activeCategories.length > 0 &&
        !eventAllowedByCategory({ notificationCategories: activeCategories }, event)
      ) {
        skipped += 1;
        entry.skipped = true;
        entry.skipReason = "category-filter";
        progress(
          `[replay] ${target.source}: skipped "${event.payload.name}" at ledger ${event.ledger} (category filter)`,
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
  const hasEventFlag = boolFlag("event") || boolFlag("events");
  const eventRaw = flag("event") ?? flag("events");
  const hasCategoryFlag = boolFlag("category") || boolFlag("categories");
  const categoryRaw = flag("category") ?? flag("categories");
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
    console.error("Usage: npm run replay -- --from <ledger> [--to <ledger>] [--send] [--dry-run] [--contract market|squad] [--event <names>] [--category <names>] [--pages N] [--cap N] [--show N] [--json] [--mock] [--progress-file <path>] [--rpm N]");
    return { report: null, exitCode: 2 };
  }

  if (hasEventFlag && (eventRaw === undefined || normalizeStringList([eventRaw]).length === 0)) {
    console.error("[replay] error: --event requires at least one event name");
    return { report: null, exitCode: 2 };
  }
  if (hasCategoryFlag && (categoryRaw === undefined || normalizeStringList([categoryRaw]).length === 0)) {
    console.error("[replay] error: --category requires at least one category name");
    return { report: null, exitCode: 2 };
  }

  const cliEventNames = eventRaw !== undefined ? normalizeStringList([eventRaw]) : undefined;
  const cliCategories = categoryRaw !== undefined ? normalizeStringList([categoryRaw]) : undefined;

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

  const activeFilters = normalizeReplayFilterSet({
    contracts: requestedContracts,
    eventNames: cliEventNames,
    categories: cliCategories ?? ("notificationCategories" in config ? config.notificationCategories : undefined),
    featureFlags: "featureFlags" in config ? config.featureFlags : undefined,
  });
  const activeFilterFingerprint = computeReplayFilterFingerprint(activeFilters);

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
        eventNames: cliEventNames,
        categories: cliCategories,
        network,
        config,
      });
      if (progressData) {
        progressData.filters = activeFilters;
        progressData.filterFingerprint = activeFilterFingerprint;
        progress(`[replay] loaded progress file "${progressFile}" (${activeFilterFingerprint})`);
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
          filters: activeFilters,
          filterFingerprint: activeFilterFingerprint,
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
          eventNames: cliEventNames,
          categories: cliCategories,
          progressFile,
          rpm,
          targetProgress,
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
