/**
 * "Squad markets closing soon" notification message.
 *
 * Pure, time-injected: `nowMs` is a parameter, never wall clock. Questions are
 * clipped and MarkdownV2-escaped before interpolation so a crafted remote
 * string cannot break Telegram's parser.
 */

import { clip, escapeMd } from "./format.js";
import { formatDeadline } from "./time.js";
import type { ClosingSoonMarket } from "../stellar/closing-soon.js";

export function closingSoonMessage(
  markets: readonly ClosingSoonMarket[],
  nowMs: number,
): string {
  if (!markets || markets.length === 0) {
    return "🔔 *Squad markets closing soon*\n\nNo markets closing in this window\\.";
  }

  const lines = markets.map((market) => {
    const deadline = escapeMd(formatDeadline(market.deadline, nowMs));
    const question = escapeMd(clip(market.question));
    return `*#${escapeMd(String(market.marketId))}* — ${question} · closes ${deadline}`;
  });

  return ["🔔 *Squad markets closing soon*", "", ...lines].join("\n");
}
