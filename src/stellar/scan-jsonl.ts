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

export interface FormatScanJsonlOptions {
  schemaVersion?: number;
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

function collectSpans(
  source: Map<number, number>,
  other: Map<number, number> | null,
  requireOtherPresence: boolean,
  classify: (ledger: number) => boolean,
): CoverageSpan[] {
  const spans: CoverageSpan[] = [];
  let current: CoverageSpan | null = null;
  for (const ledger of [...source.keys()].sort((a, b) => a - b)) {
    if (other && other.has(ledger) !== requireOtherPresence) {
      current = null;
      continue;
    }
    const expected = classify(ledger);
    const firstEvents = source.get(ledger) ?? 0;
    const secondEvents = other?.get(ledger) ?? 0;
    if (current && current.expected === expected) {
      current.lastLedger = ledger;
      current.ledgers += 1;
      current.events += firstEvents;
      current.firstEvents += firstEvents;
      current.secondEvents += secondEvents;
    } else {
      current = {
        firstLedger: ledger,
        lastLedger: ledger,
        ledgers: 1,
        events: firstEvents,
        expected,
        firstEvents,
        secondEvents,
      };
      spans.push(current);
    }
  }
  return spans;
}

function collectCountMismatches(
  first: Map<number, number>,
  second: Map<number, number>,
): CoverageCountMismatch[] {
  const ledgers = [...first.keys()]
    .sort((a, b) => a - b)
    .filter((ledger) => second.has(ledger) && second.get(ledger) !== first.get(ledger));
  const mismatches: CoverageCountMismatch[] = [];
  let current: CoverageCountMismatch | null = null;
  for (const ledger of ledgers) {
    const firstEvents = first.get(ledger) ?? 0;
    const secondEvents = second.get(ledger) ?? 0;
    if (current) {
      current.lastLedger = ledger;
      current.ledgers += 1;
      current.firstEvents += firstEvents;
      current.secondEvents += secondEvents;
    } else {
      current = { firstLedger: ledger, lastLedger: ledger, ledgers: 1, firstEvents, secondEvents };
      mismatches.push(current);
    }
  }
  return mismatches;
}

function withAliases<T extends object>(target: T, aliases: Record<string, () => unknown>): T {
  for (const [name, get] of Object.entries(aliases)) {
    Object.defineProperty(target, name, { get, enumerable: false, configurable: true });
  }
  return target;
}

function spanWithAliases(span: CoverageSpan): CoverageSpan {
  return withAliases(span, {
    intentional: () => span.expected,
    cause: () => (span.expected ? "filtered" : "incomplete"),
  });
}

function extraSpanWithAliases(span: CoverageSpan): CoverageSpan {
  return spanWithAliases({
    ...span,
    events: span.firstEvents,
    firstEvents: span.secondEvents,
    secondEvents: span.firstEvents,
  });
}

function sumEvents(spans: readonly CoverageSpan[]): number {
  return spans.reduce((sum, span) => sum + span.events, 0);
}

export function compareLedgerCoverage(
  firstInput: ArchiveCoverageInput,
  secondInput: ArchiveCoverageInput,
  options: ArchiveCoverageOptions | LedgerRange = {},
): ArchiveCoverageReport {
  const { filter, expected } = normalizeCoverageOptions(options);
  const first = partitionCoverage(parseCoverageEvents(firstInput));
  const second = partitionCoverage(parseCoverageEvents(secondInput));

  const inRange = (ledger: number, range: LedgerRange | null): boolean =>
    range === null || (ledger >= range.firstLedger && ledger <= range.lastLedger);
  const intentional = (ledger: number): boolean =>
    !inRange(ledger, filter) || !inRange(ledger, expected);

  const missing = collectSpans(first.byLedger, second.byLedger, false, intentional).map(spanWithAliases);
  const filtered = missing.filter((span) => span.expected);
  const incomplete = missing.filter((span) => !span.expected);
  const overlap = collectSpans(first.byLedger, second.byLedger, true, () => true).map(spanWithAliases);
  const extra = collectSpans(second.byLedger, first.byLedger, false, intentional).map(extraSpanWithAliases);
  const countMismatches = collectCountMismatches(first.byLedger, second.byLedger);

  const findings: CoverageFinding[] = [];
  if (incomplete.length > 0) findings.push("missing");
  if (extra.some((span) => !span.expected)) findings.push("extra");
  if (countMismatches.length > 0) findings.push("count-mismatch");

  const totals: ArchiveCoverageTotals = {
    firstEvents: first.summary.events,
    secondEvents: second.summary.events,
    missingEvents: sumEvents(missing),
    expectedEvents: sumEvents(filtered),
    unexpectedEvents: sumEvents(incomplete),
    filteredEvents: sumEvents(filtered),
    overlapFirstEvents: overlap.reduce((sum, span) => sum + span.firstEvents, 0),
    overlapSecondEvents: overlap.reduce((sum, span) => sum + span.secondEvents, 0),
    extraEvents: sumEvents(extra),
  };

  const report: ArchiveCoverageReport = {
    version: 1,
    ok: findings.length === 0,
    findings,
    range: filter,
    expectedRange: expected,
    first: first.summary,
    second: second.summary,
    missing,
    filtered,
    incomplete,
    overlap,
    extra,
    countMismatches,
    totals,
  };

  return withAliases(report, {
    before: () => report.first,
    after: () => report.second,
    lost: () => report.missing,
    gained: () => report.extra,
    intentional: () => report.filtered,
    counts: () => report.totals,
    missingRanges: () => report.missing,
    overlapRanges: () => report.overlap,
    expectedEvents: () => report.totals.expectedEvents,
    unexpectedEvents: () => report.totals.unexpectedEvents,
    missingEvents: () => report.totals.missingEvents,
    extraEvents: () => report.totals.extraEvents,
    overlapFirstEvents: () => report.totals.overlapFirstEvents,
    overlapSecondEvents: () => report.totals.overlapSecondEvents,
    firstEvents: () => report.totals.firstEvents,
    secondEvents: () => report.totals.secondEvents,
  });
}

export const compareScanJsonlCoverage = compareLedgerCoverage;
export const compareArchiveCoverage = compareLedgerCoverage;

function coverageBounds(range: LedgerRange | null): string {
  return range === null ? "none (all missing ledgers are incomplete)" : `${range.firstLedger}..${range.lastLedger}`;
}

function coverageSpanLine(span: CoverageSpan): string {
  return `  ${span.firstLedger}..${span.lastLedger}  ledgers=${span.ledgers} events=${span.events}  ${span.expected ? "filtered (intentional)" : "INCOMPLETE"}`;
}

function coverageSideLine(name: string, side: CoverageCaptureSummary): string {
  const bounds = side.ledgerMin === null ? "no ledgers" : `ledgers ${side.ledgerMin}..${side.ledgerMax}`;
  return `${name}: events=${side.events} invalid=${side.invalid} ledgers=${side.ledgers} ${bounds}`;
}

export function formatArchiveCoverageReport(report: ArchiveCoverageReport): string {
  const lines: string[] = [];
  lines.push(`Archive coverage report (v${report.version})`);
  lines.push(`status: ${report.ok ? "OK" : `FAIL (${report.findings.join(", ")})`}`);
  lines.push(`filter range: ${coverageBounds(report.range)}`);
  lines.push(
    `expected range: ${report.expectedRange === null ? "not given" : `${report.expectedRange.firstLedger}..${report.expectedRange.lastLedger}`}`,
  );
  lines.push(coverageSideLine("first", report.first));
  lines.push(coverageSideLine("second", report.second));
  lines.push("");
  lines.push(
    `Missing: ${report.missing.length} span(s), filtered events=${report.totals.expectedEvents}, incomplete events=${report.totals.unexpectedEvents}`,
  );
  for (const span of report.missing) lines.push(coverageSpanLine(span));
  lines.push(`Filtered (intentional): ${report.filtered.length} span(s), events=${report.totals.filteredEvents}`);
  for (const span of report.filtered) lines.push(coverageSpanLine(span));
  lines.push(
    `Overlap: ${report.overlap.length} span(s), first events=${report.totals.overlapFirstEvents}, second events=${report.totals.overlapSecondEvents}`,
  );
  for (const span of report.overlap) {
    lines.push(
      `  ${span.firstLedger}..${span.lastLedger}  ledgers=${span.ledgers} first=${span.firstEvents} second=${span.secondEvents} events=${span.events}`,
    );
  }
  lines.push(`Extra: ${report.extra.length} span(s), events=${report.totals.extraEvents}`);
  for (const span of report.extra) lines.push(coverageSpanLine(span));
  lines.push(`Count mismatches: ${report.countMismatches.length}`);
  for (const mismatch of report.countMismatches) {
    lines.push(
      `  ${mismatch.firstLedger}..${mismatch.lastLedger}  ledgers=${mismatch.ledgers} first=${mismatch.firstEvents} second=${mismatch.secondEvents}`,
    );
  }
  return lines.join("\n") + "\n";
}

export const renderArchiveCoverageReport = formatArchiveCoverageReport;
export const formatCoverageReport = formatArchiveCoverageReport;
export const renderCoverageReport = formatArchiveCoverageReport;
