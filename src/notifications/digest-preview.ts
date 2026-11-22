/**
 * Non-consuming operator preview for the current pending digest window.
 *
 * Renders the pending window through the live {@link formatDigest} builder
 * without draining or mutating the underlying event buffer, so operators can
 * inspect what the next scheduled digest will look like before it fires.
 */

import type { DecodedEvent } from "../stellar/decode.js";
import {
  normalizeDigestCompleteness,
  type DigestPeriodCompleteness,
} from "./digest-grouping.js";
import {
  escapeMd,
  formatDigest,
  type FormatDigestOptions,
} from "./format.js";

/**
 * Read-only view of a pending digest window.
 *
 * Any buffer exposing `peek()` (including {@link DeferredQueue}) satisfies this
 * interface without exposing mutation or drain methods to the preview path.
 */
export interface PendingDigestWindow {
  /** Return a non-consuming snapshot of events currently in the pending window. */
  peek(): readonly DecodedEvent[];
  /** Optional completeness metadata for the current pending period. */
  completeness?: () => Partial<DigestPeriodCompleteness> | undefined;
  /** Optional default formatting options (e.g. `{ grouped: true }`). */
  formatOptions?: FormatDigestOptions | undefined;
  /** Optional next scheduled digest timestamp (unix ms), e.g. from `nextRun`. */
  nextRunAtMs?: () => number | null;
}

/** Optional overrides when rendering a pending digest preview. */
export interface DigestPreviewOptions {
  /** Override grouped vs flat layout for this preview. */
  grouped?: boolean | undefined;
  /** Override completeness metadata for this preview. */
  completeness?: Partial<DigestPeriodCompleteness> | undefined;
}

/** Structured result of previewing the current pending digest window. */
export interface DigestPreviewResult {
  /** Exact output of the live `formatDigest` builder, or `null` when empty and complete. */
  digest: string | null;
  /** Number of pending events observed in the window (never consumed). */
  pendingCount: number;
  /** Normalized completeness metadata for the pending window. */
  completeness: DigestPeriodCompleteness;
  /** Next scheduled digest timestamp in unix ms, or `null` when unknown. */
  nextRunAtMs: number | null;
  /** Ready-to-send MarkdownV2 preview message for the operator. */
  message: string;
}

/**
 * Render a preview of the current pending digest window using the live
 * {@link formatDigest} builder without consuming any events.
 */
export function previewPendingDigest(
  window: PendingDigestWindow,
  options: DigestPreviewOptions = {},
): DigestPreviewResult {
  const events = window.peek();
  const rawCompleteness =
    options.completeness ?? window.completeness?.() ?? window.formatOptions?.completeness;
  const completeness = normalizeDigestCompleteness(rawCompleteness);
  const grouped = options.grouped ?? window.formatOptions?.grouped ?? false;

  const digest = formatDigest(events, { grouped, completeness });
  const rawNextRun = window.nextRunAtMs?.() ?? null;
  const nextRunAtMs =
    typeof rawNextRun === "number" && Number.isFinite(rawNextRun) ? rawNextRun : null;

  const headerLines = [
    "🧪 *Digest Preview* \\(pending window, events not consumed\\)",
  ];
  if (nextRunAtMs !== null) {
    headerLines.push(`Next scheduled digest: ${escapeMd(new Date(nextRunAtMs).toISOString())}`);
  }

  const body =
    digest ?? "_No pending events in the current digest window\\._";

  return {
    digest,
    pendingCount: events.length,
    completeness,
    nextRunAtMs,
    message: `${headerLines.join("\n")}\n\n${body}`,
  };
}
