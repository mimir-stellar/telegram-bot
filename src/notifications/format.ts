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

function flatLine(event: DecodedEvent): string {
  const name = event.payload.name === "unknown" ? event.payload.eventName : event.payload.name;
  return `· mimir\\-${escapeMd(event.source)} \`${escapeMd(clip(name, 80))}\` at ledger ${event.ledger}`;
}

function renderGroupedDigest(events: readonly DecodedEvent[]): string {
  const groups = groupDigestEvents(events);
  const header = digestHeader(events.length, completeness);
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
  const lines = sortDigestEvents(events).map(flatLine);
  return [`*Mimir Digest* — ${events.length} events in this cycle`, "", ...lines].join("\n");
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

export function previewMessage(
  config: StellarConfig & { linkPreviewMarket?: boolean; linkPreviewSquad?: boolean },
  target = "market",
): string {
  const messages = messagesFor(config.locale);
  const isSquad = target.trim().toLowerCase() === "squad";
  const linkPreviewEnabled = isSquad
    ? config.linkPreviewSquad ?? false
    : config.linkPreviewMarket ?? false;
  const settingsLine = `Link previews: ${linkPreviewEnabled ? "enabled" : "disabled"}`;
  if (isSquad) {
    const sampleEvent: DecodedEvent = {
      source: "squad",
      contractId: config.squadContractId,
      version: "v1",
      ledger: 1000000,
      txHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      at: Math.floor(Date.now() / 1000),
      eventId: "1000000-1",
      eventType: "contract",
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
      payload: {
        name: "market_created",
        marketId: 1,
        question: "Will Stellar process 1M Soroban operations in 24 hours?",
        captain: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        feeBps: 100,
        deadline: 1770000000,
      },
    };
    const formatted = formatEvent({ ...config, channelPreviewMode: false }, sampleEvent) ?? "";
    return `${messages.notificationMd.channelPreviewSquad}\n${settingsLine}\n\n${formatted}`;
  }
  const sampleEvent: DecodedEvent = {
    source: "market",
    contractId: config.marketContractId,
    version: "v1",
    ledger: 1000000,
    txHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    at: Math.floor(Date.now() / 1000),
    eventId: "1000000-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: 1,
      category: "crypto",
      creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    },
  };
  const formatted = formatEvent({ ...config, channelPreviewMode: false }, sampleEvent) ?? "";
  return `${messages.notificationMd.channelPreviewMarket}\n${settingsLine}\n\n${formatted}`;
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
