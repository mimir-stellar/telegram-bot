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
 *
 * Link previews are controlled per message: enabled for events with transaction
 * links (which provide useful context about on-chain activity) and disabled for
 * commands and status messages to keep the UI clean.
 */

import { redactText } from "../redact.js";
import { txExplorerUrl } from "../stellar/client.js";
import {
  formatUsdc,
  isUsableTxHash,
  shortAddress,
  squadSideLabel,
  winnerSideLabel,
  type DecodedEvent,
} from "../stellar/decode.js";
import { normalizeCategory } from "../stellar/category.js";
import { appUrlFor } from "./app-links.js";
import { escapeMdLinkUrl, safeLinkUrl } from "./link-safety.js";
import { iconForCategory } from "./category-icons.js";
import {
  formatCompletenessLabel,
  groupDigestEvents,
  normalizeDigestCompleteness,
  type DigestPeriodCompleteness,
} from "./digest-grouping.js";
import { confidenceIndicator } from "./confidence.js";
import { sanitizeUserText } from "./sanitize.js";
import { settlementLines } from "./settlement.js";
import { formatSquadResolution, renderSquadResolution } from "./squad-resolution.js";
import type { StellarConfig } from "../config.js";
import { messagesFor, type Messages } from "../i18n.js";
import { formatDeadline } from "./time.js";
import {
  highlightLevel,
  highlightMarker,
  prefixFirstLine,
  type HighlightThresholds,
} from "./highlights.js";
export {
  highlightLevel,
  highlightMarker,
  prefixFirstLine,
  type HighlightLevel,
  type HighlightThresholds,
} from "./highlights.js";

/** Telegram's MarkdownV2 reserved set. All of it must be escaped, everywhere. */
const MDV2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;
/**
 * Unicode First-Strong-Isolate / Pop-Directional-Isolate.
 *
 * Wrapping an already-formatted amount in FSI…PDI keeps the digits
 * and the "USDC" unit readable left-to-right regardless of the
 * surrounding text direction, while leaving the string's bytes intact
 * (the isolate is a Unicode control, not a markup change).
 */
const FSI = "\u2068";
const PDI = "\u2069";

/**
 * Isolate a displayed amount from the surrounding text direction (#920).
 *
 * The exact numeric text is preserved; only the two invisible control
 * characters FSI/PDI surround it. Use this on every user-visible amount.
 */
export function isolateAmount(text: string): string {
  return `${FSI}${text}${PDI}`;
}

const MAX_EVENT_FIELD_LENGTH = 200;
const MAX_TX_HASH_LENGTH = 128;

export function escapeMd(text: string): string {
  return text.replace(MDV2_RESERVED, (ch) => `\\${ch}`);
}


/** Telegram Bot API hard limit for sendMessage / editMessageText text. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * UTF-16 code-unit length of `text`.
 *
 * Telegram measures its 4096-character limit in UTF-16 code units, after
 * entity / markup handling. JavaScript's `string.length` is exactly that
 * unit — one code unit per `charCodeAt` index — so this helper exists to
 * make the unit explicit at every call site and keep one definition.
 *
 * Do NOT replace this with `Array.from(s).length`: that counts Unicode code
 * points, which is a different (smaller) number for any string containing an
 * astral character (every emoji, most CJK extensions). A message that fits
 * under a code-point budget can still exceed Telegram's UTF-16 limit.
 */
export function utf16Length(text: string): number {
  return text.length;
}

/**
 * Clip `text` to at most `max` UTF-16 code units without splitting a
 * surrogate pair. The returned string is <= `max` UTF-16 units (the ellipsis
 * is one unit). Returns `text` unchanged when it already fits.
 */
export function clipUtf16(text: string, max: number): string {
  if (!Number.isFinite(max) || max < 1) return "";
  if (utf16Length(text) <= max) return text;
  // Reserve one unit for the trailing ellipsis.
  const budget = max - 1;
  let used = 0;
  const out: string[] = [];
  for (const cp of Array.from(text)) {
    const w = cp.length; // 1 for BMP, 2 for astral code points
    if (used + w > budget) break;
    out.push(cp);
    used += w;
  }
  return `${out.join("")}…`;
}

/**
 * Split a MarkdownV2 (or plain) payload so each chunk fits Telegram's size limit.
 *
 * Prefers breaking on newlines, omitting the separator newline from the chunks.
 * Never splits a UTF-16 surrogate pair or ends a chunk on a lone backslash.
 * Hard-splits only when a single line exceeds the limit. Throws if the limit
 * cannot fit a complete code point or MarkdownV2 escape.
 */
export function splitTelegramMessage(
  text: string,
  limit: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`splitTelegramMessage limit must be >= 1, got ${limit}`);
  }
  if (utf16Length(text) <= limit) return [text];

  const parts: string[] = [];
  let remaining = text;

  function safeCut(cut: number): number {
    const before = remaining.charCodeAt(cut - 1);
    const after = remaining.charCodeAt(cut);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      cut -= 1;
    }
    // Retreating before an emoji can expose an escape prefix as well.
    let start = cut;
    while (start > 0 && remaining[start - 1] === "\\") start -= 1;
    return cut - ((cut - start) % 2);
  }

  while (utf16Length(remaining) > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = Math.floor(limit);
    cut = safeCut(cut);
    // An unsafe newline near the start may still allow a safe hard split.
    if (cut <= 0) cut = safeCut(Math.floor(limit));
    if (cut <= 0) {
      throw new RangeError(`splitTelegramMessage limit ${limit} cannot fit a code point or escape`);
    }

    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
    if (remaining.startsWith("\n")) remaining = remaining.slice(1);
  }

  if (utf16Length(remaining) > 0) parts.push(remaining);
  return parts;
}

/**
 * Best-effort text for an unknown thrown value, without assuming it is an
 * `Error`. The SDK throws Soroban JSON-RPC failures as plain
 * `{ code, message }` objects (js-stellar-sdk `rpc/jsonrpc.ts`), and
 * `String()` of those is the useless `"[object Object]"` — so object-shaped
 * errors are read field-wise and only then fall back to a bounded dump.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return "";
  if (typeof error === "object") {
    const record = error as { code?: unknown; message?: unknown };
    const code =
      typeof record.code === "number" || typeof record.code === "string" ? record.code : null;
    if (typeof record.message === "string" && record.message !== "") {
      return code === null ? record.message : `${code}: ${record.message}`;
    }
    try {
      const json = JSON.stringify(error);
      if (typeof json === "string" && json !== "{}") return json;
    } catch {
      // Circular or exotic object; fall through to the generic label.
    }
    return code === null ? "error object" : `error code ${code}`;
  }
  return String(error);
}

/**
 * Telegram send timeout budget, in milliseconds.
 *
 * Individual sends are bounded so a single stalled request cannot wedge the
 * poller: the cursor must advance (or the batch must be retried) on a
 * predictable schedule, not on Telegram's liveness. Kept here, next to the
 * error formatting, so the poller and its tests share one source of truth.
 */
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;

/**
 * True when a thrown value looks like a timeout/abort rather than a Telegram
 * API rejection. Recognises `AbortError`, `TimeoutError`, and the common
 * `ETIMEDOUT`/`ECONNRESET`/`UND_ERR_*` shapes surfaced by fetch/undici, so the
 * poller can log "timed out" instead of a generic failure and retry the batch.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^(ETIMEDOUT|ECONNRESET|UND_ERR_)/.test(code)) {
      return true;
    }
    return /timed? ?out/i.test(error.message);
  }
  if (error !== null && typeof error === "object") {
    const record = error as { name?: unknown; code?: unknown; message?: unknown };
    if (record.name === "AbortError" || record.name === "TimeoutError") return true;
    if (typeof record.code === "string" && /^(ETIMEDOUT|ECONNRESET|UND_ERR_)/.test(record.code)) {
      return true;
    }
    if (typeof record.message === "string" && /timed? ?out/i.test(record.message)) {
      return true;
    }
  }
  return false;
}

/**
 * Keep operational errors actionable without copying remote payloads or the
 * bot token into logs and status messages.
 */
export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  // Collapse first, so the bound below is applied to the text that will
  // actually be shown rather than to remote whitespace.
  const collapsed = describeError(error).replace(/\s+/g, " ").trim();

  // Caller-supplied secrets, the secrets registered at boot, and the
  // credential shapes in `redact.ts`: the same rules the audit trail
  // applies, so an error cannot carry a seed strkey, a token, or a URL's
  // credentials into a log, `/status`, or `/health`.
  const message = redactText(collapsed, { secrets });

  // A timeout is labelled explicitly so operators can tell a stalled Telegram
  // send from an API rejection without parsing the raw error text.
  const compact = message.trim() || (isTimeoutError(error) ? "send timed out" : "unknown error");
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
}

function usdc(units: bigint): string {
  return escapeMd(isolateAmount(`${formatUsdc(units)} USDC`));
}

function who(address: string): string {
  return `\`${escapeMd(shortAddress(address))}\``;
}

/**
 * Truncate an unbounded contract String before it sizes a chat message.
 *
 * The category, question, and summary fields all come from remote contract
 * state. A hard cap here means a crafted payload cannot push an unbounded
 * string through to a Telegram message or to a log line. Never splits a
 * Unicode code point.
 */
export function clip(text: string, max = MAX_EVENT_FIELD_LENGTH): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  return characters.length <= max ? trimmed : `${characters.slice(0, max - 1).join("")}…`;
}

function footer(config: StellarConfig, event: DecodedEvent): string {
  const ledger = escapeMd(`ledger ${event.ledger}`);
  const tx = mdTxLink(config, event);
  return tx ? `_${ledger}_ · ${tx}` : `_${ledger}_`;
}

/**
 * MarkdownV2 `tx` link for an event: a link when the explorer URL passes the
 * shared link policy, inert `tx` text when the event has a well-formed hash
 * but its URL is unsafe, and null when there is no usable hash at all.
 */
function mdTxLink(config: StellarConfig, event: DecodedEvent): string | null {
  const url = eventExplorerUrl(config, event);
  if (url) return `[tx](${escapeMdLinkUrl(url)})`;
  return eventTxHash(event) !== null ? "tx" : null;
}

/**
 * A Stellar transaction hash as returned by the RPC: 64 lowercase or uppercase
 * hex characters (32 bytes). Anything else is treated as missing — the
 * notification is still sent, just without an explorer link/button.
 */
const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

/** Explorer URL for an event's transaction, or null when it has none usable. */
export function eventExplorerUrl(config: StellarConfig, event: DecodedEvent): string | null {
  // Link only well-formed 64-hex transaction hashes. An externally-derived
  // identifier that is empty, oversized or malformed gets no link: a broken
  // explorer link is worse than no link, and the hash itself is never altered here.
  const txHash = eventTxHash(event);
  if (txHash === null) return null;
  try {
    // The shared link policy (https only, no userinfo, no control characters)
    // decides; a hand-built config with an unsafe explorer origin gets no link.
    return safeLinkUrl(txExplorerUrl(config, txHash));
  } catch {
    return null;
  }
}

/** The event's transaction hash when it is a well-formed 64-hex value, else null. */
export function eventTxHash(event: DecodedEvent): string | null {
  const raw = typeof event?.txHash === "string" ? event.txHash : "";
  if (raw.length > MAX_TX_HASH_LENGTH || !isUsableTxHash(raw)) return null;
  const txHash = raw.trim();
  return TX_HASH_RE.test(txHash) ? txHash : null;
}

export interface ExplorerButton {
  text: string;
  url: string;
}

export interface ExplorerKeyboard {
  inline_keyboard: ExplorerButton[][];
}

/**
 * Config the keyboard builder reads: the chain fields `eventExplorerUrl`
 * needs, plus the optional Mimir web-app origin (`MIMIR_APP_URL`) that adds a
 * second button. Optional here so a chain-only config keeps building the
 * explorer-only keyboard it has always built.
 */
export type KeyboardConfig = StellarConfig & { mimirAppUrl?: string | null };

/**
 * Telegram inline keyboard for an event notification.
 *
 * Returns undefined when the event carries no usable transaction hash and no
 * Mimir app page, so the caller sends the existing text-only message
 * unchanged. The explorer button reuses the same canonical explorer URL as the
 * `· [tx](…)` footer link — the footer stays as the text fallback, the button
 * is progressive enhancement in the same Telegram request (no second message,
 * no extra rate-limit cost). When `config.mimirAppUrl` is set and the event
 * maps to an app page, the "Open in Mimir" button joins the same row.
 */
export function explorerKeyboard(
  config: KeyboardConfig,
  event: DecodedEvent,
): ExplorerKeyboard | undefined {
  const messages = messagesFor(config.locale);
  const buttons: ExplorerButton[] = [];
  const explorerUrl = eventExplorerUrl(config, event);
  if (explorerUrl) buttons.push({ text: messages.explorerButtonText, url: explorerUrl });

  const appUrl = appUrlFor(event, config.mimirAppUrl);
  if (appUrl) buttons.push({ text: messages.mimirAppButtonText, url: appUrl });

  if (buttons.length === 0) return undefined;
  return { inline_keyboard: [buttons] };
}

/** Format the latest observed event, including events with no notification template. */
export function formatLastEvent(
  config: StellarConfig & { nowMs?: number },
  event: DecodedEvent,
  nowMs?: number,
): string {
  const notification = formatEvent(config, event, nowMs);
  if (notification !== null) return notification;

  const name = event.payload.name === "unknown" ? event.payload.eventName : event.payload.name;
  return (
    `*Last observed event* — \`${escapeMd(clip(name, 120))}\`\n` +
    `This event has no notification summary\\.\n${footer(config, event)}`
  );
}
