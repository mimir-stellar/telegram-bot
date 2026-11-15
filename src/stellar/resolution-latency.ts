import { eventKey } from "../dedup.js";
import type { DecodedEvent } from "./decode.js";

export interface LatencyDuration {
  seconds: number;
  ledgers: number;
}

export interface ClaimLatency {
  claimId: number;
  creationLedger: number;
  creationAt: number;
  resolutionLedger: number;
  resolutionAt: number;
  duration: LatencyDuration;
}

export interface LatencySummary {
  p50: LatencyDuration;
  p90: LatencyDuration;
  max: LatencyDuration;
}

export interface LatencyGroup {
  claims: ClaimLatency[];
  summary: LatencySummary | null;
}

export type TerminalEventKind = "claim_resolved" | "claim_cancelled";

export type ResolutionConflictReason =
  | "resolved_and_cancelled"
  | "conflicting_winner_side"
  | "conflicting_evidence";

export interface TerminalEventObservation {
  kind: TerminalEventKind;
  ledger: number;
  at: number;
  eventId?: string;
  txHash?: string;
  winnerSide?: number;
  evidenceHash?: string;
}

export interface ResolutionInconsistency {
  /** Scoped identity (`"<contractId>:<claimId>"`, or `"<claimId>"` when contractId is empty). */
  identity: string;
  contractId: string;
  claimId: number;
  reason: ResolutionConflictReason;
  creationLedger: number | null;
  creationAt: number | null;
  terminalEvents: TerminalEventObservation[];
}

export interface ResolutionLatencyReport {
  resolved: LatencyGroup;
  cancelled: LatencyGroup;
  excludedCount: number;
  inconsistencies: ResolutionInconsistency[];
}

/**
 * Calculates the p-th percentile (0 <= p <= 100) using nearest-rank integer indexing.
 * For a sorted non-empty array of length N, rank = Math.ceil((p / 100) * N) -> index = rank - 1.
 * For p=0, returns values[0].
 */
function nearestRank(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.max(0, Math.min(sortedValues.length - 1, rank - 1));
  return sortedValues[index]!;
}

function computeSummary(claims: ClaimLatency[]): LatencySummary | null {
  if (claims.length === 0) {
    return null;
  }

  const sortedSec = claims.map((c) => c.duration.seconds).sort((a, b) => a - b);
  const sortedLed = claims.map((c) => c.duration.ledgers).sort((a, b) => a - b);

  return {
    p50: {
      seconds: nearestRank(sortedSec, 50),
      ledgers: nearestRank(sortedLed, 50),
    },
    p90: {
      seconds: nearestRank(sortedSec, 90),
      ledgers: nearestRank(sortedLed, 90),
    },
    max: {
      seconds: sortedSec[sortedSec.length - 1]!,
      ledgers: sortedLed[sortedLed.length - 1]!,
    },
  };
}

interface ClaimAccumulator {
  identity: string;
  contractId: string;
  claimId: number;
  creation: { at: number; ledger: number } | null;
  seenEventKeys: Set<string>;
  seenSignatures: Set<string>;
  terminals: TerminalEventObservation[];
}

function compareTerminalObservations(
  a: TerminalEventObservation,
  b: TerminalEventObservation,
): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  if (a.at !== b.at) return a.at - b.at;
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  const aSide = a.winnerSide ?? -1;
  const bSide = b.winnerSide ?? -1;
  if (aSide !== bSide) return aSide - bSide;
  const aEv = a.evidenceHash ?? "";
  const bEv = b.evidenceHash ?? "";
  if (aEv !== bEv) return aEv.localeCompare(bEv);
  const aId = a.eventId ?? "";
  const bId = b.eventId ?? "";
  if (aId !== bId) return aId.localeCompare(bId);
  return (a.txHash ?? "").localeCompare(b.txHash ?? "");
}

function detectTerminalConflict(
  terminals: readonly TerminalEventObservation[],
): ResolutionConflictReason | null {
  if (terminals.length <= 1) {
    return null;
  }

  let hasResolved = false;
  let hasCancelled = false;
  const winnerSides = new Set<number | undefined>();
  const evidenceHashes = new Set<string>();

  for (const term of terminals) {
    if (term.kind === "claim_resolved") {
      hasResolved = true;
      winnerSides.add(term.winnerSide);
      if (typeof term.evidenceHash === "string" && term.evidenceHash.length > 0) {
        evidenceHashes.add(term.evidenceHash);
      }
    } else if (term.kind === "claim_cancelled") {
      hasCancelled = true;
    }
  }

  if (hasResolved && hasCancelled) {
    return "resolved_and_cancelled";
  }

  if (winnerSides.size > 1) {
    return "conflicting_winner_side";
  }

  if (evidenceHashes.size > 1) {
    return "conflicting_evidence";
  }

  return null;
}

/**
 * Computes durations from creation to resolution/cancellation per claim identity.
 *
 * - Excludes claims missing either creation or resolution/cancellation event.
 * - Detects contradictory terminal events for the same `(contractId, claimId)` identity
 *   (`claim_resolved` + `claim_cancelled`, conflicting `winnerSide`, or conflicting
 *   `evidenceHash`), surfaces an explicit `ResolutionInconsistency` entry in
 *   `inconsistencies`, increments `excludedCount`, and withholds the claim from
 *   latency summaries rather than silently picking an event.
 * - Idempotent duplicate re-deliveries with matching terminal outcomes collapse cleanly
 *   using deterministic earliest `(ledger, at)`.
 *
 * Uses integer math only.
 */
export function resolutionLatency(events: readonly DecodedEvent[]): ResolutionLatencyReport {
  const claimsByIdentity = new Map<string, ClaimAccumulator>();

  if (Array.isArray(events)) {
    for (const event of events) {
      if (!event || typeof event !== "object") {
        continue;
      }
      const payload = event.payload;
      if (!payload || typeof payload !== "object" || !("name" in payload) || !("claimId" in payload)) {
        continue;
      }

      const claimId = payload.claimId;
      if (typeof claimId !== "number" || !Number.isFinite(claimId)) {
        continue;
      }

      if (
        typeof event.ledger !== "number" ||
        !Number.isFinite(event.ledger) ||
        typeof event.at !== "number" ||
        !Number.isFinite(event.at)
      ) {
        continue;
      }

      const ledger = Math.trunc(event.ledger);
      const at = Math.trunc(event.at);
      const contractId = typeof event.contractId === "string" ? event.contractId.trim() : "";
      const identity = contractId ? `${contractId}:${claimId}` : String(claimId);

      let acc = claimsByIdentity.get(identity);
      if (!acc) {
        acc = {
          identity,
          contractId,
          claimId,
          creation: null,
          seenEventKeys: new Set<string>(),
          seenSignatures: new Set<string>(),
          terminals: [],
        };
        claimsByIdentity.set(identity, acc);
      }

      if (payload.name === "claim_created") {
        const existing = acc.creation;
        if (!existing || ledger < existing.ledger || (ledger === existing.ledger && at < existing.at)) {
          acc.creation = { at, ledger };
        }
      } else if (payload.name === "claim_resolved" || payload.name === "claim_cancelled") {
        const winnerSide =
          payload.name === "claim_resolved" &&
          typeof payload.winnerSide === "number" &&
          Number.isFinite(payload.winnerSide)
            ? payload.winnerSide
            : undefined;
        const evidenceHash =
          payload.name === "claim_resolved" &&
          typeof payload.evidenceHash === "string" &&
          payload.evidenceHash.length > 0
            ? payload.evidenceHash
            : undefined;
        const eventId =
          typeof event.eventId === "string" && event.eventId.length > 0 ? event.eventId : undefined;
        const txHash =
          typeof event.txHash === "string" && event.txHash.length > 0 ? event.txHash : undefined;

        const signature = `${payload.name}|${ledger}|${at}|${winnerSide ?? ""}|${evidenceHash ?? ""}`;
        const canonicalKey = eventKey(event);

        // Collapse exact redelivered duplicates while retaining any distinct terminal assertion
        if (acc.seenSignatures.has(signature)) {
          continue;
        }
        if (canonicalKey !== null && acc.seenEventKeys.has(`${canonicalKey}|${payload.name}|${winnerSide ?? ""}|${evidenceHash ?? ""}`)) {
          continue;
        }

        acc.seenSignatures.add(signature);
        if (canonicalKey !== null) {
          acc.seenEventKeys.add(`${canonicalKey}|${payload.name}|${winnerSide ?? ""}|${evidenceHash ?? ""}`);
        }

        const observation: TerminalEventObservation = {
          kind: payload.name,
          ledger,
          at,
          ...(eventId !== undefined ? { eventId } : {}),
          ...(txHash !== undefined ? { txHash } : {}),
          ...(winnerSide !== undefined ? { winnerSide } : {}),
          ...(evidenceHash !== undefined ? { evidenceHash } : {}),
        };
        acc.terminals.push(observation);
      }
    }
  }

  const resolvedClaims: ClaimLatency[] = [];
  const cancelledClaims: ClaimLatency[] = [];
  const inconsistencies: ResolutionInconsistency[] = [];
  let excludedCount = 0;

  for (const acc of claimsByIdentity.values()) {
    const sortedTerminals = [...acc.terminals].sort(compareTerminalObservations);
    const conflictReason = detectTerminalConflict(sortedTerminals);

    if (conflictReason !== null) {
      inconsistencies.push({
        identity: acc.identity,
        contractId: acc.contractId,
        claimId: acc.claimId,
        reason: conflictReason,
        creationLedger: acc.creation ? acc.creation.ledger : null,
        creationAt: acc.creation ? acc.creation.at : null,
        terminalEvents: sortedTerminals,
      });
      excludedCount++;
      continue;
    }

    if (!acc.creation || sortedTerminals.length === 0) {
      excludedCount++;
      continue;
    }

    const earliestTerminal = sortedTerminals[0]!;
    const durationSec = Math.max(0, Math.trunc(earliestTerminal.at - acc.creation.at));
    const durationLedgers = Math.max(0, Math.trunc(earliestTerminal.ledger - acc.creation.ledger));

    const claimLatency: ClaimLatency = {
      claimId: acc.claimId,
      creationLedger: acc.creation.ledger,
      creationAt: acc.creation.at,
      resolutionLedger: earliestTerminal.ledger,
      resolutionAt: earliestTerminal.at,
      duration: {
        seconds: durationSec,
        ledgers: durationLedgers,
      },
    };

    if (earliestTerminal.kind === "claim_resolved") {
      resolvedClaims.push(claimLatency);
    } else {
      cancelledClaims.push(claimLatency);
    }
  }

  // Deterministic ordering across claims and inconsistencies regardless of arrival order
  const compareClaims = (a: ClaimLatency, b: ClaimLatency): number => {
    if (a.claimId !== b.claimId) return a.claimId - b.claimId;
    if (a.creationLedger !== b.creationLedger) return a.creationLedger - b.creationLedger;
    return a.resolutionLedger - b.resolutionLedger;
  };
  resolvedClaims.sort(compareClaims);
  cancelledClaims.sort(compareClaims);

  inconsistencies.sort((a, b) => {
    if (a.claimId !== b.claimId) return a.claimId - b.claimId;
    return a.contractId.localeCompare(b.contractId);
  });

  return {
    resolved: {
      claims: resolvedClaims,
      summary: computeSummary(resolvedClaims),
    },
    cancelled: {
      claims: cancelledClaims,
      summary: computeSummary(cancelledClaims),
    },
    excludedCount,
    inconsistencies,
  };
}
