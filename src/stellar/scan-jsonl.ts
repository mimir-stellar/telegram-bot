import { createHash } from "node:crypto";
import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export const CANONICAL_NEWLINE = "\n" as const;

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode a string or UTF-8 Buffer (rejecting invalid UTF-8 byte sequences and
 * stripping an optional leading UTF-8 BOM `\uFEFF`).
 */
export function decodeArchiveText(input: string | Uint8Array): string {
  const raw = typeof input === "string" ? input : UTF8_DECODER.decode(input);
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Split JSONL text across Unix (`\n`), Windows (`\r\n`), or legacy (`\r`)
 * outer record terminators without touching escaped `\r`/`\n` inside JSON
 * string literals.
 */
export function splitNormalizedJsonlLines(input: string | Uint8Array): string[] {
  const text = decodeArchiveText(input);
  if (text.length === 0) return [];
  const rawLines = text.split(/\r\n|\n|\r/);
  const records: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(trimmed);
  }
  return records;
}

function canonicalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const next = obj[key];
      if (next !== undefined) {
        sorted[key] = canonicalizeValue(next);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize a single archive or JSONL record in deterministic canonical form
 * (sorted object keys, decimal bigint strings, no trailing CR/LF).
 */
export function serializeCanonicalRecord(record: unknown): string {
  return JSON.stringify(canonicalizeValue(record), scanJsonReplacer);
}

/**
 * Compute a stable SHA-256 record identity over the canonical representation of
 * an event record (excluding outer transport wrappers such as `type: "event"`),
 * invariant across LF and CRLF inputs and property ordering.
 */
export function computeArchiveRecordIdentity(record: DecodedEvent | ScanJsonlEventLine): string {
  const { type: _ignoredType, ...coreEvent } = record as unknown as Record<string, unknown>;
  const canonical = serializeCanonicalRecord(coreEvent);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Parse LF, CRLF, or mixed-newline JSONL input and re-emit canonical UTF-8
 * LF-terminated JSONL (`\n` after every record, zero `\r` or BOM bytes).
 */
export function normalizeScanJsonl(input: string | Uint8Array): string {
  const lines = splitNormalizedJsonlLines(input);
  if (lines.length === 0) return "";

  const canonicalLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Malformed JSONL record #${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected JSON object at JSONL record #${i + 1}`);
    }
    canonicalLines.push(serializeCanonicalRecord(parsed));
  }

  return canonicalLines.join(CANONICAL_NEWLINE) + CANONICAL_NEWLINE;
}

/**
 * Parse decoded events from LF or CRLF JSONL input while skipping summary lines.
 */
export function parseScanJsonlEvents(input: string | Uint8Array): DecodedEvent[] {
  const lines = splitNormalizedJsonlLines(input);
  const events: DecodedEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = JSON.parse(lines[i]!);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Expected JSON object at JSONL record #${i + 1}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.type === "summary") continue;
    const { type: _ignoredType, ...rest } = obj;
    events.push(rest as unknown as DecodedEvent);
  }
  return events;
}

/**
 * Format decoded events as JSON Lines (NDJSON): one event line per decoded
 * event followed by a final `{ type: "summary" }` line containing the
 * histogram from {@link eventHistogram}. Always uses canonical LF (`\n`)
 * record terminators across Windows and Unix.
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
  return lines.join(CANONICAL_NEWLINE) + CANONICAL_NEWLINE;
}
