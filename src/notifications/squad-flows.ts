/**
 * Squad market net flow notification message formatting.
 *
 * Formats per-market and per-side deposit, withdrawal, and net flows for Telegram
 * in MarkdownV2.
 *
 * Net amounts are strictly kept as bigint and formatted via `formatUsdc`,
 * never converted to floating-point numbers.
 */

import { formatUsdc, squadSideLabel } from "../stellar/decode.js";
import { escapeMd } from "./format.js";
import type { SquadMarketFlow, SquadSideFlow } from "../stellar/squad-flows.js";

function formatSideFlow(side: SquadSideFlow): string {
  const label = escapeMd(side.sideLabel || squadSideLabel(side.side));
  const sign = side.net > 0n ? "\\+" : "";
  const netStr = `${sign}${escapeMd(formatUsdc(side.net))} USDC`;
  const depStr = `${escapeMd(formatUsdc(side.deposits))} USDC`;
  const withStr = `${escapeMd(formatUsdc(side.withdrawals))} USDC`;
  const count = side.uniqueParticipants;
  const countLabel = escapeMd(`${count} participant${count === 1 ? "" : "s"}`);

  return `• *${label}*: net *${netStr}* \\(in ${depStr} · out ${withStr}\\) · ${countLabel}`;
}

function isMarketFlow(obj: unknown): obj is SquadMarketFlow {
  if (!obj || typeof obj !== "object") return false;
  const rec = obj as Record<string, unknown>;
  return typeof rec.marketId === "number" && Array.isArray(rec.sides);
}

function normalizeMarkets(flow: unknown): SquadMarketFlow[] {
  if (!flow) return [];

  // Single SquadMarketFlow passed
  if (isMarketFlow(flow) && !Array.isArray(flow)) {
    return [flow];
  }

  // Array / SquadFlowsResult passed
  if (Array.isArray(flow)) {
    return flow.filter(isMarketFlow);
  }

  // Map<number, SquadMarketFlow> passed
  if (flow instanceof Map) {
    return Array.from(flow.values()).filter(isMarketFlow);
  }

  // Object with { markets: [...] }
  if (typeof flow === "object" && flow !== null && "markets" in flow) {
    const candidate = (flow as { markets?: unknown }).markets;
    if (Array.isArray(candidate)) {
      return candidate.filter(isMarketFlow);
    }
  }

  return [];
}

/**
 * Format squad market flow totals into a MarkdownV2 Telegram message.
 *
 * Supports a single `SquadMarketFlow`, a list of flows, or an aggregated report.
 * Net amounts are formatted directly from bigint units without numeric conversion.
 */
export function squadFlowsMessage(
  flow?:
    | SquadMarketFlow
    | readonly SquadMarketFlow[]
    | Iterable<SquadMarketFlow>
    | Map<number, SquadMarketFlow>
    | { markets?: readonly SquadMarketFlow[] }
    | null,
): string {
  // If explicitly a single market flow object (not an array)
  if (flow && !Array.isArray(flow) && !(flow instanceof Map) && isMarketFlow(flow)) {
    const header = `📊 *Squad Market #${escapeMd(String(flow.marketId))} Net Flows*`;
    if (flow.sides.length === 0) {
      return `${header}\n\nNo deposit or withdrawal flows recorded\\.`;
    }
    const lines = flow.sides.map(formatSideFlow);
    return [header, "", ...lines].join("\n");
  }

  const markets = normalizeMarkets(flow);

  if (markets.length === 0) {
    return "📊 *Squad Market Net Flows*\n\nNo deposit or withdrawal flows recorded\\.";
  }

  const firstMarket = markets[0];
  if (markets.length === 1 && firstMarket) {
    const header = `📊 *Squad Market #${escapeMd(String(firstMarket.marketId))} Net Flows*`;
    if (firstMarket.sides.length === 0) {
      return `${header}\n\nNo deposit or withdrawal flows recorded\\.`;
    }
    const lines = firstMarket.sides.map(formatSideFlow);
    return [header, "", ...lines].join("\n");
  }

  const sections = markets.map((m) => {
    const header = `*Market #${escapeMd(String(m.marketId))}*`;
    if (m.sides.length === 0) {
      return `${header}\n• No flows recorded\\.`;
    }
    const sideLines = m.sides.map(formatSideFlow);
    return [header, ...sideLines].join("\n");
  });

  return ["📊 *Squad Market Net Flows*", ...sections].join("\n\n");
}
