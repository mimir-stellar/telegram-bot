/**
 * Address activity lookup and aggregation across Mimir market and squad events.
 *
 * Scans decoded events for appearances of a given Stellar address in any
 * role (creator, challenger, participant, captain, recipient, to), orders
 * the matching entries deterministically via `compareEvents`, and aggregates
 * amounts per role.
 */

import { StrKey } from "@stellar/stellar-sdk";
import {
  compareEvents,
  formatUsdc,
  shortAddress,
  type DecodedEvent,
} from "./decode.js";

/** Roles that a Stellar address can take in Mimir events. */
export type ActivityRole =
  | "creator"
  | "challenger"
  | "participant"
  | "captain"
  | "recipient"
  | "to";

export const ACTIVITY_ROLES: readonly ActivityRole[] = [
  "creator",
  "challenger",
  "participant",
  "captain",
  "recipient",
  "to",
] as const;

/** A single role-tagged event entry for an address. */
export interface ActivityEntry {
  role: ActivityRole;
  event: DecodedEvent;
  amount: bigint;
}

/** Aggregated activity report for a single address across events. */
export interface AddressActivityResult {
  readonly ok: true;
  readonly address: string;
  readonly entries: ActivityEntry[];
  readonly totals: Record<ActivityRole, bigint>;
  /** Alias for `totals`. */
  readonly amountsByRole: Record<ActivityRole, bigint>;
  /** Alias for `totals`. */
  readonly summedAmounts: Record<ActivityRole, bigint>;
}

/** Error raised or returned when an address fails strkey validation. */
export class InvalidAddressError extends Error {
  readonly ok = false as const;
  readonly code = "INVALID_ADDRESS" as const;
  readonly problem = "invalid-strkey" as const;
  readonly address: unknown;
  readonly error: InvalidAddressError;

  constructor(message: string, address?: unknown) {
    super(message);
    this.name = "InvalidAddressError";
    this.address = address;
    this.error = this;
  }
}

/**
 * Validate whether a value is a valid Stellar address strkey
 * (Ed25519 public key account `G...`, Soroban contract `C...`, or Med25519 `M...`).
 */
export function isValidAddress(address: unknown): address is string {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();
  if (trimmed === "") return false;
  return (
    StrKey.isValidEd25519PublicKey(trimmed) ||
    StrKey.isValidContract(trimmed) ||
    StrKey.isValidMed25519PublicKey(trimmed)
  );
}

/**
 * Extract all role matches for targetAddress from a single decoded event.
 */
function extractMatchingEntries(
  event: DecodedEvent,
  targetAddress: string,
): ActivityEntry[] {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return [];

  const matched: ActivityEntry[] = [];

  // 1. creator: claim_created
  if (
    "creator" in payload &&
    typeof payload.creator === "string" &&
    payload.creator === targetAddress
  ) {
    matched.push({
      role: "creator",
      event,
      amount: 0n,
    });
  }

  // 2. challenger: claim_challenged, challenger_paid
  if (
    "challenger" in payload &&
    typeof payload.challenger === "string" &&
    payload.challenger === targetAddress
  ) {
    let amt = 0n;
    if ("stake" in payload && typeof payload.stake === "bigint") {
      amt = payload.stake;
    }
    if ("net" in payload && typeof payload.net === "bigint") {
      amt = payload.net;
    } else if ("amount" in payload && typeof payload.amount === "bigint") {
      amt = payload.amount;
    }
    matched.push({
      role: "challenger",
      event,
      amount: amt,
    });
  }

  // 3. participant: deposited, withdrawn, claimed
  if (
    "participant" in payload &&
    typeof payload.participant === "string" &&
    payload.participant === targetAddress
  ) {
    let amt = 0n;
    if ("amount" in payload && typeof payload.amount === "bigint") {
      amt = payload.amount;
    } else if ("net" in payload && typeof payload.net === "bigint") {
      amt = payload.net;
    }
    matched.push({
      role: "participant",
      event,
      amount: amt,
    });
  }

  // 4. captain: market_created
  if (
    "captain" in payload &&
    typeof payload.captain === "string" &&
    payload.captain === targetAddress
  ) {
    matched.push({
      role: "captain",
      event,
      amount: 0n,
    });
  }

  // 5. recipient: fee_claimed, fees_claimed, fee_accrued
  if (
    "recipient" in payload &&
    typeof payload.recipient === "string" &&
    payload.recipient === targetAddress
  ) {
    let amt = 0n;
    if ("amount" in payload && typeof payload.amount === "bigint") {
      amt = payload.amount;
    }
    matched.push({
      role: "recipient",
      event,
      amount: amt,
    });
  }

  // 6. to: withdrawal, withdrawal_pending
  if (
    "to" in payload &&
    typeof payload.to === "string" &&
    payload.to === targetAddress
  ) {
    let amt = 0n;
    if ("amount" in payload && typeof payload.amount === "bigint") {
      amt = payload.amount;
    }
    matched.push({
      role: "to",
      event,
      amount: amt,
    });
  }

  return matched;
}

/**
 * Filter and aggregate an address's activity across market and squad events.
 *
 * Validates the address as a valid Stellar strkey first. If invalid, returns a
 * typed `InvalidAddressError`.
 *
 * Matching entries are returned in deterministic `compareEvents` order, with
 * summed amounts calculated per role.
 */
export function addressActivity(
  events: readonly DecodedEvent[],
  address: string,
): AddressActivityResult | InvalidAddressError {
  if (!isValidAddress(address)) {
    return new InvalidAddressError(
      `Invalid Stellar address strkey: ${typeof address === "string" ? `"${address}"` : String(address)}`,
      address,
    );
  }

  const targetAddress = address.trim();
  const entries: ActivityEntry[] = [];

  for (const event of events) {
    const matches = extractMatchingEntries(event, targetAddress);
    for (const m of matches) {
      entries.push(m);
    }
  }

  // Sort matching entries deterministically by compareEvents order
  entries.sort((a, b) => {
    const cmp = compareEvents(a.event, b.event);
    if (cmp !== 0) return cmp;
    return a.role.localeCompare(b.role);
  });

  // Calculate summed amounts per role
  const totals: Record<ActivityRole, bigint> = {
    creator: 0n,
    challenger: 0n,
    participant: 0n,
    captain: 0n,
    recipient: 0n,
    to: 0n,
  };

  for (const entry of entries) {
    totals[entry.role] += entry.amount;
  }

  return {
    ok: true,
    address: targetAddress,
    entries,
    totals,
    amountsByRole: totals,
    summedAmounts: totals,
  };
}

/**
 * Plain-text renderer for address activity, suitable for CLI or chat use.
 */
export function renderAddressActivity(
  activity: AddressActivityResult | InvalidAddressError,
): string {
  if (activity instanceof InvalidAddressError || !activity.ok) {
    return `Error: ${activity.message}`;
  }

  const lines: string[] = [];
  lines.push(`Address Activity: ${activity.address} (${shortAddress(activity.address)})`);

  if (activity.entries.length === 0) {
    lines.push("No activity found in the provided events window.");
    return lines.join("\n");
  }

  lines.push(`Total matching events: ${activity.entries.length}`);
  lines.push("");
  lines.push("Summed amounts per role:");
  for (const role of ACTIVITY_ROLES) {
    const amt = activity.totals[role];
    if (amt > 0n || role === "creator" || role === "captain") {
      lines.push(`  - ${role}: ${formatUsdc(amt)} USDC`);
    }
  }

  lines.push("");
  lines.push("Event Timeline:");
  for (const entry of activity.entries) {
    const ev = entry.event;
    const name = ev.payload.name;
    const amtStr = entry.amount > 0n ? ` · ${formatUsdc(entry.amount)} USDC` : "";
    const txStr = ev.txHash ? ` · tx: ${ev.txHash.slice(0, 8)}…` : "";
    lines.push(`  [ledger ${ev.ledger}] ${name} (${entry.role})${amtStr}${txStr}`);
  }

  return lines.join("\n");
}

/** Alias for `renderAddressActivity`. */
export const formatAddressActivity = renderAddressActivity;
