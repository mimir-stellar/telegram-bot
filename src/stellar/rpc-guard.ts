/**
 * Boundary validation for Soroban RPC getEvents responses.
 *
 * Rejects structurally invalid RPC responses at the boundary before decoding,
 * protecting against misbehaving or hostile RPCs that return missing fields,
 * wrong types, or unbounded arrays.
 */

import type { rpc } from "@stellar/stellar-sdk";

import { eventKey, type DedupableEvent } from "../dedup.js";
import { validateScanWindow, type ScanLedgerWindow } from "./client.js";

/** Default ceiling on the number of events permitted in a single RPC response. */
export const DEFAULT_MAX_EVENTS_PER_RESPONSE = 1_000;

export type RpcGuardProblem =
  | "not-an-object"
  | "events-not-an-array"
  | "events-oversized"
  | "cursor-invalid"
  | "latest-ledger-invalid"
  | "event-not-an-object"
  | "event-missing-id"
  | "event-missing-ledger";

/**
 * Error thrown when an RPC response fails structural validation.
 *
 * Messages are strictly bounded and never echo raw response payloads.
 */
export class RpcResponseShapeError extends Error {
  readonly problem: RpcGuardProblem;

  constructor(problem: RpcGuardProblem, message: string) {
    super(message);
    this.name = "RpcResponseShapeError";
    this.problem = problem;
  }
}

export interface AssertEventsResponseOptions {
  /**
   * Maximum allowed items in `events`.
   * Defaults to {@link DEFAULT_MAX_EVENTS_PER_RESPONSE}.
   */
  maxEvents?: number | undefined;
}

/** Check if a value is a non-null plain record/object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check if a ledger is a valid non-negative safe integer. */
function isValidLedger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate the structure of a `getEvents` RPC response.
 *
 * Validates:
 * - Top-level value is a non-null object.
 * - `events` is an array whose length does not exceed `maxEvents`.
 * - `cursor` is a string (or undefined/null if omitted by endpoint).
 * - `latestLedger` is a valid non-negative integer (or undefined/null if omitted).
 * - Every event in `events` is an object with an `id` string and a valid `ledger` number.
 *
 * @param value The raw response value to validate.
 * @param options Optional configuration including `maxEvents`.
 * @returns The typed `rpc.Api.GetEventsResponse`.
 * @throws {RpcResponseShapeError} Bounded error if validation fails.
 */
export function assertEventsResponse(
  value: unknown,
  options: AssertEventsResponseOptions = {},
): rpc.Api.GetEventsResponse {
  if (!isRecord(value)) {
    throw new RpcResponseShapeError(
      "not-an-object",
      `RPC getEvents response must be an object; got ${value === null ? "null" : typeof value}`,
    );
  }

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_RESPONSE;
  const events = value.events;

  if (!Array.isArray(events)) {
    throw new RpcResponseShapeError(
      "events-not-an-array",
      `RPC getEvents response "events" field must be an array; got ${events === null ? "null" : typeof events}`,
    );
  }

  if (events.length > maxEvents) {
    throw new RpcResponseShapeError(
      "events-oversized",
      `RPC getEvents response contains ${events.length} events, exceeding cap of ${maxEvents}`,
    );
  }

  const cursor = value.cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
    throw new RpcResponseShapeError(
      "cursor-invalid",
      `RPC getEvents response "cursor" must be a string; got ${typeof cursor}`,
    );
  }

  const latestLedger = value.latestLedger;
  if (latestLedger !== undefined && latestLedger !== null && !isValidLedger(latestLedger)) {
    throw new RpcResponseShapeError(
      "latest-ledger-invalid",
      `RPC getEvents response "latestLedger" must be a valid non-negative integer; got ${typeof latestLedger}`,
    );
  }

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!isRecord(ev)) {
      throw new RpcResponseShapeError(
        "event-not-an-object",
        `RPC getEvents event at index ${i} must be an object; got ${ev === null ? "null" : typeof ev}`,
      );
    }

    if (typeof ev.id !== "string" || ev.id.length === 0) {
      throw new RpcResponseShapeError(
        "event-missing-id",
        `RPC getEvents event at index ${i} is missing a valid string id`,
      );
    }

    if (!isValidLedger(ev.ledger)) {
      throw new RpcResponseShapeError(
        "event-missing-ledger",
        `RPC getEvents event at index ${i} is missing a valid non-negative ledger`,
      );
    }
  }

  return value as unknown as rpc.Api.GetEventsResponse;
}

// ── Multi-provider disagreement tracking ─────────────────────────────────────

/** Default maximum number of window comparisons retained by {@link ProviderDisagreementTracker}. */
export const DEFAULT_MAX_DISAGREEMENT_HISTORY = 100;

/** Events returned by one RPC provider for a shared ledger window. */
export interface ProviderEventBatch {
  /** Optional provider label for diagnostics (never used to pick a winner). */
  provider?: string;
  /** Events returned by this provider for the window. */
  events: readonly DedupableEvent[];
}

/**
 * Symmetric comparison of canonical event identities from two providers on the
 * same ledger window. Exposes any disagreement without choosing an unverified
 * winner.
 */
export interface ProviderComparisonResult {
  window: ScanLedgerWindow;
  providerA: string;
  providerB: string;
  /** True only when both providers returned the exact same canonical identities and zero unidentifiable events. */
  agrees: boolean;
  /** Negation of `agrees` for direct filtering. */
  disagrees: boolean;
  /** Number of canonical event identities present in both providers' responses. */
  sharedCount: number;
  /** Canonical event identities present only in provider A (sorted). */
  onlyInA: string[];
  /** Canonical event identities present only in provider B (sorted). */
  onlyInB: string[];
  /** Count of events in provider A whose canonical identity could not be derived. */
  unidentifiableA: number;
  /** Count of events in provider B whose canonical identity could not be derived. */
  unidentifiableB: number;
}

/** Aggregated disagreement metrics across tracked ledger windows. */
export interface ProviderDisagreementSummary {
  totalWindows: number;
  agreedWindows: number;
  disagreedWindows: number;
  disagreementRate: number;
  recentDisagreements: ProviderComparisonResult[];
}

function collectCanonicalKeys(
  events: readonly DedupableEvent[],
  label: string,
): { keys: Set<string>; unidentifiable: number } {
  if (!Array.isArray(events)) {
    throw new RpcResponseShapeError(
      "events-not-an-array",
      `Provider "${label}" events must be an array; got ${events === null ? "null" : typeof events}`,
    );
  }
  const keys = new Set<string>();
  let unidentifiable = 0;
  for (const ev of events) {
    const key = eventKey(ev);
    if (key === null) {
      unidentifiable += 1;
    } else {
      keys.add(key);
    }
  }
  return { keys, unidentifiable };
}

/**
 * Compare canonical event identities returned by two RPC providers for the
 * same ledger window.
 *
 * Uses {@link eventKey} to derive canonical identities and reports missing/extra
 * identities symmetrically without selecting an unverified winner.
 */
export function compareProviderEvents(
  window: { startLedger?: unknown; endLedger?: unknown },
  batchA: ProviderEventBatch,
  batchB: ProviderEventBatch,
): ProviderComparisonResult {
  const validWindow = validateScanWindow(window);
  const providerA = batchA.provider?.trim() || "provider-a";
  const providerB = batchB.provider?.trim() || "provider-b";

  const collectedA = collectCanonicalKeys(batchA.events, providerA);
  const collectedB = collectCanonicalKeys(batchB.events, providerB);

  let sharedCount = 0;
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];

  for (const key of collectedA.keys) {
    if (collectedB.keys.has(key)) {
      sharedCount += 1;
    } else {
      onlyInA.push(key);
    }
  }
  for (const key of collectedB.keys) {
    if (!collectedA.keys.has(key)) {
      onlyInB.push(key);
    }
  }

  onlyInA.sort();
  onlyInB.sort();

  const agrees =
    onlyInA.length === 0 &&
    onlyInB.length === 0 &&
    collectedA.unidentifiable === 0 &&
    collectedB.unidentifiable === 0;

  return {
    window: validWindow,
    providerA,
    providerB,
    agrees,
    disagrees: !agrees,
    sharedCount,
    onlyInA,
    onlyInB,
    unidentifiableA: collectedA.unidentifiable,
    unidentifiableB: collectedB.unidentifiable,
  };
}

/**
 * Bounded tracker for provider disagreement across ledger windows.
 *
 * Retains aggregated counts across all recorded windows and a bounded ring of
 * recent disagreements for inspection, without ever promoting an unverified
 * provider as authoritative.
 */
export class ProviderDisagreementTracker {
  readonly maxHistory: number;
  private totalWindows = 0;
  private agreedWindows = 0;
  private disagreedWindows = 0;
  private readonly recentDisagreements: ProviderComparisonResult[] = [];

  constructor(maxHistory: number = DEFAULT_MAX_DISAGREEMENT_HISTORY) {
    this.maxHistory = Number.isFinite(maxHistory) && maxHistory >= 0 ? Math.floor(maxHistory) : 0;
  }

  /** Compare two providers on `window` and record the outcome. */
  compareAndTrack(
    window: { startLedger?: unknown; endLedger?: unknown },
    batchA: ProviderEventBatch,
    batchB: ProviderEventBatch,
  ): ProviderComparisonResult {
    const result = compareProviderEvents(window, batchA, batchB);
    return this.record(result);
  }

  /** Record a pre-computed {@link ProviderComparisonResult}. */
  record(result: ProviderComparisonResult): ProviderComparisonResult {
    this.totalWindows += 1;
    if (result.agrees) {
      this.agreedWindows += 1;
    } else {
      this.disagreedWindows += 1;
      if (this.maxHistory > 0) {
        if (this.recentDisagreements.length >= this.maxHistory) {
          this.recentDisagreements.shift();
        }
        this.recentDisagreements.push(result);
      }
    }
    return result;
  }

  /** True if at least one recorded window had a disagreement. */
  hasDisagreement(): boolean {
    return this.disagreedWindows > 0;
  }

  /** Return bounded summary metrics and recent disagreements. */
  summary(): ProviderDisagreementSummary {
    return {
      totalWindows: this.totalWindows,
      agreedWindows: this.agreedWindows,
      disagreedWindows: this.disagreedWindows,
      disagreementRate: this.totalWindows === 0 ? 0 : this.disagreedWindows / this.totalWindows,
      recentDisagreements: [...this.recentDisagreements],
    };
  }

  /** Reset all tracked counts and history. */
  clear(): void {
    this.totalWindows = 0;
    this.agreedWindows = 0;
    this.disagreedWindows = 0;
    this.recentDisagreements.length = 0;
  }
}
