/**
 * Configurable stale-market watch report for observed Stellar / Soroban events.
 *
 * Analytical reducer that scans decoded chain events to identify open squad
 * markets and claim markets whose elapsed age exceeds a bounded threshold.
 *
 * Invariants:
 * - Pure, deterministic, time-injected: accepts explicit `nowSec` and `nowLedger`
 *   to avoid reliance on wall-clock time in tests and reproductions.
 * - Strictly read-only: this watcher only inspects observed events and labels
 *   inferred market states; it never holds signing keys, builds transactions, or
 *   submits settlement calls to the network.
 * - Handles both squad markets (`market_created` -> `resolved`) and prediction
 *   claims (`claim_created` -> `claim_resolved` | `claim_cancelled` | `market_settled`).
 * - Collapses duplicate creation events to the earliest observed ledger/timestamp.
 * - Deterministic ordering: stale entries are ordered descending by age (oldest
 *   first), breaking ties by market ID ascending and market type ascending.
 */

import type { DecodedEvent } from "./decode.js";

/** Default age threshold: 24 hours (86,400 seconds). */
export const DEFAULT_STALE_AGE_THRESHOLD_SEC = 86_400;

/** Notice string permanently stamped onto stale-market watch reports. */
export const INFERRED_STATE_DISCLAIMER =
  "Inferred state only: observed events indicate market remains open past threshold; read-only bot never submits settlement transactions or holds signing keys.";

export type MarketKind = "squad" | "claim";

export type InferredMarketState = "inferred_stale" | "inferred_overdue" | "inferred_open";

export interface StaleMarketEntry {
  /** Market identifier (squad marketId or prediction claimId). */
  marketId: number;
  /** Kind of market: "squad" or "claim". */
  marketType: MarketKind;
  /** Source contract classification. */
  source: "squad" | "market";
  /** Contract ID where the market event was observed, if present. */
  contractId?: string;
  /** Creator or captain address, if recorded on creation. */
  creator?: string;
  /** Market question or claim title, if recorded. */
  title?: string;
  /** Market category, if recorded. */
  category?: string;
  /** Unix timestamp (in seconds) of market creation. */
  creationAt: number;
  /** Ledger sequence number of market creation. */
  creationLedger: number;
  /** Optional deadline timestamp in seconds (for markets declaring a deadline). */
  deadline?: number;
  /** Elapsed age in seconds from creation to the evaluation reference time (`nowSec`). */
  ageSec: number;
  /** Elapsed age in ledger counts from creation to reference ledger (`nowLedger`). */
  ageLedgers: number;
  /** Seconds elapsed past deadline when reference time exceeds deadline; otherwise 0. */
  overdueSec: number;
  /**
   * Explicit inferred state label.
   * State is inferred purely from observed on-chain logs.
   */
  inferredState: InferredMarketState;
  /** Descriptive human-readable label clarifying the inferred state and read-only status. */
  inferredStateLabel: string;
  /** True when the open market has exceeded the configured age threshold. */
  isStale: boolean;
  /**
   * Read-only invariant: the bot never submits settlement transactions.
   * Literal false guaranteed by compiler and runtime.
   */
  settlementSubmitted: false;
}

export interface StaleMarketSummary {
  /** Total number of open (unresolved, uncancelled, unsettled) markets observed. */
  totalOpenMarkets: number;
  /** Total number of open markets exceeding the configured age threshold. */
  staleCount: number;
  /** Number of open markets whose declared deadline has elapsed without resolution. */
  overdueCount: number;
  /** Maximum age in seconds observed among open markets, or 0 if none. */
  maxAgeSec: number;
  /** Median (p50) age in seconds among open markets, calculated via nearest-rank integer math. */
  p50AgeSec: number;
  /** 90th percentile (p90) age in seconds among open markets, calculated via nearest-rank integer math. */
  p90AgeSec: number;
}

export interface StaleMarketWatchOptions {
  /**
   * Evaluation reference timestamp in Unix seconds.
   * If omitted, defaults to the latest event `at` timestamp in the input,
   * or the current Unix epoch seconds if no valid event timestamps exist.
   */
  nowSec?: number;

  /**
   * Evaluation reference ledger sequence number.
   * If omitted, defaults to the highest event `ledger` in the input, or 0.
   */
  nowLedger?: number;

  /**
   * Bounded age threshold in seconds. Markets open for longer than or equal to
   * this duration are classified as stale.
   * Must be a non-negative finite number. Defaults to 86,400 (24h).
   */
  ageThresholdSec?: number;

  /** Alias for `ageThresholdSec`. */
  thresholdSec?: number;

  /**
   * Optional threshold in ledger sequences. Markets open for >= this many ledgers
   * are classified as stale.
   */
  ageThresholdLedgers?: number;

  /**
   * Optional grace period in seconds past a declared deadline before flagging
   * as overdue. Default is 0.
   */
  deadlineGraceSec?: number;

  /**
   * Filter markets by type:
   * - "all" (default): inspects both squad markets and claim markets
   * - "squad": inspects only squad markets (`market_created`)
   * - "claim" | "market": inspects only prediction claims (`claim_created`)
   */
  marketType?: "all" | "squad" | "claim" | "market";

  /**
   * Maximum number of stale market entries to return in `staleMarkets`.
   * Must be a positive integer if provided.
   */
  limit?: number;

  /**
   * If true, includes all open markets in `allOpenMarkets` on the report.
   * Defaults to false.
   */
  includeAllOpen?: boolean;
}

export interface StaleMarketReport {
  /**
   * Identified stale open markets exceeding the bounded age threshold,
   * ordered descending by age (oldest first).
   */
  staleMarkets: StaleMarketEntry[];
  /** Optional list of all observed open markets, present when `includeAllOpen` is enabled. */
  allOpenMarkets?: StaleMarketEntry[];
  /** Summary metrics and distribution statistics for open markets. */
  summary: StaleMarketSummary;
  /** Bounded age threshold in seconds evaluated for this report. */
  thresholdSec: number;
  /** Optional ledger count threshold evaluated for this report. */
  thresholdLedgers?: number;
  /** Reference evaluation timestamp in Unix seconds. */
  nowSec: number;
  /** Reference evaluation ledger sequence number. */
  nowLedger: number;
  /** Count of valid events parsed and processed by the reducer. */
  processedEvents: number;
  /** Count of skipped malformed, non-object, or unparseable event records. */
  skippedEvents: number;
  /** Permanent audit declaration that all states are inferred and the bot is read-only. */
  inferredStateNotice: string;
  /** Invariant: bot is strictly read-only and never holds signing keys or settles transactions. */
  readOnly: true;
}

/**
 * Validates and normalizes an age threshold in seconds.
 *
 * @throws {TypeError} if value is not a number or is NaN.
 * @throws {RangeError} if value is negative or not finite.
 */
export function validateAgeThreshold(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_STALE_AGE_THRESHOLD_SEC;
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`Invalid age threshold: expected a finite number, got ${String(value)}`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid age threshold: expected non-negative finite number, got ${value}`);
  }
  return Math.trunc(value);
}

/**
 * Computes the p-th percentile (0 <= p <= 100) using nearest-rank integer indexing.
 */
function nearestRank(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index]!;
}

interface RawCreationState {
  marketId: number;
  marketType: MarketKind;
  source: "squad" | "market";
  contractId?: string;
  creator?: string;
  title?: string;
  category?: string;
  deadline?: number;
  creationAt: number;
  creationLedger: number;
}

/**
 * Reducer that derives a stale-market watch report from observed chain events.
 *
 * Identifies open squad markets and prediction claims whose age exceeds a bounded
 * threshold, computes summary metrics, and labels all inferred states without
 * initiating or allowing any settlement transactions.
 */
export function staleMarketWatch(
  events: readonly DecodedEvent[] | Iterable<DecodedEvent> | null | undefined,
  options?: StaleMarketWatchOptions,
): StaleMarketReport {
  const thresholdSec = validateAgeThreshold(options?.ageThresholdSec ?? options?.thresholdSec);

  let thresholdLedgers: number | undefined;
  if (options?.ageThresholdLedgers !== undefined && options.ageThresholdLedgers !== null) {
    if (
      typeof options.ageThresholdLedgers !== "number" ||
      !Number.isFinite(options.ageThresholdLedgers) ||
      options.ageThresholdLedgers < 0
    ) {
      throw new RangeError(
        `Invalid ageThresholdLedgers: expected non-negative number, got ${String(options.ageThresholdLedgers)}`,
      );
    }
    thresholdLedgers = Math.trunc(options.ageThresholdLedgers);
  }

  const deadlineGraceSec = Math.max(0, Math.trunc(options?.deadlineGraceSec ?? 0));
  const filterType = options?.marketType ?? "all";

  let processedEvents = 0;
  let skippedEvents = 0;
  let maxObservedAt = 0;
  let maxObservedLedger = 0;

  const squadCreations = new Map<number, RawCreationState>();
  const squadResolutions = new Set<number>();

  const claimCreations = new Map<number, RawCreationState>();
  const claimTerminals = new Set<number>();

  if (events) {
    for (const ev of events) {
      if (!ev || typeof ev !== "object") {
        skippedEvents++;
        continue;
      }

      const ledger = typeof ev.ledger === "number" && Number.isFinite(ev.ledger) ? Math.trunc(ev.ledger) : null;
      const at = typeof ev.at === "number" && Number.isFinite(ev.at) ? Math.trunc(ev.at) : null;

      if (ledger !== null && ledger > maxObservedLedger) {
        maxObservedLedger = ledger;
      }
      if (at !== null && at > maxObservedAt) {
        maxObservedAt = at;
      }

      const payload = (ev as Partial<DecodedEvent>).payload;
      if (!payload || typeof payload !== "object" || !("name" in payload) || typeof payload.name !== "string") {
        skippedEvents++;
        continue;
      }

      const name = payload.name;
      const contractId = typeof ev.contractId === "string" ? ev.contractId : undefined;

      // ── Squad contract events ─────────────────────────────────────────────
      if (name === "market_created" && "marketId" in payload) {
        const marketId = (payload as { marketId?: unknown }).marketId;
        if (typeof marketId !== "number" || !Number.isFinite(marketId) || marketId < 0) {
          skippedEvents++;
          continue;
        }

        const id = Math.trunc(marketId);
        const p = payload as {
          captain?: unknown;
          question?: unknown;
          category?: unknown;
          deadline?: unknown;
        };

        const creationAt = at ?? 0;
        const creationLedger = ledger ?? 0;

        const existing = squadCreations.get(id);
        if (
          !existing ||
          creationLedger < existing.creationLedger ||
          (creationLedger === existing.creationLedger && creationAt < existing.creationAt)
        ) {
          squadCreations.set(id, {
            marketId: id,
            marketType: "squad",
            source: "squad",
            contractId,
            creator: typeof p.captain === "string" ? p.captain : undefined,
            title: typeof p.question === "string" ? p.question : undefined,
            category: typeof p.category === "string" ? p.category : undefined,
            deadline: typeof p.deadline === "number" && Number.isFinite(p.deadline) ? Math.trunc(p.deadline) : undefined,
            creationAt,
            creationLedger,
          });
        }
        processedEvents++;
      } else if (name === "resolved" && "marketId" in payload) {
        const marketId = (payload as { marketId?: unknown }).marketId;
        if (typeof marketId === "number" && Number.isFinite(marketId)) {
          squadResolutions.add(Math.trunc(marketId));
          processedEvents++;
        } else {
          skippedEvents++;
        }
      }

      // ── Prediction market contract events ─────────────────────────────────
      else if (name === "claim_created" && "claimId" in payload) {
        const claimId = (payload as { claimId?: unknown }).claimId;
        if (typeof claimId !== "number" || !Number.isFinite(claimId) || claimId < 0) {
          skippedEvents++;
          continue;
        }

        const id = Math.trunc(claimId);
        const p = payload as {
          creator?: unknown;
          category?: unknown;
          title?: unknown;
        };

        const creationAt = at ?? 0;
        const creationLedger = ledger ?? 0;

        const existing = claimCreations.get(id);
        if (
          !existing ||
          creationLedger < existing.creationLedger ||
          (creationLedger === existing.creationLedger && creationAt < existing.creationAt)
        ) {
          claimCreations.set(id, {
            marketId: id,
            marketType: "claim",
            source: "market",
            contractId,
            creator: typeof p.creator === "string" ? p.creator : undefined,
            category: typeof p.category === "string" ? p.category : undefined,
            title: typeof p.title === "string" ? p.title : undefined,
            creationAt,
            creationLedger,
          });
        }
        processedEvents++;
      } else if (
        (name === "claim_resolved" || name === "claim_cancelled" || name === "market_settled") &&
        "claimId" in payload
      ) {
        const claimId = (payload as { claimId?: unknown }).claimId;
        if (typeof claimId === "number" && Number.isFinite(claimId)) {
          claimTerminals.add(Math.trunc(claimId));
          processedEvents++;
        } else {
          skippedEvents++;
        }
      } else {
        processedEvents++;
      }
    }
  }

  // Determine reference time and ledger (time-injected or inferred)
  const evalNowSec =
    options?.nowSec !== undefined && options.nowSec !== null
      ? Math.trunc(options.nowSec)
      : maxObservedAt > 0
      ? maxObservedAt
      : Math.floor(Date.now() / 1000);

  const evalNowLedger =
    options?.nowLedger !== undefined && options.nowLedger !== null
      ? Math.trunc(options.nowLedger)
      : maxObservedLedger;

  // Filter open markets
  const openEntries: RawCreationState[] = [];

  const includeSquad = filterType === "all" || filterType === "squad";
  const includeClaim = filterType === "all" || filterType === "claim" || filterType === "market";

  if (includeSquad) {
    for (const [id, creation] of squadCreations) {
      if (!squadResolutions.has(id)) {
        openEntries.push(creation);
      }
    }
  }

  if (includeClaim) {
    for (const [id, creation] of claimCreations) {
      if (!claimTerminals.has(id)) {
        openEntries.push(creation);
      }
    }
  }

  // Build evaluated market entries
  const evaluatedOpen: StaleMarketEntry[] = [];
  const staleMarkets: StaleMarketEntry[] = [];
  const allAges: number[] = [];
  let overdueCount = 0;

  for (const raw of openEntries) {
    const ageSec = Math.max(0, evalNowSec - raw.creationAt);
    const ageLedgers = Math.max(0, evalNowLedger - raw.creationLedger);
    allAges.push(ageSec);

    let overdueSec = 0;
    if (raw.deadline !== undefined && raw.deadline > 0 && evalNowSec > raw.deadline) {
      overdueSec = Math.max(0, evalNowSec - raw.deadline);
      overdueCount++;
    }

    const isAgeStale = ageSec >= thresholdSec;
    const isLedgerStale = thresholdLedgers !== undefined && ageLedgers >= thresholdLedgers;
    const isOverdueStale = raw.deadline !== undefined && evalNowSec >= raw.deadline + deadlineGraceSec;

    const isStale = isAgeStale || isLedgerStale || (raw.deadline !== undefined && isOverdueStale && isAgeStale);

    let inferredState: InferredMarketState = "inferred_open";
    let inferredStateLabel: string;

    if (overdueSec > 0 && isStale) {
      inferredState = "inferred_overdue";
      inferredStateLabel = `inferred_overdue (unresolved past deadline by ${overdueSec}s; off-chain inference only, read-only: no settlement submitted)`;
    } else if (isStale) {
      inferredState = "inferred_stale";
      inferredStateLabel = `inferred_stale (unresolved; age ${ageSec}s >= threshold ${thresholdSec}s; off-chain inference only, read-only: no settlement submitted)`;
    } else {
      inferredState = "inferred_open";
      inferredStateLabel = `inferred_open (within age threshold; read-only: no settlement submitted)`;
    }

    const entry: StaleMarketEntry = {
      marketId: raw.marketId,
      marketType: raw.marketType,
      source: raw.source,
      contractId: raw.contractId,
      creator: raw.creator,
      title: raw.title,
      category: raw.category,
      creationAt: raw.creationAt,
      creationLedger: raw.creationLedger,
      deadline: raw.deadline,
      ageSec,
      ageLedgers,
      overdueSec,
      inferredState,
      inferredStateLabel,
      isStale,
      settlementSubmitted: false,
    };

    evaluatedOpen.push(entry);
    if (isStale) {
      staleMarkets.push(entry);
    }
  }

  // Sort stale markets descending by age (oldest first), breaking ties deterministically
  staleMarkets.sort((a, b) => {
    if (b.ageSec !== a.ageSec) {
      return b.ageSec - a.ageSec;
    }
    if (a.marketId !== b.marketId) {
      return a.marketId - b.marketId;
    }
    return a.marketType.localeCompare(b.marketType);
  });

  evaluatedOpen.sort((a, b) => {
    if (b.ageSec !== a.ageSec) {
      return b.ageSec - a.ageSec;
    }
    if (a.marketId !== b.marketId) {
      return a.marketId - b.marketId;
    }
    return a.marketType.localeCompare(b.marketType);
  });

  // Calculate summary statistics
  allAges.sort((a, b) => a - b);
  const totalOpenMarkets = evaluatedOpen.length;
  const maxAgeSec = allAges.length > 0 ? allAges[allAges.length - 1]! : 0;
  const p50AgeSec = nearestRank(allAges, 50);
  const p90AgeSec = nearestRank(allAges, 90);

  const summary: StaleMarketSummary = {
    totalOpenMarkets,
    staleCount: staleMarkets.length,
    overdueCount,
    maxAgeSec,
    p50AgeSec,
    p90AgeSec,
  };

  const limit = options?.limit;
  const returnedStaleMarkets =
    typeof limit === "number" && limit > 0 ? staleMarkets.slice(0, Math.trunc(limit)) : staleMarkets;

  const report: StaleMarketReport = {
    staleMarkets: returnedStaleMarkets,
    summary,
    thresholdSec,
    nowSec: evalNowSec,
    nowLedger: evalNowLedger,
    processedEvents,
    skippedEvents,
    inferredStateNotice: INFERRED_STATE_DISCLAIMER,
    readOnly: true,
  };

  if (thresholdLedgers !== undefined) {
    report.thresholdLedgers = thresholdLedgers;
  }

  if (options?.includeAllOpen) {
    report.allOpenMarkets = evaluatedOpen;
  }

  return report;
}

/** Aliases for staleMarketWatch */
export const staleMarketReport = staleMarketWatch;
export const staleMarkets = staleMarketWatch;

/**
 * Format a human-readable plain-text / Markdown table report of stale markets,
 * suitable for operator CLI inspections, logging, or administrative summaries.
 */
export function renderStaleMarketReport(report: StaleMarketReport): string {
  const lines: string[] = [];

  lines.push("=== Stale Market Watch Report ===");
  lines.push(`Notice: ${report.inferredStateNotice}`);
  lines.push(
    `Reference: nowSec=${report.nowSec} | nowLedger=${report.nowLedger} | threshold=${report.thresholdSec}s`,
  );
  lines.push(
    `Summary: ${report.summary.staleCount} stale / ${report.summary.totalOpenMarkets} open markets | overdue: ${report.summary.overdueCount} | maxAge: ${report.summary.maxAgeSec}s | p50: ${report.summary.p50AgeSec}s | p90: ${report.summary.p90AgeSec}s`,
  );
  lines.push("");

  if (report.staleMarkets.length === 0) {
    lines.push("No stale open markets observed beyond the age threshold.");
    return lines.join("\n");
  }

  lines.push("ID       Type   Age (s)    Ledgers  Inferred State    Title/Question");
  lines.push("-------  -----  ---------  -------  ----------------  ----------------------------------------");

  for (const m of report.staleMarkets) {
    const id = String(m.marketId).padEnd(7);
    const type = m.marketType.padEnd(5);
    const age = String(m.ageSec).padStart(9);
    const ledgers = String(m.ageLedgers).padStart(7);
    const state = m.inferredState.padEnd(16);
    const title = (m.title ?? "n/a").replace(/[\r\n]+/g, " ").slice(0, 40);

    lines.push(`${id}  ${type}  ${age}  ${ledgers}  ${state}  ${title}`);
  }

  return lines.join("\n");
}

/** Alias for renderStaleMarketReport */
export const formatStaleMarketReport = renderStaleMarketReport;
