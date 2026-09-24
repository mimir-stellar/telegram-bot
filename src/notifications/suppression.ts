/**
 * Per-event notification suppression.
 *
 * Operators can silence noisy notifiable events (e.g. routine withdrawals)
 * without changing the poller cursor policy: suppressed events are logged and
 * counted as skipped, but the cursor still advances. The chain remains the
 * source of truth; this only gates Telegram posts.
 *
 * Admin / undecodable events are already non-notifying (`unknown` payloads) and
 * do not need to be listed here.
 */

/** Event names the bot can post about — the only valid SUPPRESSED_EVENTS values. */
export const SUPPRESSIBLE_EVENTS = [
  // mimir-market
  "claim_created",
  "claim_challenged",
  "claim_resolved",
  "claim_cancelled",
  "market_settled",
  "challenger_paid",
  "fee_claimed",
  "withdrawal",
  "withdrawal_pending",
  // mimir-squad
  "market_created",
  "deposited",
  "withdrawn",
  "resolved",
  "claimed",
  "fees_claimed",
] as const;

export type SuppressibleEvent = (typeof SUPPRESSIBLE_EVENTS)[number];

const SUPPRESSIBLE_SET: ReadonlySet<string> = new Set(SUPPRESSIBLE_EVENTS);

export interface ParsedSuppression {
  /** Lowercased, deduplicated event names to skip when notifying. */
  suppressed: Set<string>;
  /** Human-readable config problems (unknown names, etc.). */
  problems: string[];
}

/**
 * Parse a comma-separated `SUPPRESSED_EVENTS` value.
 *
 * Bounded behavior:
 * - unset / blank → no suppression
 * - empty slots (`a,,b`) and surrounding whitespace are ignored
 * - matching is case-insensitive
 * - unknown names become problems (fail-fast at boot) so typos never silently
 *   suppress nothing
 */
export function parseSuppressedEvents(raw: string | undefined): ParsedSuppression {
  const suppressed = new Set<string>();
  const problems: string[] = [];

  if (raw === undefined) return { suppressed, problems };
  const trimmed = raw.trim();
  if (trimmed === "") return { suppressed, problems };

  for (const part of trimmed.split(",")) {
    const name = part.trim().toLowerCase();
    if (name === "") continue;
    if (!SUPPRESSIBLE_SET.has(name)) {
      problems.push(
        `SUPPRESSED_EVENTS entry "${name}" is not a known notifiable event ` +
          `(expected one of: ${SUPPRESSIBLE_EVENTS.join(", ")})`,
      );
      continue;
    }
    suppressed.add(name);
  }

  return { suppressed, problems };
}

/** True when this decoded event name is configured to be silenced. */
export function isEventSuppressed(
  suppressed: ReadonlySet<string>,
  eventName: string,
): boolean {
  return suppressed.has(eventName);
}

/** Stable, sorted list for logs and /status (never includes secrets). */
export function formatSuppressedEvents(suppressed: ReadonlySet<string>): string {
  if (suppressed.size === 0) return "(none)";
  return [...suppressed].sort().join(", ");
}
