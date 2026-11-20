/**
 * Format decoded contract events into Telegram HTML messages.
 * ... (unchanged header preserved)
 */

import { txExplorerUrl } from "../stellar/client.js";
import {
  formatUsdc,
  shortAddress,
  squadSideLabel,
  winnerSideLabel,
  type DecodedEvent,
} from "../stellar/decode.js";
import { confidenceIndicator } from "./confidence.js";
import {
  clip,
  eventExplorerUrl,
  eventAllowedByCategory,
  formatPlainTextEvent,
  safeErrorMessage,
} from "./format.js";
import type { StellarConfig } from "../config.js";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

export function escapeHtmlAttr(url: string): string {
  return escapeHtml(url);
}

function usdcHtml(units: bigint): string {
  return escapeHtml(`${formatUsdc(units)} USDC`);
}

function whoHtml(address: string): string {
  return `<code>${escapeHtml(shortAddress(address))}</code>`;
}

function footerHtml(config: StellarConfig, event: DecodedEvent): string {
  const ledger = escapeHtml(`ledger ${event.ledger}`);
  const url = eventExplorerUrl(config, event);
  if (!url) return `<i>${ledger}</i>`;
  return `<i>${ledger}</i> · <a href="${escapeHtmlAttr(url)}">tx</a>`;
}

function headlineHtml(event: DecodedEvent): string | null {
  const p = event.payload;
  switch (p.name) {
    case "claim_created":
      return (
        `🆕 <b>New claim</b> #${escapeHtml(String(p.claimId))}\n` +
        `Category: ${escapeHtml(clip(p.category))}\n` +
        `Creator: ${whoHtml(p.creator)}`
      );
    case "claim_challenged":
      return (
        `⚔️ <b>Claim #${escapeHtml(String(p.claimId))} challenged</b>\n` +
        `Stake: <b>${usdcHtml(p.stake)}</b>\n` +
        `Challenger: ${whoHtml(p.challenger)}`
      );
    case "claim_resolved": {
      const summaryPart = p.summary ? `\n<i>${escapeHtml(clip(p.summary))}</i>` : "";
      return (
        `⚖️ <b>Claim #${escapeHtml(String(p.claimId))} resolved</b> — winner: <b>${escapeHtml(winnerSideLabel(p.winnerSide))}</b>\n` +
        `Confidence: ${escapeHtml(confidenceIndicator(p.confidence))}` +
        summaryPart
      );
    }
    case "claim_cancelled":
      return `🚫 <b>Claim #${escapeHtml(String(p.claimId))} cancelled</b> — stakes returned`;
    case "market_settled":
      return (
        `💰 <b>Claim #${escapeHtml(String(p.claimId))} settled</b>\n` +
        `Paid out: <b>${usdcHtml(p.totalPaid)}</b> · fees ${usdcHtml(p.totalFees)}\n` +
        `Owed to challengers: ${usdcHtml(p.owedToChallengers)}`
      );
    case "challenger_paid":
      return (
        `🏆 <b>Challenger paid</b> on claim #${escapeHtml(String(p.claimId))}\n` +
        `${whoHtml(p.challenger)} staked ${usdcHtml(p.stake)} → net <b>${usdcHtml(p.net)}</b>\n` +
        `Gross ${usdcHtml(p.gross)} · fee ${usdcHtml(p.fee)}`
      );
    case "fee_claimed":
      return `🧾 <b>Fees claimed</b> — ${usdcHtml(p.amount)} to ${whoHtml(p.recipient)}`;
    case "withdrawal":
      return `📤 <b>Withdrawal</b> — ${usdcHtml(p.amount)} to ${whoHtml(p.to)}`;
    case "withdrawal_pending":
      return `⏳ <b>Withdrawal parked</b> — ${usdcHtml(p.amount)} claimable by ${whoHtml(p.to)}`;
    case "market_created":
      return (
        `🆕 <b>New squad market</b> #${escapeHtml(String(p.marketId))}\n` +
        `${escapeHtml(clip(p.question))}\n` +
        `Captain: ${whoHtml(p.captain)} · fee ${escapeHtml(String(p.feeBps))} bps · deadline ${escapeHtml(new Date(p.deadline * 1000).toISOString())}`
      );
    case "deposited":
      return (
        `➕ <b>Squad #${escapeHtml(String(p.marketId))}</b> — ${usdcHtml(p.amount)} on <b>${escapeHtml(squadSideLabel(p.side))}</b>\n` +
        `Participant: ${whoHtml(p.participant)}`
      );
    case "withdrawn":
      return (
        `➖ <b>Squad #${escapeHtml(String(p.marketId))}</b> — ${whoHtml(p.participant)} pulled ${usdcHtml(p.amount)} from ${escapeHtml(squadSideLabel(p.side))}`
      );
    case "resolved":
      return (
        `🏁 <b>Squad #${escapeHtml(String(p.marketId))} resolved</b> — <b>${escapeHtml(squadSideLabel(p.result))}</b>\n` +
        `Pools: A ${usdcHtml(p.poolA)} · B ${usdcHtml(p.poolB)}`
      );
    case "claimed":
      return (
        `💸 <b>Squad payout</b> on #${escapeHtml(String(p.marketId))}\n` +
        `${whoHtml(p.participant)} → net <b>${usdcHtml(p.net)}</b> (gross ${usdcHtml(p.gross)}, fee ${usdcHtml(p.fee)})`
      );
    case "fees_claimed":
      return `🧾 <b>Squad fees claimed</b> — ${usdcHtml(p.amount)} to ${whoHtml(p.recipient)}`;
    case "oracle_changed":
    case "ownership_transferred":
    case "agent_attributed":
    case "fee_accrued":
    case "fee_policy_set":
    case "fee_policy_changed":
    case "fee_policy_updated":
    case "fee_policy_removed":
    case "admin":
    case "unknown":
      return null;
    default:
      return null;
  }
}

/** Options for {@link formatFallbackEventHtml}. */
export interface FallbackHtmlOptions {
  /**
   * When true, the fallback is returned as plain text (via
   * {@link formatPlainTextEvent}) instead of HTML. Image-free or
   * accessibility-focused consumers set this so a rendering failure never
   * deprives the recipient of a text rendering.
   */
  accessibleFallback?: boolean;
}

export function formatFallbackEventHtml(
  config: StellarConfig,
  event: DecodedEvent,
  reason = "malformed payload",
  options: FallbackHtmlOptions = {},
): string {
  if (options.accessibleFallback) {
    return (
      formatPlainTextEvent(config, event) ??
      `Mimir event (${event.source ?? "unknown"}) — ledger ${event.ledger ?? "unknown"} (${safeErrorMessage(reason)})`
    );
  }
  const source = escapeHtml(event.source ?? "unknown");
  const contract = escapeHtml(shortAddress(event.contractId ?? "unknown"));
  const ledger = escapeHtml(String(event.ledger ?? "unknown"));
  const safeReason = escapeHtml(safeErrorMessage(reason));
  const txPart = event.txHash
    ? ` · <a href="${escapeHtmlAttr(txExplorerUrl(config, event.txHash))}">tx</a>`
    : "";
  return (
    `⚠️ <b>Event Notification Fallback</b> (${source})\n` +
    `Contract: <code>${contract}</code> · Ledger: ${ledger}${txPart}\n` +
    `Reason: <i>${safeReason}</i>`
  );
}

export function formatEventHtml(
  config: StellarConfig & {
    channelPreviewMode?: boolean;
    notificationCategories?: readonly string[];
  },
  event: DecodedEvent,
): string | null {
  if (!eventAllowedByCategory(config, event)) return null;
  try {
    const head = headlineHtml(event);
    if (head === null) return null;
    const body = `${head}\n${footerHtml(config, event)}`;
    if (config.channelPreviewMode) {
      return `🧪 <b>[PREVIEW MODE]</b>\n${body}`;
    }
    return body;
  } catch (err) {
    return formatFallbackEventHtml(config, event, safeErrorMessage(err));
  }
}
