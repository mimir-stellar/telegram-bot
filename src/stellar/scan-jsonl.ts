import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { validateLedgerRange, type LedgerRange } from "./ledger-range.js";

export interface ScanJsonlEventLine extends DecodedEvent {
  type: "event";
}

export interface ScanJsonlSummaryLine {
  type: "summary";
  eventCount: number;
  histogram: Record<string, number>;
}

export interface PrivacyFinding {
  kind: "private_chat_id" | "secret_like_value";
  line: number;
  path: string;
  preview: string;
}

export interface PrivacyReviewReport {
  type: "privacy_review";
  findingCount: number;
  findings: PrivacyFinding[];
}

const PRIVATE_CHAT_KEYS = new Set(["chatId", "chat_id", "telegramChatId", "userId", "user_id"]);

const SECRET_PATTERNS: RegExp[] = [
  /\bS[A-Z2-7]{55}\b/,
  /\b(?:sk|secret|token|api[_-]?key)[=:]\s*[A-Za-z0-9_\-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}/,
  /\b\d{8,12}:[A-Za-z0-9_\-]{30,}\b/,
];

function previewOf(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : "***";
}

function walk(
  value: unknown,
  path: string,
  line: number,
  out: PrivacyFinding[],
): void {
  if (typeof value === "string") {
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(value);
      if (match) {
        out.push({ kind: "secret_like_value", line, path, preview: previewOf(match[0]) });
        break;
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, line, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (PRIVATE_CHAT_KEYS.has(key) && (typeof child === "string" || typeof child === "number")) {
        out.push({ kind: "private_chat_id", line, path: childPath, preview: previewOf(String(child)) });
      }
      walk(child, childPath, line, out);
    }
  }
}

/**
 * Deterministically scan JSONL archive text for private chat identifiers and
 * secret-shaped values. Performs no network I/O. Findings are ordered by
 * line number, then discovery order within each line.
 */
export function reviewJsonlPrivacy(jsonl: string): PrivacyReviewReport {
  const findings: PrivacyFinding[] = [];
  const lines = jsonl.split("\n");
  lines.forEach((raw, index) => {
    const text = raw.trim();
    if (text.length === 0) return;
    const lineNo = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      walk(text, "", lineNo, findings);
      return;
    }
    walk(parsed, "", lineNo, findings);
  });
  return { type: "privacy_review", findingCount: findings.length, findings };
}

/** Result of compacting a canonical JSONL scan export to an inclusive ledger range. */
export interface CompactScanJsonlResult {
  /** Re-serialized canonical LF JSONL: retained event lines plus one summary line. */
  jsonl: string;
  /** Events retained because their ledger fell inside the requested range. */
  retained: number;
  /** Events dropped because their ledger fell outside the requested range. */
  dropped: number;
}

/** Error thrown when a JSONL export contains a record that is not event or summary. */
export class MalformedScanJsonlRecordError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number) {
    super(`Malformed JSONL record at line ${lineNumber}`);
    this.name = "MalformedScanJsonlRecordError";
    this.lineNumber = lineNumber;
  }
}

/**
 * Format decoded events as canonical LF (`\n`)-delimited JSON Lines (NDJSON):
 * one event line per decoded event followed by a final `{ type: "summary" }`
 * line containing the histogram from {@link eventHistogram}, with a trailing
 * `\n` regardless of host operating system.
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

/**
 * Compact a canonical JSONL scan export to an inclusive ledger range.
 *
 * Retains only `{ type: "event" }` records whose `ledger` is within
 * `[firstLedger, lastLedger]`, then rebuilds the trailing `{ type: "summary" }`
 * metadata (`eventCount` and histogram) from the retained events. Any existing
 * summary line is replaced, so a stale summary can never survive compaction.
 * Output is canonical LF JSONL with a single trailing newline.
 *
 * A malformed or unrecognized record aborts the compaction by throwing
 * {@link MalformedScanJsonlRecordError}; input is never silently dropped.
 *
 * @throws {RangeError} when the range is invalid (see `validateLedgerRange`).
 * @throws {MalformedScanJsonlRecordError} on a non-JSON, non-event, or
 * ledger-less record.
 */
export function compactScanJsonl(
  input: string,
  range: LedgerRange,
): CompactScanJsonlResult {
  validateLedgerRange(range);
  const { firstLedger, lastLedger } = range;

  const retainedEvents: DecodedEvent[] = [];
  let dropped = 0;

  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new MalformedScanJsonlRecordError(index + 1);
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MalformedScanJsonlRecordError(index + 1);
    }

    const record = parsed as Record<string, unknown>;
    if (record.type === "summary") {
      continue; // rebuilt from the retained events below
    }
    if (record.type !== "event") {
      throw new MalformedScanJsonlRecordError(index + 1);
    }

    const ledger = record.ledger;
    if (typeof ledger !== "number" || !Number.isSafeInteger(ledger)) {
      throw new MalformedScanJsonlRecordError(index + 1);
    }

    if (ledger >= firstLedger && ledger <= lastLedger) {
      retainedEvents.push(parsed as DecodedEvent);
    } else {
      dropped += 1;
    }
  }

  return {
    jsonl: formatScanJsonl(retainedEvents),
    retained: retainedEvents.length,
    dropped,
  };
}