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

/**
 * An explicit inconsistency: the same claim identity has terminal events that
 * contradict each other (e.g. both a resolution and a cancellation, or more than
 * one distinct resolution outcome). Such claims are never silently resolved to
 * the last or earliest event; they are reported here and excluded from groups.
 */
export interface ConflictingTerminalEvents {
  claimId: number;
  resolutionLedgers: number[];
  cancellationLedgers: number[];
  reason: "resolved_and_cancelled" | "multiple_resolutions" | "multiple_cancellations";
}

export interface ResolutionLatencyReport {
  resolved: LatencyGroup;
  cancelled: LatencyGroup;
  excludedCount: number;
  conflicts: ConflictingTerminalEvents[];
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

interface Marker {
  at: number;
  ledger: number;
}

function earlier(a: Marker, b: Marker): boolean {
  return a.ledger < b.ledger || (a.ledger === b.ledger && a.at < b.at);
}

/**
 * Computes durations from creation to resolution/cancellation per claim.
 *
 * Excludes claims missing either creation or resolution/cancellation event.
 * If multiple creation events exist for the same claimId, deterministic
 * earliest creation is used.
 *
 * Contradictory terminal events for the same claimId (a resolution together with
 * a cancellation, or multiple resolutions / multiple cancellations) are reported
 * explicitly in `conflicts` and the claim is excluded from both groups, rather
 * than silently selecting one of the events.
 *
 * Uses integer math only.
 */
export function resolutionLatency(events: readonly DecodedEvent[]): ResolutionLatencyReport {
  const creations = new Map<number, Marker>();
  const resolutions = new Map<number, Marker[]>();
  const cancellations = new Map<number, Marker[]>();

  for (const event of events) {
    const payload = event.payload;
    if (!payload || !("name" in payload) || !("claimId" in payload)) {
      continue;
    }

    const claimId = payload.claimId;
    if (typeof claimId !== "number" || !Number.isFinite(claimId)) {
      continue;
    }

    const marker: Marker = { at: Math.trunc(event.at), ledger: Math.trunc(event.ledger) };

    if (payload.name === "claim_created") {
      const existing = creations.get(claimId);
      if (!existing || earlier(marker, existing)) {
        creations.set(claimId, marker);
      }
    } else if (payload.name === "claim_resolved") {
      const list = resolutions.get(claimId) ?? [];
      list.push(marker);
      resolutions.set(claimId, list);
    } else if (payload.name === "claim_cancelled") {
      const list = cancellations.get(claimId) ?? [];
      list.push(marker);
      cancellations.set(claimId, list);
    }
  }

  // All known claimIds across any event type
  const allClaimIds = new Set<number>([
    ...creations.keys(),
    ...resolutions.keys(),
    ...cancellations.keys(),
  ]);

  const resolvedClaims: ClaimLatency[] = [];
  const cancelledClaims: ClaimLatency[] = [];
  const conflicts: ConflictingTerminalEvents[] = [];
  let excludedCount = 0;

  for (const claimId of allClaimIds) {
    const creation = creations.get(claimId);
    const resolutionList = resolutions.get(claimId) ?? [];
    const cancellationList = cancellations.get(claimId) ?? [];

    // Contradictory terminal events: surface explicitly, never pick silently.
    let conflictReason: ConflictingTerminalEvents["reason"] | null = null;
    if (resolutionList.length > 0 && cancellationList.length > 0) {
      conflictReason = "resolved_and_cancelled";
    } else if (resolutionList.length > 1) {
      conflictReason = "multiple_resolutions";
    } else if (cancellationList.length > 1) {
      conflictReason = "multiple_cancellations";
    }

    if (conflictReason) {
      conflicts.push({
        claimId,
        resolutionLedgers: resolutionList.map((m) => m.ledger).sort((a, b) => a - b),
        cancellationLedgers: cancellationList.map((m) => m.ledger).sort((a, b) => a - b),
        reason: conflictReason,
      });
      excludedCount++;
      continue;
    }

    // If missing creation, it cannot form a duration
    if (!creation) {
      excludedCount++;
      continue;
    }

    const resolution = resolutionList[0];
    const cancellation = cancellationList[0];

    let endEvent: Marker | null = null;
    let endType: "resolved" | "cancelled" | null = null;

    if (resolution) {
      endEvent = resolution;
      endType = "resolved";
    } else if (cancellation) {
      endEvent = cancellation;
      endType = "cancelled";
    }

    if (!endEvent || !endType) {
      // Incomplete claim (missing end)
      excludedCount++;
      continue;
    }

    const durationSec = Math.max(0, Math.trunc(endEvent.at - creation.at));
    const durationLedgers = Math.max(0, Math.trunc(endEvent.ledger - creation.ledger));

    const claimLatency: ClaimLatency = {
      claimId,
      creationLedger: creation.ledger,
      creationAt: creation.at,
      resolutionLedger: endEvent.ledger,
      resolutionAt: endEvent.at,
      duration: {
        seconds: durationSec,
        ledgers: durationLedgers,
      },
    };

    if (endType === "resolved") {
      resolvedClaims.push(claimLatency);
    } else {
      cancelledClaims.push(claimLatency);
    }
  }

  // Ensure deterministic ordering by claimId ascending
  resolvedClaims.sort((a, b) => a.claimId - b.claimId);
  cancelledClaims.sort((a, b) => a.claimId - b.claimId);
  conflicts.sort((a, b) => a.claimId - b.claimId);

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
    conflicts,
  };
}
