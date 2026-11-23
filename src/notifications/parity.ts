/**
 * Semantic parity verification across notification renderers.
 *
 * MarkdownV2 ({@link formatEvent}), plaintext ({@link formatPlainTextEvent}),
 * and Telegram HTML ({@link formatEventHtml}) have distinct escaping and layout
 * constraints, but they must preserve the same critical domain facts for every
 * event:
 *   - Event identity (claim/market id, participant/actor address, ledger)
 *   - Amounts (USDC figures, fee basis points)
 *   - Verdicts (winner side, confidence, squad side/result, cancellation)
 *
 * Presentation differences (markup tags, escaping, link syntax, emoji,
 * whitespace, or separator punctuation) are normalized away before comparison,
 * while any dropped or altered critical fact is reported as a violation.
 */

import type { StellarConfig } from "../config.js";
import {
  formatUsdc,
  shortAddress,
  squadSideLabel,
  winnerSideLabel,
  type DecodedEvent,
} from "../stellar/decode.js";
import { confidenceIndicator } from "./confidence.js";
import { formatEvent, formatPlainTextEvent } from "./format.js";
import { formatEventHtml } from "./html.js";

export type RendererFormat = "markdown" | "plaintext" | "html";

export type SemanticFieldKind = "identity" | "amount" | "verdict";

export interface SemanticFact {
  kind: SemanticFieldKind;
  field: string;
  value: string;
}

export interface RenderedOutputs {
  markdown: string | null;
  plaintext: string | null;
  html: string | null;
}

export interface ParityViolation {
  format: RendererFormat;
  kind: SemanticFieldKind | "nullability";
  field: string;
  expected: string;
  reason: string;
}

export interface SemanticParityResult {
  ok: boolean;
  eventName: string;
  facts: SemanticFact[];
  rendered: RenderedOutputs;
  violations: ParityViolation[];
}

export type ParityConfig = StellarConfig & {
  channelPreviewMode?: boolean;
  notificationCategories?: readonly string[];
};

const ALL_FORMATS: readonly RendererFormat[] = ["markdown", "plaintext", "html"];

const HTML_ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * Strip format-specific presentation markup and escaping so that semantic
 * facts can be compared across renderers without false positives from styling
 * differences (bold/italic/code tags, MarkdownV2 backslash escapes, link
 * syntax, or whitespace).
 */
export function normalizeRenderedText(format: RendererFormat, text: string): string {
  let normalized = text;

  if (format === "markdown") {
    // Convert MarkdownV2 links [label](url) to "label url".
    normalized = normalized.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 $2");
    // Unescape MarkdownV2 backslash-escaped characters.
    normalized = normalized.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1");
    // Strip MarkdownV2 emphasis/code wrappers.
    normalized = normalized.replace(/[*_`~]/g, "");
  } else if (format === "html") {
    // Preserve href URLs alongside anchor text before stripping tags.
    normalized = normalized.replace(
      /<a\s+href="([^"]*)"\s*>([\s\S]*?)<\/a>/gi,
      "$2 $1",
    );
    // Strip remaining HTML tags.
    normalized = normalized.replace(/<\/?[a-zA-Z0-9]+(?:\s+[^>]*)?>/g, "");
    // Decode HTML entities.
    normalized = normalized.replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (entity) => HTML_ENTITY_MAP[entity] ?? entity,
    );
  }

  return normalized.replace(/\s+/g, " ").trim();
}

function usdcFact(field: string, units: bigint): SemanticFact {
  return { kind: "amount", field, value: `${formatUsdc(units)} USDC` };
}

function addressFact(field: string, address: string): SemanticFact {
  return { kind: "identity", field, value: shortAddress(address) };
}

/**
 * Extract the critical semantic facts (identity, amount, verdict) that every
 * notification renderer must preserve for a decoded event.
 *
 * Returns an empty array for non-notifiable events (admin / unknown).
 */
export function extractSemanticFacts(event: DecodedEvent): SemanticFact[] {
  const p = event.payload;
  const ledgerFact: SemanticFact = {
    kind: "identity",
    field: "ledger",
    value: `ledger ${event.ledger}`,
  };

  switch (p.name) {
    // ── mimir-market ────────────────────────────────────────────────────────
    case "claim_created":
      return [
        { kind: "identity", field: "claimId", value: `#${p.claimId}` },
        addressFact("creator", p.creator),
        ledgerFact,
      ];

    case "claim_challenged":
      return [
        { kind: "identity", field: "claimId", value: `#${p.claimId}` },
        usdcFact("stake", p.stake),
        addressFact("challenger", p.challenger),
        ledgerFact,
      ];

    case "claim_resolved":
      return [
        { kind: "identity", field: "claimId", value: `#${p.claimId}` },
        { kind: "verdict", field: "winnerSide", value: winnerSideLabel(p.winnerSide) },
        { kind: "verdict", field: "confidence", value: confidenceIndicator(p.confidence) },
        ledgerFact,
      ];

    case "claim_cancelled":
      return [
        { kind: "identity", field: "claimId", value: `#${p.claimId}` },
        { kind: "verdict", field: "status", value: "cancelled" },
        ledgerFact,
      ];

    case "market_settled":
      return [
        { kind: "identity", field: "claimId", value: `#${p.claimId}` },
        usdcFact("totalPaid", p.totalPaid),
        usdcFact("totalFees", p.totalFees),
        usdcFact("owedToChallengers", p.owedToChallengers),
        ledgerFact,
      ];

    case "challenger_paid":
      return [
        { kind: "identity", field: "claimId", value: `#${p.claimId}` },
        addressFact("challenger", p.challenger),
        usdcFact("stake", p.stake),
        usdcFact("net", p.net),
        usdcFact("gross", p.gross),
        usdcFact("fee", p.fee),
        ledgerFact,
      ];

    case "fee_claimed":
      return [
        usdcFact("amount", p.amount),
        addressFact("recipient", p.recipient),
        ledgerFact,
      ];

    case "withdrawal":
      return [
        usdcFact("amount", p.amount),
        addressFact("to", p.to),
        ledgerFact,
      ];

    case "withdrawal_pending":
      return [
        usdcFact("amount", p.amount),
        addressFact("to", p.to),
        ledgerFact,
      ];

    // ── mimir-squad ─────────────────────────────────────────────────────────
    case "market_created":
      return [
        { kind: "identity", field: "marketId", value: `#${p.marketId}` },
        addressFact("captain", p.captain),
        { kind: "amount", field: "feeBps", value: `${p.feeBps} bps` },
        ledgerFact,
      ];

    case "deposited":
      return [
        { kind: "identity", field: "marketId", value: `#${p.marketId}` },
        usdcFact("amount", p.amount),
        { kind: "verdict", field: "side", value: squadSideLabel(p.side) },
        addressFact("participant", p.participant),
        ledgerFact,
      ];

    case "withdrawn":
      return [
        { kind: "identity", field: "marketId", value: `#${p.marketId}` },
        addressFact("participant", p.participant),
        usdcFact("amount", p.amount),
        { kind: "verdict", field: "side", value: squadSideLabel(p.side) },
        ledgerFact,
      ];

    case "resolved":
      return [
        { kind: "identity", field: "marketId", value: `#${p.marketId}` },
        { kind: "verdict", field: "result", value: squadSideLabel(p.result) },
        usdcFact("poolA", p.poolA),
        usdcFact("poolB", p.poolB),
        ledgerFact,
      ];

    case "claimed":
      return [
        { kind: "identity", field: "marketId", value: `#${p.marketId}` },
        addressFact("participant", p.participant),
        usdcFact("net", p.net),
        usdcFact("gross", p.gross),
        usdcFact("fee", p.fee),
        ledgerFact,
      ];

    case "fees_claimed":
      return [
        usdcFact("amount", p.amount),
        addressFact("recipient", p.recipient),
        ledgerFact,
      ];

    // Non-notifiable events have no expected notification facts.
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
    default:
      return [];
  }
}

function factPresent(normalizedText: string, fact: SemanticFact): boolean {
  if (fact.kind === "verdict") {
    return normalizedText.toLowerCase().includes(fact.value.toLowerCase());
  }
  return normalizedText.includes(fact.value);
}

/**
 * Compare already-rendered outputs from MarkdownV2, plaintext, and HTML
 * renderers against the event's critical semantic facts.
 *
 * Allows presentation differences while rejecting:
 * - Nullability mismatches (one renderer emits a message while another suppresses it)
 * - Missing or altered identity, amount, or verdict facts in any format
 */
export function checkRenderedParity(
  event: DecodedEvent,
  rendered: RenderedOutputs,
): SemanticParityResult {
  const eventName =
    event.payload.name === "unknown" ? event.payload.eventName : event.payload.name;
  const facts = extractSemanticFacts(event);
  const violations: ParityViolation[] = [];

  const nonNullFormats = ALL_FORMATS.filter((fmt) => rendered[fmt] !== null);
  const nullFormats = ALL_FORMATS.filter((fmt) => rendered[fmt] === null);

  // 1. All renderers must agree on whether the event produces a notification.
  if (nonNullFormats.length > 0 && nullFormats.length > 0) {
    for (const fmt of nullFormats) {
      violations.push({
        format: fmt,
        kind: "nullability",
        field: "output",
        expected: "non-null notification",
        reason: `${fmt} returned null while ${nonNullFormats.join(", ")} rendered output`,
      });
    }
  }

  // 2. Every non-null renderer output must contain all critical semantic facts.
  for (const fmt of nonNullFormats) {
    const raw = rendered[fmt];
    if (raw === null) continue;
    const normalized = normalizeRenderedText(fmt, raw);

    for (const fact of facts) {
      if (!factPresent(normalized, fact)) {
        violations.push({
          format: fmt,
          kind: fact.kind,
          field: fact.field,
          expected: fact.value,
          reason: `${fmt} output is missing ${fact.kind} fact "${fact.field}" (${fact.value})`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    eventName,
    facts,
    rendered,
    violations,
  };
}

/**
 * Render an event with all three notification renderers (MarkdownV2,
 * plaintext, HTML) and verify semantic parity across all outputs.
 */
export function checkEventSemanticParity(
  config: ParityConfig,
  event: DecodedEvent,
): SemanticParityResult {
  const rendered: RenderedOutputs = {
    markdown: formatEvent(config, event),
    plaintext: formatPlainTextEvent(config, event),
    html: formatEventHtml(config, event),
  };
  return checkRenderedParity(event, rendered);
}
