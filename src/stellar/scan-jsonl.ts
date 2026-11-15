import type { ContractSource, DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export interface ScanJsonlCaptureFilter {
  sources?: readonly ContractSource[];
  contractIds?: readonly string[];
  eventNames?: readonly string[];
  categories?: readonly string[];
}

export interface ScanJsonlCaptureMeta {
  startLedger?: number | null;
  endLedger?: number | null;
  truncated?: boolean;
  startClamped?: boolean;
  filter?: ScanJsonlCaptureFilter;
}

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
  capture?: ScanJsonlCaptureMeta;
}

export interface ParsedScanJsonl {
  events: DecodedEvent[];
  summary: ScanJsonlSummaryLine | null;
  meta?: ScanJsonlCaptureMeta;
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram} and optional capture acquisition metadata.
 */
export function formatScanJsonl(
  events: readonly DecodedEvent[],
  capture?: ScanJsonlCaptureMeta,
): string {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(JSON.stringify({ type: "event", ...event }, scanJsonReplacer));
  }
  const summary: ScanJsonlSummaryLine = {
    type: "summary",
    eventCount: events.length,
    histogram: eventHistogram([...events]),
    ...(capture !== undefined ? { capture } : {}),
  };
  lines.push(JSON.stringify(summary, scanJsonReplacer));
  return lines.join("\n") + "\n";
}

/**
 * Parse JSONL scanner output back into decoded event records and optional capture metadata.
 */
export function parseScanJsonl(jsonl: string): ParsedScanJsonl {
  if (typeof jsonl !== "string") {
    throw new TypeError("Expected JSONL input to be a string");
  }
  const events: DecodedEvent[] = [];
  let summary: ScanJsonlSummaryLine | null = null;
  const rawLines = jsonl.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i]?.trim() ?? "";
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Malformed JSONL at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid JSONL record at line ${i + 1}: expected an object`);
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "summary") {
      summary = record as unknown as ScanJsonlSummaryLine;
      continue;
    }
    if (record.type === "event" || record.type === undefined) {
      const { type: _ignored, ...rest } = record;
      events.push(rest as unknown as DecodedEvent);
      continue;
    }
    throw new Error(`Unknown JSONL record type at line ${i + 1}: ${String(record.type)}`);
  }

  return {
    events,
    summary,
    ...(summary?.capture !== undefined ? { meta: summary.capture } : {}),
  };
}
