import type { ContractSource, DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export const MAX_DIAGNOSTIC_LENGTH = 160;

export type MalformedRecordReasonCode =
  | "INVALID_JSON"
  | "NON_OBJECT_RECORD"
  | "INVALID_RECORD_SHAPE";

export interface MalformedArchiveRecordInit {
  file: string;
  line: number;
  byteLength: number;
  reasonCode: MalformedRecordReasonCode;
  detail: string;
  committedCount: number;
  retainedEvents: readonly DecodedEvent[];
}

function clampDiagnostic(text: string, maxLen: number = MAX_DIAGNOSTIC_LENGTH): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function safeFileLabel(file: string): string {
  const cleaned = file.replace(/[\r\n\t]+/g, " ").trim() || "<jsonl>";
  return cleaned.length <= 64 ? cleaned : `…${cleaned.slice(-63)}`;
}

/**
 * Bounded, payload-safe error raised when an archive or JSONL capture contains
 * a malformed record. Never echoes raw line content or field values.
 */
export class MalformedArchiveRecordError extends Error {
  readonly file: string;
  readonly line: number;
  readonly byteLength: number;
  readonly reasonCode: MalformedRecordReasonCode;
  readonly diagnostic: string;
  readonly committedCount: number;
  readonly retainedEvents: readonly DecodedEvent[];

  constructor(init: MalformedArchiveRecordInit) {
    const fileLabel = safeFileLabel(init.file);
    const bounded = clampDiagnostic(
      `Malformed archive record at ${fileLabel}:${init.line} (${init.reasonCode}): ${init.detail}`,
    );
    super(bounded);
    this.name = "MalformedArchiveRecordError";
    this.file = init.file;
    this.line = init.line;
    this.byteLength = init.byteLength;
    this.reasonCode = init.reasonCode;
    this.diagnostic = bounded;
    this.committedCount = init.committedCount;
    this.retainedEvents = init.retainedEvents;
  }
}

export interface ParseScanJsonlOptions {
  /** Logical filename reported in diagnostics (default: "<jsonl>"). */
  sourceName?: string | undefined;
  /**
   * When true, already parsed valid events prior to the malformed line are
   * attached to `MalformedArchiveRecordError.retainedEvents`. Defaults to false.
   */
  retainCommittedOutput?: boolean | undefined;
}

export interface ParsedScanJsonlResult {
  events: DecodedEvent[];
  summary: ScanJsonlSummaryLine | null;
}

const VALID_SOURCES: ReadonlySet<string> = new Set<ContractSource>(["market", "squad"]);

function extractSyntaxPosition(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = /\bat position (\d+)\b/i.exec(err.message);
  if (!match || !match[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse and structurally validate one physical JSONL record without ever
 * echoing raw payload characters or field values in error messages.
 */
export function parseSingleArchiveRecord(
  rawLine: string,
  meta: {
    file: string;
    line: number;
    committedCount: number;
    retainedEvents: readonly DecodedEvent[];
  },
): { kind: "event"; event: DecodedEvent } | { kind: "summary"; summary: ScanJsonlSummaryLine } {
  const byteLength = Buffer.byteLength(rawLine, "utf8");
  const trimmed = rawLine.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const pos = extractSyntaxPosition(err);
    const detail =
      pos !== null ? `invalid JSON syntax near offset ${pos}` : "invalid JSON syntax";
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_JSON",
      detail,
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const valueKind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "NON_OBJECT_RECORD",
      detail: `expected JSON object record, got ${valueKind}`,
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.type === "summary") {
    if (
      typeof obj.eventCount !== "number" ||
      !Number.isInteger(obj.eventCount) ||
      obj.eventCount < 0
    ) {
      throw new MalformedArchiveRecordError({
        file: meta.file,
        line: meta.line,
        byteLength,
        reasonCode: "INVALID_RECORD_SHAPE",
        detail: "invalid or missing integer 'eventCount' on summary record",
        committedCount: meta.committedCount,
        retainedEvents: meta.retainedEvents,
      });
    }
    if (!obj.histogram || typeof obj.histogram !== "object" || Array.isArray(obj.histogram)) {
      throw new MalformedArchiveRecordError({
        file: meta.file,
        line: meta.line,
        byteLength,
        reasonCode: "INVALID_RECORD_SHAPE",
        detail: "invalid or missing object 'histogram' on summary record",
        committedCount: meta.committedCount,
        retainedEvents: meta.retainedEvents,
      });
    }
    return {
      kind: "summary",
      summary: {
        type: "summary",
        eventCount: obj.eventCount,
        histogram: obj.histogram as Record<string, number>,
      },
    };
  }

  if (obj.type !== undefined && obj.type !== "event") {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "unsupported record 'type' discriminator",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (typeof obj.source !== "string" || !VALID_SOURCES.has(obj.source)) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid 'source' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (typeof obj.ledger !== "number" || !Number.isInteger(obj.ledger) || obj.ledger < 0) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid non-negative integer 'ledger' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (typeof obj.contractId !== "string" || obj.contractId.trim().length === 0) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid 'contractId' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (typeof obj.txHash !== "string" || obj.txHash.trim().length === 0) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid 'txHash' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (typeof obj.eventId !== "string" || obj.eventId.trim().length === 0) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid 'eventId' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  if (!obj.payload || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid object 'payload' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  const payloadObj = obj.payload as Record<string, unknown>;
  if (typeof payloadObj.name !== "string" || payloadObj.name.trim().length === 0) {
    throw new MalformedArchiveRecordError({
      file: meta.file,
      line: meta.line,
      byteLength,
      reasonCode: "INVALID_RECORD_SHAPE",
      detail: "missing or invalid 'payload.name' field",
      committedCount: meta.committedCount,
      retainedEvents: meta.retainedEvents,
    });
  }

  const { type: _ignoredType, ...rest } = obj;
  return {
    kind: "event",
    event: rest as unknown as DecodedEvent,
  };
}

/**
 * Parse a JSONL capture with exact 1-based physical line tracking and bounded,
 * payload-free diagnostics.
 */
export function parseScanJsonl(
  jsonl: string,
  options: ParseScanJsonlOptions = {},
): ParsedScanJsonlResult {
  const sourceName = options.sourceName ?? "<jsonl>";
  const retainCommitted = options.retainCommittedOutput === true;
  const rawLines = jsonl.split("\n");
  const events: DecodedEvent[] = [];
  let summary: ScanJsonlSummaryLine | null = null;

  for (let idx = 0; idx < rawLines.length; idx++) {
    const rawLine = (rawLines[idx] ?? "").replace(/\r$/, "");
    if (!rawLine.trim()) continue;

    const lineNumber = idx + 1;
    const record = parseSingleArchiveRecord(rawLine, {
      file: sourceName,
      line: lineNumber,
      committedCount: events.length,
      retainedEvents: retainCommitted ? [...events] : [],
    });

    if (record.kind === "summary") {
      summary = record.summary;
    } else {
      events.push(record.event);
    }
  }

  return { events, summary };
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
