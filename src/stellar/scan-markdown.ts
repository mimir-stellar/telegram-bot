import { summarizePayloadForLog } from "./decode.js";

/** Patterns that suggest a private chat identifier or secret-shaped value. */
const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  /\bS[A-Z2-7]{55}\b/g,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/gi,
];

const CHAT_ID_PATTERN = /\b(?:chat[_-]?id|telegram[_-]?id)\s*[:=]\s*-?\d{5,}\b/gi;

export type PrivacyFindingKind = "private-chat-id" | "secret-value";

export interface PrivacyFinding {
  kind: PrivacyFindingKind;
  source: string;
  ledger: string;
  txHash: string;
  field: string;
  match: string;
}

export interface PrivacyReport {
  findings: PrivacyFinding[];
  scannedEvents: number;
}

/**
 * Deterministically scan a {@link ScanJsonReport} for private chat identifiers
 * and secret-shaped values. Performs no network access. Matched values are
  * redacted in the returned findings.
 */
export function reviewScanReportPrivacy(report: ScanJsonReport): PrivacyReport {
  const findings: PrivacyFinding[] = [];
  let scannedEvents = 0;

  for (const target of report?.targets ?? []) {
    const source = String(target.source ?? "");
    const events = Array.isArray(target.events) ? target.events : [];
    for (const event of events) {
      scannedEvents += 1;
      const text = summarizePayloadForLog(event.payload);
      const ledger = String(event.ledger ?? "");
      const txHash = typeof event.txHash === "string" ? event.txHash : "";
      const base = { source, ledger, txHash, field: "payload" };

      for (const pattern of CHAT_ID_PATTERN.source ? [CHAT_ID_PATTERN] : []) {
        for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
          findings.push({ kind: "private-chat-id", ...base, match: redact(m[0]) });
        }
      }
      for (const pattern of SECRET_PATTERNS) {
        for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
          findings.push({ kind: "secret-value", ...base, match: redact(m[0]) });
        }
      }
    }
  }

  return { findings, scannedEvents };
}

function redact(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}****${value.slice(-2)}`;
}

/** Render a {@link PrivacyReport} as deterministic Markdown. */
export function formatPrivacyReportMarkdown(report: PrivacyReport): string {
  const lines: string[] = [
    `Scanned events: ${report.scannedEvents}`,
    `Findings: ${report.findings.length}`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No private chat identifiers or secret-shaped values detected.");
    return lines.join("\n") + "\n";
  }
  lines.push("| Kind | Source | Ledger | Tx | Field | Match |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const f of report.findings) {
    lines.push(
      `| ${escapeMarkdownCell(f.kind)} | ${escapeMarkdownCell(f.source)} | ${escapeMarkdownCell(f.ledger)} | ${escapeMarkdownCell(shortTxHash(f.txHash))} | ${escapeMarkdownCell(f.field)} | ${escapeMarkdownCell(f.match)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
import type { ScanJsonEvent, ScanJsonReport } from "./events.js";

/** Default maximum number of event rows rendered before appending a trailing "N more" row. */
export const DEFAULT_MARKDOWN_MAX_ROWS = 50;

export interface ScanMarkdownOptions {
  /** Maximum event rows to render before capping with a trailing "N more" row. */
  maxRows?: number | undefined;
}

interface MarkdownRow {
  source: string;
  ledger: string;
  eventName: string;
  txHash: string;
  summary: string;
}

/**
 * Shorten a transaction hash for compact table display (`aabbcc00…1122`),
 * leaving already-short strings untouched.
 */
export function shortTxHash(txHash: string): string {
  return txHash.length <= 12 ? txHash : `${txHash.slice(0, 8)}…${txHash.slice(-4)}`;
}

/**
 * Sanitize cell text for a GitHub-flavoured Markdown table by collapsing
 * line breaks and escaping pipe characters (`|` -> `\|`).
 */
export function escapeMarkdownCell(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

function eventNameOf(event: ScanJsonEvent): string {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return "unknown";
  if (payload.name === "unknown") {
    return `unknown:${payload.eventName || "?"}`;
  }
  return payload.name;
}

/**
 * Format a {@link ScanJsonReport} as a GitHub-flavoured Markdown table that can
 * be pasted directly into issues and pull requests.
 *
 * Columns: `Source`, `Ledger`, `Event`, `Tx`, `Summary` (from {@link summarizePayloadForLog}).
 * Pipe characters in cell text are escaped as `\|`, and large reports are capped
 * with a trailing `"N more"` row.
 */
export function formatScanMarkdown(
  report: ScanJsonReport,
  options?: ScanMarkdownOptions | number,
): string {
  const rawMax =
    typeof options === "number"
      ? options
      : options?.maxRows ?? DEFAULT_MARKDOWN_MAX_ROWS;
  const maxRows = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : DEFAULT_MARKDOWN_MAX_ROWS;

  const allRows: MarkdownRow[] = [];
  let totalEvents = 0;

  for (const target of report?.targets ?? []) {
    const events = Array.isArray(target.events) ? target.events : [];
    const declaredCount =
      typeof target.eventCount === "number" && Number.isFinite(target.eventCount)
        ? target.eventCount
        : events.length;
    totalEvents += Math.max(declaredCount, events.length);

    for (const event of events) {
      allRows.push({
        source: String(target.source ?? ""),
        ledger: String(event.ledger ?? ""),
        eventName: eventNameOf(event),
        txHash: shortTxHash(typeof event.txHash === "string" ? event.txHash : ""),
        summary: summarizePayloadForLog(event.payload),
      });
    }
  }

  const visibleRows = allRows.slice(0, maxRows);
  const remaining = Math.max(0, totalEvents - visibleRows.length);

  const lines: string[] = [
    "| Source | Ledger | Event | Tx | Summary |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const row of visibleRows) {
    lines.push(
      `| ${escapeMarkdownCell(row.source)} | ${escapeMarkdownCell(row.ledger)} | ${escapeMarkdownCell(row.eventName)} | ${escapeMarkdownCell(row.txHash)} | ${escapeMarkdownCell(row.summary)} |`,
    );
  }

  if (remaining > 0) {
    lines.push(`| … | | | | ${remaining} more |`);
  }

  return lines.join("\n") + "\n";
}
