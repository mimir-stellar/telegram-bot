/**
 * Boundary validation for Soroban RPC getEvents responses.
 *
 * Rejects structurally invalid RPC responses at the boundary before decoding,
 * protecting against misbehaving or hostile RPCs that return missing fields,
 * wrong types, or unbounded arrays.
 */

import { createHash } from "node:crypto";

import type { rpc } from "@stellar/stellar-sdk";

import { eventKey, type DedupableEvent } from "../dedup.js";
import { redactUrl } from "../redact.js";

/** Default ceiling on the number of events permitted in a single RPC response. */
export const DEFAULT_MAX_EVENTS_PER_RESPONSE = 1_000;

/** Default number of recent cross-provider window comparisons retained in memory. */
export const DEFAULT_MAX_DISAGREEMENT_HISTORY = 32;

/** Default cap on per-category disagreement entries retained in a single comparison report. */
export const DEFAULT_MAX_DISAGREEMENT_ITEMS = 50;

/** Default cap on distinct provider pairs tracked concurrently. */
export const DEFAULT_MAX_TRACKED_PROVIDER_PAIRS = 32;

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

// ── Cross-provider ledger-window disagreement tracking ───────────────────────

export type ProviderWindowProblem =
  | "invalid-provider"
  | "malformed-window"
  | "events-not-an-array"
  | "events-oversized"
  | "event-not-an-object"
  | "event-missing-ledger"
  | "event-missing-identity";

/**
 * Bounded validation error thrown when a provider window sample is malformed.
 *
 * Messages never echo raw event payloads, credentials, or query strings.
 */
export class ProviderWindowValidationError extends Error {
  readonly problem: ProviderWindowProblem;

  constructor(problem: ProviderWindowProblem, message: string) {
    super(message);
    this.name = "ProviderWindowValidationError";
    this.problem = problem;
  }
}

/** Inclusive ledger range `[startLedger, endLedger]` observed on an RPC provider. */
export interface ProviderLedgerWindow {
  startLedger: number;
  endLedger: number;
}

/** Validated or raw event batch associated with a provider's ledger window. */
export interface ProviderWindowSample {
  /** Provider endpoint URL or stable label (redacted before reporting). */
  provider: string;
  /** Inclusive ledger range covered by this provider sample. */
  window: ProviderLedgerWindow;
  /** Events observed by this provider. */
  events: readonly unknown[];
}

export interface ProviderDisagreementItem {
  key: string;
  ledger: number;
  digest: string;
}

export interface ProviderDivergentEvent {
  key: string;
  ledgerFirst: number;
  ledgerSecond: number;
  digestFirst: string;
  digestSecond: string;
  /** Canonical field names whose normalized content differed across providers. */
  differingFields: readonly string[];
}

export type ProviderComparisonStatus = "agreed" | "disagreed" | "no-overlap";

/**
 * Symmetric comparison of two RPC providers over their overlapping ledger window.
 *
 * `authoritativeProvider` is always `null`: when two unverified RPC endpoints
 * disagree, neither is promoted as authoritative truth.
 */
export interface ProviderWindowComparison {
  status: ProviderComparisonStatus;
  disagreed: boolean;
  authoritativeProvider: null;
  providers: readonly [string, string];
  sharedWindow: ProviderLedgerWindow | null;
  matchedCount: number;
  matchedKeys: readonly string[];
  onlyInFirstCount: number;
  onlyInFirst: readonly ProviderDisagreementItem[];
  onlyInSecondCount: number;
  onlyInSecond: readonly ProviderDisagreementItem[];
  divergentCount: number;
  divergentEvents: readonly ProviderDivergentEvent[];
  truncatedDiffs: boolean;
}

export interface CompareProviderWindowOptions {
  /** Maximum events permitted per sample (defaults to `DEFAULT_MAX_EVENTS_PER_RESPONSE`). */
  maxEvents?: number | undefined;
  /** Maximum diff items retained per category (defaults to `DEFAULT_MAX_DISAGREEMENT_ITEMS`). */
  maxDiffItems?: number | undefined;
  /**
   * Event identity strategy:
   * - `"canonical"` (default): uses `eventKey` (`id` -> `eventId` -> `v2:` composite).
   * - `"chain-composite"`: derives `v2:<ledger>:<txHash>:<txIndex>:<opIndex>:<topicDigest>`
   *   when chain metadata is available, falling back to `eventKey`.
   */
  identityMode?: "canonical" | "chain-composite" | undefined;
}

const CANONICAL_EVENT_FIELDS = [
  "ledger",
  "contractId",
  "txHash",
  "type",
  "transactionIndex",
  "operationIndex",
  "inSuccessfulContractCall",
  "topic",
  "value",
] as const;

/**
 * Normalize a provider URL or label to a bounded, credential-free identifier.
 * Strips userinfo, query parameters, and fragments from HTTP(S) URLs.
 */
export function normalizeProviderIdentity(provider: unknown): string {
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw new ProviderWindowValidationError(
      "invalid-provider",
      "RPC provider identifier must be a non-empty string",
    );
  }
  const trimmed = provider.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const cleanPath = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${cleanPath}`.slice(0, 120);
    }
  } catch {
    // Fall through to redacted label handling for non-URL logical names.
  }
  const sanitized = redactUrl(trimmed).replace(/[?#].*$/, "").trim();
  if (sanitized.length === 0) {
    throw new ProviderWindowValidationError(
      "invalid-provider",
      "RPC provider identifier cannot be empty after redaction",
    );
  }
  return sanitized.length <= 120 ? sanitized : `${sanitized.slice(0, 119)}…`;
}

function validateProviderWindow(
  window: unknown,
  label: string,
): ProviderLedgerWindow {
  if (!isRecord(window)) {
    throw new ProviderWindowValidationError(
      "malformed-window",
      `${label} window must be an object with startLedger and endLedger`,
    );
  }
  const { startLedger, endLedger } = window;
  if (!isValidLedger(startLedger) || !isValidLedger(endLedger)) {
    throw new ProviderWindowValidationError(
      "malformed-window",
      `${label} window bounds must be non-negative safe integers`,
    );
  }
  if (startLedger > endLedger) {
    throw new ProviderWindowValidationError(
      "malformed-window",
      `${label} window is inverted (startLedger ${startLedger} > endLedger ${endLedger})`,
    );
  }
  return { startLedger, endLedger };
}

function normalizeXdrOrJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeXdrOrJson);
  }
  if (typeof value === "object") {
    const maybeXdr = value as { toXDR?: (encoding?: string) => unknown };
    if (typeof maybeXdr.toXDR === "function") {
      try {
        const encoded = maybeXdr.toXDR("base64");
        if (typeof encoded === "string") return encoded;
      } catch {
        // Fall back to deterministic key-sorted object normalization.
      }
    }
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = normalizeXdrOrJson(record[key]);
    }
    return sorted;
  }
  return String(value);
}

/**
 * Derive a canonical event identity for cross-provider comparison.
 */
export function canonicalEventIdentity(
  event: unknown,
  mode: "canonical" | "chain-composite" = "canonical",
): string {
  if (!isRecord(event)) {
    throw new ProviderWindowValidationError(
      "event-not-an-object",
      `Provider event must be an object; got ${event === null ? "null" : typeof event}`,
    );
  }
  if (!isValidLedger(event.ledger)) {
    throw new ProviderWindowValidationError(
      "event-missing-ledger",
      "Provider event is missing a valid non-negative integer ledger",
    );
  }

  if (mode === "chain-composite") {
    const compositeCandidate: DedupableEvent = {
      ledger: event.ledger,
      txHash: typeof event.txHash === "string" ? event.txHash : null,
      transactionIndex:
        typeof event.transactionIndex === "number" ||
        typeof event.transactionIndex === "string" ||
        typeof event.transactionIndex === "bigint"
          ? event.transactionIndex
          : null,
      operationIndex:
        typeof event.operationIndex === "number" ||
        typeof event.operationIndex === "string" ||
        typeof event.operationIndex === "bigint"
          ? event.operationIndex
          : null,
      topic: event.topic,
    };
    const compositeKey = eventKey(compositeCandidate);
    if (compositeKey !== null) return compositeKey;
  }

  const key = eventKey(event as DedupableEvent);
  if (key === null || key.length === 0) {
    throw new ProviderWindowValidationError(
      "event-missing-identity",
      `Provider event at ledger ${event.ledger} is missing canonical identity fields`,
    );
  }
  return key;
}

interface NormalizedProviderEvent {
  key: string;
  ledger: number;
  digest: string;
  fields: Record<string, unknown>;
  selfContradicted: boolean;
}

/**
 * Compute a deterministic 16-hex-char SHA-256 content digest over canonical
 * chain-anchored event fields (`ledger`, `contractId`, `txHash`, `type`,
 * `transactionIndex`, `operationIndex`, `inSuccessfulContractCall`, `topic`, `value`).
 */
export function canonicalEventFingerprint(event: Record<string, unknown>): {
  digest: string;
  fields: Record<string, unknown>;
} {
  const fields: Record<string, unknown> = {
    ledger: event.ledger,
    contractId: typeof event.contractId === "string" ? event.contractId : null,
    txHash: typeof event.txHash === "string" ? event.txHash : null,
    type: typeof event.type === "string" ? event.type : null,
    transactionIndex:
      typeof event.transactionIndex === "number" && Number.isFinite(event.transactionIndex)
        ? Math.trunc(event.transactionIndex)
        : null,
    operationIndex:
      typeof event.operationIndex === "number" && Number.isFinite(event.operationIndex)
        ? Math.trunc(event.operationIndex)
        : null,
    inSuccessfulContractCall:
      typeof event.inSuccessfulContractCall === "boolean"
        ? event.inSuccessfulContractCall
        : null,
    topic: Array.isArray(event.topic) ? normalizeXdrOrJson(event.topic) : null,
    value: event.value !== undefined ? normalizeXdrOrJson(event.value) : null,
  };

  const digest = createHash("sha256")
    .update(JSON.stringify(fields), "utf8")
    .digest("hex")
    .slice(0, 16);

  return { digest, fields };
}

function indexSampleInWindow(
  sample: ProviderWindowSample,
  label: string,
  sharedWindow: ProviderLedgerWindow | null,
  maxEvents: number,
  identityMode: "canonical" | "chain-composite",
): Map<string, NormalizedProviderEvent> {
  if (!Array.isArray(sample.events)) {
    throw new ProviderWindowValidationError(
      "events-not-an-array",
      `${label} events must be an array; got ${sample.events === null ? "null" : typeof sample.events}`,
    );
  }
  if (sample.events.length > maxEvents) {
    throw new ProviderWindowValidationError(
      "events-oversized",
      `${label} events length ${sample.events.length} exceeds cap of ${maxEvents}`,
    );
  }

  const map = new Map<string, NormalizedProviderEvent>();
  for (let i = 0; i < sample.events.length; i++) {
    const raw = sample.events[i];
    const key = canonicalEventIdentity(raw, identityMode);
    const ev = raw as Record<string, unknown>;
    const ledger = ev.ledger as number;

    if (
      sharedWindow === null ||
      ledger < sharedWindow.startLedger ||
      ledger > sharedWindow.endLedger
    ) {
      continue;
    }

    const { digest, fields } = canonicalEventFingerprint(ev);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        ledger,
        digest,
        fields,
        selfContradicted: false,
      });
    } else if (existing.digest !== digest) {
      existing.selfContradicted = true;
    }
  }
  return map;
}

function differingCanonicalFields(
  firstFields: Record<string, unknown>,
  secondFields: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  for (const field of CANONICAL_EVENT_FIELDS) {
    if (JSON.stringify(firstFields[field]) !== JSON.stringify(secondFields[field])) {
      changed.push(field);
    }
  }
  return changed;
}

/**
 * Compare canonical event identities and digests from two providers across
 * their shared ledger window without choosing an unverified winner.
 */
export function compareProviderWindowEvents(
  first: ProviderWindowSample,
  second: ProviderWindowSample,
  options: CompareProviderWindowOptions = {},
): ProviderWindowComparison {
  if (!isRecord(first) || !isRecord(second)) {
    throw new ProviderWindowValidationError(
      "malformed-window",
      "Both provider samples must be non-null objects",
    );
  }

  const providerFirst = normalizeProviderIdentity(first.provider);
  const providerSecond = normalizeProviderIdentity(second.provider);
  const windowFirst = validateProviderWindow(first.window, "first provider");
  const windowSecond = validateProviderWindow(second.window, "second provider");

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS_PER_RESPONSE;
  const maxDiffItems = Math.max(
    1,
    Math.floor(options.maxDiffItems ?? DEFAULT_MAX_DISAGREEMENT_ITEMS),
  );
  const identityMode = options.identityMode ?? "canonical";

  const overlapStart = Math.max(windowFirst.startLedger, windowSecond.startLedger);
  const overlapEnd = Math.min(windowFirst.endLedger, windowSecond.endLedger);
  const sharedWindow: ProviderLedgerWindow | null =
    overlapStart <= overlapEnd
      ? { startLedger: overlapStart, endLedger: overlapEnd }
      : null;

  const mapFirst = indexSampleInWindow(
    first,
    "first provider",
    sharedWindow,
    maxEvents,
    identityMode,
  );
  const mapSecond = indexSampleInWindow(
    second,
    "second provider",
    sharedWindow,
    maxEvents,
    identityMode,
  );

  if (sharedWindow === null) {
    return {
      status: "no-overlap",
      disagreed: false,
      authoritativeProvider: null,
      providers: [providerFirst, providerSecond],
      sharedWindow: null,
      matchedCount: 0,
      matchedKeys: [],
      onlyInFirstCount: 0,
      onlyInFirst: [],
      onlyInSecondCount: 0,
      onlyInSecond: [],
      divergentCount: 0,
      divergentEvents: [],
      truncatedDiffs: false,
    };
  }

  const matchedKeysAll: string[] = [];
  const onlyInFirstAll: ProviderDisagreementItem[] = [];
  const onlyInSecondAll: ProviderDisagreementItem[] = [];
  const divergentAll: ProviderDivergentEvent[] = [];

  for (const [key, itemFirst] of mapFirst.entries()) {
    const itemSecond = mapSecond.get(key);
    if (!itemSecond) {
      onlyInFirstAll.push({
        key,
        ledger: itemFirst.ledger,
        digest: itemFirst.digest,
      });
      continue;
    }

    if (
      itemFirst.digest !== itemSecond.digest ||
      itemFirst.selfContradicted ||
      itemSecond.selfContradicted
    ) {
      const differingFields = differingCanonicalFields(itemFirst.fields, itemSecond.fields);
      if (differingFields.length === 0 && (itemFirst.selfContradicted || itemSecond.selfContradicted)) {
        differingFields.push("duplicate-id-conflict");
      }
      divergentAll.push({
        key,
        ledgerFirst: itemFirst.ledger,
        ledgerSecond: itemSecond.ledger,
        digestFirst: itemFirst.digest,
        digestSecond: itemSecond.digest,
        differingFields,
      });
    } else {
      matchedKeysAll.push(key);
    }
  }

  for (const [key, itemSecond] of mapSecond.entries()) {
    if (!mapFirst.has(key)) {
      onlyInSecondAll.push({
        key,
        ledger: itemSecond.ledger,
        digest: itemSecond.digest,
      });
    }
  }

  matchedKeysAll.sort();
  onlyInFirstAll.sort((a, b) => a.ledger - b.ledger || a.key.localeCompare(b.key));
  onlyInSecondAll.sort((a, b) => a.ledger - b.ledger || a.key.localeCompare(b.key));
  divergentAll.sort(
    (a, b) => a.ledgerFirst - b.ledgerFirst || a.key.localeCompare(b.key),
  );

  const disagreed =
    onlyInFirstAll.length > 0 ||
    onlyInSecondAll.length > 0 ||
    divergentAll.length > 0;

  const truncatedDiffs =
    matchedKeysAll.length > maxDiffItems ||
    onlyInFirstAll.length > maxDiffItems ||
    onlyInSecondAll.length > maxDiffItems ||
    divergentAll.length > maxDiffItems;

  return {
    status: disagreed ? "disagreed" : "agreed",
    disagreed,
    authoritativeProvider: null,
    providers: [providerFirst, providerSecond],
    sharedWindow,
    matchedCount: matchedKeysAll.length,
    matchedKeys: matchedKeysAll.slice(0, maxDiffItems),
    onlyInFirstCount: onlyInFirstAll.length,
    onlyInFirst: onlyInFirstAll.slice(0, maxDiffItems),
    onlyInSecondCount: onlyInSecondAll.length,
    onlyInSecond: onlyInSecondAll.slice(0, maxDiffItems),
    divergentCount: divergentAll.length,
    divergentEvents: divergentAll.slice(0, maxDiffItems),
    truncatedDiffs,
  };
}

export interface ProviderComparisonRecord {
  atMs: number;
  comparison: ProviderWindowComparison;
}

export interface ProviderPairDisagreementSummary {
  providers: readonly [string, string];
  agreedWindows: number;
  disagreedWindows: number;
  noOverlapWindows: number;
  lastStatus: ProviderComparisonStatus;
  lastSharedWindow: ProviderLedgerWindow | null;
  lastUpdatedAtMs: number;
  authoritativeProvider: null;
}

export interface ProviderDisagreementSnapshot {
  totalComparisons: number;
  agreedCount: number;
  disagreedCount: number;
  noOverlapCount: number;
  activeDisagreement: boolean;
  authoritativeProvider: null;
  pairs: readonly ProviderPairDisagreementSummary[];
  recent: readonly ProviderComparisonRecord[];
}

export interface ProviderDisagreementTrackerOptions extends CompareProviderWindowOptions {
  /** Maximum comparison records retained in the ring buffer (default `32`, `0` disables history). */
  maxHistory?: number | undefined;
  /** Maximum distinct provider pairs retained concurrently (default `32`). */
  maxPairs?: number | undefined;
  /** Optional clock override for deterministic tests. */
  now?: (() => number) | undefined;
}

interface MutablePairSummary {
  providers: readonly [string, string];
  agreedWindows: number;
  disagreedWindows: number;
  noOverlapWindows: number;
  lastStatus: ProviderComparisonStatus;
  lastSharedWindow: ProviderLedgerWindow | null;
  lastUpdatedAtMs: number;
}

/**
 * Bounded tracker recording cross-provider agreement and disagreement over
 * shared ledger windows without promoting either provider as an unverified winner.
 */
export class ProviderDisagreementTracker {
  private readonly maxHistory: number;
  private readonly maxPairs: number;
  private readonly compareOptions: CompareProviderWindowOptions;
  private readonly now: () => number;

  private totalComparisons = 0;
  private agreedCount = 0;
  private disagreedCount = 0;
  private noOverlapCount = 0;
  private readonly pairs = new Map<string, MutablePairSummary>();
  private readonly recent: ProviderComparisonRecord[] = [];

  constructor(options: ProviderDisagreementTrackerOptions = {}) {
    this.maxHistory = Number.isFinite(options.maxHistory)
      ? Math.max(0, Math.floor(options.maxHistory!))
      : DEFAULT_MAX_DISAGREEMENT_HISTORY;
    this.maxPairs = Number.isFinite(options.maxPairs)
      ? Math.max(1, Math.floor(options.maxPairs!))
      : DEFAULT_MAX_TRACKED_PROVIDER_PAIRS;
    this.compareOptions = {
      maxEvents: options.maxEvents,
      maxDiffItems: options.maxDiffItems,
      identityMode: options.identityMode,
    };
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Compare two provider samples on their overlapping ledger window and record
   * the bounded outcome.
   */
  record(
    first: ProviderWindowSample,
    second: ProviderWindowSample,
  ): ProviderWindowComparison {
    const comparison = compareProviderWindowEvents(first, second, this.compareOptions);
    const atMs = this.now();

    this.totalComparisons += 1;
    if (comparison.status === "agreed") this.agreedCount += 1;
    else if (comparison.status === "disagreed") this.disagreedCount += 1;
    else this.noOverlapCount += 1;

    const orderedPair =
      comparison.providers[0] <= comparison.providers[1]
        ? comparison.providers
        : ([comparison.providers[1], comparison.providers[0]] as const);
    const pairKey = `${orderedPair[0]}\u0000${orderedPair[1]}`;

    const existing = this.pairs.get(pairKey);
    if (existing) {
      this.pairs.delete(pairKey);
      if (comparison.status === "agreed") existing.agreedWindows += 1;
      else if (comparison.status === "disagreed") existing.disagreedWindows += 1;
      else existing.noOverlapWindows += 1;
      if (comparison.status !== "no-overlap") {
        existing.lastStatus = comparison.status;
        existing.lastSharedWindow = comparison.sharedWindow;
      }
      existing.lastUpdatedAtMs = atMs;
      this.pairs.set(pairKey, existing);
    } else {
      if (this.pairs.size >= this.maxPairs) {
        const oldestKey = this.pairs.keys().next().value;
        if (oldestKey !== undefined) this.pairs.delete(oldestKey);
      }
      this.pairs.set(pairKey, {
        providers: orderedPair,
        agreedWindows: comparison.status === "agreed" ? 1 : 0,
        disagreedWindows: comparison.status === "disagreed" ? 1 : 0,
        noOverlapWindows: comparison.status === "no-overlap" ? 1 : 0,
        lastStatus: comparison.status,
        lastSharedWindow: comparison.sharedWindow,
        lastUpdatedAtMs: atMs,
      });
    }

    if (this.maxHistory > 0) {
      if (this.recent.length >= this.maxHistory) {
        this.recent.shift();
      }
      this.recent.push({ atMs, comparison });
    }

    return comparison;
  }

  /** Return an immutable, bounded diagnostic snapshot. */
  snapshot(): ProviderDisagreementSnapshot {
    const pairSummaries: ProviderPairDisagreementSummary[] = [];
    let activeDisagreement = false;
    for (const entry of this.pairs.values()) {
      if (entry.lastStatus === "disagreed") {
        activeDisagreement = true;
      }
      pairSummaries.push({
        providers: entry.providers,
        agreedWindows: entry.agreedWindows,
        disagreedWindows: entry.disagreedWindows,
        noOverlapWindows: entry.noOverlapWindows,
        lastStatus: entry.lastStatus,
        lastSharedWindow: entry.lastSharedWindow
          ? { ...entry.lastSharedWindow }
          : null,
        lastUpdatedAtMs: entry.lastUpdatedAtMs,
        authoritativeProvider: null,
      });
    }

    return {
      totalComparisons: this.totalComparisons,
      agreedCount: this.agreedCount,
      disagreedCount: this.disagreedCount,
      noOverlapCount: this.noOverlapCount,
      activeDisagreement,
      authoritativeProvider: null,
      pairs: pairSummaries,
      recent: [...this.recent],
    };
  }

  /** Clear accumulated comparisons and pair summaries. */
  reset(): void {
    this.totalComparisons = 0;
    this.agreedCount = 0;
    this.disagreedCount = 0;
    this.noOverlapCount = 0;
    this.pairs.clear();
    this.recent.length = 0;
  }
}
