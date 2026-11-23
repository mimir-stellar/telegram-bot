import type { DecodedEvent } from "./decode.js";
import { eventHistogram, scanJsonReplacer } from "./events.js";
import { validateLedgerRange, type LedgerRange } from "./ledger-range.js";

/** Default maximum byte length of a single JSONL record (excluding line ending). */
export const DEFAULT_MAX_JSONL_LINE_BYTES = 64 * 1024; // 64 KiB

/** Default chunk size in bytes when streaming JSONL files from disk. */
export const DEFAULT_JSONL_CHUNK_BYTES = 64 * 1024; // 64 KiB

export const ARCHIVE_SCHEMA_FORMAT = "mimir-event-archive" as const;
export const SCAN_JSONL_SCHEMA_FORMAT = "mimir-scan-jsonl" as const;
export const DEFAULT_ARCHIVE_SCHEMA_VERSION = 1 as const;
export const SUPPORTED_ARCHIVE_READER_VERSIONS: readonly number[] = Object.freeze([1]);
export const SUPPORTED_ARCHIVE_WRITER_VERSIONS: readonly number[] = Object.freeze([1]);

export type ArchiveSchemaErrorCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "INVALID_SCHEMA_VERSION"
  | "INCOMPATIBLE_SCHEMA_FORMAT"
  | "MISSING_SCHEMA_VERSION"
  | "NO_MUTUAL_SCHEMA_VERSION";

export class UnsupportedArchiveSchemaError extends Error {
  readonly code: ArchiveSchemaErrorCode;
  readonly foundVersion: unknown;
  readonly supportedVersions: readonly number[];

  constructor(params: {
    code: ArchiveSchemaErrorCode;
    message: string;
    foundVersion?: unknown;
    supportedVersions?: readonly number[];
  }) {
    super(params.message);
    this.name = "UnsupportedArchiveSchemaError";
    this.code = params.code;
    this.foundVersion = params.foundVersion;
    this.supportedVersions = params.supportedVersions ?? SUPPORTED_ARCHIVE_READER_VERSIONS;
  }
}

export interface ArchiveSchemaCapabilities {
  archiveFormat: typeof ARCHIVE_SCHEMA_FORMAT;
  jsonlFormat: typeof SCAN_JSONL_SCHEMA_FORMAT;
  readerVersions: readonly number[];
  writerVersions: readonly number[];
  defaultWriterVersion: number;
}

export function getSupportedArchiveSchemaVersions(): ArchiveSchemaCapabilities {
  return {
    archiveFormat: ARCHIVE_SCHEMA_FORMAT,
    jsonlFormat: SCAN_JSONL_SCHEMA_FORMAT,
    readerVersions: SUPPORTED_ARCHIVE_READER_VERSIONS,
    writerVersions: SUPPORTED_ARCHIVE_WRITER_VERSIONS,
    defaultWriterVersion: DEFAULT_ARCHIVE_SCHEMA_VERSION,
  };
}

export interface SchemaNegotiationRequest {
  format: string;
  mode: "read" | "write";
  requestedVersion?: unknown;
  peerSupportedVersions?: readonly number[];
  acceptedVersions?: readonly number[];
}

function assertPositiveIntegerVersion(version: unknown, context: string): number {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new UnsupportedArchiveSchemaError({
      code: "INVALID_SCHEMA_VERSION",
      foundVersion: version,
      message: `Invalid schema version in ${context}: expected a positive integer`,
    });
  }
  return version;
}

function supportedVersionsFor(mode: "read" | "write"): readonly number[] {
  return mode === "read"
    ? SUPPORTED_ARCHIVE_READER_VERSIONS
    : SUPPORTED_ARCHIVE_WRITER_VERSIONS;
}

function assertKnownFormat(format: string): void {
  if (format === ARCHIVE_SCHEMA_FORMAT || format === SCAN_JSONL_SCHEMA_FORMAT) return;

  const versionSuffix = /-v(\d+)$/.exec(format);
  if (versionSuffix?.[1] !== undefined) {
    const version = Number(versionSuffix[1]);
    if (!SUPPORTED_ARCHIVE_READER_VERSIONS.includes(version)) {
      throw new UnsupportedArchiveSchemaError({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        foundVersion: version,
        message: `Unsupported archive schema format version v${version}`,
      });
    }
  }
  throw new UnsupportedArchiveSchemaError({
    code: "INCOMPATIBLE_SCHEMA_FORMAT",
    foundVersion: format,
    message: `Incompatible archive schema format "${format}"`,
  });
}

export function negotiateArchiveSchemaVersion(
  request: SchemaNegotiationRequest,
): number {
  assertKnownFormat(request.format);
  const baseSupported = supportedVersionsFor(request.mode);
  let localSupported = baseSupported;

  if (request.acceptedVersions !== undefined) {
    if (!Array.isArray(request.acceptedVersions) || request.acceptedVersions.length === 0) {
      throw new UnsupportedArchiveSchemaError({
        code: "INVALID_SCHEMA_VERSION",
        supportedVersions: baseSupported,
        message: "acceptedVersions must be a non-empty array of supported schema versions",
      });
    }
    for (const version of request.acceptedVersions) {
      const accepted = assertPositiveIntegerVersion(version, "acceptedVersions");
      if (!baseSupported.includes(accepted)) {
        throw new UnsupportedArchiveSchemaError({
          code: "UNSUPPORTED_SCHEMA_VERSION",
          foundVersion: accepted,
          supportedVersions: baseSupported,
          message: `Unsupported accepted schema version v${accepted}`,
        });
      }
    }
    localSupported = [...new Set(request.acceptedVersions)];
  }

  if (request.requestedVersion !== undefined) {
    const requested = assertPositiveIntegerVersion(
      request.requestedVersion,
      `${request.mode} negotiation`,
    );
    if (!localSupported.includes(requested)) {
      throw new UnsupportedArchiveSchemaError({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        foundVersion: requested,
        supportedVersions: localSupported,
        message: `Unsupported ${request.mode} archive schema version v${requested}`,
      });
    }
    if (
      request.peerSupportedVersions !== undefined &&
      !request.peerSupportedVersions.includes(requested)
    ) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        foundVersion: requested,
        supportedVersions: localSupported,
        message: `Peer does not support requested archive schema version v${requested}`,
      });
    }
    return requested;
  }

  if (request.peerSupportedVersions !== undefined) {
    if (
      !Array.isArray(request.peerSupportedVersions) ||
      request.peerSupportedVersions.length === 0
    ) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        supportedVersions: localSupported,
        message: "Peer advertised no supported archive schema versions",
      });
    }
    const peerVersions = request.peerSupportedVersions.map((version) =>
      assertPositiveIntegerVersion(version, "peerSupportedVersions"),
    );
    const common = localSupported.filter((version) => peerVersions.includes(version));
    if (common.length === 0) {
      throw new UnsupportedArchiveSchemaError({
        code: "NO_MUTUAL_SCHEMA_VERSION",
        foundVersion: peerVersions,
        supportedVersions: localSupported,
        message: "No mutually supported archive schema version",
      });
    }
    return Math.max(...common);
  }

  return request.mode === "write"
    ? DEFAULT_ARCHIVE_SCHEMA_VERSION
    : (localSupported[localSupported.length - 1] ?? DEFAULT_ARCHIVE_SCHEMA_VERSION);
}

export interface ScanJsonlSchemaLine {
  type: "schema";
  format: typeof SCAN_JSONL_SCHEMA_FORMAT;
  schemaVersion: number;
}

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

export interface ReadScanJsonlSchemaOptions {
  acceptedVersions?: readonly number[];
  requireExplicitVersion?: boolean;
}

export interface ParsedScanJsonl {
  schemaVersion: number;
  explicitVersionFound: boolean;
  events: DecodedEvent[];
  summary: ScanJsonlSummaryLine | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDecodedEventRecord(value: unknown): value is DecodedEvent {
  if (!isRecord(value) || !isRecord(value.payload)) return false;
  return (
    (value.source === "market" || value.source === "squad") &&
    typeof value.contractId === "string" &&
    typeof value.version === "string" &&
    typeof value.ledger === "number" &&
    typeof value.txHash === "string" &&
    typeof value.at === "number" &&
    typeof value.eventId === "string" &&
    typeof value.eventType === "string"
  );
}

function isScanJsonlSummaryLine(value: unknown): value is ScanJsonlSummaryLine {
  if (!isRecord(value) || value.type !== "summary" || typeof value.eventCount !== "number") {
    return false;
  }
  if (!isRecord(value.histogram)) return false;
  return Object.values(value.histogram).every((count) => typeof count === "number");
}

/**
 * Format decoded events as canonical LF (`\n`)-delimited JSON Lines (NDJSON):
 * one event line per decoded event followed by a final `{ type: "summary" }`
 * line containing the histogram from {@link eventHistogram}, with a trailing
 * `\n` regardless of host operating system.
 */
export function formatScanJsonl(
  events: readonly DecodedEvent[],
  options: FormatScanJsonlOptions = {},
): string {
  const lines: string[] = [];
  if (options.schemaVersion !== undefined) {
    const schemaVersion = negotiateArchiveSchemaVersion({
      format: SCAN_JSONL_SCHEMA_FORMAT,
      mode: "write",
      requestedVersion: options.schemaVersion,
    });
    const schema: ScanJsonlSchemaLine = {
      type: "schema",
      format: SCAN_JSONL_SCHEMA_FORMAT,
      schemaVersion,
    };
    lines.push(JSON.stringify(schema));
  }
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

export function parseScanJsonl(
  input: string,
  options: ReadScanJsonlSchemaOptions = {},
): ParsedScanJsonl {
  const events: DecodedEvent[] = [];
  let summary: ScanJsonlSummaryLine | null = null;
  let explicitVersionFound = false;
  let schemaVersion: number = DEFAULT_ARCHIVE_SCHEMA_VERSION;
  let recordCount = 0;

  for (const [index, rawLine] of input.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;

    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Malformed scan JSONL record at line ${index + 1}`);
    }
    if (!isRecord(record)) {
      throw new Error(`Malformed scan JSONL record at line ${index + 1}`);
    }

    if (recordCount === 0 && record.type === "schema") {
      if (typeof record.format !== "string") {
        throw new UnsupportedArchiveSchemaError({
          code: "INCOMPATIBLE_SCHEMA_FORMAT",
          foundVersion: record.format,
          message: "Scan JSONL schema header must include a format",
        });
      }
      if (record.schemaVersion === undefined) {
        throw new UnsupportedArchiveSchemaError({
          code: "INVALID_SCHEMA_VERSION",
          message: "Scan JSONL schema header must declare a schemaVersion",
        });
      }
      schemaVersion = negotiateArchiveSchemaVersion({
        format: record.format,
        mode: "read",
        requestedVersion: record.schemaVersion,
        acceptedVersions: options.acceptedVersions,
      });
      if (record.format !== SCAN_JSONL_SCHEMA_FORMAT) {
        throw new UnsupportedArchiveSchemaError({
          code: "INCOMPATIBLE_SCHEMA_FORMAT",
          foundVersion: record.format,
          message: `Incompatible scan JSONL schema format "${record.format}"`,
        });
      }
      explicitVersionFound = true;
      recordCount += 1;
      continue;
    }

    if (record.type === "schema") {
      throw new Error(`Unexpected scan JSONL schema record at line ${index + 1}`);
    }
    if (record.type === "event") {
      const { type: _type, ...event } = record;
      if (!isDecodedEventRecord(event)) {
        throw new Error(`Malformed scan JSONL event at line ${index + 1}`);
      }
      events.push(event);
    } else if (record.type === "summary") {
      if (summary !== null || !isScanJsonlSummaryLine(record)) {
        throw new Error(`Malformed scan JSONL summary at line ${index + 1}`);
      }
      summary = record;
    } else {
      throw new Error(`Unknown scan JSONL record type at line ${index + 1}`);
    }
    recordCount += 1;
  }

  if (!explicitVersionFound) {
    schemaVersion = negotiateArchiveSchemaVersion({
      format: SCAN_JSONL_SCHEMA_FORMAT,
      mode: "read",
      requestedVersion: DEFAULT_ARCHIVE_SCHEMA_VERSION,
      acceptedVersions: options.acceptedVersions,
    });
  }

  if (options.requireExplicitVersion && !explicitVersionFound) {
    throw new UnsupportedArchiveSchemaError({
      code: "MISSING_SCHEMA_VERSION",
      message: "Scan JSONL input does not declare an explicit schema version",
    });
  }

  return { schemaVersion, explicitVersionFound, events, summary };
}

export type ArchiveCoverageInput = readonly DecodedEvent[] | string | null | undefined;

export interface ArchiveCoverageOptions {
  range?: LedgerRange;
  filteredRange?: LedgerRange;
  intentionalRange?: LedgerRange;
  retainedRange?: LedgerRange;
  expectedRange?: LedgerRange;
  scope?: LedgerRange;
}

export interface CoverageCaptureSummary {
  events: number;
  invalid: number;
  ledgers: number;
  ledgerMin: number | null;
  ledgerMax: number | null;
}

export interface CoverageSpan {
  firstLedger: number;
  lastLedger: number;
  ledgers: number;
  events: number;
  expected: boolean;
  firstEvents: number;
  secondEvents: number;
}

export interface CoverageCountMismatch {
  firstLedger: number;
  lastLedger: number;
  ledgers: number;
  firstEvents: number;
  secondEvents: number;
}

export type CoverageFinding = "missing" | "extra" | "count-mismatch";

export interface ArchiveCoverageTotals {
  firstEvents: number;
  secondEvents: number;
  missingEvents: number;
  expectedEvents: number;
  unexpectedEvents: number;
  filteredEvents: number;
  overlapFirstEvents: number;
  overlapSecondEvents: number;
  extraEvents: number;
}

export interface ArchiveCoverageReport {
  version: 1;
  ok: boolean;
  findings: CoverageFinding[];
  range: LedgerRange | null;
  expectedRange: LedgerRange | null;
  first: CoverageCaptureSummary;
  second: CoverageCaptureSummary;
  missing: CoverageSpan[];
  filtered: CoverageSpan[];
  incomplete: CoverageSpan[];
  overlap: CoverageSpan[];
  extra: CoverageSpan[];
  countMismatches: CoverageCountMismatch[];
  totals: ArchiveCoverageTotals;
}

function isLedgerRange(value: unknown): value is LedgerRange {
  return (
    typeof value === "object" &&
    value !== null &&
    "firstLedger" in value &&
    "lastLedger" in value
  );
}

interface NormalizedCoverageOptions {
  filter: LedgerRange | null;
  expected: LedgerRange | null;
}

function normalizeCoverageOptions(
  options: ArchiveCoverageOptions | LedgerRange | null | undefined,
): NormalizedCoverageOptions {
  const opts: ArchiveCoverageOptions = isLedgerRange(options)
    ? { range: options }
    : options ?? {};
  const filter =
    opts.range ?? opts.filteredRange ?? opts.intentionalRange ?? opts.retainedRange ?? null;
  const expected = opts.expectedRange ?? opts.scope ?? null;
  if (filter) validateLedgerRange(filter);
  if (expected) validateLedgerRange(expected);
  return {
    filter: filter ? { ...filter } : null,
    expected: expected ? { ...expected } : null,
  };
}

function isEventRecord(parsed: unknown): parsed is DecodedEvent {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  return record.type === "event" || record.type === undefined;
}

function parseCoverageEvents(input: ArchiveCoverageInput): readonly DecodedEvent[] {
  if (input == null) return [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new MalformedScanJsonlRecordError(1);
      }
      if (!Array.isArray(parsed) || !parsed.every(isEventRecord)) {
        throw new MalformedScanJsonlRecordError(1);
      }
      return parsed;
    }

    const events: DecodedEvent[] = [];
    const lines = input.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new MalformedScanJsonlRecordError(index + 1);
      }
      const record = parsed as Record<string, unknown> | null;
      if (record?.type === "summary") continue;
      if (!isEventRecord(parsed)) throw new MalformedScanJsonlRecordError(index + 1);
      events.push(parsed);
    }
    return events;
  }
  if (Array.isArray(input)) return input;
  const candidate = input as { events?: unknown };
  if (Array.isArray(candidate.events)) return candidate.events as DecodedEvent[];
  return [];
}

interface CoveragePartition {
  summary: CoverageCaptureSummary;
  byLedger: Map<number, number>;
}

function partitionCoverage(events: readonly DecodedEvent[]): CoveragePartition {
  const byLedger = new Map<number, number>();
  let invalid = 0;
  let ledgerMin: number | null = null;
  let ledgerMax: number | null = null;

  for (const event of events) {
    const ledger =
      typeof event === "object" && event !== null
        ? (event as { ledger?: unknown }).ledger
        : undefined;
    if (typeof ledger !== "number" || !Number.isSafeInteger(ledger)) {
      invalid += 1;
      continue;
    }
    byLedger.set(ledger, (byLedger.get(ledger) ?? 0) + 1);
    if (ledgerMin === null || ledger < ledgerMin) ledgerMin = ledger;
    if (ledgerMax === null || ledger > ledgerMax) ledgerMax = ledger;
  }

  return {
    summary: { events: [...byLedger.values()].reduce((a, b) => a + b, 0), invalid, ledgers: byLedger.size, ledgerMin, ledgerMax },
    byLedger,
  };
}