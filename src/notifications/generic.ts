/**
 * Plain-text notification formatter for generic Soroban contract events.
 *
 * ── Invariants ───────────────────────────────────────────────────────────────
 *
 * 1. NEVER throws on null, undefined, or malformed input shapes.
 * 2. Emits plain text only (no Markdown or HTML entity escaping).
 * 3. Output is capped to TELEGRAM_MAX_MESSAGE_LENGTH (4096) to prevent send rejections.
 * 4. Flexibly accepts (event, config?), (config, event), or (event).
 */

import type { StellarConfig } from "../config.js";
import { txExplorerUrl } from "../stellar/client.js";
import { shortAddress } from "../stellar/decode.js";
import type { GenericDecodedEvent } from "../stellar/generic-decode.js";

/** Plain text message limit matching Telegram Bot API hard ceiling. */
export const MAX_GENERIC_NOTIFICATION_LENGTH = 4096;

function clipPlainText(text: string, max: number = MAX_GENERIC_NOTIFICATION_LENGTH): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function isStellarConfig(val: unknown): val is StellarConfig {
  if (!val || typeof val !== "object") return false;
  const c = val as Record<string, unknown>;
  return (
    typeof c.rpcUrl === "string" ||
    typeof c.horizonUrl === "string" ||
    typeof c.networkPassphrase === "string" ||
    typeof c.chatId === "string"
  );
}

function resolveExplorerUrl(config: StellarConfig | undefined, txHash: string | undefined): string | null {
  if (!config || !txHash) return null;
  const trimmed = txHash.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  try {
    const url = txExplorerUrl(config, trimmed);
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Format a generic contract event into plain text.
 *
 * Supported call patterns:
 * - `formatGenericEvent(event, config?)`
 * - `formatGenericEvent(config, event)`
 */
export function formatGenericEvent(
  first: unknown,
  second?: unknown,
): string {
  try {
    let event: Partial<GenericDecodedEvent> & Record<string, unknown>;
    let config: StellarConfig | undefined;

    if (isStellarConfig(first)) {
      config = first;
      event = (second ?? {}) as Partial<GenericDecodedEvent> & Record<string, unknown>;
    } else {
      event = (first ?? {}) as Partial<GenericDecodedEvent> & Record<string, unknown>;
      if (isStellarConfig(second)) {
        config = second;
      }
    }

    const contractId = typeof event.contractId === "string" ? event.contractId.trim() : "";
    const eventName =
      (typeof event.eventName === "string" && event.eventName.trim()) ||
      (event.payload && typeof (event.payload as { eventName?: unknown }).eventName === "string"
        ? String((event.payload as { eventName: unknown }).eventName).trim()
        : "generic");

    const header = contractId
      ? `Contract: ${shortAddress(contractId)} · Event: ${eventName}`
      : `Event: ${eventName}`;

    let topicsStr = "";
    if (Array.isArray(event.topics)) {
      topicsStr = event.topics.join(" | ");
    } else if (event.payload && Array.isArray((event.payload as { topics?: unknown }).topics)) {
      topicsStr = (event.payload as { topics: unknown[] }).topics.join(" | ");
    } else if (typeof event.topicSummary === "string") {
      topicsStr = event.topicSummary;
    }

    let valueStr = "";
    if (typeof event.value === "string") {
      valueStr = event.value;
    } else if (event.payload && typeof (event.payload as { value?: unknown }).value === "string") {
      valueStr = String((event.payload as { value: unknown }).value);
    } else if (typeof event.valueSummary === "string") {
      valueStr = event.valueSummary;
    } else {
      valueStr = "void";
    }

    const ledger =
      typeof event.ledger === "number" && Number.isFinite(event.ledger) && event.ledger > 0
        ? `ledger ${event.ledger}`
        : "ledger unknown";

    const txHash = typeof event.txHash === "string" ? event.txHash.trim() : "";
    const explorerUrl = resolveExplorerUrl(config, txHash);

    let footer = ledger;
    if (explorerUrl) {
      footer += `\ntx: ${explorerUrl}`;
    } else if (txHash) {
      footer += `\ntx: ${txHash}`;
    }

    const lines = [
      header,
      `Topics: ${topicsStr || "(none)"}`,
      `Value: ${valueStr || "void"}`,
      footer,
    ];

    return clipPlainText(lines.join("\n").trim());
  } catch {
    return "Event: unknown\nTopics: (none)\nValue: malformed\nledger unknown";
  }
}
