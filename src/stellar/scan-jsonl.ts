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
