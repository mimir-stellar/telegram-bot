import { dedupeEvents, sortEvents, type ContractSource, type DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
  ledgerRange?: { minLedger: number; maxLedger: number } | null | undefined;
  compactedRange?: { fromLedger: number; toLedger: number } | undefined;
}

export interface LedgerBounds {
  fromLedger: number;
  toLedger: number;
}

export class ArchiveCompactionError extends Error {
  readonly code:
    | "INVALID_RANGE"
    | "MALFORMED_SOURCE"
    | "VERIFICATION_FAILED"
    | "SOURCE_NOT_FOUND";

  constructor(
    code:
      | "INVALID_RANGE"
      | "MALFORMED_SOURCE"
      | "VERIFICATION_FAILED"
      | "SOURCE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ArchiveCompactionError";
    this.code = code;
  }
}

export function validateCompactionRange(range: LedgerBounds): LedgerBounds {
  if (!range || typeof range !== "object") {
    throw new ArchiveCompactionError("INVALID_RANGE", "Compaction ledger range is required");
  }
  const { fromLedger, toLedger } = range;
  if (
    typeof fromLedger !== "number" ||
    !Number.isInteger(fromLedger) ||
    fromLedger < 0
  ) {
    throw new ArchiveCompactionError(
      "INVALID_RANGE",
      `fromLedger must be a non-negative integer, got ${String(fromLedger)}`,
    );
  }
  if (
    typeof toLedger !== "number" ||
    !Number.isInteger(toLedger) ||
    toLedger < 0
  ) {
    throw new ArchiveCompactionError(
      "INVALID_RANGE",
      `toLedger must be a non-negative integer, got ${String(toLedger)}`,
    );
  }
  if (fromLedger > toLedger) {
    throw new ArchiveCompactionError(
      "INVALID_RANGE",
      `fromLedger (${fromLedger}) must be <= toLedger (${toLedger})`,
    );
  }
  return { fromLedger, toLedger };
}

export function computeLedgerSpan(
  events: readonly DecodedEvent[],
): { minLedger: number; maxLedger: number } | null {
  let minLedger = Infinity;
  let maxLedger = -Infinity;
  for (const ev of events) {
    if (typeof ev.ledger === "number" && Number.isFinite(ev.ledger)) {
      if (ev.ledger < minLedger) minLedger = ev.ledger;
      if (ev.ledger > maxLedger) maxLedger = ev.ledger;
    }
  }
  return minLedger <= maxLedger ? { minLedger, maxLedger } : null;
}

export function extractContractsFromEvents(
  events: readonly DecodedEvent[],
): Partial<Record<ContractSource, string>> {
  const contracts: Partial<Record<ContractSource, string>> = {};
  for (const ev of events) {
    if (
      (ev.source === "market" || ev.source === "squad") &&
      typeof ev.contractId === "string" &&
      ev.contractId.length > 0 &&
      contracts[ev.source] === undefined
    ) {
      contracts[ev.source] = ev.contractId;
    }
  }
  return contracts;
}

export interface CompactedScanJsonlResult {
  jsonl: string;
  retainedCount: number;
  droppedOutOfRangeCount: number;
  duplicateCount: number;
  histogram: Record<string, number>;
  retainedLedgerRange: { minLedger: number; maxLedger: number } | null;
  requestedRange: LedgerBounds;
}

/**
 * Compact a JSONL capture to a bounded `[fromLedger, toLedger]` range,
 * deduplicating and sorting retained events, rebuilding summary metadata, and
 * verifying the resulting JSONL before returning it.
 */
export function compactScanJsonlByLedgerRange(
  jsonl: string,
  range: LedgerBounds,
): CompactedScanJsonlResult {
  const validated = validateCompactionRange(range);
  const rawLines = jsonl.split(/\r?\n/);
  const inRange: DecodedEvent[] = [];
  let droppedOutOfRangeCount = 0;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const trimmed = (rawLines[idx] ?? "").trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new ArchiveCompactionError(
        "MALFORMED_SOURCE",
        `Malformed JSON at line ${idx + 1}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ArchiveCompactionError(
        "MALFORMED_SOURCE",
        `Non-object JSON record at line ${idx + 1}`,
      );
    }

    const record = parsed as Record<string, unknown>;
    if (record.type === "summary" || record.type === "meta") {
      continue;
    }

    if (typeof record.ledger !== "number" || !Number.isInteger(record.ledger)) {
      throw new ArchiveCompactionError(
        "MALFORMED_SOURCE",
        `Record at line ${idx + 1} is missing an integer ledger`,
      );
    }

    if (record.ledger < validated.fromLedger || record.ledger > validated.toLedger) {
      droppedOutOfRangeCount += 1;
      continue;
    }

    const { type: _ignoredType, ...rest } = record;
    inRange.push(rest as unknown as DecodedEvent);
  }

  const deduped = sortEvents(dedupeEvents(inRange));
  const duplicateCount = inRange.length - deduped.length;
  const histogram = eventHistogram(deduped);
  const retainedLedgerRange = computeLedgerSpan(deduped);

  const outLines: string[] = [];
  for (const event of deduped) {
    outLines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }
  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: deduped.length,
    histogram,
    ledgerRange: retainedLedgerRange,
    compactedRange: validated,
  };
  outLines.push(JSON.stringify(summary, scanJsonReplacer));
  const compactedJsonl = outLines.join("\n") + "\n";

  // Verify compacted output before returning.
  const verifyLines = compactedJsonl.trim().split("\n");
  if (verifyLines.length !== deduped.length + 1) {
    throw new ArchiveCompactionError(
      "VERIFICATION_FAILED",
      "Compacted JSONL line count mismatch",
    );
  }

  return {
    jsonl: compactedJsonl,
    retainedCount: deduped.length,
    droppedOutOfRangeCount,
    duplicateCount,
    histogram,
    retainedLedgerRange,
    requestedRange: validated,
  };
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}.
 */
export function formatScanJsonl(events: readonly DecodedEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }
  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: events.length,
    histogram: eventHistogram([...events]),
  };
  lines.push(JSON.stringify(summary, scanJsonReplacer));
  return lines.join("\n") + "\n";
}
