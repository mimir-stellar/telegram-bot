import { open, mkdir, readdir, unlink, chmod } from "node:fs/promises";
import path from "node:path";
import { normalizeCategory } from "./category.js";
import { scanJsonReplacer } from "./events.js";
import type { ContractSource, DecodedEvent } from "./decode.js";

export interface EventArchiveOptions {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
}

export interface EventArchive {
  append(events: readonly DecodedEvent[]): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_FILES = 10;
const FILE_MODE = 0o600;

function formatArchiveFilename(index: number, timestamp: number): string {
  const ts = new Date(timestamp).toISOString().replace(/[:.]/g, "-");
  const idx = String(index).padStart(6, "0");
  return `events-${ts}-${idx}.jsonl`;
}

export function createEventArchive(options: EventArchiveOptions): EventArchive {
  const { dir } = options;
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);

  let currentHandle: any = null;
  let currentFilePath: string | null = null;
  let currentSize = 0;
  let fileIndex = 0;
  let closed = false;

  let queue: Promise<void> = Promise.resolve();

  async function rotateIfNeeded(additionalBytes: number): Promise<void> {
    if (currentHandle && currentSize + additionalBytes <= maxBytes) {
      return;
    }

    if (currentHandle) {
      await currentHandle.sync();
      await currentHandle.close();
      currentHandle = null;
      currentFilePath = null;
    }

    await mkdir(dir, { recursive: true });

    // Enforce maxFiles by deleting older files if needed
    const existing = await listArchiveFiles(dir);
    // If we're creating a new file, we'll have existing.length + 1 files.
    // If existing.length + 1 > maxFiles, remove oldest so we stay within maxFiles.
    const toRemoveCount = Math.max(0, existing.length + 1 - maxFiles);
    for (let i = 0; i < toRemoveCount; i++) {
      const target = existing[i];
      if (!target) continue;
      try {
        await unlink(path.join(dir, target));
      } catch {
        // ignore
      }
    }

    fileIndex += 1;
    const filename = formatArchiveFilename(fileIndex, Date.now());
    currentFilePath = path.join(dir, filename);

    // Open with 'a+' flag (append and reading), 0o600 permissions
    currentHandle = await open(currentFilePath, "a+", FILE_MODE);
    try {
      await chmod(currentFilePath, FILE_MODE);
    } catch {
      // chmod might not be fully supported on some OS/filesystems, safe to ignore
    }

    const st = await currentHandle.stat();
    currentSize = st.size;
  }

  async function doAppend(events: readonly DecodedEvent[]): Promise<void> {
    if (closed) {
      throw new Error("Event archive is closed");
    }
    if (!events || events.length === 0) return;

    for (const event of events) {
      const line = JSON.stringify(event, scanJsonReplacer) + "\n";
      const buffer = Buffer.from(line, "utf8");
      const bytes = buffer.byteLength;

      // Rotate if adding this line exceeds maxBytes, or if no file opened yet
      if (!currentHandle || currentSize + bytes > maxBytes) {
        await rotateIfNeeded(bytes);
      }

      await currentHandle.write(buffer);
      await currentHandle.sync();
      currentSize += bytes;
    }
  }

  async function doClose(): Promise<void> {
    if (closed) return;
    closed = true;
    if (currentHandle) {
      await currentHandle.sync();
      await currentHandle.close();
      currentHandle = null;
    }
  }

  return {
    async append(events: readonly DecodedEvent[]): Promise<void> {
      queue = queue.then(() => doAppend(events));
      return queue;
    },
    async close(): Promise<void> {
      queue = queue.then(() => doClose());
      return queue;
    },
  };
}

async function listArchiveFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.startsWith("events-") && name.endsWith(".jsonl"))
      .sort();
  } catch {
    return [];
  }
}

export async function* readArchive(dir: string): AsyncGenerator<DecodedEvent, void, unknown> {
  const files = await listArchiveFiles(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const handle = await open(filePath, "r");
    try {
      const content = await handle.readFile({ encoding: "utf8" });
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parsed = JSON.parse(trimmed);
        yield parsed as DecodedEvent;
      }
    } finally {
      await handle.close();
    }
  }
}

export interface CaptureFilter {
  sources?: readonly ContractSource[];
  contractIds?: readonly string[];
  eventNames?: readonly string[];
  categories?: readonly string[];
}

export interface CaptureAcquisitionMeta {
  startLedger?: number | null;
  endLedger?: number | null;
  truncated?: boolean;
  startClamped?: boolean;
  filter?: CaptureFilter;
}

export interface LedgerCapture {
  events: readonly DecodedEvent[];
  meta?: CaptureAcquisitionMeta;
}

export type LedgerCaptureInput = readonly DecodedEvent[] | LedgerCapture;

export interface LedgerRange {
  startLedger: number;
  endLedger: number;
  ledgerCount: number;
  eventCount: number;
}

export interface OverlapLedgerRange extends LedgerRange {
  leftEventCount: number;
  rightEventCount: number;
  sharedEventCount: number;
}

export type DiscrepancyStatus =
  | "none"
  | "intentional_filter"
  | "incomplete_acquisition"
  | "mixed";

export interface CoverageDiscrepancy {
  side: "left" | "right";
  classification: "intentional_filter" | "incomplete_acquisition";
  reason:
    | "filter_mismatch"
    | "missing_ledger_range"
    | "missing_overlap_events"
    | "truncated_scan"
    | "clamped_start";
  range: { startLedger: number; endLedger: number } | null;
  eventCount: number;
}

export interface ArchiveCoverageComparison {
  left: {
    bounds: { startLedger: number; endLedger: number } | null;
    uniqueEventCount: number;
    duplicateEventCount: number;
  };
  right: {
    bounds: { startLedger: number; endLedger: number } | null;
    uniqueEventCount: number;
    duplicateEventCount: number;
  };
  overlappingRanges: OverlapLedgerRange[];
  missingInLeft: LedgerRange[];
  missingInRight: LedgerRange[];
  uncoveredGapRanges: Array<{ startLedger: number; endLedger: number; ledgerCount: number }>;
  counts: {
    sharedEvents: number;
    onlyInLeft: number;
    onlyInRight: number;
    filteredOutInLeft: number;
    filteredOutInRight: number;
    incompleteInLeft: number;
    incompleteInRight: number;
  };
  status: DiscrepancyStatus;
  discrepancies: CoverageDiscrepancy[];
}

/**
 * Derive a deterministic identity key for a decoded event across captures.
 */
export function archiveEventIdentity(event: DecodedEvent): string {
  const source = event.source ?? "";
  const contractId = event.contractId ?? "";
  const idPart =
    typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : `${event.ledger}:${event.txHash ?? ""}:${event.transactionIndex ?? ""}:${event.operationIndex ?? ""}:${event.payload?.name ?? ""}`;
  return `${source}:${contractId}:${idPart}`;
}

/**
 * Test whether a decoded event satisfies a capture's declared filter criteria.
 */
export function matchesCaptureFilter(event: DecodedEvent, filter?: CaptureFilter): boolean {
  if (!filter) return true;

  if (filter.sources && filter.sources.length > 0) {
    if (!filter.sources.includes(event.source)) return false;
  }

  if (filter.contractIds && filter.contractIds.length > 0) {
    if (!filter.contractIds.includes(event.contractId)) return false;
  }

  if (filter.eventNames && filter.eventNames.length > 0) {
    const payloadName = event.payload?.name ?? "";
    if (!filter.eventNames.includes(payloadName)) return false;
  }

  if (filter.categories && filter.categories.length > 0) {
    const allowedCategories = new Set(filter.categories.map((c) => normalizeCategory(c)));
    const payload = event.payload as Record<string, unknown> | undefined;
    const rawCat = payload && "category" in payload ? payload.category : undefined;
    if (!allowedCategories.has(normalizeCategory(rawCat))) {
      return false;
    }
  }

  return true;
}

function hasActiveFilter(filter?: CaptureFilter): boolean {
  if (!filter) return false;
  return Boolean(
    (filter.sources && filter.sources.length > 0) ||
      (filter.contractIds && filter.contractIds.length > 0) ||
      (filter.eventNames && filter.eventNames.length > 0) ||
      (filter.categories && filter.categories.length > 0),
  );
}

interface NormalizedCapture {
  uniqueEvents: DecodedEvent[];
  eventMap: Map<string, DecodedEvent>;
  duplicateCount: number;
  bounds: { startLedger: number; endLedger: number } | null;
  hasExplicitBounds: boolean;
  meta: CaptureAcquisitionMeta | undefined;
}

function validateOptionalLedger(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RangeError(`Invalid ${label}: expected a positive integer ledger, got ${String(value)}`);
  }
  return value;
}

function normalizeCaptureInput(input: LedgerCaptureInput, sideLabel: string): NormalizedCapture {
  const isArray = Array.isArray(input);
  const rawEvents: readonly DecodedEvent[] = isArray
    ? input
    : (input as LedgerCapture).events;
  const meta: CaptureAcquisitionMeta | undefined = isArray
    ? undefined
    : (input as LedgerCapture).meta;

  if (!Array.isArray(rawEvents)) {
    throw new TypeError(`Invalid ${sideLabel} capture: expected an events array`);
  }

  const declaredStart = validateOptionalLedger(meta?.startLedger, `${sideLabel}.meta.startLedger`);
  const declaredEnd = validateOptionalLedger(meta?.endLedger, `${sideLabel}.meta.endLedger`);

  if (declaredStart !== null && declaredEnd !== null && declaredEnd < declaredStart) {
    throw new RangeError(
      `Invalid ${sideLabel} capture bounds: endLedger (${declaredEnd}) cannot precede startLedger (${declaredStart})`,
    );
  }

  const eventMap = new Map<string, DecodedEvent>();
  let duplicateCount = 0;
  let minObserved: number | null = null;
  let maxObserved: number | null = null;

  for (const ev of rawEvents) {
    if (!ev || typeof ev !== "object") continue;
    if (typeof ev.ledger !== "number" || !Number.isInteger(ev.ledger) || ev.ledger <= 0) {
      throw new RangeError(
        `Invalid event ledger in ${sideLabel} capture: expected positive integer, got ${String(ev.ledger)}`,
      );
    }
    const key = archiveEventIdentity(ev);
    if (eventMap.has(key)) {
      duplicateCount += 1;
      continue;
    }
    eventMap.set(key, ev);
    if (minObserved === null || ev.ledger < minObserved) minObserved = ev.ledger;
    if (maxObserved === null || ev.ledger > maxObserved) maxObserved = ev.ledger;
  }

  // Deterministic ordering by (ledger, identity) so output is invariant under input permutations
  const uniqueEvents = [...eventMap.entries()]
    .sort((a, b) => a[1].ledger - b[1].ledger || a[0].localeCompare(b[0]))
    .map(([, ev]) => ev);

  const candidatesStart = [declaredStart, minObserved].filter((n): n is number => n !== null);
  const candidatesEnd = [declaredEnd, maxObserved].filter((n): n is number => n !== null);

  let bounds: { startLedger: number; endLedger: number } | null = null;
  if (candidatesStart.length > 0 && candidatesEnd.length > 0) {
    const startLedger = Math.min(...candidatesStart);
    const endLedger = Math.max(...candidatesEnd);
    bounds = { startLedger, endLedger };
  } else if (declaredStart !== null) {
    bounds = { startLedger: declaredStart, endLedger: declaredStart };
  } else if (declaredEnd !== null) {
    bounds = { startLedger: declaredEnd, endLedger: declaredEnd };
  }

  return {
    uniqueEvents,
    eventMap,
    duplicateCount,
    bounds,
    hasExplicitBounds: declaredStart !== null || declaredEnd !== null,
    meta,
  };
}

function countEventsInRange(
  events: readonly DecodedEvent[],
  startLedger: number,
  endLedger: number,
): number {
  let count = 0;
  for (const ev of events) {
    if (ev.ledger >= startLedger && ev.ledger <= endLedger) {
      count += 1;
    }
  }
  return count;
}

function makeRange(
  events: readonly DecodedEvent[],
  startLedger: number,
  endLedger: number,
): LedgerRange {
  return {
    startLedger,
    endLedger,
    ledgerCount: endLedger - startLedger + 1,
    eventCount: countEventsInRange(events, startLedger, endLedger),
  };
}

/**
 * Compare two ledger event captures, reporting missing and overlapping ledger
 * ranges with stable deduplicated event counts and distinguishing intentional
 * filter differences from incomplete data acquisition.
 */
export function compareArchiveCoverage(
  leftInput: LedgerCaptureInput,
  rightInput: LedgerCaptureInput,
): ArchiveCoverageComparison {
  const left = normalizeCaptureInput(leftInput, "left");
  const right = normalizeCaptureInput(rightInput, "right");

  const overlappingRanges: OverlapLedgerRange[] = [];
  const missingInLeft: LedgerRange[] = [];
  const missingInRight: LedgerRange[] = [];
  const uncoveredGapRanges: Array<{ startLedger: number; endLedger: number; ledgerCount: number }> = [];

  const L = left.bounds;
  const R = right.bounds;

  if (L !== null && R === null) {
    missingInRight.push(makeRange(left.uniqueEvents, L.startLedger, L.endLedger));
  } else if (L === null && R !== null) {
    missingInLeft.push(makeRange(right.uniqueEvents, R.startLedger, R.endLedger));
  } else if (L !== null && R !== null) {
    const oStart = Math.max(L.startLedger, R.startLedger);
    const oEnd = Math.min(L.endLedger, R.endLedger);

    if (oStart <= oEnd) {
      const leftOverlapKeys = new Set<string>();
      const rightOverlapKeys = new Set<string>();
      for (const [key, ev] of left.eventMap.entries()) {
        if (ev.ledger >= oStart && ev.ledger <= oEnd) leftOverlapKeys.add(key);
      }
      for (const [key, ev] of right.eventMap.entries()) {
        if (ev.ledger >= oStart && ev.ledger <= oEnd) rightOverlapKeys.add(key);
      }
      let sharedInOverlap = 0;
      const unionKeys = new Set<string>(leftOverlapKeys);
      for (const key of rightOverlapKeys) {
        if (leftOverlapKeys.has(key)) sharedInOverlap += 1;
        unionKeys.add(key);
      }

      overlappingRanges.push({
        startLedger: oStart,
        endLedger: oEnd,
        ledgerCount: oEnd - oStart + 1,
        eventCount: unionKeys.size,
        leftEventCount: leftOverlapKeys.size,
        rightEventCount: rightOverlapKeys.size,
        sharedEventCount: sharedInOverlap,
      });

      if (L.startLedger < R.startLedger) {
        missingInRight.push(makeRange(left.uniqueEvents, L.startLedger, R.startLedger - 1));
      }
      if (L.endLedger > R.endLedger) {
        missingInRight.push(makeRange(left.uniqueEvents, R.endLedger + 1, L.endLedger));
      }

      if (R.startLedger < L.startLedger) {
        missingInLeft.push(makeRange(right.uniqueEvents, R.startLedger, L.startLedger - 1));
      }
      if (R.endLedger > L.endLedger) {
        missingInLeft.push(makeRange(right.uniqueEvents, L.endLedger + 1, R.endLedger));
      }
    } else {
      missingInRight.push(makeRange(left.uniqueEvents, L.startLedger, L.endLedger));
      missingInLeft.push(makeRange(right.uniqueEvents, R.startLedger, R.endLedger));

      const earlierEnd = Math.min(L.endLedger, R.endLedger);
      const laterStart = Math.max(L.startLedger, R.startLedger);
      if (earlierEnd + 1 <= laterStart - 1) {
        const gapStart = earlierEnd + 1;
        const gapEnd = laterStart - 1;
        uncoveredGapRanges.push({
          startLedger: gapStart,
          endLedger: gapEnd,
          ledgerCount: gapEnd - gapStart + 1,
        });
      }
    }
  }

  let sharedEvents = 0;
  let onlyInLeft = 0;
  let onlyInRight = 0;
  let filteredOutInRight = 0;
  let incompleteInRight = 0;
  let filteredOutInLeft = 0;
  let incompleteInLeft = 0;

  let overlapMissingInRight = 0;
  let overlapMissingInLeft = 0;
  const overlap = overlappingRanges[0] ?? null;

  const rightFilterActive = hasActiveFilter(right.meta?.filter);
  const leftFilterActive = hasActiveFilter(left.meta?.filter);

  for (const [key, ev] of left.eventMap.entries()) {
    if (right.eventMap.has(key)) {
      sharedEvents += 1;
      continue;
    }
    onlyInLeft += 1;
    if (rightFilterActive && !matchesCaptureFilter(ev, right.meta?.filter)) {
      filteredOutInRight += 1;
    } else {
      incompleteInRight += 1;
      if (overlap && ev.ledger >= overlap.startLedger && ev.ledger <= overlap.endLedger) {
        overlapMissingInRight += 1;
      }
    }
  }

  for (const [key, ev] of right.eventMap.entries()) {
    if (left.eventMap.has(key)) {
      continue;
    }
    onlyInRight += 1;
    if (leftFilterActive && !matchesCaptureFilter(ev, left.meta?.filter)) {
      filteredOutInLeft += 1;
    } else {
      incompleteInLeft += 1;
      if (overlap && ev.ledger >= overlap.startLedger && ev.ledger <= overlap.endLedger) {
        overlapMissingInLeft += 1;
      }
    }
  }

  const discrepancies: CoverageDiscrepancy[] = [];

  if (filteredOutInRight > 0) {
    discrepancies.push({
      side: "right",
      classification: "intentional_filter",
      reason: "filter_mismatch",
      range: L,
      eventCount: filteredOutInRight,
    });
  }
  if (filteredOutInLeft > 0) {
    discrepancies.push({
      side: "left",
      classification: "intentional_filter",
      reason: "filter_mismatch",
      range: R,
      eventCount: filteredOutInLeft,
    });
  }

  for (const range of missingInRight) {
    const matchingLeftEvents = left.uniqueEvents.filter(
      (ev) =>
        ev.ledger >= range.startLedger &&
        ev.ledger <= range.endLedger &&
        (!rightFilterActive || matchesCaptureFilter(ev, right.meta?.filter)),
    ).length;

    const rangeIsPurelyFilteredObservation =
      rightFilterActive &&
      !right.hasExplicitBounds &&
      !right.meta?.truncated &&
      !right.meta?.startClamped &&
      matchingLeftEvents === 0 &&
      range.eventCount > 0;

    if (!rangeIsPurelyFilteredObservation) {
      discrepancies.push({
        side: "right",
        classification: "incomplete_acquisition",
        reason: "missing_ledger_range",
        range: { startLedger: range.startLedger, endLedger: range.endLedger },
        eventCount: matchingLeftEvents,
      });
    }
  }

  for (const range of missingInLeft) {
    const matchingRightEvents = right.uniqueEvents.filter(
      (ev) =>
        ev.ledger >= range.startLedger &&
        ev.ledger <= range.endLedger &&
        (!leftFilterActive || matchesCaptureFilter(ev, left.meta?.filter)),
    ).length;

    const rangeIsPurelyFilteredObservation =
      leftFilterActive &&
      !left.hasExplicitBounds &&
      !left.meta?.truncated &&
      !left.meta?.startClamped &&
      matchingRightEvents === 0 &&
      range.eventCount > 0;

    if (!rangeIsPurelyFilteredObservation) {
      discrepancies.push({
        side: "left",
        classification: "incomplete_acquisition",
        reason: "missing_ledger_range",
        range: { startLedger: range.startLedger, endLedger: range.endLedger },
        eventCount: matchingRightEvents,
      });
    }
  }

  if (overlap && overlapMissingInRight > 0) {
    discrepancies.push({
      side: "right",
      classification: "incomplete_acquisition",
      reason: "missing_overlap_events",
      range: { startLedger: overlap.startLedger, endLedger: overlap.endLedger },
      eventCount: overlapMissingInRight,
    });
  }

  if (overlap && overlapMissingInLeft > 0) {
    discrepancies.push({
      side: "left",
      classification: "incomplete_acquisition",
      reason: "missing_overlap_events",
      range: { startLedger: overlap.startLedger, endLedger: overlap.endLedger },
      eventCount: overlapMissingInLeft,
    });
  }

  if (right.meta?.truncated) {
    discrepancies.push({
      side: "right",
      classification: "incomplete_acquisition",
      reason: "truncated_scan",
      range: R,
      eventCount: incompleteInRight,
    });
  }
  if (left.meta?.truncated) {
    discrepancies.push({
      side: "left",
      classification: "incomplete_acquisition",
      reason: "truncated_scan",
      range: L,
      eventCount: incompleteInLeft,
    });
  }

  if (right.meta?.startClamped) {
    discrepancies.push({
      side: "right",
      classification: "incomplete_acquisition",
      reason: "clamped_start",
      range: R,
      eventCount: incompleteInRight,
    });
  }
  if (left.meta?.startClamped) {
    discrepancies.push({
      side: "left",
      classification: "incomplete_acquisition",
      reason: "clamped_start",
      range: L,
      eventCount: incompleteInLeft,
    });
  }

  const hasFilterDiff = discrepancies.some((d) => d.classification === "intentional_filter");
  const hasIncomplete = discrepancies.some((d) => d.classification === "incomplete_acquisition");
  const status: DiscrepancyStatus =
    hasFilterDiff && hasIncomplete
      ? "mixed"
      : hasIncomplete
        ? "incomplete_acquisition"
        : hasFilterDiff
          ? "intentional_filter"
          : "none";

  return {
    left: {
      bounds: L,
      uniqueEventCount: left.uniqueEvents.length,
      duplicateEventCount: left.duplicateCount,
    },
    right: {
      bounds: R,
      uniqueEventCount: right.uniqueEvents.length,
      duplicateEventCount: right.duplicateCount,
    },
    overlappingRanges,
    missingInLeft,
    missingInRight,
    uncoveredGapRanges,
    counts: {
      sharedEvents,
      onlyInLeft,
      onlyInRight,
      filteredOutInLeft,
      filteredOutInRight,
      incompleteInLeft,
      incompleteInRight,
    },
    status,
    discrepancies,
  };
}

/**
 * Load all events from an on-disk archive directory into a {@link LedgerCapture}.
 */
export async function loadArchiveCapture(
  dir: string,
  meta?: CaptureAcquisitionMeta,
): Promise<LedgerCapture> {
  const events: DecodedEvent[] = [];
  for await (const ev of readArchive(dir)) {
    events.push(ev);
  }
  return meta !== undefined ? { events, meta } : { events };
}

/**
 * Compare two on-disk event archive directories directly.
 */
export async function compareArchiveDirectories(
  leftDir: string,
  rightDir: string,
  options: { leftMeta?: CaptureAcquisitionMeta; rightMeta?: CaptureAcquisitionMeta } = {},
): Promise<ArchiveCoverageComparison> {
  const [leftCapture, rightCapture] = await Promise.all([
    loadArchiveCapture(leftDir, options.leftMeta),
    loadArchiveCapture(rightDir, options.rightMeta),
  ]);
  return compareArchiveCoverage(leftCapture, rightCapture);
}

/**
 * Format an {@link ArchiveCoverageComparison} as a deterministic human-readable report.
 */
export function formatArchiveCoverageReport(comparison: ArchiveCoverageComparison): string {
  const fmtBounds = (b: { startLedger: number; endLedger: number } | null): string =>
    b ? `${b.startLedger}..${b.endLedger}` : "empty";
  const fmtRanges = (ranges: readonly LedgerRange[]): string =>
    ranges.length === 0
      ? "none"
      : ranges.map((r) => `${r.startLedger}..${r.endLedger} (events=${r.eventCount})`).join(", ");

  const lines = [
    `status: ${comparison.status}`,
    `left: bounds=${fmtBounds(comparison.left.bounds)} unique=${comparison.left.uniqueEventCount} duplicates=${comparison.left.duplicateEventCount}`,
    `right: bounds=${fmtBounds(comparison.right.bounds)} unique=${comparison.right.uniqueEventCount} duplicates=${comparison.right.duplicateEventCount}`,
    `overlap: ${fmtRanges(comparison.overlappingRanges)}`,
    `missing_in_left: ${fmtRanges(comparison.missingInLeft)}`,
    `missing_in_right: ${fmtRanges(comparison.missingInRight)}`,
    `counts: shared=${comparison.counts.sharedEvents} only_left=${comparison.counts.onlyInLeft} only_right=${comparison.counts.onlyInRight} filtered_left=${comparison.counts.filteredOutInLeft} filtered_right=${comparison.counts.filteredOutInRight} incomplete_left=${comparison.counts.incompleteInLeft} incomplete_right=${comparison.counts.incompleteInRight}`,
  ];
  if (comparison.uncoveredGapRanges.length > 0) {
    lines.push(
      `uncovered_gaps: ${comparison.uncoveredGapRanges.map((g) => `${g.startLedger}..${g.endLedger}`).join(", ")}`,
    );
  }
  return lines.join("\n") + "\n";
}
