/**
 * Turn a decoded contract event into a Telegram message.
 * ... (unchanged header preserved)
 */

import { redactText } from "../redact.js";
import { txExplorerUrl } from "../stellar/client.js";
import {
  formatUsdc,
  isUsableTxHash,
  shortAddress,
  squadSideLabel,
  winnerSideLabel,
  type ContractSource,
  type DecodedEvent,
} from "../stellar/decode.js";
import { normalizeCategory } from "../stellar/category.js";
import { appUrlFor } from "./app-links.js";
import { escapeMdLinkUrl, safeLinkUrl } from "./link-safety.js";
import { iconForCategory } from "./category-icons.js";
import { groupDigestEvents, sortDigestEvents } from "./digest-grouping.js";
import { confidenceIndicator } from "./confidence.js";
import { sanitizeUserText } from "./sanitize.js";
import { settlementLines } from "./settlement.js";
import { formatSquadResolution, renderSquadResolution } from "./squad-resolution.js";
import type { StellarConfig, TelegramRoute } from "../config.js";
import {
  DEFAULT_LOCALE,
  messagesFor,
  normalizeLocale,
  type Locale,
  type Messages,
} from "../i18n.js";
import { formatDeadline } from "./time.js";
import { buildSampleEvents } from "./samples.js";
import {
  highlightLevel,
  highlightMarker,
  prefixFirstLine,
  type HighlightThresholds,
} from "./highlights.js";
import { formatEventHtml } from "./html.js";
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

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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
    let start = cut;
    while (start > 0 && remaining[start - 1] === "\\") start -= 1;
    return cut - ((cut - start) % 2);
  }

  while (utf16Length(remaining) > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut <= 0) cut = Math.floor(limit);
    cut = safeCut(cut);
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

export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") return true;
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^(ETIMEDOUT|ECONNRESET|UND_ERR_)/.test(code)) return true;
    return /timed? ?out/i.test(error.message);
  }
  if (error !== null && typeof error === "object") {
    const record = error as { name?: unknown; code?: unknown; message?: unknown };
    if (record.name === "AbortError" || record.name === "TimeoutError") return true;
    if (typeof record.code === "string" && /^(ETIMEDOUT|ECONNRESET|UND_ERR_)/.test(record.code)) {
      return true;
    }
    if (typeof record.message === "string" && /timed? ?out/i.test(record.message)) return true;
  }
  return false;
}

export function safeErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  const collapsed = describeError(error).replace(/\s+/g, " ").trim();
  const message = redactText(collapsed, { secrets });
  const compact = message.trim() || (isTimeoutError(error) ? "send timed out" : "unknown error");
  return compact.length <= 240 ? compact : `${compact.slice(0, 239)}…`;
}

function usdc(units: bigint): string {
  return escapeMd(isolateAmount(`${formatUsdc(units)} USDC`));
}

function who(address: string): string {
  return `\`${escapeMd(shortAddress(address))}\``;
}

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

const TX_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function eventExplorerUrl(config: StellarConfig, event: DecodedEvent): string | null {
  const raw = event.txHash ?? "";
  if (raw.length > MAX_TX_HASH_LENGTH || !isUsableTxHash(raw)) return null;
  const txHash = raw.trim();
  if (!TX_HASH_RE.test(txHash)) return null;
  try {
    // The shared link policy (https only, no userinfo, no control characters)
    // decides; a hand-built config with an unsafe explorer origin gets no link.
    return safeLinkUrl(txExplorerUrl(config, txHash));
  } catch {
    return null;
  }
}

export interface ExplorerButton { text: string; url: string; }
export interface ExplorerKeyboard { inline_keyboard: ExplorerButton[][]; }
export type KeyboardConfig = StellarConfig & { mimirAppUrl?: string | null };

export function explorerKeyboard(
  config: KeyboardConfig,
  event: DecodedEvent,
): ExplorerKeyboard | undefined {
  const messages = messagesFor(resolveNotificationLocale(config, { source: event?.source }));
  const buttons: ExplorerButton[] = [];
  const explorerUrl = eventExplorerUrl(config, event);
  if (explorerUrl) buttons.push({ text: messages.explorerButtonText, url: explorerUrl });
  const appUrl = appUrlFor(event, config.mimirAppUrl);
  if (appUrl) buttons.push({ text: messages.mimirAppButtonText, url: appUrl });
  if (buttons.length === 0) return undefined;
  return { inline_keyboard: [buttons] };
}

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

export interface FormatDigestOptions {
  grouped?: boolean;
  /**
   * Completeness metadata for the digest period.
   *
   * When incomplete (e.g. affected by an RPC gap or restart), the header
   * explicitly labels the period as incomplete and marks the event count as a
   * partial observation rather than a complete ledger summary.
   */
  completeness?: Partial<DigestPeriodCompleteness>;
}

function digestHeader(count: number, completeness: DigestPeriodCompleteness): string {
  if (completeness.complete) {
    return `*Mimir Digest* — ${count} events in this cycle`;
  }
  const label = formatCompletenessLabel(completeness) ?? "Incomplete period";
  const noun = count === 1 ? "event" : "events";
  return `*Mimir Digest* — ${escapeMd(label)} \\(${count} observed ${noun}, partial\\)`;
}

/** Options for {@link formatDigestPages}. */
export interface FormatDigestPagesOptions extends FormatDigestOptions {
  /**
   * Maximum length in UTF-16 code units for each rendered Telegram message page.
   * Defaults to {@link TELEGRAM_MAX_MESSAGE_LENGTH} (4096).
   */
  maxLength?: number;
}

interface DigestEntry {
  groupHeader: string | null;
  line: string;
}

/**
 * One digest line in the flat layout.  Extracted so both the flat path and the
 * grouped renderer share identical line formatting.
 */
function flatLine(event: DecodedEvent): string {
  const name = event.payload.name === "unknown" ? event.payload.eventName : event.payload.name;
  return `· mimir\\-${escapeMd(event.source)} \`${escapeMd(clip(name, 80))}\` at ledger ${event.ledger}`;
}

function digestHeader(totalEvents: number, page?: number, totalPages?: number): string {
  if (page !== undefined && totalPages !== undefined && totalPages > 1) {
    return `*Mimir Digest* ${escapeMd(`(${page}/${totalPages})`)} — ${totalEvents} events in this cycle`;
  }
  return `*Mimir Digest* — ${totalEvents} events in this cycle`;
}

function buildDigestEntries(
  events: readonly DecodedEvent[],
  grouped: boolean,
): DigestEntry[] {
  if (!grouped) {
    return events.map((event) => ({ groupHeader: null, line: flatLine(event) }));
  }

  const groups = groupDigestEvents(events);
  const entries: DigestEntry[] = [];
  for (const group of groups) {
    if (group.events.length === 1) {
      // Singleton group: no header, no indentation — identical to flat layout.
      const [sole] = group.events;
      if (sole) entries.push({ groupHeader: null, line: flatLine(sole) });
    } else {
      // Multi-event group: MarkdownV2-escaped Group_Key as header, then
      // each event on an indented line.
      const groupHeader = escapeMd(group.key);
      for (const e of group.events) {
        entries.push({ groupHeader, line: `  ${flatLine(e)}` });
      }
    }
  }
  return entries;
}

function packDigestEntries(
  entries: readonly DigestEntry[],
  maxBodyLength: number,
  maxLength: number,
): string[][] {
  const pages: string[][] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  let activeGroupHeader: string | null = null;

  for (const entry of entries) {
    const needsGroupHeader =
      entry.groupHeader !== null && entry.groupHeader !== activeGroupHeader;
    const additionLines = needsGroupHeader
      ? [entry.groupHeader!, entry.line]
      : [entry.line];
    const additionTextLen = additionLines.reduce(
      (sum, l, idx) => sum + l.length + (idx > 0 ? 1 : 0),
      0,
    );
    const separatorLen = currentLines.length > 0 ? 1 : 0;

    if (currentLines.length > 0 && currentLen + separatorLen + additionTextLen > maxBodyLength) {
      pages.push(currentLines);
      currentLines = [];
      currentLen = 0;
      activeGroupHeader = null;
    }

    const freshNeedsHeader =
      entry.groupHeader !== null && entry.groupHeader !== activeGroupHeader;
    const freshLines = freshNeedsHeader
      ? [entry.groupHeader!, entry.line]
      : [entry.line];
    const freshTextLen = freshLines.reduce(
      (sum, l, idx) => sum + l.length + (idx > 0 ? 1 : 0),
      0,
    );
    const freshSepLen = currentLines.length > 0 ? 1 : 0;

    if (currentLen + freshSepLen + freshTextLen > maxBodyLength) {
      throw new RangeError(
        `formatDigestPages maxLength ${maxLength} cannot fit digest header and a complete event summary`,
      );
    }

    currentLines.push(...freshLines);
    currentLen += freshSepLen + freshTextLen;
    activeGroupHeader = entry.groupHeader;
  }

  if (currentLines.length > 0) {
    pages.push(currentLines);
  }
  return pages;
}

/**
 * Render a grouped digest.  Called only when `options.grouped` is `true`.
 */
function renderGroupedDigest(events: readonly DecodedEvent[]): string {
  const groups = groupDigestEvents(events);
  const header = digestHeader(events.length);
  const body: string[] = [];
  for (const group of groups) {
    if (group.events.length === 1) {
      const [sole] = group.events;
      if (sole) body.push(flatLine(sole));
    } else {
      body.push(escapeMd(group.key));
      for (const e of group.events) body.push(`  ${flatLine(e)}`);
    }
  }
  return [header, "", ...body].join("\n");
}

export function formatDigest(
  events: readonly DecodedEvent[],
  options: FormatDigestOptions = {},
): string | null {
  if (events.length === 0) return null;
  if (options.grouped) return renderGroupedDigest(events);
  const lines = events.map(flatLine);
  return [digestHeader(events.length), "", ...lines].join("\n");
}

/**
 * Format a digest into one or more Telegram-bounded MarkdownV2 continuation pages.
 *
 * - Returns `[]` when `events` is empty.
 * - When the full digest fits within `maxLength`, returns a single page identical
 *   to {@link formatDigest}.
 * - When pagination is required, splits strictly on complete event summaries
 *   (never mid-line, mid-surrogate-pair, or mid-MarkdownV2 escape), repeats the
 *   group header when a multi-event group continues onto a new page, and retains
 *   the same total event count across every page header (`(page/total)`).
 * - Throws `RangeError` if `maxLength` is invalid or too small to fit a page
 *   header plus a single complete event summary.
 */
export function formatDigestPages(
  events: readonly DecodedEvent[],
  options: FormatDigestPagesOptions = {},
): string[] {
  const limit = options.maxLength ?? TELEGRAM_MAX_MESSAGE_LENGTH;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`formatDigestPages maxLength must be >= 1, got ${limit}`);
  }
  const maxLength = Math.floor(limit);
  if (events.length === 0) return [];

  const grouped = options.grouped === true;
  const single = formatDigest(events, { grouped });
  if (single !== null && single.length <= maxLength) {
    return [single];
  }

  const totalEvents = events.length;
  const entries = buildDigestEntries(events, grouped);

  let estimatedTotal = 2;
  let packedPages: string[][] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const worstHeaderLen = digestHeader(totalEvents, estimatedTotal, estimatedTotal).length;
    const maxBodyLength = maxLength - worstHeaderLen - 2; // "\n\n"
    if (maxBodyLength < 1) {
      throw new RangeError(
        `formatDigestPages maxLength ${maxLength} cannot fit digest header and a complete event summary`,
      );
    }
    packedPages = packDigestEntries(entries, maxBodyLength, maxLength);
    const actualTotal = Math.max(2, packedPages.length);
    if (String(actualTotal).length <= String(estimatedTotal).length) {
      break;
    }
    estimatedTotal = actualTotal;
  }

  const totalPages = packedPages.length;
  return packedPages.map(
    (lines, index) => `${digestHeader(totalEvents, index + 1, totalPages)}\n\n${lines.join("\n")}`,
  );
}

function headline(
  messages: Messages,
  event: DecodedEvent,
  nowMs?: number,
): string | null {
  const p = event.payload;
  const md = messages.notificationMd;
  switch (p.name) {
    case "claim_created": {
      const icon = iconForCategory(p.category);
      const cat = escapeMd(clip(sanitizeUserText(p.category)));
      const formattedCategory = cat ? `${icon} ${cat}` : icon;
      return md.claimCreated(String(p.claimId), formattedCategory, who(p.creator));
    }
    case "claim_challenged":
      return md.claimChallenged(String(p.claimId), usdc(p.stake), who(p.challenger));
    case "claim_resolved":
      return md.claimResolved(
        String(p.claimId),
        escapeMd(winnerSideLabel(p.winnerSide)),
        escapeMd(confidenceIndicator(p.confidence)),
        p.summary ? escapeMd(clip(sanitizeUserText(p.summary))) : null,
      );
    case "claim_cancelled":
      return md.claimCancelled(String(p.claimId));
    case "market_settled": {
      const lines = settlementLines(p).map(escapeMd);
      return md.marketSettled(
        String(p.claimId),
        usdc(p.totalPaid),
        usdc(p.totalFees),
        usdc(p.owedToChallengers),
        lines,
      );
    }
    case "challenger_paid":
      return md.challengerPaid(
        String(p.claimId),
        who(p.challenger),
        usdc(p.stake),
        usdc(p.net),
        usdc(p.gross),
        usdc(p.fee),
      );
    case "fee_claimed":
      return md.feeClaimed(usdc(p.amount), who(p.recipient));
    case "withdrawal":
      return md.withdrawal(usdc(p.amount), who(p.to));
    case "withdrawal_pending":
      return md.withdrawalPending(usdc(p.amount), who(p.to));
    case "market_created":
      return md.marketCreated(
        String(p.marketId),
        escapeMd(clip(sanitizeUserText(p.question))),
        who(p.captain),
        escapeMd(String(p.feeBps)),
        escapeMd(formatDeadline(p.deadline, nowMs)),
        p.category ? escapeMd(clip(p.category)) : null,
      );
    case "deposited":
      return md.deposited(
        String(p.marketId),
        usdc(p.amount),
        escapeMd(squadSideLabel(p.side)),
        who(p.participant),
      );
    case "withdrawn":
      return md.withdrawn(
        String(p.marketId),
        who(p.participant),
        usdc(p.amount),
        escapeMd(squadSideLabel(p.side)),
      );
    case "resolved":
      return renderSquadResolution(formatSquadResolution(p), md, escapeMd);
    case "claimed":
      return md.claimed(
        String(p.marketId),
        who(p.participant),
        usdc(p.net),
        usdc(p.gross),
        usdc(p.fee),
      );
    case "fees_claimed":
      return md.feesClaimedSquad(usdc(p.amount), who(p.recipient));
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

export function eventAllowedByCategory(
  config: { notificationCategories?: readonly string[] },
  event: DecodedEvent,
): boolean {
  const categories = config.notificationCategories ?? [];
  if (categories.length === 0 || event.payload.name !== "claim_created") return true;
  const allowed = new Set(categories.map((category) => normalizeCategory(category)));
  return allowed.has(normalizeCategory(String(event.payload.category ?? "")));
}

export function formatEvent(
  config: StellarConfig &
    RouteLocaleConfig & {
      channelPreviewMode?: boolean;
      notificationCategories?: readonly string[];
      highlightThresholds?: HighlightThresholds;
      nowMs?: number;
    },
  event: DecodedEvent,
  nowMsOrThresholds?: number | HighlightThresholds,
): string | null {
  if (!eventAllowedByCategory(config, event)) return null;
  const nowMs = typeof nowMsOrThresholds === "number" ? nowMsOrThresholds : undefined;
  const thresholds =
    typeof nowMsOrThresholds === "object" && nowMsOrThresholds !== null
      ? nowMsOrThresholds
      : undefined;
  const currentMs = nowMs ?? config.nowMs ?? (event?.at && event.at > 0 ? event.at * 1000 : Date.now());
  try {
    const messages = messagesFor(resolveNotificationLocale(config, { source: event?.source }));
    let head = headline(messages, event, currentMs);
    if (head === null) return null;
    const effectiveThresholds = thresholds ?? config.highlightThresholds;
    if (effectiveThresholds !== undefined) {
      const level = highlightLevel(event, effectiveThresholds);
      const marker = highlightMarker(level, effectiveThresholds);
      if (marker) head = prefixFirstLine(head, marker);
    }
    const body = `${head}\n${footer(config, event)}`;
    if (config.channelPreviewMode) {
      return `${messages.notificationMd.previewModePrefix}\n${body}`;
    }
    return body;
  } catch (err) {
    return formatFallbackEvent(config, event, safeErrorMessage(err));
  }
}

const MAX_PLAIN_TEXT_LENGTH = 4000;

function plainUsdc(units: bigint): string {
  // Plaintext is not a Telegram renderer; the isolate belongs on the
  // Markdown and HTML paths, where the client applies bidi layout.
  return `${formatUsdc(units)} USDC`;
}

function plainWho(address: string): string {
  return shortAddress(address);
}

function plainFooter(config: StellarConfig, event: DecodedEvent): string {
  const url = eventExplorerUrl(config, event);
  const ledger = `ledger ${event.ledger}`;
  return url ? `${ledger}\ntx: ${url}` : ledger;
}

/**
 * Plaintext headline. Every line carries a text label ("Claim #7", "Stake:",
 * "winner:") so meaning is never carried by emoji alone; the icon, when one is
 * present for `claim_created`, always accompanies the category text.
 */
function plainHeadline(
  messages: Messages,
  event: DecodedEvent,
  nowMs?: number,
): string | null {
  const p = event.payload;
  const plain = messages.notificationPlain;
  switch (p.name) {
    case "claim_created": {
      const cat = clip(sanitizeUserText(p.category));
      // Text-only: the emoji icon is intentionally omitted here so the plain
      // export never relies on emoji. The HTML renderer keeps the icon.
      return plain.claimCreated(p.claimId, cat || "uncategorized", plainWho(p.creator));
    }
    case "claim_challenged":
      return plain.claimChallenged(p.claimId, plainUsdc(p.stake), plainWho(p.challenger));
    case "claim_resolved":
      return plain.claimResolved(
        p.claimId,
        winnerSideLabel(p.winnerSide),
        confidenceIndicator(p.confidence),
        p.summary ? clip(sanitizeUserText(p.summary)) : null,
      );
    case "claim_cancelled":
      return plain.claimCancelled(p.claimId);
    case "market_settled": {
      const lines = settlementLines(p);
      return plain.marketSettled(
        p.claimId,
        plainUsdc(p.totalPaid),
        plainUsdc(p.totalFees),
        plainUsdc(p.owedToChallengers),
        lines,
      );
    }
    case "challenger_paid":
      return plain.challengerPaid(
        p.claimId,
        plainWho(p.challenger),
        plainUsdc(p.stake),
        plainUsdc(p.net),
        plainUsdc(p.gross),
        plainUsdc(p.fee),
      );
    case "fee_claimed":
      return plain.feeClaimed(plainUsdc(p.amount), plainWho(p.recipient));
    case "withdrawal":
      return plain.withdrawal(plainUsdc(p.amount), plainWho(p.to));
    case "withdrawal_pending":
      return plain.withdrawalPending(plainUsdc(p.amount), plainWho(p.to));
    case "market_created":
      return plain.marketCreated(
        p.marketId,
        clip(sanitizeUserText(p.question)),
        plainWho(p.captain),
        String(p.feeBps),
        formatDeadline(p.deadline, nowMs),
        p.category ? clip(p.category) : null,
      );
    case "deposited":
      return plain.deposited(
        p.marketId,
        plainUsdc(p.amount),
        squadSideLabel(p.side),
        plainWho(p.participant),
      );
    case "withdrawn":
      return plain.withdrawn(
        p.marketId,
        plainWho(p.participant),
        plainUsdc(p.amount),
        squadSideLabel(p.side),
      );
    case "resolved":
      return renderSquadResolution(formatSquadResolution(p), plain);
    case "claimed":
      return plain.claimed(
        p.marketId,
        plainWho(p.participant),
        plainUsdc(p.net),
        plainUsdc(p.gross),
        plainUsdc(p.fee),
      );
    case "fees_claimed":
      return plain.feesClaimedSquad(plainUsdc(p.amount), plainWho(p.recipient));
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

function clipPlainText(text: string, max = MAX_PLAIN_TEXT_LENGTH): string {
  return clipUtf16(text, max);
}

export function formatPlainTextEvent(
  config: StellarConfig & RouteLocaleConfig & { highlightThresholds?: HighlightThresholds; nowMs?: number },
  event: DecodedEvent,
  nowMsOrThresholds?: number | HighlightThresholds,
): string | null {
  const messages = messagesFor(resolveNotificationLocale(config, { source: event?.source }));
  const nowMs = typeof nowMsOrThresholds === "number" ? nowMsOrThresholds : undefined;
  const thresholds =
    typeof nowMsOrThresholds === "object" && nowMsOrThresholds !== null
      ? nowMsOrThresholds
      : undefined;
  const currentMs = nowMs ?? config.nowMs ?? (event?.at && event.at > 0 ? event.at * 1000 : Date.now());
  try {
    let head = plainHeadline(messages, event, currentMs);
    if (head === null) return null;
    const effectiveThresholds = thresholds ?? config.highlightThresholds;
    if (effectiveThresholds !== undefined) {
      const level = highlightLevel(event, effectiveThresholds);
      const marker = highlightMarker(level, effectiveThresholds);
      if (marker) head = prefixFirstLine(head, marker);
    }
    const body = `${head}\n${plainFooter(config, event)}`.trim();
    if (!body) return minimalPlainTextEvent(messages, event);
    return clipPlainText(body);
  } catch {
    return minimalPlainTextEvent(messages, event);
  }
}

function minimalPlainTextEvent(messages: Messages, event: DecodedEvent): string {
  const source = typeof event?.source === "string" ? event.source : "unknown";
  const ledger =
    typeof event?.ledger === "number" && Number.isFinite(event.ledger)
      ? `ledger ${event.ledger}`
      : "ledger unknown";
  const eventId = typeof event?.eventId === "string" && event.eventId ? event.eventId : "";
  return clipPlainText(messages.notificationPlain.minimal(source, ledger, eventId));
}

export function formatFallbackEvent(
  config: StellarConfig & RouteLocaleConfig,
  event: DecodedEvent,
  reason = "malformed payload",
): string {
  const source = escapeMd(event.source ?? "unknown");
  const contract = escapeMd(shortAddress(event.contractId ?? "unknown"));
  const ledger = escapeMd(String(event.ledger ?? "unknown"));
  const safeReason = escapeMd(safeErrorMessage(reason));
  const txPart = event.txHash ? ` · [tx](${txExplorerUrl(config, event.txHash)})` : "";
  return messagesFor(config.locale).notificationMd.fallbackEvent(
    source, contract, ledger, safeReason, txPart,
  );
}

/**
 * Generate a channel preview message for on-demand preview commands.
 * Shows a sample notification and current link preview settings for the specified contract or event.
 * If an unknown event or target is requested, returns a usage message listing valid names.
 */
export function previewMessage(
  config: StellarConfig & { linkPreviewMarket?: boolean; linkPreviewSquad?: boolean },
  target = "market",
): string {
  const messages = messagesFor(config.locale);
  const normalized = target.trim().toLowerCase();
  const samples = buildSampleEvents(config);

  const render = (sampleEvent: DecodedEvent): string => {
    const isSquad = sampleEvent.source === "squad";
    const linkPreviewEnabled = isSquad
      ? config.linkPreviewSquad ?? false
      : config.linkPreviewMarket ?? false;
    const settingsLine = `Link previews: ${linkPreviewEnabled ? "enabled" : "disabled"}`;
    const header = isSquad
      ? messages.notificationMd.channelPreviewSquad
      : messages.notificationMd.channelPreviewMarket;
    const formatted = formatEvent({ ...config, channelPreviewMode: false }, sampleEvent) ?? "";
    return `${header}\n${settingsLine}\n\n${formatted}`;
  };

  if (normalized === "squad") return render(samples["market_created"]);
  if (normalized === "market") return render(samples["claim_created"]);

  if (Object.prototype.hasOwnProperty.call(samples, normalized)) {
    return render(samples[normalized as keyof typeof samples]);
  }

  const validNames = Object.keys(samples)
    .sort()
    .map((name) => escapeMd(name))
    .join(", ");
  return (
    `Unknown preview event: \`${escapeMd(clip(target, 40))}\`\n\n` +
    `Usage: \`/preview <event_name>\`\n` +
    `Valid names:\n${validNames}\n\n` +
    `Shortcuts: \`market\`, \`squad\``
  );
}

// ── Accessible export contract (#921) ─────────────────────────────────────────

/** Format selector for {@link formatNotificationExport}. */
export type NotificationExportFormat = "plain" | "html";

/** Options for {@link formatNotificationExport}. */
export interface NotificationExportOptions {
  /**
   * `"plain"` (default) returns the image-free, text-only rendering via
   * {@link formatPlainTextEvent}; `"html"` returns the HTML rendering via
   * `formatEventHtml`.
   */
  format?: NotificationExportFormat;
}

/**
 * Canonical accessible-export entry point for a decoded event.
 *
 * Contract — every returned non-null string carries, as text:
 *   • market identity (claim/squad id and event name),
 *   • action (challenged / resolved / settled / deposited / …),
 *   • amount (USDC value with unit, when the event has one),
 *   • outcome (winner side, resolution result, or equivalent).
 *
 * Emoji or color is never the sole carrier of any of those: the plaintext path
 * emits no emoji at all for the plaintext renderer, and every emoji that does
 * appear in the HTML path is accompanied by a text label on the same line.
 *
 * Returns `null` when the event is filtered out or has no notification summary.
 */
export function formatNotificationExport(
  config: StellarConfig & {
    channelPreviewMode?: boolean;
    notificationCategories?: readonly string[];
    highlightThresholds?: HighlightThresholds;
    nowMs?: number;
  },
  event: DecodedEvent,
  options: NotificationExportOptions = {},
): string | null {
  if ((options.format ?? "plain") === "html") {
    return formatEventHtml(config, event);
  }
  return formatPlainTextEvent(config, event);
}
