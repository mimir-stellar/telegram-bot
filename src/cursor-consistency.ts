/*
 * Read-only cursor consistency check against a scan archive.
 *
 * Compares the persisted cursor (`CURSOR_FILE`, schema v1) with the decoded
 * events an operator captured in an event archive (`createEventArchive`) or a
 * `npm run scan -- --jsonl` export, and reports where the two disagree:
 *
 *  - target identity: archived records for a source the cursor does not
 *    track, a source whose records carry more than one contract id, or a
 *    contract id other than the one configured for that source;
 *  - observed ledger ranges: the cursor's last-event ledger past the end of
 *    the archive, archived events beyond the cursor's resume position,
 *    processed event ids (the cursor's dedup window) missing from the archived
 *    range, and floor-rewind gaps the cursor itself recorded;
 *  - contradictions inside the archive: an event id whose packed ledger
 *    disagrees with the record's ledger, the same event id archived with
 *    different identities, and exact duplicates or out-of-order records.
 *
 * Everything here is a pure function of its inputs. It never advances,
 * rewinds, or writes a cursor and never touches the archive: an operator
 * decides what to do with the report. Comparisons are at ledger granularity
 * because that is what both sides record; the chain stays the source of
 * truth, so a clean report is evidence of agreement, not a delivery guarantee.
 */

import type { CursorFile } from "./poller.js";
import { eventCursorLedger } from "./stellar/events.js";

export type ConsistencySeverity = "error" | "warning";

/** Bounded, stable set of finding kinds (also the JSON output vocabulary). */
export type ConsistencyFindingKind =
  // Identity
  | "malformed-record"
  | "archive-target-untracked"
  | "cursor-target-unarchived"
  | "mixed-contract-ids"
  | "contract-mismatch"
  // Archive contradictions / overlaps
  | "event-ledger-mismatch"
  | "conflicting-duplicate"
  | "duplicate-event"
  | "out-of-order"
  // Cursor vs archive ledger ranges
  | "cursor-ledger-contradiction"
  | "cursor-unreadable"
  | "cursor-unpositioned"
  | "archive-behind-cursor"
  | "archive-beyond-cursor"
  | "processed-events-missing"
  | "rewind-pending"
  | "recorded-gap";

const SEVERITY: Record<ConsistencyFindingKind, ConsistencySeverity> = {
  "malformed-record": "error",
  "archive-target-untracked": "warning",
  "cursor-target-unarchived": "warning",
  "mixed-contract-ids": "error",
  "contract-mismatch": "error",
  "event-ledger-mismatch": "error",
  "conflicting-duplicate": "error",
  "duplicate-event": "warning",
  "out-of-order": "warning",
  "cursor-ledger-contradiction": "error",
  "cursor-unreadable": "warning",
  "cursor-unpositioned": "warning",
  "archive-behind-cursor": "error",
  "archive-beyond-cursor": "error",
  "processed-events-missing": "error",
  "rewind-pending": "warning",
  "recorded-gap": "warning",
};

/** Report order for kinds, so output is deterministic for identical input. */
const KIND_ORDER: readonly ConsistencyFindingKind[] = Object.keys(SEVERITY) as ConsistencyFindingKind[];

export interface ConsistencyFinding {
  severity: ConsistencySeverity;
  kind: ConsistencyFindingKind;
  /** Target the finding is about, or `null` for archive-wide findings. */
  source: string | null;
  /** How many records / ids / occurrences the finding aggregates. */
  count: number;
  /** Inclusive ledger span the finding covers, when one applies. */
  firstLedger: number | null;
  lastLedger: number | null;
  /** 1-based position (archive read order) of the first offending record, when one applies. */
  firstRecord: number | null;
  message: string;
}

export interface TargetConsistencySummary {
  source: string;
  /** True when the cursor file has an entry for this source. */
  inCursor: boolean;
  /** Ledger packed in the persisted resume cursor, `null` when absent or unreadable. */
  cursorLedger: number | null;
  lastEventLedger: number | null;
  rewindFromLedger: number | null;
  /** Number of event ids in the cursor's dedup window. */
  processedIds: number;
  archive: {
    records: number;
    firstLedger: number | null;
    lastLedger: number | null;
    contractIds: string[];
  };
}

export interface CursorConsistencyReport {
  /** True when no `error` finding was reported (warnings are allowed). */
  consistent: boolean;
  errors: number;
  warnings: number;
  /** Archive records read, including malformed ones. */
  records: number;
  targets: TargetConsistencySummary[];
  findings: ConsistencyFinding[];
}

export interface CursorConsistencyOptions {
  /**
   * Contract id each source is expected to belong to (e.g. from
   * `MARKET_CONTRACT_ID` / `SQUAD_CONTRACT_ID`). The cursor file does not
   * record contract ids, so without this only archive self-consistency of the
   * contract identity is checked.
   */
  expectedContracts?: Readonly<Record<string, string | undefined>>;
}

interface TargetAccumulator {
  records: number;
  firstLedger: number | null;
  lastLedger: number | null;
  contractIds: Set<string>;
  eventIds: Set<string>;
  ledgers: number[];
  lastPosition: readonly [bigint, bigint] | null;
}

interface FindingAccumulator {
  kind: ConsistencyFindingKind;
  source: string | null;
  count: number;
  firstLedger: number | null;
  lastLedger: number | null;
  firstRecord: number | null;
  detail: string;
}

function parsePagingToken(token: string): readonly [bigint, bigint] | null {
  const match = /^(\d{1,20})-(\d{1,10})$/.exec(token);
  if (!match) return null;
  return [BigInt(match[1]!), BigInt(match[2]!)];
}

function comparePositions(a: readonly [bigint, bigint], b: readonly [bigint, bigint]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

function readableLedger(token: string | null | undefined): number | null {
  if (typeof token !== "string" || token === "") return null;
  const ledger = eventCursorLedger(token);
  return ledger !== null && ledger > 0 ? ledger : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function span(first: number | null, last: number | null): string {
  if (first === null || last === null) return "";
  return first === last ? ` (ledger ${first})` : ` (ledgers ${first}-${last})`;
}

function spanCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Compare a parsed cursor file with archived scan records.
 *
 * `records` is the archive in read order (oldest file first). Records are only
 * inspected, never mutated, and `cursor` is never written back: the function
 * returns a deterministic report and has no side effects.
 */
export function checkCursorConsistency(
  cursor: CursorFile,
  records: Iterable<unknown>,
  options: CursorConsistencyOptions = {},
): CursorConsistencyReport {
  const findings = new Map<string, FindingAccumulator>();
  const note = (
    kind: ConsistencyFindingKind,
    source: string | null,
    detail: string,
    ledger: number | null = null,
    recordIndex: number | null = null,
    count = 1,
  ): void => {
    const key = `${kind}\u0000${source ?? ""}`;
    const existing = findings.get(key);
    if (!existing) {
      findings.set(key, {
        kind,
        source,
        count,
        firstLedger: ledger,
        lastLedger: ledger,
        firstRecord: recordIndex,
        detail,
      });
      return;
    }
    existing.count += count;
    if (ledger !== null) {
      existing.firstLedger = existing.firstLedger === null ? ledger : Math.min(existing.firstLedger, ledger);
      existing.lastLedger = existing.lastLedger === null ? ledger : Math.max(existing.lastLedger, ledger);
    }
  };

  // ── Pass over the archive ─────────────────────────────────────────────────
  const targets = new Map<string, TargetAccumulator>();
  const identities = new Map<string, string>();
  let total = 0;

  for (const raw of records) {
    total += 1;
    const index = total;
    if (!isRecord(raw)) {
      note("malformed-record", null, "archive records are not decoded event objects", null, index);
      continue;
    }
    const { source, contractId, ledger, eventId } = raw;
    if (
      typeof source !== "string" ||
      source === "" ||
      typeof contractId !== "string" ||
      contractId === "" ||
      typeof ledger !== "number" ||
      !Number.isSafeInteger(ledger) ||
      ledger < 1 ||
      typeof eventId !== "string" ||
      eventId === ""
    ) {
      note(
        "malformed-record",
        null,
        "archive records lack a source, contractId, positive integer ledger, or eventId",
        null,
        index,
      );
      continue;
    }

    let target = targets.get(source);
    if (!target) {
      target = {
        records: 0,
        firstLedger: null,
        lastLedger: null,
        contractIds: new Set(),
        eventIds: new Set(),
        ledgers: [],
        lastPosition: null,
      };
      targets.set(source, target);
    }

    const txHash = typeof raw.txHash === "string" ? raw.txHash : "";
    const identity = `${source}\u0000${contractId}\u0000${ledger}\u0000${txHash}`;
    const seen = identities.get(eventId);
    if (seen !== undefined) {
      if (seen === identity) {
        note("duplicate-event", source, "archive records repeat an event already archived (overlapping captures)", ledger, index);
      } else {
        note(
          "conflicting-duplicate",
          source,
          "archive records reuse an event id with a different source, contract, ledger, or transaction",
          ledger,
          index,
        );
      }
      continue;
    }
    identities.set(eventId, identity);

    target.records += 1;
    target.firstLedger = target.firstLedger === null ? ledger : Math.min(target.firstLedger, ledger);
    target.lastLedger = target.lastLedger === null ? ledger : Math.max(target.lastLedger, ledger);
    target.contractIds.add(contractId);
    target.eventIds.add(eventId);
    target.ledgers.push(ledger);

    const position = parsePagingToken(eventId);
    if (position) {
      const packedLedger = readableLedger(eventId);
      if (packedLedger !== null && packedLedger !== ledger) {
        note(
          "event-ledger-mismatch",
          source,
          "archive records carry a ledger that contradicts the ledger packed in their event id",
          ledger,
          index,
        );
      }
      if (target.lastPosition && comparePositions(position, target.lastPosition) < 0) {
        note("out-of-order", source, "archive records appear before an event they follow on chain", ledger, index);
      }
      if (!target.lastPosition || comparePositions(position, target.lastPosition) > 0) {
        target.lastPosition = position;
      }
    }
  }

  // ── Identity: contract ids ────────────────────────────────────────────────
  for (const [source, target] of targets) {
    const ids = [...target.contractIds].sort();
    if (ids.length > 1) {
      note(
        "mixed-contract-ids",
        source,
        `archive records for one target carry ${ids.length} different contract ids`,
        target.firstLedger,
        null,
        ids.length,
      );
      const mixed = findings.get(`mixed-contract-ids\u0000${source}`)!;
      mixed.lastLedger = target.lastLedger;
    }
    const expected = options.expectedContracts?.[source];
    if (typeof expected === "string" && expected !== "") {
      const foreign = ids.filter((id) => id !== expected);
      if (foreign.length > 0) {
        note(
          "contract-mismatch",
          source,
          `archive records belong to a contract other than the one configured for ${source}`,
          target.firstLedger,
          null,
          foreign.length,
        );
        findings.get(`contract-mismatch\u0000${source}`)!.lastLedger = target.lastLedger;
      }
    }
  }

  // ── Cursor vs archive, per target ─────────────────────────────────────────
  const sources = new Set<string>([...Object.keys(cursor.targets), ...targets.keys()]);
  const summaries: TargetConsistencySummary[] = [];

  for (const source of [...sources].sort()) {
    const entry = cursor.targets[source];
    const archived = targets.get(source);
    const cursorLedger = readableLedger(entry?.cursor);
    const lastEventLedger = entry?.lastEventLedger ?? null;
    const rewindFromLedger = typeof entry?.rewindFromLedger === "number" ? entry.rewindFromLedger : null;
    const processed = entry?.recentEventIds ?? [];

    summaries.push({
      source,
      inCursor: entry !== undefined,
      cursorLedger,
      lastEventLedger,
      rewindFromLedger,
      processedIds: processed.length,
      archive: {
        records: archived?.records ?? 0,
        firstLedger: archived?.firstLedger ?? null,
        lastLedger: archived?.lastLedger ?? null,
        contractIds: archived ? [...archived.contractIds].sort() : [],
      },
    });

    if (!entry) {
      if (archived) {
        note(
          "archive-target-untracked",
          source,
          "archive holds records for a target the cursor file does not track",
          archived.firstLedger,
          null,
          archived.records,
        );
        findings.get(`archive-target-untracked\u0000${source}`)!.lastLedger = archived.lastLedger;
      }
      continue;
    }

    if (typeof entry.cursor === "string" && entry.cursor !== "" && cursorLedger === null) {
      note("cursor-unreadable", source, "persisted cursor carries no readable ledger; compared by lastEventLedger only");
    }
    if (cursorLedger !== null && lastEventLedger !== null && cursorLedger < lastEventLedger) {
      note(
        "cursor-ledger-contradiction",
        source,
        `resume cursor (ledger ${cursorLedger}) sits behind the last event ledger it claims to have seen (${lastEventLedger})`,
        cursorLedger,
      );
      findings.get(`cursor-ledger-contradiction\u0000${source}`)!.lastLedger = lastEventLedger;
    }
    if (rewindFromLedger !== null) {
      note(
        "rewind-pending",
        source,
        "cursor is resuming from the RPC's retained floor after a stale cursor",
        rewindFromLedger,
      );
    }

    const hasPosition = cursorLedger !== null || lastEventLedger !== null || rewindFromLedger !== null;
    if (!archived) {
      if (hasPosition) {
        note(
          "cursor-target-unarchived",
          source,
          "cursor has a position for this target but the archive holds no records for it",
          lastEventLedger ?? cursorLedger ?? rewindFromLedger,
        );
      }
      continue;
    }
    if (!hasPosition) {
      note(
        "cursor-unpositioned",
        source,
        "cursor has no position for this target (cold start); ledger ranges not compared",
      );
      continue;
    }

    const archiveFirst = archived.firstLedger!;
    const archiveLast = archived.lastLedger!;

    // The archive stops before the newest event the cursor says it processed.
    // Count = processed ids past the archive's end (at least the last event).
    if (lastEventLedger !== null && lastEventLedger > archiveLast) {
      const pastEnd = processed.filter((id) => (readableLedger(id) ?? 0) > archiveLast).length;
      note(
        "archive-behind-cursor",
        source,
        `cursor processed events up to ledger ${lastEventLedger} but the archive ends at ledger ${archiveLast}`,
        archiveLast + 1,
        null,
        Math.max(1, pastEnd),
      );
      findings.get(`archive-behind-cursor\u0000${source}`)!.lastLedger = lastEventLedger;
    }

    // The archive holds events past the point the cursor would resume from.
    // While rewinding, the floor walk re-reads from rewindFromLedger, so
    // archived events at or above it are expected and not a contradiction.
    if (rewindFromLedger === null) {
      const position = Math.max(cursorLedger ?? 0, lastEventLedger ?? 0);
      if (archiveLast > position) {
        const beyond = archived.ledgers.filter((ledger) => ledger > position).length;
        note(
          "archive-beyond-cursor",
          source,
          `archive holds events up to ledger ${archiveLast}, past the cursor's position at ledger ${position}`,
          position + 1,
          null,
          beyond,
        );
        findings.get(`archive-beyond-cursor\u0000${source}`)!.lastLedger = archiveLast;
      }
    }

    // Events the cursor recorded as processed but that are missing from the
    // archived span. Ids older than the archive's first ledger predate the
    // capture and are not a gap; ids past its end are reported above.
    let missing = 0;
    let missingFirst: number | null = null;
    let missingLast: number | null = null;
    for (const id of processed) {
      const ledger = readableLedger(id);
      if (ledger === null || ledger < archiveFirst || ledger > archiveLast) continue;
      if (archived.eventIds.has(id)) continue;
      missing += 1;
      missingFirst = missingFirst === null ? ledger : Math.min(missingFirst, ledger);
      missingLast = missingLast === null ? ledger : Math.max(missingLast, ledger);
    }
    if (missing > 0) {
      note(
        "processed-events-missing",
        source,
        "events the cursor recorded as processed are missing from the archived ledger span",
        missingFirst,
        null,
        missing,
      );
      findings.get(`processed-events-missing\u0000${source}`)!.lastLedger = missingLast;
    }
  }

  // ── Gaps the cursor recorded itself (automatic floor rewinds) ─────────────
  for (const record of cursor.recoveryHistory ?? []) {
    if (record.reason !== "floor_rewind") continue;
    for (const [source, after] of Object.entries(record.after)) {
      const floor = typeof after.rewindFromLedger === "number" ? after.rewindFromLedger : null;
      const before = record.before[source];
      const from = readableLedger(before?.cursor) ?? before?.lastEventLedger ?? null;
      if (floor === null || from === null || floor <= from + 1) continue;
      note(
        "recorded-gap",
        source,
        "cursor recovery history records ledgers lost to a floor rewind",
        from + 1,
      );
      const gap = findings.get(`recorded-gap\u0000${source}`)!;
      gap.lastLedger = Math.max(gap.lastLedger ?? floor - 1, floor - 1);
    }
  }

  const ordered = [...findings.values()].sort((a, b) => {
    const bySource = (a.source ?? "").localeCompare(b.source ?? "");
    if (bySource !== 0) return bySource;
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });

  const out: ConsistencyFinding[] = ordered.map((f) => ({
    severity: SEVERITY[f.kind],
    kind: f.kind,
    source: f.source,
    count: f.count,
    firstLedger: f.firstLedger,
    lastLedger: f.lastLedger,
    firstRecord: f.firstRecord,
    message: f.detail,
  }));

  const errors = out.filter((f) => f.severity === "error").length;
  return {
    consistent: errors === 0,
    errors,
    warnings: out.length - errors,
    records: total,
    targets: summaries,
    findings: out,
  };
}

/**
 * Render a report as stable plain text. Prints ledgers and counts only, never
 * opaque cursor strings, event ids, or payloads.
 */
export function formatCursorConsistencyReport(report: CursorConsistencyReport): string {
  const lines: string[] = [];
  lines.push(
    `[cursor] consistency check: ${report.consistent ? "consistent" : "INCONSISTENT"} ` +
      `(${spanCount(report.errors, "error")}, ${spanCount(report.warnings, "warning")}, ` +
      `${spanCount(report.records, "archive record")})`,
  );
  for (const t of report.targets) {
    const archive =
      t.archive.records === 0
        ? "archive=none"
        : `archive=${t.archive.records}@${t.archive.firstLedger}-${t.archive.lastLedger} ` +
          `contracts=${t.archive.contractIds.length}`;
    const position = t.inCursor
      ? `cursorLedger=${t.cursorLedger ?? "-"} lastEventLedger=${t.lastEventLedger ?? "-"}` +
        (t.rewindFromLedger !== null ? ` rewindFrom=${t.rewindFromLedger}` : "") +
        ` processedIds=${t.processedIds}`
      : "cursor=untracked";
    lines.push(`  target ${t.source}: ${position} ${archive}`);
  }
  for (const f of report.findings) {
    const where = f.source ?? "archive";
    const record = f.firstRecord !== null ? ` first at record #${f.firstRecord}` : "";
    lines.push(
      `  ${f.severity.toUpperCase()} ${f.kind} [${where}] x${f.count}${span(f.firstLedger, f.lastLedger)}${record}: ${f.message}`,
    );
  }
  lines.push("[cursor] read-only: no cursor or archive was modified");
  return `${lines.join("\n")}\n`;
}
