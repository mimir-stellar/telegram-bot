/**
 * Deterministic replay completeness certificates.
 *
 * Records the requested ledger range, observed ledger range, retention window,
 * and every unresolved ledger gap per watched contract, producing a canonical
 * SHA-256 digest without wall-clock timestamps or nondeterministic host fields.
 *
 * A certificate marks `complete: true` if and only if every requested target
 * observed the entire requested ledger span end-to-end with zero pruned,
 * truncated, beyond-tip, cursor-ambiguous, or failed subranges.
 */

import { createHash } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ContractSource } from "./decode.js";
import { eventCursorLedger } from "./events.js";

export type ReplayCompletenessGapReason =
  | "pruned-before-retention-floor"
  | "beyond-chain-tip"
  | "truncated-page-budget"
  | "partial-cursor-start"
  | "opaque-cursor-start"
  | "scan-failed";

export interface ReplayLedgerSpan {
  /** Inclusive start ledger of the span. */
  from: number;
  /** Inclusive end ledger of the span. */
  to: number;
  /** Number of ledgers in the span (`to - from + 1`). */
  count: number;
}

export interface ReplayCompletenessGap {
  source: ContractSource;
  /** Inclusive start ledger of the unresolved gap, or `null` when unknown (opaque cursor). */
  from: number | null;
  /** Inclusive end ledger of the unresolved gap, or `null` when chain tip could not be resolved. */
  to: number | null;
  /** Number of unresolved ledgers (`to - from + 1`), or `null` when bounds are unknown. */
  count: number | null;
  reason: ReplayCompletenessGapReason;
}

export interface ReplayTargetCompleteness {
  source: ContractSource;
  contractId: string;
  complete: boolean;
  requestedRange: {
    from: string;
    fromLedger: number | null;
    toLedger: number | null;
    resolvedToLedger: number | null;
  };
  retentionWindow: {
    oldestLedger: number;
    latestLedger: number;
  } | null;
  observedRange: ReplayLedgerSpan | null;
  unresolvedGaps: ReplayCompletenessGap[];
  pagesObserved: number;
  eventsObserved: number;
}

export interface ReplayCompletenessCertificate {
  format: "mimir-replay-completeness-v1";
  version: 1;
  network: string;
  contracts: ContractSource[];
  complete: boolean;
  requestedRange: {
    from: string;
    fromLedger: number | null;
    toLedger: number | null;
  };
  targets: ReplayTargetCompleteness[];
  unresolvedGaps: ReplayCompletenessGap[];
  /** Deterministic SHA-256 digest (`sha256:<hex>`) over canonical sorted-key JSON. */
  digest: string;
}

export interface BuildTargetCompletenessInput {
  source: ContractSource;
  contractId: string;
  requestedFromRaw: string | number;
  requestedToLedger: number | null;
  retentionWindow: { oldestLedger: number; latestLedger: number } | null;
  /** Inclusive start ledger actually walked (after floor clamping), if any walk occurred. */
  walkStartLedger: number | null;
  /** Inclusive upper ledger bound proven exhausted by the walk, if any. */
  walkExhaustedToLedger: number | null;
  startClamped: boolean;
  stoppedByMaxPages: boolean;
  scanFailed: boolean;
  pagesObserved: number;
  eventsObserved: number;
}

const MAX_UINT32 = 4_294_967_295n;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

function parseRequestedStart(raw: string | number): {
  normalizedFrom: string;
  fromLedger: number | null;
  isCursor: boolean;
  isMidLedgerCursor: boolean;
} {
  const normalizedFrom = String(raw).trim();
  if (/^\d+$/.test(normalizedFrom)) {
    const ledger = Number(normalizedFrom);
    if (Number.isSafeInteger(ledger) && ledger >= 1) {
      return {
        normalizedFrom,
        fromLedger: ledger,
        isCursor: false,
        isMidLedgerCursor: false,
      };
    }
  }

  const cursorMatch = /^(\d+)-(\d+)$/.exec(normalizedFrom);
  if (cursorMatch && cursorMatch[1] !== undefined && cursorMatch[2] !== undefined) {
    try {
      const toid = BigInt(cursorMatch[1]);
      const opIdx = BigInt(cursorMatch[2]);
      if (toid <= MAX_UINT64 && opIdx <= MAX_UINT32) {
        const ledger = eventCursorLedger(normalizedFrom);
        if (ledger !== null && ledger >= 1) {
          const subLedgerOffset = (toid & 0xffffffffn) > 0n || opIdx > 0n;
          return {
            normalizedFrom,
            fromLedger: ledger,
            isCursor: true,
            isMidLedgerCursor: subLedgerOffset,
          };
        }
      }
    } catch {
      // Fall through to opaque cursor.
    }
  }

  return {
    normalizedFrom,
    fromLedger: null,
    isCursor: true,
    isMidLedgerCursor: false,
  };
}

function makeSpan(from: number, to: number): ReplayLedgerSpan | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
    return null;
  }
  return {
    from,
    to,
    count: to - from + 1,
  };
}

function makeBoundedGap(
  source: ContractSource,
  from: number,
  to: number,
  reason: ReplayCompletenessGapReason,
): ReplayCompletenessGap | null {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) {
    return null;
  }
  return {
    source,
    from,
    to,
    count: to - from + 1,
    reason,
  };
}

function compareGaps(a: ReplayCompletenessGap, b: ReplayCompletenessGap): number {
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const fromA = a.from ?? -1;
  const fromB = b.from ?? -1;
  if (fromA !== fromB) return fromA - fromB;
  const toA = a.to ?? -1;
  const toB = b.to ?? -1;
  if (toA !== toB) return toA - toB;
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  return 0;
}

/**
 * Recursively canonicalize any JSON-serializable value by sorting object keys
 * lexicographically and omitting `undefined` fields.
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v !== undefined) {
      sorted[key] = canonicalizeJsonValue(v);
    }
  }
  return sorted;
}

/** Compute the canonical SHA-256 digest of a completeness certificate body. */
export function computeCertificateDigest(
  body: Omit<ReplayCompletenessCertificate, "digest">,
): string {
  const canonicalJson = JSON.stringify(canonicalizeJsonValue(body));
  const hex = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `sha256:${hex}`;
}

/** Build deterministic completeness details for a single contract target. */
export function buildTargetCompleteness(
  input: BuildTargetCompletenessInput,
): ReplayTargetCompleteness {
  const parsedStart = parseRequestedStart(input.requestedFromRaw);
  const requestedTo = input.requestedToLedger;
  const window = input.retentionWindow;
  const resolvedTo =
    window !== null
      ? requestedTo !== null
        ? Math.min(requestedTo, window.latestLedger)
        : window.latestLedger
      : requestedTo;

  const gaps: ReplayCompletenessGap[] = [];

  // 1. Opaque cursor start cannot prove ledger coverage.
  if (parsedStart.fromLedger === null) {
    gaps.push({
      source: input.source,
      from: null,
      to: requestedTo ?? window?.latestLedger ?? null,
      count: null,
      reason: "opaque-cursor-start",
    });

    return {
      source: input.source,
      contractId: input.contractId,
      complete: false,
      requestedRange: {
        from: parsedStart.normalizedFrom,
        fromLedger: null,
        toLedger: requestedTo,
        resolvedToLedger: resolvedTo,
      },
      retentionWindow: window
        ? { oldestLedger: window.oldestLedger, latestLedger: window.latestLedger }
        : null,
      observedRange: null,
      unresolvedGaps: gaps,
      pagesObserved: input.pagesObserved,
      eventsObserved: input.eventsObserved,
    };
  }

  const reqFrom = parsedStart.fromLedger;
  const targetGoalEnd = requestedTo ?? window?.latestLedger ?? null;

  // 2. If health check itself failed before a retention window was obtained.
  if (window === null) {
    const committedSpan =
      input.walkStartLedger !== null && input.walkExhaustedToLedger !== null
        ? makeSpan(input.walkStartLedger, input.walkExhaustedToLedger)
        : null;
    const gapStart = committedSpan ? committedSpan.to + 1 : reqFrom;
    gaps.push({
      source: input.source,
      from: gapStart,
      to: targetGoalEnd,
      count:
        targetGoalEnd !== null && targetGoalEnd >= gapStart
          ? targetGoalEnd - gapStart + 1
          : null,
      reason: "scan-failed",
    });

    return {
      source: input.source,
      contractId: input.contractId,
      complete: false,
      requestedRange: {
        from: parsedStart.normalizedFrom,
        fromLedger: reqFrom,
        toLedger: requestedTo,
        resolvedToLedger: null,
      },
      retentionWindow: null,
      observedRange: committedSpan,
      unresolvedGaps: gaps.sort(compareGaps),
      pagesObserved: input.pagesObserved,
      eventsObserved: input.eventsObserved,
    };
  }

  // 3. Pruned range prior to RPC retention floor (`oldestLedger`).
  const effectiveFloor = Math.max(
    window.oldestLedger,
    input.startClamped && input.walkStartLedger !== null
      ? input.walkStartLedger
      : window.oldestLedger,
  );
  if (reqFrom < effectiveFloor || input.startClamped) {
    const prunedEndCap =
      targetGoalEnd !== null
        ? Math.min(targetGoalEnd, effectiveFloor - 1)
        : effectiveFloor - 1;
    const prunedGap = makeBoundedGap(
      input.source,
      reqFrom,
      prunedEndCap,
      "pruned-before-retention-floor",
    );
    if (prunedGap) {
      gaps.push(prunedGap);
    }
  }

  // 4. Requested `--to` ahead of current chain tip (`latestLedger`).
  if (requestedTo !== null && requestedTo > window.latestLedger) {
    const beyondStart = Math.max(reqFrom, window.latestLedger + 1);
    const beyondGap = makeBoundedGap(
      input.source,
      beyondStart,
      requestedTo,
      "beyond-chain-tip",
    );
    if (beyondGap) {
      gaps.push(beyondGap);
    }
  }

  // Compute reachable sub-window [reachableFrom, reachableTo].
  const reachableFrom = Math.max(reqFrom, effectiveFloor);
  const reachableTo =
    requestedTo !== null ? Math.min(requestedTo, window.latestLedger) : window.latestLedger;

  let observedRange: ReplayLedgerSpan | null = null;

  if (reachableFrom <= reachableTo) {
    // 5. Mid-ledger TOID cursor start leaves the initial cursor ledger only partially scanned.
    let fullyObservedStart = input.walkStartLedger ?? reachableFrom;
    if (parsedStart.isMidLedgerCursor && reqFrom >= effectiveFloor) {
      const partialGap = makeBoundedGap(
        input.source,
        reqFrom,
        reqFrom,
        "partial-cursor-start",
      );
      if (partialGap) {
        gaps.push(partialGap);
      }
      fullyObservedStart = Math.max(fullyObservedStart, reqFrom + 1);
    }

    if (input.scanFailed) {
      if (
        input.walkExhaustedToLedger !== null &&
        input.walkExhaustedToLedger >= fullyObservedStart
      ) {
        const clampedEnd = Math.min(input.walkExhaustedToLedger, reachableTo);
        observedRange = makeSpan(fullyObservedStart, clampedEnd);
        const failGap = makeBoundedGap(
          input.source,
          clampedEnd + 1,
          reachableTo,
          "scan-failed",
        );
        if (failGap) gaps.push(failGap);
      } else {
        observedRange = null;
        const failGap = makeBoundedGap(
          input.source,
          fullyObservedStart,
          reachableTo,
          "scan-failed",
        );
        if (failGap) gaps.push(failGap);
      }
    } else if (input.stoppedByMaxPages) {
      if (
        input.walkExhaustedToLedger !== null &&
        input.walkExhaustedToLedger >= fullyObservedStart
      ) {
        const clampedEnd = Math.min(input.walkExhaustedToLedger, reachableTo);
        observedRange = makeSpan(fullyObservedStart, clampedEnd);
        const truncGap = makeBoundedGap(
          input.source,
          clampedEnd + 1,
          reachableTo,
          "truncated-page-budget",
        );
        if (truncGap) gaps.push(truncGap);
      } else {
        observedRange = null;
        const truncGap = makeBoundedGap(
          input.source,
          fullyObservedStart,
          reachableTo,
          "truncated-page-budget",
        );
        if (truncGap) gaps.push(truncGap);
      }
    } else if (
      input.walkExhaustedToLedger !== null &&
      input.walkExhaustedToLedger >= fullyObservedStart
    ) {
      const clampedEnd = Math.min(input.walkExhaustedToLedger, reachableTo);
      observedRange = makeSpan(fullyObservedStart, clampedEnd);
      if (clampedEnd < reachableTo) {
        const tailGap = makeBoundedGap(
          input.source,
          clampedEnd + 1,
          reachableTo,
          "truncated-page-budget",
        );
        if (tailGap) gaps.push(tailGap);
      }
    }
  }

  gaps.sort(compareGaps);

  const expectedGoalEnd = requestedTo ?? window.latestLedger;
  const complete =
    !input.scanFailed &&
    !input.stoppedByMaxPages &&
    !input.startClamped &&
    gaps.length === 0 &&
    observedRange !== null &&
    observedRange.from === reqFrom &&
    observedRange.to === expectedGoalEnd &&
    observedRange.count === expectedGoalEnd - reqFrom + 1;

  return {
    source: input.source,
    contractId: input.contractId,
    complete,
    requestedRange: {
      from: parsedStart.normalizedFrom,
      fromLedger: reqFrom,
      toLedger: requestedTo,
      resolvedToLedger: resolvedTo,
    },
    retentionWindow: {
      oldestLedger: window.oldestLedger,
      latestLedger: window.latestLedger,
    },
    observedRange,
    unresolvedGaps: gaps,
    pagesObserved: input.pagesObserved,
    eventsObserved: input.eventsObserved,
  };
}

/** Assemble and hash a deterministic `ReplayCompletenessCertificate` across all targets. */
export function buildReplayCompletenessCertificate(input: {
  network: string;
  contracts: readonly ContractSource[];
  requestedFrom: string | number;
  requestedTo: number | null;
  targets: readonly ReplayTargetCompleteness[];
}): ReplayCompletenessCertificate {
  const parsedStart = parseRequestedStart(input.requestedFrom);
  const sortedContracts = [...input.contracts].sort() as ContractSource[];
  const sortedTargets = [...input.targets].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0,
  );
  const allGaps = sortedTargets
    .flatMap((t) => t.unresolvedGaps)
    .sort(compareGaps);

  const complete =
    sortedTargets.length > 0 &&
    sortedTargets.length === sortedContracts.length &&
    allGaps.length === 0 &&
    sortedTargets.every((t) => t.complete === true);

  const body: Omit<ReplayCompletenessCertificate, "digest"> = {
    format: "mimir-replay-completeness-v1",
    version: 1,
    network: input.network,
    contracts: sortedContracts,
    complete,
    requestedRange: {
      from: parsedStart.normalizedFrom,
      fromLedger: parsedStart.fromLedger,
      toLedger: input.requestedTo,
    },
    targets: sortedTargets,
    unresolvedGaps: allGaps,
  };

  return {
    ...body,
    digest: computeCertificateDigest(body),
  };
}

/**
 * Verify a completeness certificate's digest and structural soundness
 * (guaranteeing no certificate with gaps or partial bounds can validate as complete).
 */
export function verifyReplayCompletenessCertificate(
  cert: ReplayCompletenessCertificate,
): boolean {
  if (!cert || typeof cert !== "object") return false;
  if (cert.format !== "mimir-replay-completeness-v1" || cert.version !== 1) return false;

  const { digest, ...body } = cert;
  if (typeof digest !== "string" || computeCertificateDigest(body) !== digest) {
    return false;
  }

  if (cert.complete) {
    if (cert.unresolvedGaps.length > 0) return false;
    if (cert.targets.length === 0) return false;
    if (cert.requestedRange.fromLedger === null) return false;
    for (const target of cert.targets) {
      if (!target.complete) return false;
      if (target.unresolvedGaps.length > 0) return false;
      if (!target.observedRange) return false;
      const goalEnd =
        target.requestedRange.toLedger ?? target.requestedRange.resolvedToLedger;
      if (
        goalEnd === null ||
        target.observedRange.from !== cert.requestedRange.fromLedger ||
        target.observedRange.to !== goalEnd
      ) {
        return false;
      }
    }
  }

  return true;
}

/** Format a completeness certificate into canonical deterministic JSON text. */
export function formatCompletenessCertificateJson(
  cert: ReplayCompletenessCertificate,
): string {
  return `${JSON.stringify(canonicalizeJsonValue(cert), null, 2)}\n`;
}

/** Atomically write a completeness certificate to disk via temporary sibling rename. */
export async function writeCompletenessCertificateAtomic(
  filePath: string,
  cert: ReplayCompletenessCertificate,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, formatCompletenessCertificateJson(cert), "utf8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // Ignore missing temp file.
    }
    throw err;
  }
}
