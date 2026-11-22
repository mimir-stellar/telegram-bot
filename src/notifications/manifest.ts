/**
 * Notification template compatibility manifest.
 *
 * Every notifiable contract event type is listed here with the payload fields
 * that each renderer (MarkdownV2, HTML, plaintext) requires to produce output.
 * A field listed as required must be present and non-null/non-undefined on the
 * event payload for the renderer to produce a meaningful notification.
 *
 * Purpose
 * ───────
 * When a new event type is added, or an existing field is renamed or removed,
 * updating this manifest causes the focused fixture check
 * (tests/notification-manifest.test.mjs) to surface the break immediately,
 * before any formatter silently degrades.
 *
 * Rules
 * ─────
 * • `requiredFields` lists only the fields that, when absent, make the
 *   notification non-renderable or misleading. Optional display fields (e.g.
 *   `summary` on `claim_resolved`, `category` on squad `market_created`) are
 *   intentionally excluded — their absence is handled by the formatters with
 *   explicit null/undefined guards.
 * • All three renderers share the same field requirements for every event: the
 *   three `switch` blocks in format.ts, html.ts and the plaintext path all
 *   mirror one another field-for-field.
 * • The `source` column documents which contract the event originates from,
 *   for documentation and test-fixture generation purposes.
 * • `silentEvents` are event names the bot intentionally does not notify for.
 *   They must NOT appear in `notifiableEvents`. The fixture check validates
 *   this invariant.
 */

import type { EventPayload } from "../stellar/decode.js";

/** Which Mimir contract an event originates from. */
export type EventSource = "market" | "squad";

/**
 * Descriptor for a single notifiable event type.
 *
 * `requiredFields` is typed as an array of keys of the payload union member
 * matching `name`, using a mapped lookup so TypeScript catches invalid field
 * names at compile time.
 */
export interface EventTemplateDescriptor<N extends EventPayload["name"]> {
  /** Contract event name, matches `payload.name`. */
  name: N;
  /** Which Mimir contract emits this event. */
  source: EventSource;
  /**
   * Payload fields that all three renderers require.
   * Any field listed here must be present on a valid event payload fixture.
   */
  requiredFields: ReadonlyArray<string>;
}

// ── mimir-market events ───────────────────────────────────────────────────────

const claimCreated: EventTemplateDescriptor<"claim_created"> = {
  name: "claim_created",
  source: "market",
  requiredFields: ["claimId", "creator", "category"],
};

const claimChallenged: EventTemplateDescriptor<"claim_challenged"> = {
  name: "claim_challenged",
  source: "market",
  requiredFields: ["claimId", "challenger", "stake"],
};

const claimResolved: EventTemplateDescriptor<"claim_resolved"> = {
  name: "claim_resolved",
  source: "market",
  // `summary` is optional (null allowed) in all three renderers — not listed here.
  requiredFields: ["claimId", "winnerSide", "confidence"],
};

const claimCancelled: EventTemplateDescriptor<"claim_cancelled"> = {
  name: "claim_cancelled",
  source: "market",
  requiredFields: ["claimId"],
};

const marketSettled: EventTemplateDescriptor<"market_settled"> = {
  name: "market_settled",
  source: "market",
  requiredFields: ["claimId", "totalPaid", "totalFees", "owedToChallengers"],
};

const challengerPaid: EventTemplateDescriptor<"challenger_paid"> = {
  name: "challenger_paid",
  source: "market",
  requiredFields: ["claimId", "challenger", "stake", "net", "gross", "fee"],
};

const feeClaimed: EventTemplateDescriptor<"fee_claimed"> = {
  name: "fee_claimed",
  source: "market",
  requiredFields: ["amount", "recipient"],
};

const withdrawal: EventTemplateDescriptor<"withdrawal"> = {
  name: "withdrawal",
  source: "market",
  requiredFields: ["amount", "to"],
};

const withdrawalPending: EventTemplateDescriptor<"withdrawal_pending"> = {
  name: "withdrawal_pending",
  source: "market",
  requiredFields: ["amount", "to"],
};

// ── mimir-squad events ────────────────────────────────────────────────────────

const marketCreated: EventTemplateDescriptor<"market_created"> = {
  name: "market_created",
  source: "squad",
  // `category` is optional (v2 only) — not listed here.
  requiredFields: ["marketId", "question", "captain", "feeBps", "deadline"],
};

const deposited: EventTemplateDescriptor<"deposited"> = {
  name: "deposited",
  source: "squad",
  requiredFields: ["marketId", "amount", "side", "participant"],
};

const withdrawn: EventTemplateDescriptor<"withdrawn"> = {
  name: "withdrawn",
  source: "squad",
  requiredFields: ["marketId", "participant", "amount", "side"],
};

const resolved: EventTemplateDescriptor<"resolved"> = {
  name: "resolved",
  source: "squad",
  requiredFields: ["marketId", "result", "poolA", "poolB"],
};

const claimed: EventTemplateDescriptor<"claimed"> = {
  name: "claimed",
  source: "squad",
  requiredFields: ["marketId", "participant", "net", "gross", "fee"],
};

const feesClaimedSquad: EventTemplateDescriptor<"fees_claimed"> = {
  name: "fees_claimed",
  source: "squad",
  requiredFields: ["amount", "recipient"],
};

/**
 * All event types the bot sends notifications for, in declaration order.
 *
 * This is the single source of truth for the compatibility check. Adding a
 * new notifiable event type requires a corresponding entry here AND a
 * matching `case` in all three renderer switch blocks (format.ts, html.ts,
 * and the plain-text path in format.ts).
 */
export const notifiableEvents: ReadonlyArray<EventTemplateDescriptor<EventPayload["name"]>> = [
  // mimir-market
  claimCreated,
  claimChallenged,
  claimResolved,
  claimCancelled,
  marketSettled,
  challengerPaid,
  feeClaimed,
  withdrawal,
  withdrawalPending,
  // mimir-squad
  marketCreated,
  deposited,
  withdrawn,
  resolved,
  claimed,
  feesClaimedSquad,
];

/**
 * Event names the bot intentionally suppresses (no notification, no error).
 *
 * Any event name in this list that also appears in `notifiableEvents` is a
 * manifest inconsistency and the fixture check will fail.
 */
export const silentEvents: ReadonlyArray<string> = [
  "oracle_changed",
  "ownership_transferred",
  "agent_attributed",
  "fee_accrued",
  "fee_policy_set",
  "fee_policy_changed",
  "fee_policy_updated",
  "fee_policy_removed",
  "admin",
  "unknown",
];

/**
 * Validate that a payload object satisfies all required fields for its event
 * type as declared in the manifest.
 *
 * Returns an array of missing field names. An empty array means the payload
 * is compatible. Returns `null` when `name` is not found in the manifest (i.e.
 * it is a silent or unknown event and no check applies).
 *
 * This function is intentionally side-effect-free: it only reads the manifest
 * and the payload, never throws, and never mutates anything. Tests use it
 * directly to assert fixture compatibility.
 */
export function checkPayloadCompatibility(
  name: string,
  payload: Record<string, unknown>,
): string[] | null {
  const descriptor = notifiableEvents.find((d) => d.name === name);
  if (descriptor === undefined) return null;

  const missing: string[] = [];
  for (const field of descriptor.requiredFields) {
    const value = payload[field];
    if (value === undefined || value === null) {
      missing.push(field);
    }
  }
  return missing;
}

/**
 * A lookup map from event name to its descriptor, for O(1) access in
 * hot paths (e.g. poller-side pre-flight checks).
 */
export const notifiableEventsByName: ReadonlyMap<
  string,
  EventTemplateDescriptor<EventPayload["name"]>
> = new Map(notifiableEvents.map((d) => [d.name, d]));
