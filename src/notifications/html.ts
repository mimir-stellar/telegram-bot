/**
 * Format decoded contract events into Telegram HTML messages.
 *
 * Telegram HTML supports a strict subset of HTML tags:
 * <b>, <i>, <code>, <a>, <s>, <u>, <pre>, <tg-spoiler>, etc.
 * Here we restrict formatting exclusively to <b>, <i>, <code>, and <a>
 * as per Telegram event notification specifications.
 *
 * Every interpolated dynamic value goes through escapeHtml or escapeHtmlAttr.
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
  eventAllowedByCategory,
  eventExplorerUrl,
  resolveNotificationLocale,
  safeErrorMessage,
  type RouteLocaleConfig,
} from "./format.js";
import type { StellarConfig } from "../config.js";
import { messagesFor, type Messages } from "../i18n.js";

/**
 * Escape HTML special characters in body text: &, <, and >.
 * (Double and single quotes can also be escaped safely).
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * Escape attribute values for HTML links (specifically href).
 */
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

/**
 * HTML event headlines covering every market and squad event.
 */
function headlineHtml(messages: Messages, event: DecodedEvent): string | null {
  const p = event.payload;
  const t = messages.notificationHtml;

  switch (p.name) {
    // ── mimir-market ────────────────────────────────────────────────────────
    case "claim_created":
      return t.claimCreated(
        escapeHtml(String(p.claimId)),
        escapeHtml(clip(p.category)),
        whoHtml(p.creator),
      );

    case "claim_challenged":
      return t.claimChallenged(
        escapeHtml(String(p.claimId)),
        usdcHtml(p.stake),
        whoHtml(p.challenger),
      );

    case "claim_resolved":
      return t.claimResolved(
        escapeHtml(String(p.claimId)),
        escapeHtml(winnerSideLabel(p.winnerSide)),
        escapeHtml(confidenceIndicator(p.confidence)),
        p.summary ? escapeHtml(clip(p.summary)) : null,
      );

    case "claim_cancelled":
      return t.claimCancelled(escapeHtml(String(p.claimId)));

    case "market_settled":
      return t.marketSettled(
        escapeHtml(String(p.claimId)),
        usdcHtml(p.totalPaid),
        usdcHtml(p.totalFees),
        usdcHtml(p.owedToChallengers),
      );

    case "challenger_paid":
      return t.challengerPaid(
        escapeHtml(String(p.claimId)),
        whoHtml(p.challenger),
        usdcHtml(p.stake),
        usdcHtml(p.net),
        usdcHtml(p.gross),
        usdcHtml(p.fee),
      );

    case "fee_claimed":
      return t.feeClaimed(usdcHtml(p.amount), whoHtml(p.recipient));

    case "withdrawal":
      return t.withdrawal(usdcHtml(p.amount), whoHtml(p.to));

    case "withdrawal_pending":
      return t.withdrawalPending(usdcHtml(p.amount), whoHtml(p.to));

    // ── mimir-squad ─────────────────────────────────────────────────────────
    case "market_created":
      return t.marketCreated(
        escapeHtml(String(p.marketId)),
        escapeHtml(clip(p.question)),
        whoHtml(p.captain),
        escapeHtml(String(p.feeBps)),
        escapeHtml(new Date(p.deadline * 1000).toISOString()),
      );

    case "deposited":
      return t.deposited(
        escapeHtml(String(p.marketId)),
        usdcHtml(p.amount),
        escapeHtml(squadSideLabel(p.side)),
        whoHtml(p.participant),
      );

    case "withdrawn":
      return t.withdrawn(
        escapeHtml(String(p.marketId)),
        whoHtml(p.participant),
        usdcHtml(p.amount),
        escapeHtml(squadSideLabel(p.side)),
      );

    case "resolved":
      return t.resolved(
        escapeHtml(String(p.marketId)),
        escapeHtml(squadSideLabel(p.result)),
        usdcHtml(p.poolA),
        usdcHtml(p.poolB),
      );

    case "claimed":
      return t.claimed(
        escapeHtml(String(p.marketId)),
        whoHtml(p.participant),
        usdcHtml(p.net),
        usdcHtml(p.gross),
        usdcHtml(p.fee),
      );

    case "fees_claimed":
      return t.feesClaimedSquad(usdcHtml(p.amount), whoHtml(p.recipient));

    // Admin events and undecodable shapes get no notification.
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

/**
 * Fallback message formatted in Telegram HTML when formatting throws.
 */
export function formatFallbackEventHtml(
  config: StellarConfig & RouteLocaleConfig,
  event: DecodedEvent,
  reason = "malformed payload",
): string {
  const source = escapeHtml(event.source ?? "unknown");
  const contract = escapeHtml(shortAddress(event.contractId ?? "unknown"));
  const ledger = escapeHtml(String(event.ledger ?? "unknown"));
  const safeReason = escapeHtml(safeErrorMessage(reason));
  const txPart = event.txHash
    ? ` · <a href="${escapeHtmlAttr(txExplorerUrl(config, event.txHash))}">tx</a>`
    : "";
  return messagesFor(
    resolveNotificationLocale(config, { source: event?.source }),
  ).notificationHtml.fallbackEvent(source, contract, ledger, safeReason, txPart);
}

/**
 * Format a decoded event into Telegram HTML.
 * Returns null when the event has no notification summary or is filtered out.
 */
export function formatEventHtml(
  config: StellarConfig &
    RouteLocaleConfig & {
      channelPreviewMode?: boolean;
      notificationCategories?: readonly string[];
    },
  event: DecodedEvent,
): string | null {
  if (!eventAllowedByCategory(config, event)) return null;
  try {
    const messages = messagesFor(resolveNotificationLocale(config, { source: event?.source }));
    const head = headlineHtml(messages, event);
    if (head === null) return null;
    const body = `${head}\n${footerHtml(config, event)}`;
    if (config.channelPreviewMode) {
      return `${messages.notificationHtml.previewModePrefix}\n${body}`;
    }
    return body;
  } catch (err) {
    return formatFallbackEventHtml(config, event, safeErrorMessage(err));
  }
}
