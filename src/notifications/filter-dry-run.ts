/**
 * Dry-run filter evaluation report over a local event archive.
 *
 * Evaluates filter expressions and/or amount thresholds against decoded events
 * stored in a local JSONL event archive without modifying live bot configuration.
 *
 * Counts matching and rejected events by reason, providing operators with a pure,
 * safe dry-run preview of proposed filter changes before deployment.
 */

import { readArchive, type ReadArchiveOptions } from "../stellar/archive.js";
import type { DecodedEvent } from "../stellar/decode.js";
import {
  parseFilterExpression,
  evaluateFilterRule,
  type FilterRule,
  EVENT_PAYLOAD_SCHEMAS,
} from "./filter-expr.js";
import {
  meetsThreshold,
  type AmountThresholds,
} from "./amount-threshold.js";

/**
 * Filter configuration for a dry-run report.
 * Either expression, expressions list, and/or amount thresholds can be supplied.
 */
export interface FilterDryRunConfig {
  /** Single filter expression string to evaluate. */
  expression?: string;
  /** Multiple filter expressions to evaluate (all must match). */
  expressions?: readonly string[];
  /** Amount thresholds to evaluate. */
  thresholds?: AmountThresholds;
}

/**
 * Reason an event was rejected (or evaluated) during dry-run filtering.
 */
export type RejectionReason =
  | "name_mismatch"
  | "condition_unmet"
  | "threshold_unmet"
  | "unknown_payload"
  | "malformed";

/**
 * Breakdown of event counts by event name.
 */
export interface EventNameCounts {
  [eventName: string]: {
    total: number;
    matched: number;
    rejected: number;
  };
}

/**
 * Breakdown of rejections by specific rejection reason.
 */
export interface RejectionReasonCounts {
  /** Event payload name does not match expression's eventName filter. */
  name_mismatch: number;
  /** Event matched name (or general rule) but failed the expression condition. */
  condition_unmet: number;
  /** Event failed configured USDC amount threshold (market challenge stake or squad deposit amount). */
  threshold_unmet: number;
  /** Non-notifiable or unknown payload (payload name unknown/missing). */
  unknown_payload: number;
  /** Event record failed evaluation or was unparseable. */
  malformed: number;
  /** Catch-all for other failure reasons. */
  [customReason: string]: number;
}

/**
 * Result of evaluating a filter dry-run against an archive.
 */
export interface FilterDryRunReport {
  /** Total events read from the archive. */
  totalEvents: number;
  /** Number of events matching all applied filter rules and thresholds. */
  matchedEvents: number;
  /** Number of events rejected by any filter rule or threshold. */
  rejectedEvents: number;
  /** Counts of rejections grouped by reason. */
  rejectionReasons: RejectionReasonCounts;
  /** Counts of events grouped by payload event name. */
  byEventName: EventNameCounts;
  /** Filter expressions parsed and evaluated during the dry-run. */
  expressionsEvaluated: string[];
  /** Thresholds evaluated during the dry-run, if provided. */
  thresholdsEvaluated?: AmountThresholds;
  /** Timestamp when the dry-run was executed. */
  executedAt: string;
}

/**
 * Options for running the filter dry-run report.
 */
export interface RunFilterDryRunOptions {
  /** Path to the archive directory containing events-*.jsonl files. */
  archiveDir: string;
  /** Filter configuration to evaluate against the archive. */
  filter: FilterDryRunConfig;
  /** Archive read options (e.g. retainCommitted). */
  archiveOptions?: ReadArchiveOptions;
  /** Optional custom timestamp provider for deterministic testing. */
  now?: () => Date;
}

/**
 * Normalizes event payload fields so that string-serialized bigint values
 * (from JSON serialization in the archive) are restored to bigints before filter evaluation.
 */
export function normalizeArchiveEventPayload(event: DecodedEvent): DecodedEvent {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") {
    return event;
  }
  const eventName = payload.name;
  if (typeof eventName !== "string") {
    return event;
  }
  const schema = EVENT_PAYLOAD_SCHEMAS[eventName];
  if (!schema) {
    return event;
  }
  const normalizedPayload: Record<string, unknown> = { ...payload };
  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (fieldDef.type === "bigint") {
      const val = normalizedPayload[fieldName];
      if (typeof val === "string" && /^-?\d+$/.test(val.trim())) {
        try {
          normalizedPayload[fieldName] = BigInt(val.trim());
        } catch {
          // ignore
        }
      } else if (typeof val === "number" && Number.isInteger(val)) {
        normalizedPayload[fieldName] = BigInt(val);
      }
    }
  }
  return {
    ...event,
    payload: normalizedPayload as unknown as DecodedEvent["payload"],
  };
}

/**
 * Evaluates whether an event passes the provided parsed rules and thresholds,
 * returning `{ matched: true }` or `{ matched: false, reason: RejectionReason }`.
 */
export function evaluateEventAgainstFilter(
  rawEvent: DecodedEvent,
  rules: readonly FilterRule[],
  thresholds?: AmountThresholds,
): { matched: true } | { matched: false; reason: RejectionReason } {
  const event = normalizeArchiveEventPayload(rawEvent);
  const payload = event.payload as Record<string, unknown> | undefined;

  if (!payload || typeof payload !== "object") {
    return { matched: false, reason: "malformed" };
  }

  const eventName = typeof payload.name === "string" ? payload.name : "";
  if (!eventName || eventName === "unknown") {
    return { matched: false, reason: "unknown_payload" };
  }

  // Check amount thresholds first if configured
  if (thresholds && !meetsThreshold(event, thresholds)) {
    return { matched: false, reason: "threshold_unmet" };
  }

  // Check filter expression rules
  for (const rule of rules) {
    if (rule.eventName && rule.eventName !== eventName) {
      return { matched: false, reason: "name_mismatch" };
    }
    if (rule.condition && !evaluateFilterRule(rule, event)) {
      return { matched: false, reason: "condition_unmet" };
    }
  }

  return { matched: true };
}

/**
 * Runs a dry-run filter report over an event archive directory.
 *
 * Reads events from the archive, passes them through the production expression parser
 * and threshold evaluator, and aggregates matching and rejection counts by reason.
 *
 * Does not modify any live configuration or state.
 *
 * @throws {@link FilterParseError} if any filter expression is invalid.
 */
export async function runFilterDryRunReport(
  options: RunFilterDryRunOptions,
): Promise<FilterDryRunReport> {
  const { archiveDir, filter, archiveOptions, now = () => new Date() } = options;

  // Compile filter expressions through the production parser
  const expressions: string[] = [];
  if (filter.expression && filter.expression.trim()) {
    expressions.push(filter.expression.trim());
  }
  if (filter.expressions) {
    for (const expr of filter.expressions) {
      if (expr && expr.trim()) {
        expressions.push(expr.trim());
      }
    }
  }

  const parsedRules: FilterRule[] = expressions.map((expr) =>
    parseFilterExpression(expr),
  );

  const report: FilterDryRunReport = {
    totalEvents: 0,
    matchedEvents: 0,
    rejectedEvents: 0,
    rejectionReasons: {
      name_mismatch: 0,
      condition_unmet: 0,
      threshold_unmet: 0,
      unknown_payload: 0,
      malformed: 0,
    },
    byEventName: {},
    expressionsEvaluated: expressions,
    thresholdsEvaluated: filter.thresholds,
    executedAt: now().toISOString(),
  };

  for await (const event of readArchive(archiveDir, archiveOptions)) {
    report.totalEvents += 1;

    const payloadName =
      event.payload && typeof event.payload.name === "string"
        ? event.payload.name
        : "unknown";

    if (!report.byEventName[payloadName]) {
      report.byEventName[payloadName] = { total: 0, matched: 0, rejected: 0 };
    }
    report.byEventName[payloadName].total += 1;

    const evalResult = evaluateEventAgainstFilter(event, parsedRules, filter.thresholds);

    if (evalResult.matched) {
      report.matchedEvents += 1;
      report.byEventName[payloadName].matched += 1;
    } else {
      report.rejectedEvents += 1;
      report.byEventName[payloadName].rejected += 1;
      const reason = evalResult.reason;
      report.rejectionReasons[reason] = (report.rejectionReasons[reason] ?? 0) + 1;
    }
  }

  return report;
}

/**
 * Formats a {@link FilterDryRunReport} into a clean, human-readable plain-text summary.
 */
export function formatFilterDryRunReport(report: FilterDryRunReport): string {
  const lines: string[] = [];

  lines.push("=== Filter Dry-Run Report ===");
  lines.push(`Executed at: ${report.executedAt}`);
  lines.push(
    `Expressions (${report.expressionsEvaluated.length}): ${
      report.expressionsEvaluated.length > 0
        ? report.expressionsEvaluated.map((e) => `"${e}"`).join(", ")
        : "none (unfiltered)"
    }`,
  );

  if (report.thresholdsEvaluated) {
    const parts: string[] = [];
    if (report.thresholdsEvaluated.marketChallenge !== undefined) {
      parts.push(`marketChallenge: ${report.thresholdsEvaluated.marketChallenge} units`);
    }
    if (report.thresholdsEvaluated.squadDeposit !== undefined) {
      parts.push(`squadDeposit: ${report.thresholdsEvaluated.squadDeposit} units`);
    }
    lines.push(`Thresholds: ${parts.length > 0 ? parts.join(", ") : "none"}`);
  }

  lines.push("");
  lines.push(`Total Events Evaluated: ${report.totalEvents}`);
  lines.push(
    `Matched: ${report.matchedEvents} (${
      report.totalEvents > 0
        ? Math.round((report.matchedEvents / report.totalEvents) * 100)
        : 0
    }%)`,
  );
  lines.push(
    `Rejected: ${report.rejectedEvents} (${
      report.totalEvents > 0
        ? Math.round((report.rejectedEvents / report.totalEvents) * 100)
        : 0
    }%)`,
  );

  lines.push("");
  lines.push("Rejection Reasons:");
  const reasonEntries = Object.entries(report.rejectionReasons);
  if (reasonEntries.every(([, count]) => count === 0)) {
    lines.push("  (no rejections)");
  } else {
    for (const [reason, count] of reasonEntries) {
      if (count > 0) {
        lines.push(`  - ${reason}: ${count}`);
      }
    }
  }

  lines.push("");
  lines.push("By Event Name:");
  const eventEntries = Object.entries(report.byEventName);
  if (eventEntries.length === 0) {
    lines.push("  (no events in archive)");
  } else {
    for (const [name, stats] of eventEntries) {
      lines.push(
        `  - ${name}: ${stats.total} total (matched: ${stats.matched}, rejected: ${stats.rejected})`,
      );
    }
  }

  return lines.join("\n");
}
