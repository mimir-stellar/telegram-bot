import { summarizePayloadForLog } from "./decode.js";
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
