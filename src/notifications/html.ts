/**
 * Format decoded contract events into Telegram HTML messages.
 * ... (unchanged header preserved)
 */

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
import { messagesFor, type Messages } from "../i18n.js";

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
  return escapeHtml(isolateAmount(`${formatUsdc(units)} USDC`));
}

function whoHtml(address: string): string {
  return `<code>${escapeHtml(shortAddress(address))}</code>`;
}

/**
 * Render `label` as an `<a>` link when `url` passes the shared link policy
 * (`link-safety.ts`), otherwise as inert escaped text with no `href`.
 */
export function linkHtml(label: string, url: string | null | undefined): string {
  const safe = safeLinkUrl(url);
  if (!safe) return escapeHtml(label);
  return `<a href="${escapeHtmlAttr(safe)}">${escapeHtml(label)}</a>`;
}

function txLinkHtml(config: StellarConfig, event: DecodedEvent): string | null {
  const url = eventExplorerUrl(config, event);
  if (url) return linkHtml("tx", url);
  return eventTxHash(event) !== null ? escapeHtml("tx") : null;
}

function footerHtml(config: StellarConfig, event: DecodedEvent): string {
  const ledger = escapeHtml(`ledger ${event.ledger}`);
  const tx = txLinkHtml(config, event);
  return tx ? `<i>${ledger}</i> · ${tx}` : `<i>${ledger}</i>`;
}

function headlineHtml(event: DecodedEvent): string | null {
  const p = event.payload;
  switch (p.name) {
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
      return `🧾 <b>Fees claimed</b> — ${usdcHtml(p.amount)} to ${whoHtml(p.recipient)}`;
    case "withdrawal":
      return `📤 <b>Withdrawal</b> — ${usdcHtml(p.amount)} to ${whoHtml(p.to)}`;
    case "withdrawal_pending":
      return `⏳ <b>Withdrawal parked</b> — ${usdcHtml(p.amount)} claimable by ${whoHtml(p.to)}`;
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
  config: StellarConfig & RouteLocaleConfig,
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
  return messagesFor(
    resolveNotificationLocale(config, { source: event?.source }),
  ).notificationHtml.fallbackEvent(source, contract, ledger, safeReason, txPart);
}

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
