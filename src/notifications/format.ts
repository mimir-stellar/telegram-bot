/**
 * Turn a decoded contract event into a Telegram message.
 *
 * MarkdownV2, not legacy Markdown: legacy silently accepts malformed input and
 * renders garbage, while MarkdownV2 rejects it — a formatting bug should be a
 * failed send in the log, not a mangled message in the channel. Every
 * interpolated value therefore goes through {@link escapeMd}.
 *
 * One event, one message, one line of substance. A notification is read on a
 * phone lock screen.
 */

import { txExplorerUrl } from "../stellar/client.js";
import {
  formatUsdc,
  shortAddress,
  squadSideLabel,
  winnerSideLabel,
  type DecodedEvent,
} from "../stellar/decode.js";
import type { StellarConfig } from "../config.js";

/** Telegram's MarkdownV2 reserved set. All of it must be escaped, everywhere. */
const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMd(text: string): string {
  return text.replace(MDV2_RESERVED, (ch) => `\\${ch}`);
}


/** Telegram Bot API hard limit for sendMessage / editMessageText text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split a MarkdownV2 (or plain) payload so each chunk fits Telegram's size limit.
 *
 * Prefers breaking on newlines. Never ends a chunk on a lone trailing backslash,
 * which would corrupt a MarkdownV2 escape sequence across chunk boundaries.
 * Hard-splits only when a single line exceeds the limit.
 */
export function splitTelegramMessage(
  text: string,
  limit: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`splitTelegramMessage limit must be >= 1, got ${limit}`);
  }
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = limit;

    // If the chunk would end on an odd-length trailing backslash run, the next
    // character belongs to that escape — pull the cut back before the run.
    while (cut > 0) {
      let i = cut - 1;
      let slashes = 0;
      while (i >= 0 && remaining[i] === "\\") {
        slashes += 1;
        i -= 1;
      }
      if (slashes % 2 === 1) {
        cut = cut - 1;
        continue;
      }
      break;
    }

    if (cut <= 0) {
      cut = limit;
      if (remaining[cut - 1] === "\\" && cut < remaining.length) {
        cut = limit - 1;
        if (cut <= 0) cut = limit;
      }
    }

    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    if (remaining.startsWith("\n")) remaining = remaining.slice(1);
  }

  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function usdc(units: bigint): string {
  return escapeMd(`${formatUsdc(units)} USDC`);
}

function who(address: string): string {
  return `\`${escapeMd(shortAddress(address))}\``;
}

/** Truncate an unbounded contract String before it sizes a chat message. */
function clip(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function footer(config: StellarConfig, event: DecodedEvent): string {
  const ledger = escapeMd(`ledger ${event.ledger}`);
  if (!event.txHash) return `_${ledger}_`;
  return `_${ledger}_ · [tx](${txExplorerUrl(config, event.txHash)})`;
}

/**
 * The headline for an event, or null when this bot has nothing to say about it.
 *
 * Note what is deliberately absent: the market contract's `claim_created`
 * carries only `id`, `creator` and `category` — the claim's question text lives
 * in contract state, not the event, so it is not invented here. The squad
 * contract's `market_created` does carry `question`, and that is shown.
 */
function headline(event: DecodedEvent): string | null {
  const p = event.payload;

  switch (p.name) {
    // ── mimir-market ────────────────────────────────────────────────────────
    case "claim_created":
      return (
        `🆕 *New claim* \\#${p.claimId}\n` +
        `Category: ${escapeMd(p.category)}\n` +
        `Creator: ${who(p.creator)}`
      );

    case "claim_challenged":
      return (
        `⚔️ *Claim \\#${p.claimId} challenged*\n` +
        `Stake: *${usdc(p.stake)}*\n` +
        `Challenger: ${who(p.challenger)}`
      );

    case "claim_resolved":
      return (
        `⚖️ *Claim \\#${p.claimId} resolved* — winner: *${escapeMd(winnerSideLabel(p.winnerSide))}*\n` +
        `Confidence: ${escapeMd(String(p.confidence))}%\n` +
        (p.summary ? `_${escapeMd(clip(p.summary))}_` : "")
      ).trimEnd();

    case "claim_cancelled":
      return `🚫 *Claim \\#${p.claimId} cancelled* — stakes returned`;

    case "market_settled":
      return (
        `💰 *Claim \\#${p.claimId} settled*\n` +
        `Paid out: *${usdc(p.totalPaid)}* · fees ${usdc(p.totalFees)}\n` +
        `Owed to challengers: ${usdc(p.owedToChallengers)}`
      );

    case "challenger_paid":
      return (
        `🏆 *Challenger paid* on claim \\#${p.claimId}\n` +
        `${who(p.challenger)} staked ${usdc(p.stake)} → net *${usdc(p.net)}*\n` +
        `Gross ${usdc(p.gross)} · fee ${usdc(p.fee)}`
      );

    case "fee_claimed":
      return `🧾 *Fees claimed* — ${usdc(p.amount)} to ${who(p.recipient)}`;

    case "withdrawal":
      return `📤 *Withdrawal* — ${usdc(p.amount)} to ${who(p.to)}`;

    case "withdrawal_pending":
      return `⏳ *Withdrawal parked* — ${usdc(p.amount)} claimable by ${who(p.to)}`;

    // ── mimir-squad ─────────────────────────────────────────────────────────
    case "market_created":
      return (
        `🆕 *New squad market* \\#${p.marketId}\n` +
        `${escapeMd(clip(p.question))}\n` +
        `Captain: ${who(p.captain)} · fee ${escapeMd(String(p.feeBps))} bps · ` +
        `deadline ${escapeMd(new Date(p.deadline * 1000).toISOString())}`
      );

    case "deposited":
      return (
        `➕ *Squad \\#${p.marketId}* — ${usdc(p.amount)} on *${escapeMd(squadSideLabel(p.side))}*\n` +
        `Participant: ${who(p.participant)}`
      );

    case "withdrawn":
      return (
        `➖ *Squad \\#${p.marketId}* — ${who(p.participant)} pulled ${usdc(p.amount)} ` +
        `from ${escapeMd(squadSideLabel(p.side))}`
      );

    case "resolved":
      return (
        `🏁 *Squad \\#${p.marketId} resolved* — *${escapeMd(squadSideLabel(p.result))}*\n` +
        `Pools: A ${usdc(p.poolA)} · B ${usdc(p.poolB)}`
      );

    case "claimed":
      return (
        `💸 *Squad payout* on \\#${p.marketId}\n` +
        `${who(p.participant)} → net *${usdc(p.net)}* \\(gross ${usdc(p.gross)}, fee ${usdc(p.fee)}\\)`
      );

    case "fees_claimed":
      return `🧾 *Squad fees claimed* — ${usdc(p.amount)} to ${who(p.recipient)}`;

    // Admin events and undecodable shapes get no notification. The poller logs
    // them so a silent bot is distinguishable from an unteachable one.
    case "unknown":
      return null;

    default:
      return null;
  }
}

/** The full message, or null when the event is not worth notifying. */
export function formatEvent(config: StellarConfig, event: DecodedEvent): string | null {
  const head = headline(event);
  if (head === null) return null;
  return `${head}\n${footer(config, event)}`;
}
