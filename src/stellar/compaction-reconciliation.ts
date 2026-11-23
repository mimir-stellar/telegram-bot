import type { DecodedEvent } from "./decode.js";
import { validateLedgerRange, type LedgerRange } from "./ledger-range.js";
import { resolutionLatency, type LatencyGroup, type ResolutionLatencyReport } from "./resolution-latency.js";
import { volumeSeries, type VolumeBucketUnit, type VolumeSeriesResult } from "./volume-series.js";

/**
 * Compare the analytical aggregates (volume series and resolution latency)
 * derived from an event capture before and after archive compaction.
 *
 * Two failure classes are kept apart:
 *
 * - **Range loss**: ledgers that carried events before compaction and carry
 *   none afterwards. Each lost run is reported with its inclusive bounds and
 *   event count. When the compaction `range` is supplied, a lost run outside
 *   that window is marked `expected` (compaction was asked to drop it); a run
 *   inside the window is unexpected and fails the reconciliation. Ledgers that
 *   only appear after compaction are reported as range gain.
 * - **Arithmetic mismatch**: aggregate values that differ when both reducers
 *   run over the ledgers present on *both* sides. Because range loss is removed
 *   from this comparison first, a dropped ledger never shows up as an
 *   arithmetic mismatch, and an altered amount never shows up as range loss.
 *
 * The function is pure: no I/O, no clock, no randomness. The same inputs
 * always produce a deep-equal report and a byte-identical rendering.
 */

export interface CompactionReconciliationOptions {
  /** Volume bucket width used for the volume comparison. Defaults to `"day"`. */
  bucket?: VolumeBucketUnit;
  /**
   * The inclusive ledger range the compaction was asked to retain. When set,
   * ledgers lost outside it are expected; ledgers lost inside it are not.
   * When omitted, every lost ledger is unexpected.
   */
  range?: LedgerRange;
}

export interface ReconciliationSide {
  /** Events with a safe-integer ledger that took part in the comparison. */
  events: number;
  /** Records skipped because they are not objects or have no safe-integer ledger. */
  invalid: number;
  /** Lowest ledger seen, or `null` when there are no events. */
  ledgerMin: number | null;
  /** Highest ledger seen, or `null` when there are no events. */
  ledgerMax: number | null;
}

export interface LedgerSpan {
  /** Inclusive first ledger of the run. */
  firstLedger: number;
  /** Inclusive last ledger of the run. */
  lastLedger: number;
  /** Distinct ledgers with events inside the run. */
  ledgers: number;
  /** Events carried by those ledgers. */
  events: number;
  /** `true` when the run lies outside the requested compaction range. */
  expected: boolean;
}

export interface RangeLossImpact {
  /** Challenge stake carried by events on lost ledgers (decimal string). */
  challengeStake: string;
  /** Squad deposits carried by events on lost ledgers (decimal string). */
  squadDeposit: string;
  /** Paired (resolved + cancelled) claims whose latency can no longer be derived. */
  pairedClaims: number;
}

export interface RangeLossSection {
  /** Ledger runs present before compaction and absent after, ascending. */
  lost: LedgerSpan[];
  /** Ledger runs present only after compaction, ascending (always unexpected). */
  gained: LedgerSpan[];
  /** Events on lost runs that fall outside the requested range. */
  expectedEvents: number;
  /** Events on lost runs inside the requested range (or all, without a range). */
  unexpectedEvents: number;
  /** Aggregate value that disappears with the lost ledgers (expected and unexpected). */
  impact: RangeLossImpact;
}

export interface AggregateMismatch {
  reducer: "volume" | "latency";
  /** Stable key: `total`, an ISO bucket start, `resolved`/`cancelled`, or `claim:<id>`. */
  key: string;
  metric: string;
  before: string;
  after: string;
  /** `after - before` for numeric values, `"n/a"` otherwise. */
  delta: string;
}

export type ReconciliationFinding = "range-loss" | "range-gain" | "arithmetic-mismatch";

export interface CompactionReconciliationReport {
  version: 1;
  /** `true` when there is no unexpected range loss, no range gain and no mismatch. */
  ok: boolean;
  /** Failure classes present, in fixed order. Empty when `ok`. */
  findings: ReconciliationFinding[];
  bucket: VolumeBucketUnit;
  range: LedgerRange | null;
  before: ReconciliationSide;
  after: ReconciliationSide;
  rangeLoss: RangeLossSection;
  /** Differences over the ledgers present on both sides, in stable order. */
  mismatches: AggregateMismatch[];
}

interface Partitioned {
  side: ReconciliationSide;
  events: DecodedEvent[];
  byLedger: Map<number, number>;
}

function partition(events: readonly DecodedEvent[] | null | undefined): Partitioned {
  const valid: DecodedEvent[] = [];
  const byLedger = new Map<number, number>();
  let invalid = 0;
  let ledgerMin: number | null = null;
  let ledgerMax: number | null = null;

  for (const event of events ?? []) {
    const ledger = event && typeof event === "object" ? (event as { ledger?: unknown }).ledger : undefined;
    if (typeof ledger !== "number" || !Number.isSafeInteger(ledger)) {
      invalid += 1;
      continue;
    }
    valid.push(event);
    byLedger.set(ledger, (byLedger.get(ledger) ?? 0) + 1);
    if (ledgerMin === null || ledger < ledgerMin) ledgerMin = ledger;
    if (ledgerMax === null || ledger > ledgerMax) ledgerMax = ledger;
  }

  return { side: { events: valid.length, invalid, ledgerMin, ledgerMax }, events: valid, byLedger };
}

/** Group sorted ledgers missing from `other` into maximal runs of adjacent entries in `source`. */
function missingSpans(
  source: Map<number, number>,
  other: Map<number, number>,
  isExpected: (ledger: number) => boolean,
): LedgerSpan[] {
  const ledgers = [...source.keys()].sort((a, b) => a - b);
  const spans: LedgerSpan[] = [];
  let current: LedgerSpan | null = null;

  for (const ledger of ledgers) {
    if (other.has(ledger)) {
      current = null;
      continue;
    }
    const expected = isExpected(ledger);
    if (current && current.expected === expected) {
      current.lastLedger = ledger;
      current.ledgers += 1;
      current.events += source.get(ledger)!;
    } else {
      current = { firstLedger: ledger, lastLedger: ledger, ledgers: 1, events: source.get(ledger)!, expected };
      spans.push(current);
    }
  }
  return spans;
}

function bigDelta(before: bigint, after: bigint): string {
  const d = after - before;
  return d > 0n ? `+${d}` : d.toString();
}

function numDelta(before: number, after: number): string {
  const d = after - before;
  return d > 0 ? `+${d}` : String(d);
}

function pushNum(
  out: AggregateMismatch[],
  reducer: AggregateMismatch["reducer"],
  key: string,
  metric: string,
  before: number,
  after: number,
): void {
  if (before !== after) {
    out.push({ reducer, key, metric, before: String(before), after: String(after), delta: numDelta(before, after) });
  }
}

function pushBig(
  out: AggregateMismatch[],
  key: string,
  metric: string,
  before: bigint,
  after: bigint,
): void {
  if (before !== after) {
    out.push({
      reducer: "volume",
      key,
      metric,
      before: before.toString(),
      after: after.toString(),
      delta: bigDelta(before, after),
    });
  }
}

function compareVolume(before: VolumeSeriesResult, after: VolumeSeriesResult): AggregateMismatch[] {
  const out: AggregateMismatch[] = [];
  pushBig(out, "total", "challengeStake", BigInt(before.totalChallengeStake), BigInt(after.totalChallengeStake));
  pushBig(out, "total", "squadDeposit", BigInt(before.totalSquadDeposit), BigInt(after.totalSquadDeposit));
  pushNum(out, "volume", "total", "processedEvents", before.processedEvents, after.processedEvents);
  pushNum(out, "volume", "total", "skippedWithoutAt", before.skippedWithoutAt, after.skippedWithoutAt);

  const b = new Map(before.buckets.map((bucket) => [bucket.startAt, bucket]));
  const a = new Map(after.buckets.map((bucket) => [bucket.startAt, bucket]));
  const starts = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x - y);
  for (const start of starts) {
    const key = new Date(start * 1000).toISOString();
    const x = b.get(start);
    const y = a.get(start);
    pushBig(out, key, "challengeStake", x?.challengeStake ?? 0n, y?.challengeStake ?? 0n);
    pushBig(out, key, "squadDeposit", x?.squadDeposit ?? 0n, y?.squadDeposit ?? 0n);
    pushNum(out, "volume", key, "challengeCount", x?.challengeCount ?? 0, y?.challengeCount ?? 0);
    pushNum(out, "volume", key, "depositCount", x?.depositCount ?? 0, y?.depositCount ?? 0);
    pushNum(out, "volume", key, "eventCount", x?.eventCount ?? 0, y?.eventCount ?? 0);
  }
  return out;
}

function compareLatencyGroup(
  out: AggregateMismatch[],
  name: "resolved" | "cancelled",
  before: LatencyGroup,
  after: LatencyGroup,
): void {
  pushNum(out, "latency", name, "claims", before.claims.length, after.claims.length);
  for (const stat of ["p50", "p90", "max"] as const) {
    for (const unit of ["seconds", "ledgers"] as const) {
      const x = before.summary?.[stat][unit];
      const y = after.summary?.[stat][unit];
      if (x === undefined && y === undefined) continue;
      if (x === undefined || y === undefined) {
        out.push({
          reducer: "latency",
          key: name,
          metric: `${stat}.${unit}`,
          before: x === undefined ? "none" : String(x),
          after: y === undefined ? "none" : String(y),
          delta: "n/a",
        });
        continue;
      }
      pushNum(out, "latency", name, `${stat}.${unit}`, x, y);
    }
  }
}

function compareLatency(before: ResolutionLatencyReport, after: ResolutionLatencyReport): AggregateMismatch[] {
  const out: AggregateMismatch[] = [];
  compareLatencyGroup(out, "resolved", before.resolved, after.resolved);
  compareLatencyGroup(out, "cancelled", before.cancelled, after.cancelled);
  pushNum(out, "latency", "total", "excludedCount", before.excludedCount, after.excludedCount);

  type Entry = { outcome: string; seconds: number; ledgers: number };
  const index = (report: ResolutionLatencyReport): Map<number, Entry> => {
    const map = new Map<number, Entry>();
    for (const c of report.resolved.claims) map.set(c.claimId, { outcome: "resolved", ...c.duration });
    for (const c of report.cancelled.claims) map.set(c.claimId, { outcome: "cancelled", ...c.duration });
    return map;
  };
  const b = index(before);
  const a = index(after);
  const ids = [...new Set([...b.keys(), ...a.keys()])].sort((x, y) => x - y);
  for (const id of ids) {
    const key = `claim:${id}`;
    const x = b.get(id);
    const y = a.get(id);
    const xo = x?.outcome ?? "unpaired";
    const yo = y?.outcome ?? "unpaired";
    if (xo !== yo) {
      out.push({ reducer: "latency", key, metric: "outcome", before: xo, after: yo, delta: "n/a" });
      continue;
    }
    if (x && y) {
      pushNum(out, "latency", key, "seconds", x.seconds, y.seconds);
      pushNum(out, "latency", key, "ledgers", x.ledgers, y.ledgers);
    }
  }
  return out;
}

function pairedClaims(report: ResolutionLatencyReport): number {
  return report.resolved.claims.length + report.cancelled.claims.length;
}

/**
 * Build a deterministic reconciliation report comparing the volume and
 * latency aggregates of an event capture before and after compaction.
 *
 * @throws {RangeError} when `options.range` is supplied and invalid.
 * @throws {Error} when `options.bucket` is not `"hour"` or `"day"`.
 */
export function reconcileCompaction(
  beforeEvents: readonly DecodedEvent[] | null | undefined,
  afterEvents: readonly DecodedEvent[] | null | undefined,
  options: CompactionReconciliationOptions = {},
): CompactionReconciliationReport {
  const bucket = options.bucket ?? "day";
  const range = options.range ? { firstLedger: options.range.firstLedger, lastLedger: options.range.lastLedger } : null;
  if (range) validateLedgerRange(range);
  // Validate the bucket up front with the reducer's own error.
  volumeSeries([], { bucket });

  const before = partition(beforeEvents);
  const after = partition(afterEvents);

  const outsideRange = (ledger: number): boolean =>
    range !== null && (ledger < range.firstLedger || ledger > range.lastLedger);

  const lost = missingSpans(before.byLedger, after.byLedger, outsideRange);
  const gained = missingSpans(after.byLedger, before.byLedger, () => false);

  // Comparable sets: only ledgers present on both sides.
  const beforeShared = before.events.filter((e) => after.byLedger.has(e.ledger));
  const afterShared = after.events.filter((e) => before.byLedger.has(e.ledger));

  const fullVolume = volumeSeries(before.events, { bucket });
  const sharedVolume = volumeSeries(beforeShared, { bucket });
  const fullLatency = resolutionLatency(before.events);
  const sharedLatency = resolutionLatency(beforeShared);

  const mismatches = [
    ...compareVolume(sharedVolume, volumeSeries(afterShared, { bucket })),
    ...compareLatency(sharedLatency, resolutionLatency(afterShared)),
  ];

  let expectedEvents = 0;
  let unexpectedEvents = 0;
  for (const span of lost) {
    if (span.expected) expectedEvents += span.events;
    else unexpectedEvents += span.events;
  }

  const findings: ReconciliationFinding[] = [];
  if (unexpectedEvents > 0) findings.push("range-loss");
  if (gained.length > 0) findings.push("range-gain");
  if (mismatches.length > 0) findings.push("arithmetic-mismatch");

  return {
    version: 1,
    ok: findings.length === 0,
    findings,
    bucket,
    range,
    before: before.side,
    after: after.side,
    rangeLoss: {
      lost,
      gained,
      expectedEvents,
      unexpectedEvents,
      impact: {
        challengeStake: (BigInt(fullVolume.totalChallengeStake) - BigInt(sharedVolume.totalChallengeStake)).toString(),
        squadDeposit: (BigInt(fullVolume.totalSquadDeposit) - BigInt(sharedVolume.totalSquadDeposit)).toString(),
        pairedClaims: pairedClaims(fullLatency) - pairedClaims(sharedLatency),
      },
    },
    mismatches,
  };
}

function ledgerBounds(side: ReconciliationSide): string {
  return side.ledgerMin === null ? "no ledgers" : `ledgers ${side.ledgerMin}..${side.ledgerMax}`;
}

function spanLine(span: LedgerSpan): string {
  const tag = span.expected ? "expected (outside compaction range)" : "UNEXPECTED";
  return `  ${span.firstLedger}..${span.lastLedger}  ledgers=${span.ledgers} events=${span.events}  ${tag}`;
}

/**
 * Render a report as plain LF-delimited text with a trailing newline. The
 * output contains no clock or environment data, so it is byte-identical for
 * the same report.
 */
export function renderReconciliationReport(report: CompactionReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`Compaction reconciliation report (v${report.version})`);
  lines.push(`status: ${report.ok ? "OK" : `FAIL (${report.findings.join(", ")})`}`);
  lines.push(`bucket: ${report.bucket}`);
  lines.push(
    `compaction range: ${report.range ? `${report.range.firstLedger}..${report.range.lastLedger}` : "not given (all loss unexpected)"}`,
  );
  lines.push(`before: events=${report.before.events} invalid=${report.before.invalid} ${ledgerBounds(report.before)}`);
  lines.push(`after:  events=${report.after.events} invalid=${report.after.invalid} ${ledgerBounds(report.after)}`);
  lines.push("");

  const rl = report.rangeLoss;
  lines.push(
    `Range loss: ${rl.lost.length} span(s), expected events=${rl.expectedEvents}, unexpected events=${rl.unexpectedEvents}`,
  );
  for (const span of rl.lost) lines.push(spanLine(span));
  lines.push(
    `  impact: challengeStake=${rl.impact.challengeStake} squadDeposit=${rl.impact.squadDeposit} pairedClaims=${rl.impact.pairedClaims}`,
  );
  lines.push(`Range gain: ${rl.gained.length} span(s)`);
  for (const span of rl.gained) lines.push(spanLine(span));
  lines.push("");

  lines.push(`Arithmetic mismatches (shared ledgers only): ${report.mismatches.length}`);
  for (const m of report.mismatches) {
    lines.push(`  ${m.reducer} ${m.key} ${m.metric}: before=${m.before} after=${m.after} delta=${m.delta}`);
  }
  return lines.join("\n") + "\n";
}
