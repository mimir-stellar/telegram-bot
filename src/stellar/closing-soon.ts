/**
 * Rank open squad markets by how soon their deadline arrives.
 *
 * Pure, time-injected: `nowSec` and `horizonSec` are parameters, never wall
 * clock. A market counts as "closing soon" when it has a `market_created`
 * event, no `resolved` event for the same market, a deadline strictly in the
 * future, and that deadline falls within `horizonSec` seconds of `nowSec`.
 * Results are sorted by deadline ascending; duplicate `market_created` events
 * for one market collapse to a single entry.
 */

import type { DecodedEvent } from "./decode.js";

export interface ClosingSoonMarket {
  marketId: number;
  deadline: number;
  question: string;
  captain: string;
  feeBps: number;
}

export function closingSoon(
  events: readonly DecodedEvent[],
  nowSec: number,
  horizonSec: number,
): ClosingSoonMarket[] {
  const resolved = new Set<number>();
  for (const event of events) {
    if (event.source !== "squad") continue;
    if (event.payload.name === "resolved") resolved.add(event.payload.marketId);
  }

  const markets = new Map<number, ClosingSoonMarket>();
  const horizon = Math.max(0, horizonSec);
  for (const event of events) {
    if (event.source !== "squad") continue;
    const p = event.payload;
    if (p.name !== "market_created") continue;
    if (resolved.has(p.marketId)) continue;
    if (!Number.isFinite(p.deadline)) continue;
    if (p.deadline <= nowSec) continue;
    if (p.deadline - nowSec > horizon) continue;
    markets.set(p.marketId, {
      marketId: p.marketId,
      deadline: p.deadline,
      question: p.question,
      captain: p.captain,
      feeBps: p.feeBps,
    });
  }

  return [...markets.values()].sort((a, b) => a.deadline - b.deadline);
}
