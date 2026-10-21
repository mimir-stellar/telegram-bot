/**
 * Compute challenge statistics per claim category.
 *
 * Tracks how often claims in each category get challenged and how challenges resolve.
 * Events are joined by claimId; claims whose creation is outside the window are
 * assigned to an "unknown" category.
 */

import type { Event } from "./events.js";

/**
 * Statistics for a single category.
 */
export interface CategoryStats {
  /** Normalized category name. */
  category: string;
  /** Number of claims created in this category. */
  created: number;
  /** Number of claims that were challenged. */
  challenged: number;
  /** Number of challenges where the challenger won (winnerSide = 2). */
  challengerWon: number;
  /** Number of challenges where the creator won (winnerSide = 1). */
  creatorWon: number;
  /** Challenge rate per mille (‰) = (challenged / created) * 1000. */
  challengeRatePerMille: number;
  /** Challenger win rate per mille (‰) = (challengerWon / challenged) * 1000. */
  challengerWinRatePerMille: number;
}

/**
 * Result of category statistics computation.
 */
export interface CategoryStatsResult {
  /** Statistics per category, sorted deterministically by category name. */
  byCategory: CategoryStats[];
  /** Total number of claims created across all categories. */
  totalCreated: number;
  /** Total number of claims challenged across all categories. */
  totalChallenged: number;
}

/**
 * Normalize a category string for consistent grouping.
 *
 * Trims whitespace and lowercases the string. If a `normalizeCategory` function
 * is available in the future, it should be used instead.
 */
function normalizeCategory(category: string): string {
  return category.trim().toLowerCase();
}

/**
 * Compute challenge statistics per claim category from a list of events.
 *
 * Events are joined by claimId:
 * - `claim_created` provides the category
 * - `claim_challenged` marks a claim as challenged
 * - `claim_resolved` provides the winner (winnerSide: 1 = creator, 2 = challenger)
 *
 * Claims whose creation event is missing from the input are assigned to the
 * "unknown" category.
 *
 * @param events List of decoded events to analyze
 * @returns Category statistics with per-mille rates
 */
export function categoryStats(events: readonly Event[]): CategoryStatsResult {
  // Map: claimId -> category (from claim_created)
  const claimCategories = new Map<number, string>();

  // Map: claimId -> challenged (from claim_challenged)
  const claimChallenged = new Map<number, boolean>();

  // Map: claimId -> winnerSide (from claim_resolved)
  const claimWinners = new Map<number, number>();

  // First pass: extract data from events
  for (const event of events) {
    if (event.source !== "market") continue;

    const payload = event.payload;
    if (!payload) continue;

    if (payload.name === "claim_created") {
      claimCategories.set(payload.claimId, normalizeCategory(payload.category));
    } else if (payload.name === "claim_challenged") {
      claimChallenged.set(payload.claimId, true);
    } else if (payload.name === "claim_resolved") {
      claimWinners.set(payload.claimId, payload.winnerSide);
    }
  }

  // Map: category -> aggregated stats
  const statsByCategory = new Map<string, {
    created: number;
    challenged: number;
    challengerWon: number;
    creatorWon: number;
  }>();

  // Second pass: aggregate by category
  for (const [claimId, category] of claimCategories) {
    const current = statsByCategory.get(category) ?? {
      created: 0,
      challenged: 0,
      challengerWon: 0,
      creatorWon: 0,
    };

    current.created += 1;

    if (claimChallenged.has(claimId)) {
      current.challenged += 1;

      const winnerSide = claimWinners.get(claimId);
      if (winnerSide === 2) {
        current.challengerWon += 1;
      } else if (winnerSide === 1) {
        current.creatorWon += 1;
      }
    }

    statsByCategory.set(category, current);
  }

  // Handle claims that were challenged but have no creation event (unknown category)
  for (const [claimId] of claimChallenged) {
    if (!claimCategories.has(claimId)) {
      const current = statsByCategory.get("unknown") ?? {
        created: 0,
        challenged: 0,
        challengerWon: 0,
        creatorWon: 0,
      };

      current.challenged += 1;

      const winnerSide = claimWinners.get(claimId);
      if (winnerSide === 2) {
        current.challengerWon += 1;
      } else if (winnerSide === 1) {
        current.creatorWon += 1;
      }

      statsByCategory.set("unknown", current);
    }
  }

  // Convert to CategoryStats with per-mille rates
  const byCategory: CategoryStats[] = [];

  for (const [category, stats] of statsByCategory) {
    const challengeRatePerMille = stats.created > 0
      ? Math.round((stats.challenged / stats.created) * 1000)
      : 0;

    const challengerWinRatePerMille = stats.challenged > 0
      ? Math.round((stats.challengerWon / stats.challenged) * 1000)
      : 0;

    byCategory.push({
      category,
      created: stats.created,
      challenged: stats.challenged,
      challengerWon: stats.challengerWon,
      creatorWon: stats.creatorWon,
      challengeRatePerMille,
      challengerWinRatePerMille,
    });
  }

  // Sort deterministically by category name
  byCategory.sort((a, b) => a.category.localeCompare(b.category));

  // Compute totals
  const totalCreated = byCategory.reduce((sum, s) => sum + s.created, 0);
  const totalChallenged = byCategory.reduce((sum, s) => sum + s.challenged, 0);

  return {
    byCategory,
    totalCreated,
    totalChallenged,
  };
}
