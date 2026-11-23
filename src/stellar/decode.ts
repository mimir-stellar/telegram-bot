/**
 * Decode Mimir contract events into typed objects, split by contract version.
 *
 * ── Wire shape ───────────────────────────────────────────────────────────────
 *
 * Soroban's `#[contractevent]` macro lays an event out as:
 *
 *   topic[0]   the event name in snake_case ("claim_created", "market_settled")
 *   topic[1..] the `#[topic]`-annotated fields, in DECLARATION ORDER
 *   value      a MAP of the remaining (non-topic) fields, keyed by snake_case name
 *
 * So `ClaimChallenged { #[topic] id, #[topic] challenger, stake }` arrives as
 *   topics: "claim_challenged" | <u64 id> | <G… challenger>   value: { stake }
 *
 * ── Versioned Decoders ───────────────────────────────────────────────────────
 *
 * Decoders are split by contract version (`v1`, `v2`, etc.). Version dispatch
 * looks up the appropriate decoder function while safely falling back to v1 or
 * unknown payloads if an unrecognised version or event shape is encountered.
 *
 * ── Amounts & Numeric Safety ─────────────────────────────────────────────────
 *
 * All money is atomic USDC in `i128`. Stellar's USDC Stellar Asset Contract has
 * **7 decimals**, not the 6 of the ERC-20. Amounts stay `bigint` through
 * decoding and are only converted for display, at the formatting edge.
 * Large integers are represented as decimal strings or `bigint`; lossy number
 * coercion in IDs, amounts, and ordering positions is strictly rejected.
 */

import { recordDecodeOutcome } from "./decode-stats.js";
import { scValToNative, type rpc, xdr } from "@stellar/stellar-sdk";
import type { StellarConfig } from "../config.js";
import { eventKey } from "../dedup.js";
import { txExplorerUrl } from "./client.js";
import { redactText } from "../redact.js";
import { peekEventName } from "./peek.js";
import {
  DEPTH_LIMIT_REASON,
  MAX_DECODED_COLLECTION_DEPTH,
  scValCollectionDepth,
} from "./generic-decode.js";

export { peekEventName };
export { adaptArchivedTypedEvent } from "./archive.js";

/** Which of the two Mimir contracts an event came from. */
export type ContractSource = "market" | "squad";

/** Supported contract versions for decoder selection. */
export type ContractVersion = "v1" | "v2" | string;

export interface DecodeOptions {
  /**
   * Optional hook to test if full value decoding is needed for `eventName`.
   * When `shouldDecode(name)` returns `false` (and the event is not an admin
   * or unknown event), full value XDR decoding is skipped while preserving
   * the event name and metadata for metrics and filtering.
   */
  shouldDecode?: (name: string) => boolean;
  /**
   * Maximum nested vec/map collection depth, in `event.value` or any topic.
   * Defaults to {@link MAX_DECODED_COLLECTION_DEPTH}. Deeper events become
   * `unknown` with reason {@link DEPTH_LIMIT_REASON} before native conversion.
   */
  maxDepth?: number;
}

export const DEFAULT_CONTRACT_VERSION: ContractVersion = "v1";
export const SUPPORTED_CONTRACT_VERSIONS: ContractVersion[] = ["v1", "v2"];

export function normalizeContractVersion(raw?: string): string {
  if (!raw) return DEFAULT_CONTRACT_VERSION;
  const v = raw.trim().toLowerCase();
  return v || DEFAULT_CONTRACT_VERSION;
}

/** A finite, non-negative depth bound; malformed overrides fall back to the default. */
export function normalizeMaxDepth(raw?: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return MAX_DECODED_COLLECTION_DEPTH;
  return Math.max(0, Math.floor(raw));
}

/** 1 USDC in atomic units. */
export const USDC_UNIT = 10_000_000n;

/** `WinnerSide` in `mimir-market/src/types.rs`. Unit enums decode to their u32. */
export const WINNER_SIDE: Record<number, string> = {
  0: "unresolved",
  1: "creator",
  2: "challengers",
  3: "draw",
  4: "unresolvable",
};

/** `SIDE_A` / `SIDE_B` / `RESULT_CANCELLED` in `mimir-squad/src/types.rs`. */
export const SQUAD_SIDE: Record<number, string> = {
  0: "pending",
  1: "Side A",
  2: "Side B",
  3: "cancelled",
};

export interface EventMeta {
  /** Optional archive record schema version, present on archived/migrated records. */
  schemaVersion?: number;
  source: ContractSource;
  contractId: string;
  version: string;
  ledger: number;
  txHash: string;
  /** Ledger close time, unix seconds. */
  at: number;
  /** The RPC's own event id — unique and monotonic, handy for logs. */
  eventId: string;
  /**
   * Preserved ordering metadata (issue #48).
   *
   * Soroban RPC's `getEvents` returns each event with `ledger`,
   * `transactionIndex`, `operationIndex`, `txHash` and an opaque paging-token
   * `id` (`<TOID>-<order>`). All of it is carried here so events from the same
   * or different ledgers/transactions can be ordered deterministically without
   * relying on array order, arrival order, or local timestamps.
   *
   * `transactionIndex` / `operationIndex` are `null` when the chain response
   * does not provide them — never invented. Sorting treats `null` as
   * "unknown, order after known positions" and falls back to the paging token.
   */
  /** RPC `type` (`"contract"` | `"system"` | `"diagnostic"`), else `"unknown"`. */
  eventType: string;
  /** Position of the transaction inside its ledger, when the RPC provides it. */
  transactionIndex: number | null;
  /** Position of the operation inside its transaction, when provided. */
  operationIndex: number | null;
  /** Whether the emitting call succeeded, when the RPC provides it. */
  inSuccessfulContractCall: boolean | null;
}

export type MarketPayload =
  | { name: "claim_created"; claimId: number; creator: string; category: string; title?: string }
  | { name: "claim_challenged"; claimId: number; challenger: string; stake: bigint }
  | {
      name: "claim_resolved";
      claimId: number;
      winnerSide: number;
      summary: string;
      confidence: number;
      evidenceHash: string;
      resolver?: string;
    }
  | { name: "claim_cancelled"; claimId: number }
  | {
      name: "market_settled";
      claimId: number;
      totalPaid: bigint;
      totalFees: bigint;
      owedToChallengers: bigint;
      dust: bigint;
    }
  | {
      name: "challenger_paid";
      claimId: number;
      challenger: string;
      stake: bigint;
      gross: bigint;
      fee: bigint;
      net: bigint;
    }
  | { name: "fee_claimed"; recipient: string; amount: bigint }
  | { name: "withdrawal"; to: string; amount: bigint }
  | { name: "withdrawal_pending"; to: string; amount: bigint };

export type SquadMarketCreatedPayload = {
  name: "market_created";
  marketId: number;
  captain: string;
  deadline: number;
  feeBps: number;
  question: string;
  /** Present only on v2 squad contracts. */
  category?: string | null;
};

export type SquadDepositedPayload = {
  name: "deposited";
  marketId: number;
  side: number;
  participant: string;
  amount: bigint;
  shares: bigint;
};

export type SquadWithdrawnPayload = {
  name: "withdrawn";
  marketId: number;
  side: number;
  participant: string;
  amount: bigint;
};

export type SquadResolvedPayload = {
  name: "resolved";
  marketId: number;
  result: number;
  poolA: bigint;
  poolB: bigint;
};

export type SquadClaimedPayload = {
  name: "claimed";
  marketId: number;
  participant: string;
  gross: bigint;
  fee: bigint;
  net: bigint;
};

export type SquadFeesClaimedPayload = {
  name: "fees_claimed";
  recipient: string;
  amount: bigint;
};

export type SquadPayload =
  | SquadMarketCreatedPayload
  | SquadDepositedPayload
  | SquadWithdrawnPayload
  | SquadResolvedPayload
  | SquadClaimedPayload
  | SquadFeesClaimedPayload;

export type OracleChangedPayload = {
  name: "oracle_changed";
  newOracle?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type OwnershipTransferredPayload = {
  name: "ownership_transferred";
  previousOwner?: string;
  newOwner?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type AgentAttributedPayload = {
  name: "agent_attributed";
  agent?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type FeeAccruedPayload = {
  name: "fee_accrued";
  recipient?: string;
  amount?: bigint;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type FeePolicyPayload = {
  name: "fee_policy_set" | "fee_policy_changed" | "fee_policy_updated" | "fee_policy_removed";
  feeBps?: number;
  category?: string;
  recipient?: string;
  admin?: string;
  details?: Record<string, string | number | boolean>;
};

export type GenericAdminPayload = {
  name: "admin";
  action: string;
  admin?: string;
  details: Record<string, string | number | boolean>;
};

export type AdminPayload =
  | OracleChangedPayload
  | OwnershipTransferredPayload
  | AgentAttributedPayload
  | FeeAccruedPayload
  | FeePolicyPayload
  | GenericAdminPayload;

export interface AdminAuditRecord {
  type: string;
  ledger: number;
  at: number;
  transactionHash?: string;
  contractId?: string;
  admin?: string;
  details: Record<string, string | number | boolean>;
  explorerUrl?: string;
}

export type SquadEvent = EventMeta & {
  source: "squad";
  payload: SquadPayload | UnknownPayload;
};

/**
 * Anything this bot has no notification for or a shape it failed to decode.
 * Kept rather than dropped so the poller can log what it skipped instead of going quiet.
 */
export interface UnknownPayload {
  name: "unknown";
  eventName: string;
  reason?: string;
}

export type EventPayload = MarketPayload | SquadPayload | AdminPayload | UnknownPayload;

export type ClaimCreatedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_created" }> };
export type ClaimChallengedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_challenged" }> };
export type ClaimResolvedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_resolved" }> };
export type ClaimCancelledEvent = EventMeta & { payload: Extract<MarketPayload, { name: "claim_cancelled" }> };
export type MarketSettledEvent = EventMeta & { payload: Extract<MarketPayload, { name: "market_settled" }> };
export type ChallengerPaidEvent = EventMeta & { payload: Extract<MarketPayload, { name: "challenger_paid" }> };
export type FeeClaimedEvent = EventMeta & { payload: Extract<MarketPayload, { name: "fee_claimed" }> };
export type WithdrawalEvent = EventMeta & { payload: Extract<MarketPayload, { name: "withdrawal" }> };
export type WithdrawalPendingEvent = EventMeta & { payload: Extract<MarketPayload, { name: "withdrawal_pending" }> };

export type SquadMarketCreatedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "market_created" }> };
export type SquadDepositedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "deposited" }> };
export type SquadWithdrawnEvent = EventMeta & { payload: Extract<SquadPayload, { name: "withdrawn" }> };
export type SquadResolvedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "resolved" }> };
export type SquadClaimedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "claimed" }> };
export type SquadFeesClaimedEvent = EventMeta & { payload: Extract<SquadPayload, { name: "fees_claimed" }> };

export type UnknownMarketEvent = EventMeta & { payload: UnknownPayload };

export type MarketEvent =
  | ClaimCreatedEvent
  | ClaimChallengedEvent
  | ClaimResolvedEvent
  | ClaimCancelledEvent
  | MarketSettledEvent
  | ChallengerPaidEvent
  | FeeClaimedEvent
  | WithdrawalEvent
  | WithdrawalPendingEvent
  | SquadMarketCreatedEvent
  | SquadDepositedEvent
  | SquadWithdrawnEvent
  | SquadResolvedEvent
  | SquadClaimedEvent
  | SquadFeesClaimedEvent
  | UnknownMarketEvent;

export type DecodedEvent = EventMeta & { payload: EventPayload };

/** Keep decoder diagnostics useful without copying an unbounded RPC payload. */
const MAX_DIAGNOSTIC_LENGTH = 200;

function diagnostic(value: unknown): string {
  const compact = String(value).replace(/\s+/g, " ").trim() || "unknown error";
  return compact.length <= MAX_DIAGNOSTIC_LENGTH
    ? compact
    : `${compact.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

// ── Scalar helpers ───────────────────────────────────────────────────────────

class DecodeError extends Error {}

/**
 * Ceiling on a single event's decoded footprint.
 *
 * Soroban events can carry arbitrary `String` / `Bytes` values — claim
 * categories, summaries, questions. Unbounded, a hostile or buggy contract can
 * make the notifier allocate, and then JSON-log, multi-megabyte payloads every
 * poll cycle. The cap is measured on the XDR wire form *before*
 * `scValToNative`, so an oversized value never inflates into a JS string in the
 * first place.
 *
 * 16 KiB is far above any legitimate Mimir event on Testnet, and far below
 * anything that would distress the poller.
 */
export const MAX_DECODED_EVENT_XDR_BYTES = 16_384;

/** Per-topic XDR budget — event names, ids and addresses are all tiny. */
export const MAX_EVENT_TOPIC_XDR_BYTES = 1_024;

/** Maximum number of topics allowed on a single Soroban event (protocol max is 4). */
export const MAX_EVENT_TOPICS = 4;

/** Hard ceiling on any single decoded string field after native conversion. */
export const MAX_DECODED_STRING_CHARS = 2_048;

/**
 * Wire size of one `ScVal`.
 *
 * Anything that is not a `ScVal` measures as zero: the RPC response is typed but
 * not trusted, and a non-`ScVal` is `native()`'s problem to diagnose, not this
 * function's. Its message is more specific than "over the cap".
 */
function scValXdrBytes(value: unknown): number {
  if (!value || typeof (value as { toXDR?: unknown }).toXDR !== "function") return 0;
  try {
    const bytes = (value as xdr.ScVal).toXDR();
    return bytes.byteLength ?? (bytes as Buffer).length;
  } catch {
    // Fail closed: a value we cannot serialize is over the cap by definition.
    return MAX_DECODED_EVENT_XDR_BYTES + 1;
  }
}

/** Reject an event whose wire form is too large to decode safely. */
function assertEventXdrWithinCap(event: rpc.Api.EventResponse): void {
  const valueBytes = scValXdrBytes(event.value);
  if (valueBytes > MAX_DECODED_EVENT_XDR_BYTES) {
    throw new DecodeError(
      `event.value XDR ${valueBytes} bytes exceeds cap of ${MAX_DECODED_EVENT_XDR_BYTES}`,
    );
  }

  const topics = Array.isArray(event.topic) ? event.topic : [];
  let topicTotal = 0;
  for (let i = 0; i < topics.length; i += 1) {
    const bytes = scValXdrBytes(topics[i]);
    if (bytes > MAX_EVENT_TOPIC_XDR_BYTES) {
      throw new DecodeError(
        `event.topic[${i}] XDR ${bytes} bytes exceeds per-topic cap of ${MAX_EVENT_TOPIC_XDR_BYTES}`,
      );
    }
    topicTotal += bytes;
  }
  if (topicTotal > MAX_DECODED_EVENT_XDR_BYTES) {
    throw new DecodeError(
      `event.topic XDR total ${topicTotal} bytes exceeds cap of ${MAX_DECODED_EVENT_XDR_BYTES}`,
    );
  }
}
function native(value: xdr.ScVal): unknown {
  // stellar-sdk 16 threw on anything that was not an ScVal; 17 (#527) quietly
  // returns undefined, which would let garbage decode as an empty payload.
  // Keep failing closed so malformed values still surface as `unknown`.
  const v = value as unknown as { type?: unknown } | null;
  if (v === null || typeof v !== "object" || typeof v.type !== "string") {
    throw new DecodeError(`expected an ScVal, got ${v === null ? "null" : typeof v}`);
  }
  const collision = findDuplicateMapKey(value);
  if (collision) {
    throw new DecodeError(collision.reason);
  }
  return scValToNative(value);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function big(value: unknown, what: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new DecodeError(`${what}: expected safe integer number, got ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new DecodeError(`${what}: expected an integer, got ${typeof value}`);
}

/** Reject negative amounts, returning non-negative bigint. */
function amount(value: unknown, what: string): bigint {
  const b = big(value, what);
  if (b < 0n) {
    throw new DecodeError(`${what}: expected non-negative amount, got ${b}`);
  }
  return b;
}

/** For ids, deadlines and bps — small enough that `number` is honest. */
function num(value: unknown, what: string): number {
  const asBig = big(value, what);
  if (asBig < 0n) {
    throw new DecodeError(`${what}: expected non-negative integer, got ${asBig}`);
  }
  if (asBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DecodeError(`${what}: ${asBig} exceeds the safe integer range`);
  }
  return Number(asBig);
}

function str(value: unknown, what: string): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else if (value instanceof Uint8Array) {
    // A contract `String` normally decodes to a JS string, but bytes-shaped
    // payloads show up as Buffer on some SDK paths.
    s = Buffer.from(value).toString("utf8");
  } else {
    throw new DecodeError(`${what}: expected a string, got ${typeof value}`);
  }
  if (s.length > MAX_DECODED_STRING_CHARS) {
    throw new DecodeError(
      `${what}: string length ${s.length} exceeds cap of ${MAX_DECODED_STRING_CHARS}`,
    );
  }
  return s;
}

function optStr(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return str(value, what);
}

/** An `Address` decodes to its `G…`/`C…` strkey. */
function addr(value: unknown, what: string): string {
  const s = str(value, what);
  if (!/^[GC][A-Z2-7]{55}$/.test(s)) {
    throw new DecodeError(`${what}: expected a Stellar address strkey, got "${s}"`);
  }
  return s;
}

function optAddr(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return addr(value, what);
}

function hex(value: unknown, what: string): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "string") return value;
  throw new DecodeError(`${what}: expected bytes, got ${typeof value}`);
}

function topicAt(topics: unknown[], index: number, what: string): unknown {
  if (index >= topics.length) {
    throw new DecodeError(`${what}: missing topic[${index}] (event has ${topics.length} topics)`);
  }
  return topics[index];
}

// ── Topic schemas ───────────────────────────────────────────────────────────

/** Kind of an indexed topic argument after the event name. */
export type TopicArgKind = "int" | "address";

export interface TopicSchema {
  /** Total topic count, including the event name at `topic[0]`. */
  expectedCount: number;
  /** Kinds of `topic[1..]`, in order. */
  args: readonly TopicArgKind[];
}

/** Indexed topic layout of each mimir-market event the v1 decoder reads. */
export const MARKET_TOPIC_SCHEMAS: Readonly<Record<string, TopicSchema>> = {
  claim_created: { expectedCount: 3, args: ["int", "address"] },
  claim_challenged: { expectedCount: 3, args: ["int", "address"] },
  claim_resolved: { expectedCount: 2, args: ["int"] },
  claim_cancelled: { expectedCount: 2, args: ["int"] },
  market_settled: { expectedCount: 2, args: ["int"] },
  challenger_paid: { expectedCount: 3, args: ["int", "address"] },
  fee_claimed: { expectedCount: 2, args: ["address"] },
  withdrawal: { expectedCount: 2, args: ["address"] },
  withdrawal_pending: { expectedCount: 2, args: ["address"] },
};

/** Indexed topic layout of each mimir-squad event the v1 decoder reads. */
export const SQUAD_TOPIC_SCHEMAS: Readonly<Record<string, TopicSchema>> = {
  market_created: { expectedCount: 3, args: ["int", "address"] },
  deposited: { expectedCount: 4, args: ["int", "int", "address"] },
  withdrawn: { expectedCount: 4, args: ["int", "int", "address"] },
  resolved: { expectedCount: 2, args: ["int"] },
  claimed: { expectedCount: 3, args: ["int", "address"] },
  fees_claimed: { expectedCount: 2, args: ["address"] },
};

export type TopicSchemaResult = { valid: true } | { valid: false; reason: string };

/**
 * Check already-native topics (`topic[0]` is the event name) against the
 * documented layout. Events without a schema (admin events, future names) are
 * accepted: the decoder, not this check, decides whether it can read them.
 * Reasons are bounded and never echo the offending value.
 */
export function validateTopicSchema(
  source: ContractSource,
  eventName: string,
  topics: readonly unknown[],
): TopicSchemaResult {
  const schemas = source === "market" ? MARKET_TOPIC_SCHEMAS : SQUAD_TOPIC_SCHEMAS;
  const schema = Object.prototype.hasOwnProperty.call(schemas, eventName)
    ? schemas[eventName]
    : undefined;
  if (!schema) return { valid: true };

  if (topics.length !== schema.expectedCount) {
    return {
      valid: false,
      reason: `${eventName}: expected ${schema.expectedCount} topics, got ${topics.length}`,
    };
  }
  for (const [offset, kind] of schema.args.entries()) {
    const index = offset + 1;
    const what = `${eventName}.topic[${index}]`;
    try {
      if (kind === "int") big(topics[index], what);
      else addr(topics[index], what);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the expectation, drop the echoed value.
      return { valid: false, reason: diagnostic(message.replace(/, got .*$/, "")) };
    }
  }
  return { valid: true };
}

/** Redact credential-shaped substrings from a decode reason and cap its length. */
export function sanitizeReason(reason: unknown, maxLen: number = MAX_DIAGNOSTIC_LENGTH): string {
  const compact = String(reason ?? "").replace(/\s+/g, " ").trim() || "unknown error";
  return redactText(compact, { maxLen: Math.max(1, maxLen) });
}

/** Redact and bound any raw value for safe inclusion in explain diagnostics. */
export function redactAndBoundValue(value: unknown, maxLen: number = 80): string {
  const cap = Math.max(1, maxLen);
  let raw: string;
  if (value === undefined) {
    raw = "undefined";
  } else if (value === null) {
    raw = "null";
  } else if (typeof value === "bigint") {
    raw = `${value.toString()}n`;
  } else if (typeof value === "string") {
    raw = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    raw = String(value);
  } else if (Array.isArray(value)) {
    raw = `[array(${value.length})]`;
  } else if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 8);
    raw = `{${keys.join(",")}}`;
  } else {
    raw = String(value);
  }
  const compact = raw.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim() || "(empty)";
  return redactText(compact, { maxLen: cap });
}

// ── Per-contract version decoders ────────────────────────────────────────────

export type MarketDecoderFn = (
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
) => MarketPayload | AdminPayload | null;

export type SquadDecoderFn = (
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
) => SquadPayload | AdminPayload | null;

export function decodeMarketV1(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): MarketPayload | AdminPayload | null {
  switch (name) {
    case "claim_created":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_created.id"), "claim_created.id"),
        creator: addr(topicAt(topics, 2, "claim_created.creator"), "claim_created.creator"),
        category: str(fields.category, "claim_created.category"),
      };

    case "claim_challenged":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_challenged.id"), "claim_challenged.id"),
        challenger: addr(
          topicAt(topics, 2, "claim_challenged.challenger"),
          "claim_challenged.challenger",
        ),
        stake: amount(fields.stake, "claim_challenged.stake"),
      };

    case "claim_resolved":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_resolved.id"), "claim_resolved.id"),
        winnerSide: num(fields.winner_side, "claim_resolved.winner_side"),
        summary: str(fields.summary, "claim_resolved.summary"),
        confidence: num(fields.confidence, "claim_resolved.confidence"),
        evidenceHash: hex(fields.evidence_hash, "claim_resolved.evidence_hash"),
      };

    case "claim_cancelled":
      return {
        name,
        claimId: num(topicAt(topics, 1, "claim_cancelled.id"), "claim_cancelled.id"),
      };

    case "market_settled":
      return {
        name,
        claimId: num(topicAt(topics, 1, "market_settled.id"), "market_settled.id"),
        totalPaid: amount(fields.total_paid, "market_settled.total_paid"),
        totalFees: amount(fields.total_fees, "market_settled.total_fees"),
        owedToChallengers: amount(fields.owed_to_challengers, "market_settled.owed_to_challengers"),
        dust: amount(fields.dust, "market_settled.dust"),
      };

    case "challenger_paid":
      return {
        name,
        claimId: num(topicAt(topics, 1, "challenger_paid.id"), "challenger_paid.id"),
        challenger: addr(
          topicAt(topics, 2, "challenger_paid.challenger"),
          "challenger_paid.challenger",
        ),
        stake: amount(fields.stake, "challenger_paid.stake"),
        gross: amount(fields.gross, "challenger_paid.gross"),
        fee: amount(fields.fee, "challenger_paid.fee"),
        net: amount(fields.net, "challenger_paid.net"),
      };

    case "fee_claimed":
      return {
        name,
        recipient: addr(topicAt(topics, 1, "fee_claimed.recipient"), "fee_claimed.recipient"),
        amount: amount(fields.amount, "fee_claimed.amount"),
      };

    case "withdrawal":
    case "withdrawal_pending":
      return {
        name,
        to: addr(topicAt(topics, 1, `${name}.to`), `${name}.to`),
        amount: amount(fields.amount, `${name}.amount`),
      };

    default:
      return decodeAdmin(name, topics, fields);
  }
}

function decodeAdmin(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): AdminPayload | null {
  switch (name) {
    case "oracle_changed": {
      let newOracle: string | undefined = undefined;
      if (topics.length > 1) {
        try {
          newOracle = addr(topics[1], "oracle_changed.new_oracle");
        } catch {
          // Ignore topic parse failure, check fields
        }
      }
      if (!newOracle && fields.new_oracle) {
        try {
          newOracle = addr(fields.new_oracle, "oracle_changed.new_oracle");
        } catch {
          // Ignore
        }
      }
      if (!newOracle && fields.oracle) {
        try {
          newOracle = addr(fields.oracle, "oracle_changed.oracle");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (newOracle) details.newOracle = newOracle;
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        } else if (typeof v === "bigint") {
          details[k] = v.toString();
        }
      }
      return {
        name: "oracle_changed",
        ...(newOracle ? { newOracle } : {}),
        details,
      };
    }

    case "ownership_transferred": {
      let previousOwner: string | undefined = undefined;
      let newOwner: string | undefined = undefined;

      if (topics.length > 1) {
        try {
          newOwner = addr(topics[1], "ownership_transferred.new_owner");
        } catch {
          // Ignore
        }
      }
      if (fields.previous_owner) {
        try {
          previousOwner = addr(fields.previous_owner, "ownership_transferred.previous_owner");
        } catch {
          // Ignore
        }
      }
      if (fields.new_owner) {
        try {
          newOwner = addr(fields.new_owner, "ownership_transferred.new_owner");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (previousOwner) details.previousOwner = previousOwner;
      if (newOwner) details.newOwner = newOwner;
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        } else if (typeof v === "bigint") {
          details[k] = v.toString();
        }
      }
      return {
        name: "ownership_transferred",
        ...(previousOwner ? { previousOwner } : {}),
        ...(newOwner ? { newOwner } : {}),
        details,
      };
    }

    case "agent_attributed": {
      let agent: string | undefined = undefined;
      if (topics.length > 1) {
        try {
          agent = addr(topics[1], "agent_attributed.agent");
        } catch {
          // Ignore
        }
      }
      if (!agent && fields.agent) {
        try {
          agent = addr(fields.agent, "agent_attributed.agent");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (agent) details.agent = agent;
      for (const [k, v] of Object.entries(fields)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        } else if (typeof v === "bigint") {
          details[k] = v.toString();
        }
      }
      return {
        name: "agent_attributed",
        ...(agent ? { agent } : {}),
        details,
      };
    }

    case "fee_accrued": {
      let recipient: string | undefined = undefined;
      let amt: bigint | undefined = undefined;
      if (topics.length > 1) {
        try {
          recipient = addr(topics[1], "fee_accrued.recipient");
        } catch {
          // Ignore
        }
      }
      if (!recipient && fields.recipient) {
        try {
          recipient = addr(fields.recipient, "fee_accrued.recipient");
        } catch {
          // Ignore
        }
      }
      if (fields.amount !== undefined) {
        try {
          amt = amount(fields.amount, "fee_accrued.amount");
        } catch {
          // Ignore
        }
      }
      const details: Record<string, string | number | boolean> = {};
      if (recipient) details.recipient = recipient;
      if (amt !== undefined) details.amount = amt.toString();
      for (const [k, v] of Object.entries(fields)) {
        if (k !== "recipient" && k !== "amount") {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            details[k] = v;
          } else if (typeof v === "bigint") {
            details[k] = v.toString();
          }
        }
      }
      return {
        name: "fee_accrued",
        ...(recipient ? { recipient } : {}),
        ...(amt !== undefined ? { amount: amt } : {}),
        details,
      };
    }

    default: {
      if (
        name.startsWith("fee_policy_") ||
        name.startsWith("admin_") ||
        name === "fee_policy_set" ||
        name === "fee_policy_changed"
      ) {
        let feeBps: number | undefined = undefined;
        let category: string | undefined = undefined;
        let recipient: string | undefined = undefined;

        if (fields.fee_bps !== undefined) {
          try {
            feeBps = num(fields.fee_bps, "fee_policy.fee_bps");
          } catch {
            // Ignore
          }
        }
        if (fields.category !== undefined) {
          try {
            category = str(fields.category, "fee_policy.category");
          } catch {
            // Ignore
          }
        }
        if (fields.recipient !== undefined) {
          try {
            recipient = addr(fields.recipient, "fee_policy.recipient");
          } catch {
            // Ignore
          }
        }

        const details: Record<string, string | number | boolean> = {};
        if (feeBps !== undefined) details.feeBps = feeBps;
        if (category) details.category = category;
        if (recipient) details.recipient = recipient;
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            details[k] = v;
          } else if (typeof v === "bigint") {
            details[k] = v.toString();
          }
        }

        if (
          name === "fee_policy_set" ||
          name === "fee_policy_changed" ||
          name === "fee_policy_updated" ||
          name === "fee_policy_removed"
        ) {
          return {
            name,
            ...(feeBps !== undefined ? { feeBps } : {}),
            ...(category ? { category } : {}),
            ...(recipient ? { recipient } : {}),
            details,
          };
        }

        return {
          name: "admin",
          action: name,
          ...(recipient ? { admin: recipient } : {}),
          details,
        };
      }
      return null;
    }
  }
}

export function decodeMarketV2(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): MarketPayload | AdminPayload | null {
  // v2 Market extension support: decode v2 fields if present, else fallback to v1.
  if (name === "claim_created" && fields.title !== undefined) {
    return {
      name,
      claimId: num(topicAt(topics, 1, "claim_created.id"), "claim_created.id"),
      creator: addr(topicAt(topics, 2, "claim_created.creator"), "claim_created.creator"),
      category: str(fields.category, "claim_created.category"),
      title: str(fields.title, "claim_created.title"),
    };
  }

  if (name === "claim_resolved" && fields.resolver !== undefined) {
    return {
      name,
      claimId: num(topicAt(topics, 1, "claim_resolved.id"), "claim_resolved.id"),
      winnerSide: num(fields.winner_side, "claim_resolved.winner_side"),
      summary: str(fields.summary, "claim_resolved.summary"),
      confidence: num(fields.confidence, "claim_resolved.confidence"),
      evidenceHash: hex(fields.evidence_hash, "claim_resolved.evidence_hash"),
      resolver: optAddr(fields.resolver, "claim_resolved.resolver"),
    };
  }

  return decodeMarketV1(name, topics, fields);
}

export function decodeSquadV1(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): SquadPayload | AdminPayload | null {
  switch (name) {
    case "market_created":
      return {
        name,
        marketId: num(topicAt(topics, 1, "market_created.market_id"), "market_created.market_id"),
        captain: addr(topicAt(topics, 2, "market_created.captain"), "market_created.captain"),
        deadline: num(fields.deadline, "market_created.deadline"),
        feeBps: num(fields.fee_bps, "market_created.fee_bps"),
        question: str(fields.question, "market_created.question"),
      };

    case "deposited":
      return {
        name,
        marketId: num(topicAt(topics, 1, "deposited.market_id"), "deposited.market_id"),
        side: num(topicAt(topics, 2, "deposited.side"), "deposited.side"),
        participant: addr(topicAt(topics, 3, "deposited.participant"), "deposited.participant"),
        amount: amount(fields.amount, "deposited.amount"),
        shares: amount(fields.shares, "deposited.shares"),
      };

    case "withdrawn":
      return {
        name,
        marketId: num(topicAt(topics, 1, "withdrawn.market_id"), "withdrawn.market_id"),
        side: num(topicAt(topics, 2, "withdrawn.side"), "withdrawn.side"),
        participant: addr(topicAt(topics, 3, "withdrawn.participant"), "withdrawn.participant"),
        amount: amount(fields.amount, "withdrawn.amount"),
      };

    case "resolved":
      return {
        name,
        marketId: num(topicAt(topics, 1, "resolved.market_id"), "resolved.market_id"),
        result: num(fields.result, "resolved.result"),
        poolA: amount(fields.pool_a, "resolved.pool_a"),
        poolB: amount(fields.pool_b, "resolved.pool_b"),
      };

    case "claimed":
      return {
        name,
        marketId: num(topicAt(topics, 1, "claimed.market_id"), "claimed.market_id"),
        participant: addr(topicAt(topics, 2, "claimed.participant"), "claimed.participant"),
        gross: amount(fields.gross, "claimed.gross"),
        fee: amount(fields.fee, "claimed.fee"),
        net: amount(fields.net, "claimed.net"),
      };

    case "fees_claimed":
      return {
        name,
        recipient: addr(topicAt(topics, 1, "fees_claimed.recipient"), "fees_claimed.recipient"),
        amount: amount(fields.amount, "fees_claimed.amount"),
      };

    default:
      return decodeAdmin(name, topics, fields);
  }
}

export function decodeSquadV2(
  name: string,
  topics: unknown[],
  fields: Record<string, unknown>,
): SquadPayload | AdminPayload | null {
  if (name === "market_created" && fields.category !== undefined) {
    return {
      name,
      marketId: num(topicAt(topics, 1, "market_created.market_id"), "market_created.market_id"),
      captain: addr(topicAt(topics, 2, "market_created.captain"), "market_created.captain"),
      deadline: num(fields.deadline, "market_created.deadline"),
      feeBps: num(fields.fee_bps, "market_created.fee_bps"),
      question: str(fields.question, "market_created.question"),
      category: optStr(fields.category, "market_created.category"),
    };
  }

  return decodeSquadV1(name, topics, fields);
}

/** Registry of decoders for market contracts by version. */
export const MARKET_DECODERS: Record<string, MarketDecoderFn> = {
  v1: decodeMarketV1,
  v2: decodeMarketV2,
};

/** Registry of decoders for squad contracts by version. */
export const SQUAD_DECODERS: Record<string, SquadDecoderFn> = {
  v1: decodeSquadV1,
  v2: decodeSquadV2,
};

// ── Decoder Capabilities & Schemas ──────────────────────────────────────────

/** Canonical admin event names supported across contracts. */
export const ADMIN_EVENT_NAMES: readonly string[] = [
  "oracle_changed",
  "ownership_transferred",
  "agent_attributed",
  "fee_accrued",
  "fee_policy_set",
  "fee_policy_changed",
  "fee_policy_updated",
  "fee_policy_removed",
  "admin",
] as const;

/** Schema description of an event decoded by the subsystem. */
export interface DecoderEventSchema {
  name: string;
  expectedTopicCount: number;
  topicArgs: readonly TopicArgKind[];
  extensions?: readonly string[];
  isAdmin?: boolean;
}

/** Comprehensive capability report for a contract decoder and version. */
export interface DecoderCapabilityReport {
  source: string;
  contractId?: string;
  version: string;
  normalizedVersion: string;
  supported: boolean;
  decoderKind: "typed" | "generic";
  fallbackVersion?: string;
  supportedVersions: readonly string[];
  eventSchemas: readonly DecoderEventSchema[];
  events: readonly string[];
  adminEvents: readonly string[];
  wildcardSupport: boolean;
}

/** Description of an unsupported combination flagged before polling starts. */
export interface UnsupportedCombinationFlag {
  source: string;
  version?: string;
  normalizedVersion: string;
  contractId?: string;
  fallbackVersion: string;
  reason: string;
}

/** Configuration targets used to resolve decoder capabilities. */
export interface DecoderTargetConfig {
  marketContractId?: string;
  squadContractId?: string;
  marketContractVersion?: string;
  squadContractVersion?: string;
}

/**
 * Check whether a given contract version is explicitly supported for a source.
 */
export function isContractVersionSupported(
  source: ContractSource | "generic" | string,
  version?: string,
): boolean {
  const norm = normalizeContractVersion(version);
  if (source === "generic") {
    return true;
  }
  if (source === "market") {
    return Object.prototype.hasOwnProperty.call(MARKET_DECODERS, norm);
  }
  if (source === "squad") {
    return Object.prototype.hasOwnProperty.call(SQUAD_DECODERS, norm);
  }
  return false;
}

/**
 * List supported event schemas for a contract source and version.
 */
export function listSupportedEventSchemas(
  source: ContractSource | "generic" | string,
  version: string = DEFAULT_CONTRACT_VERSION,
): readonly DecoderEventSchema[] {
  const norm = normalizeContractVersion(version);
  if (source === "generic") {
    return [
      {
        name: "*",
        expectedTopicCount: -1,
        topicArgs: [],
        isAdmin: false,
      },
    ];
  }

  const schemas: DecoderEventSchema[] = [];
  if (source === "market") {
    for (const [eventName, schema] of Object.entries(MARKET_TOPIC_SCHEMAS)) {
      const extensions: string[] = [];
      if (norm === "v2") {
        if (eventName === "claim_created") extensions.push("title");
        if (eventName === "claim_resolved") extensions.push("resolver");
      }
      schemas.push({
        name: eventName,
        expectedTopicCount: schema.expectedCount,
        topicArgs: schema.args,
        ...(extensions.length > 0 ? { extensions } : {}),
        isAdmin: false,
      });
    }
  } else if (source === "squad") {
    for (const [eventName, schema] of Object.entries(SQUAD_TOPIC_SCHEMAS)) {
      const extensions: string[] = [];
      if (norm === "v2") {
        if (eventName === "market_created") extensions.push("category");
      }
      schemas.push({
        name: eventName,
        expectedTopicCount: schema.expectedCount,
        topicArgs: schema.args,
        ...(extensions.length > 0 ? { extensions } : {}),
        isAdmin: false,
      });
    }
  }

  if (source === "market" || source === "squad") {
    for (const adminName of ADMIN_EVENT_NAMES) {
      schemas.push({
        name: adminName,
        expectedTopicCount: 1,
        topicArgs: [],
        isAdmin: true,
      });
    }
  }

  return schemas;
}

/**
 * Generate a decoder capability report for a single contract source and version.
 */
export function getDecoderCapabilityReport(
  source: ContractSource | "generic" | string,
  version?: string,
  contractId?: string,
): DecoderCapabilityReport {
  const rawVersion = version ?? DEFAULT_CONTRACT_VERSION;
  const normVersion = normalizeContractVersion(rawVersion);

  if (source === "generic") {
    const genericReport = getGenericDecoderCapabilityReport(contractId);
    if (version !== undefined) {
      return {
        ...genericReport,
        version,
        normalizedVersion: normVersion,
      };
    }
    return genericReport;
  }

  const isMarket = source === "market";
  const isSquad = source === "squad";
  const knownSource = isMarket || isSquad;

  const supportedVersions = isMarket
    ? Object.keys(MARKET_DECODERS)
    : isSquad
      ? Object.keys(SQUAD_DECODERS)
      : [];

  const supported = knownSource && supportedVersions.includes(normVersion);
  const fallbackVersion = supported ? undefined : DEFAULT_CONTRACT_VERSION;
  const effectiveVersion = supported ? normVersion : DEFAULT_CONTRACT_VERSION;

  const eventSchemas = knownSource
    ? listSupportedEventSchemas(source as ContractSource, effectiveVersion)
    : [];

  const nonAdminEvents = eventSchemas
    .filter((s) => !s.isAdmin && s.name !== "*")
    .map((s) => s.name);
  const adminEvents = eventSchemas.filter((s) => s.isAdmin).map((s) => s.name);

  return {
    source,
    ...(contractId ? { contractId } : {}),
    version: rawVersion,
    normalizedVersion: normVersion,
    supported,
    decoderKind: "typed",
    ...(fallbackVersion ? { fallbackVersion } : {}),
    supportedVersions,
    eventSchemas,
    events: nonAdminEvents,
    adminEvents,
    wildcardSupport: false,
  };
}

/**
 * Generate capability reports for all configured contract versions.
 */
export function getConfiguredDecoderCapabilities(
  config: DecoderTargetConfig,
): DecoderCapabilityReport[] {
  const reports: DecoderCapabilityReport[] = [];
  if (config.marketContractId || config.marketContractVersion) {
    reports.push(
      getDecoderCapabilityReport(
        "market",
        config.marketContractVersion,
        config.marketContractId,
      ),
    );
  }
  if (config.squadContractId || config.squadContractVersion) {
    reports.push(
      getDecoderCapabilityReport(
        "squad",
        config.squadContractVersion,
        config.squadContractId,
      ),
    );
  }
  return reports;
}

/**
 * Validate contract version combinations and flag unsupported ones.
 */
export function validateDecoderCombinations(
  targets: readonly { source: string; version?: string; contractId?: string }[],
): UnsupportedCombinationFlag[] {
  const flags: UnsupportedCombinationFlag[] = [];
  for (const t of targets) {
    const report = getDecoderCapabilityReport(t.source, t.version, t.contractId);
    if (!report.supported) {
      let reason = `Version '${t.version ?? ""}' is not supported for contract source '${t.source}'`;
      if (report.supportedVersions.length > 0) {
        reason += ` (supported: ${report.supportedVersions.join(', ')})`;
      } else {
        reason += ` (unknown source '${t.source}')`;
      }
      flags.push({
        source: t.source,
        version: t.version,
        normalizedVersion: report.normalizedVersion,
        ...(t.contractId ? { contractId: t.contractId } : {}),
        fallbackVersion: report.fallbackVersion ?? DEFAULT_CONTRACT_VERSION,
        reason,
      });
    }
  }
  return flags;
}

/**
 * Format a human-readable text summary of a DecoderCapabilityReport.
 */
export function formatDecoderCapabilityReport(report: DecoderCapabilityReport): string {
  const lines: string[] = [];
  lines.push(
    `Decoder Capability Report: ${report.source}${report.contractId ? ` (${report.contractId})` : ''}`,
  );
  lines.push(`  Decoder Kind: ${report.decoderKind}`);
  lines.push(`  Version: ${report.version} (normalized: ${report.normalizedVersion})`);
  lines.push(
    `  Supported: ${report.supported ? 'yes' : `no (fallback: ${report.fallbackVersion ?? 'none'})`}`,
  );
  lines.push(`  Supported Versions: ${report.supportedVersions.join(', ') || 'none'}`);
  lines.push(`  Wildcard Support: ${report.wildcardSupport ? 'yes' : 'no'}`);
  if (report.events.length > 0) {
    lines.push(`  Events (${report.events.length}): ${report.events.join(', ')}`);
  }
  if (report.adminEvents.length > 0) {
    lines.push(`  Admin Events (${report.adminEvents.length}): ${report.adminEvents.join(', ')}`);
  }
  return lines.join("\n");
}


// ── Entry point ──────────────────────────────────────────────────────────────

function contractIdOf(event: rpc.Api.EventResponse): string {
  if (!event || typeof event !== "object") return "";
  const raw: unknown = (event as { contractId?: unknown }).contractId;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const maybe = raw as { contractId?: () => string; toString?: () => string };
    if (typeof maybe.contractId === "function") {
      try {
        return maybe.contractId();
      } catch {
        return "";
      }
    }
    if (typeof maybe.toString === "function") {
      try {
        const text = maybe.toString();
        // A default `[object Object]` string is not a contract id.
        if (typeof text === "string" && text !== "[object Object]") return text;
      } catch {
        // Fall through to "".
      }
    }
  }
  return "";
}

/** Check if an event name represents an admin event. */
export function isAdminEventName(name: string): boolean {
  return (
    name === "admin" ||
    name === "oracle_changed" ||
    name === "ownership_transferred" ||
    name === "agent_attributed" ||
    name === "fee_accrued" ||
    name === "fee_policy_set" ||
    name === "fee_policy_changed" ||
    name === "fee_policy_updated" ||
    name === "fee_policy_removed" ||
    name.startsWith("fee_policy_") ||
    name.startsWith("admin_")
  );
}

/** Check if an event name is a known non-admin event for the given source. */
function isKnownEventName(source: ContractSource, name: string): boolean {
  const schemas = source === "market" ? MARKET_TOPIC_SCHEMAS : SQUAD_TOPIC_SCHEMAS;
  return Object.prototype.hasOwnProperty.call(schemas, name);
}

/**
 * Decode one RPC event for a specific contract version.
 *
 * Never throws: an event this bot does not understand — a new contract event, a
 * shape change, malformed XDR, or missing ordering metadata — becomes an
 * `unknown` payload with the reason attached. A notifier must not die on an
 * event it was not taught. Malformed metadata falls back to safe defaults
 * (`ledger` 0, indexes `null`, `at` 0) rather than `NaN`, so a poisoned field
 * can neither crash the scanner nor corrupt ordering math.
 */
export function decodeEvent(
  source: ContractSource,
  event: rpc.Api.EventResponse,
  versionOrOptions: string | DecodeOptions = DEFAULT_CONTRACT_VERSION,
  options?: DecodeOptions,
): DecodedEvent {
  const version = typeof versionOrOptions === "string" ? versionOrOptions : DEFAULT_CONTRACT_VERSION;
  const opts = typeof versionOrOptions === "object" ? versionOrOptions : options;
  const normVersion = normalizeContractVersion(version);
  const meta: EventMeta = { ...safeMeta(source, event), version: normVersion };

  const handleUndecodable = (reason: string, eventName: string = ""): DecodedEvent => {
    if (opts?.quarantine) {
      void opts.quarantine.quarantine(event as unknown as Record<string, unknown>, source, reason).catch(() => {});
    }
    return {
      ...meta,
      payload: { name: "unknown", eventName, reason },
    };
  };

  if (!event || !Array.isArray(event.topic)) {
    recordDecodeOutcome(source, "", "malformed");
    return handleUndecodable("missing or invalid topic array");
  }

  if (event.topic.length === 0) {
    recordDecodeOutcome(source, "", "malformed");
    return handleUndecodable("empty topic array");
  }

  let eventName = "";
  try {
    if (!event || typeof event !== "object") {
      throw new DecodeError("invalid or missing event object");
    }

    // Fast-peek topic[0] first
    eventName = peekEventName(event);
    if (eventName === "") {
      // Without a name no decoder can be chosen; say why instead of "no decoder".
      recordDecodeOutcome(source, eventName, "malformed");
      return handleUndecodable("topic[0] is not an event name string", eventName);
    }

    const rawTopics = Array.isArray(event.topic) ? event.topic : [];
    const maxDepth = normalizeMaxDepth(opts?.maxDepth);
    // Depth is checked independently of XDR byte size: a handful of nested
    // collections is small on the wire but can still exhaust native recursion.
    // This probe never serializes or converts the value, so it is safe first.
    if (
      scValCollectionDepth(event.value, maxDepth) > maxDepth ||
      rawTopics.some((topic) => scValCollectionDepth(topic, maxDepth) > maxDepth)
    ) {
      throw new DecodeError(DEPTH_LIMIT_REASON);
    }

    // If caller provided shouldDecode, and it returned false, and the event is neither admin nor unknown:
    // skip full value XDR decoding and return a minimal decoded event.
    if (opts?.shouldDecode && !opts.shouldDecode(eventName)) {
      if (!isAdminEventName(eventName) && isKnownEventName(source, eventName)) {
        return {
          ...meta,
          payload: { name: eventName } as unknown as EventPayload,
        };
      }
    }

    const topics = rawTopics.map((t) => {
      try {
        return native(t as xdr.ScVal);
      } catch {
        return null;
      }
    });

    const topicCheck = validateTopicSchema(source, eventName, topics);
    if (!topicCheck.valid) {
      recordDecodeOutcome(source, eventName, "malformed");
      return {
        ...meta,
        payload: {
          name: "unknown",
          eventName,
          reason: topicCheck.reason,
        },
      };
    }

    // Fail closed before native conversion allocates: an oversized value must
    // not turn one hostile event into a multi-megabyte payload. This runs after
    // the name is read so the `unknown` payload still says which event it was.
    assertEventXdrWithinCap(event);

    let decodedValue: unknown = null;
    if (event.value !== undefined && event.value !== null) {
      try {
        decodedValue = native(event.value);
      } catch (err) {
        recordDecodeOutcome(source, eventName, "malformed");
        const reason = diagnostic(
          `malformed XDR value: ${err instanceof Error ? err.message : String(err)}`,
        );
        return handleUndecodable(reason, eventName);
      }
    }

    const fields = isRecord(decodedValue) ? decodedValue : {};

    const decoderMap = source === "market" ? MARKET_DECODERS : SQUAD_DECODERS;
    const decoder =
      decoderMap[normVersion] ??
      decoderMap[DEFAULT_CONTRACT_VERSION] ??
      (source === "market" ? decodeMarketV1 : decodeSquadV1);

    const payload = decoder(eventName, topics, fields);

    if (payload) {
      recordDecodeOutcome(source, eventName, isAdminPayload(payload) ? "admin" : "decoded");
      return { ...meta, payload } as DecodedEvent;
    }
    recordDecodeOutcome(source, eventName, "unknown");
    return handleUndecodable("no decoder", eventName);
  } catch (err) {
    recordDecodeOutcome(source, eventName, "malformed");
    const reason = diagnostic(err instanceof Error ? err.message : err);
    return handleUndecodable(reason, eventName);
  }
}

// ── Decoder explain mode ─────────────────────────────────────────────────────

export interface DecodeExplainFieldCheck {
  field: string;
  passed: boolean;
  expected?: string;
  observedPreview: string;
  reason?: string;
}

export interface DecodeExplainResult {
  source: ContractSource;
  selectedSchema: string;
  version: string;
  eventName: string;
  accepted: boolean;
  fieldChecks: DecodeExplainFieldCheck[];
  rejectionReason: string | null;
  decoded: DecodedEvent;
}

const MAX_EXPLAIN_FIELDS = 20;

/**
 * Explain how `decodeEvent` evaluates a single captured Soroban event.
 *
 * Reports the selected schema, ordered topic/field checks, and any rejection
 * reason, while redacting and bounding all raw values in diagnostics. Never throws.
 */
export function explainDecodeEvent(
  source: ContractSource,
  event: rpc.Api.EventResponse,
  versionOrOptions: string | DecodeOptions = DEFAULT_CONTRACT_VERSION,
  options?: DecodeOptions,
): DecodeExplainResult {
  const version = typeof versionOrOptions === "string" ? versionOrOptions : DEFAULT_CONTRACT_VERSION;
  const normVersion = normalizeContractVersion(version);
  const decoded = decodeEvent(source, event, versionOrOptions, options);
  const fieldChecks: DecodeExplainFieldCheck[] = [];

  const hasTopicArray = Boolean(event && Array.isArray(event.topic));
  fieldChecks.push({
    field: "topic",
    passed: hasTopicArray && event.topic.length > 0,
    expected: "non-empty array",
    observedPreview: hasTopicArray ? `[array(${event.topic.length})]` : redactAndBoundValue(event?.topic),
    ...(!hasTopicArray
      ? { reason: "missing or invalid topic array" }
      : event.topic.length === 0
        ? { reason: "empty topic array" }
        : {}),
  });

  let eventName = "";
  if (hasTopicArray && event.topic.length > 0) {
    try {
      eventName = peekEventName(event);
    } catch {
      eventName = "";
    }
    fieldChecks.push({
      field: "topic[0]",
      passed: eventName !== "",
      expected: "event name string",
      observedPreview: redactAndBoundValue(eventName || event.topic[0]),
      ...(eventName === "" ? { reason: "topic[0] is not an event name string" } : {}),
    });
  }

  if (hasTopicArray && eventName !== "") {
    const topics = event.topic.map((t) => {
      try {
        return native(t as xdr.ScVal);
      } catch {
        return null;
      }
    });
    const topicSchema = validateTopicSchema(source, eventName, topics);
    fieldChecks.push({
      field: "topics",
      passed: topicSchema.valid,
      observedPreview: `[${topics.slice(0, 6).map((t) => redactAndBoundValue(t, 32)).join(", ")}]`,
      ...(!topicSchema.valid ? { reason: sanitizeReason(topicSchema.reason) } : {}),
    });
  }

  const payload = decoded.payload as unknown as Record<string, unknown>;
  const accepted = payload.name !== "unknown";

  if (accepted) {
    const keys = Object.keys(payload).filter((k) => k !== "name").slice(0, MAX_EXPLAIN_FIELDS);
    for (const key of keys) {
      fieldChecks.push({
        field: `payload.${key}`,
        passed: true,
        observedPreview: redactAndBoundValue(payload[key]),
      });
    }
  } else if (event && event.value !== undefined && event.value !== null) {
    try {
      const decodedValue = native(event.value);
      if (isRecord(decodedValue)) {
        const keys = Object.keys(decodedValue).slice(0, MAX_EXPLAIN_FIELDS);
        for (const key of keys) {
          fieldChecks.push({
            field: `value.${key}`,
            passed: true,
            observedPreview: redactAndBoundValue(decodedValue[key]),
          });
        }
      } else {
        fieldChecks.push({
          field: "value",
          passed: true,
          observedPreview: redactAndBoundValue(decodedValue),
        });
      }
    } catch (err) {
      fieldChecks.push({
        field: "value",
        passed: false,
        observedPreview: redactAndBoundValue(event.value),
        reason: sanitizeReason(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  const schemaEvent = accepted ? String(payload.name) : eventName || "unknown";
  const selectedSchema = `${source}:${normVersion}:${schemaEvent}`;
  const rejectionReason = accepted
    ? null
    : sanitizeReason(typeof payload.reason === "string" ? payload.reason : "unknown event");

  return {
    source,
    selectedSchema,
    version: normVersion,
    eventName: eventName || (typeof payload.eventName === "string" ? payload.eventName : ""),
    accepted,
    fieldChecks,
    rejectionReason,
    decoded,
  };
}

// ── Ordering metadata (issue #48) ────────────────────────────────────────────

/** Ledger sequence: a safe non-negative integer, else 0. Never `NaN` or lossy float. */
function toLedger(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return 0;
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    try {
      const bn = BigInt(value.trim());
      if (bn < 0n || bn > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
      return Number(bn);
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Transaction/operation position: a non-negative safe integer when the RPC provides
 * one (safe number or decimal string), else `null`. `null` means "the chain did not
 * say" — sorting orders it after known positions instead of inventing one.
 */
function toPosition(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    try {
      const bn = BigInt(value.trim());
      if (bn < 0n || bn > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      return Number(bn);
    } catch {
      return null;
    }
  }
  return null;
}

/** Trimmed transaction hash, or `""` when absent. Kept verbatim, not dropped. */
function toTxHash(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** RPC event `type`, or `"unknown"` when missing/unexpected. */
function toEventType(value: unknown): string {
  return value === "contract" || value === "system" || value === "diagnostic"
    ? value
    : "unknown";
}

function toSuccessFlag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Unix seconds for `ledgerClosedAt`, or 0 when unparseable. Never `NaN`. */
function toAt(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const ms = new Date(value as string).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000);
}

/**
 * Build the ordering-safe metadata for one RPC event. Never throws, even for
 * `null`/partially-shaped input: every field is coerced with a safe default.
 */
function safeMeta(
  source: ContractSource,
  event: rpc.Api.EventResponse,
): Omit<EventMeta, "version"> {
  try {
    const raw = (event ?? {}) as Partial<rpc.Api.EventResponse> & Record<string, unknown>;
    const id = raw.id;
    return {
      source,
      contractId: contractIdOf(event),
      ledger: toLedger(raw.ledger),
      txHash: toTxHash(raw.txHash),
      at: toAt(raw.ledgerClosedAt),
      eventId: typeof id === "string" ? id : "",
      eventType: toEventType(raw.type),
      transactionIndex: toPosition(raw.transactionIndex),
      operationIndex: toPosition(raw.operationIndex),
      inSuccessfulContractCall: toSuccessFlag(raw.inSuccessfulContractCall),
    };
  } catch {
    return {
      source,
      contractId: "",
      ledger: 0,
      txHash: "",
      at: 0,
      eventId: "",
      eventType: "unknown",
      transactionIndex: null,
      operationIndex: null,
      inSuccessfulContractCall: null,
    };
  }
}

/**
 * A transaction hash is usable for ordering display and explorer links only
 * when it is a 64-character hex string (32-byte Stellar transaction hash).
 * The all-zero hash is a placeholder, never a real transaction (it would be a
 * SHA-256 preimage of zero), so it is not usable either.
 * Anything else stays on the event but is never turned into a link.
 */
export function isUsableTxHash(txHash: string): boolean {
  const hash = (txHash ?? "").trim();
  return /^[0-9a-fA-F]{64}$/.test(hash) && !/^0{64}$/.test(hash);
}

/** Rank a position for ordering: known indexes first (ascending), `null` last. */
function rankPosition(value: number | null): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Deterministic ordering over chain-provided metadata only:
 * ledger → transaction index → operation index → paging token → tx hash.
 *
 * Returns 0 only when every compared field is equal. No wall-clock time, no
 * array position, and no JS object iteration order are consulted, so the same
 * set of events always sorts the same way regardless of RPC page splits or
 * poll-cycle boundaries.
 */
export function compareEvents(a: EventMeta, b: EventMeta): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  const txA = rankPosition(a.transactionIndex);
  const txB = rankPosition(b.transactionIndex);
  if (txA !== txB) return txA - txB;
  const opA = rankPosition(a.operationIndex);
  const opB = rankPosition(b.operationIndex);
  if (opA !== opB) return opA - opB;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
  return 0;
}

/**
 * A stable, deterministic sort. Returns a new array; the input is untouched.
 * Elements with identical ordering keys keep their input relative order.
 */
export function sortEvents<T extends EventMeta>(events: readonly T[]): T[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((x, y) => compareEvents(x.event, y.event) || x.index - y.index)
    .map((entry) => entry.event);
}

/**
 * Drop within-scan duplicates using the canonical {@link eventKey} derivation
 * shared with the raw-layer window and the replay CLI, so one event cannot be
 * identified one way here and another way there. The RPC may repeat the
 * boundary event across pages; the first occurrence wins and input order is
 * preserved. Decoded events carry no `topic`, so the composite branch is
 * unreachable here — an event without a paging token yields `null`, is kept,
 * and identity is never invented.
 */
export function dedupeEvents<T extends EventMeta>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const event of events) {
    const key = eventKey(event);
    if (key === null) {
      out.push(event);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

// ── Display helpers (shared by formatting and the CLI) ───────────────────────

/** One field's budget in a log line, and the whole document's. */
const MAX_LOG_FIELD_CHARS = 240;
const MAX_LOG_JSON_CHARS = 4_096;

const ANSI_ESCAPE_PATTERN =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
const CONTROL_OR_WHITESPACE_PATTERN = /[\x00-\x1f\x7f-\x9f\s]+/g;

function cleanLogString(value: string): string {
  const compact = value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(CONTROL_OR_WHITESPACE_PATTERN, " ")
    .trim();
  return compact.length <= MAX_LOG_FIELD_CHARS
    ? compact
    : `${compact.slice(0, MAX_LOG_FIELD_CHARS - 1)}…`;
}

/**
 * JSON-safe view of a payload for logs and the `scan` CLI.
 *
 * Bounded twice, because the failure modes differ: every string is stripped of
 * ANSI/control sequences, collapsed to a single line and capped, so one remote
 * value cannot dominate or corrupt a log line, and the serialized document is
 * capped as a whole, so a payload built from many fields cannot either. Plain
 * object keys are sorted for deterministic log output, and `bigint` is
 * stringified and bounded explicitly because `JSON.stringify` throws on it.
 */
export function summarizePayloadForLog(
  payload: unknown,
  maxChars = MAX_LOG_JSON_CHARS,
): string {
  const limit = Math.max(1, maxChars);
  const json =
    JSON.stringify(payload, (_key, item) => {
      if (typeof item === "bigint") return cleanLogString(item.toString());
      if (typeof item === "string") return cleanLogString(item);
      if (isRecord(item)) {
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(item).sort()) {
          sorted[cleanLogString(k)] = item[k];
        }
        return sorted;
      }
      return item;
    }) ?? "null";
  return json.length <= limit ? json : `${json.slice(0, limit - 1)}…`;
}

/**
 * Atomic USDC -> an explicit 7-decimal string.
 *
 * Soroban amounts are integer atomic units, so keeping all seven fractional
 * digits makes the display unit unambiguous (`20000000n` -> `"2.0000000"`)
 * without ever converting through a floating-point number.
 */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / USDC_UNIT;
  const frac = (abs % USDC_UNIT).toString().padStart(7, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** `GABCD…WXYZ` — full strkeys are unreadable in a chat message. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 5)}…${address.slice(-4)}`;
}

export function winnerSideLabel(side: number): string {
  return WINNER_SIDE[side] ?? `side ${side}`;
}

export function squadSideLabel(side: number): string {
  return SQUAD_SIDE[side] ?? `side ${side}`;
}

/** Check if a payload represents a decoded admin event. */
export function isAdminPayload(payload: EventPayload): payload is AdminPayload {
  if (!payload || typeof payload !== "object") return false;
  if ((ADMIN_EVENT_NAMES as readonly string[]).includes(payload.name)) return true;
  if (
    typeof payload.name === "string" &&
    (payload.name.startsWith("fee_policy_") || payload.name.startsWith("admin_"))
  ) {
    return true;
  }
  return false;
}

/**
 * Transform a decoded event into a structured admin audit record, or null if it
 * is not an admin event.
 */
export function toAdminAuditRecord(
  event: DecodedEvent,
  config?: StellarConfig,
): AdminAuditRecord | null {
  if (!isAdminPayload(event.payload)) return null;

  const p = event.payload;
  let adminAddr: string | undefined = undefined;
  const details: Record<string, string | number | boolean> = {};

  if (p.name === "oracle_changed") {
    if (p.newOracle) adminAddr = p.newOracle;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "ownership_transferred") {
    if (p.newOwner) adminAddr = p.newOwner;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.previousOwner) details.previousOwner = p.previousOwner;
    if (p.newOwner) details.newOwner = p.newOwner;
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "agent_attributed") {
    if (p.agent) adminAddr = p.agent;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "fee_accrued") {
    if (p.recipient) adminAddr = p.recipient;
    if (p.admin && !adminAddr) adminAddr = p.admin;
    if (p.amount !== undefined) details.amount = p.amount.toString();
    if (p.details) Object.assign(details, p.details);
  } else if (p.name === "admin") {
    if (p.admin) adminAddr = p.admin;
    if (p.details) Object.assign(details, p.details);
  } else {
    if ("admin" in p && typeof p.admin === "string") adminAddr = p.admin;
    if ("recipient" in p && typeof p.recipient === "string" && !adminAddr) adminAddr = p.recipient;
    if ("feeBps" in p && p.feeBps !== undefined) details.feeBps = p.feeBps;
    if ("category" in p && typeof p.category === "string") details.category = p.category;
    if ("details" in p && isRecord(p.details)) {
      for (const [k, v] of Object.entries(p.details as Record<string, unknown>)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          details[k] = v;
        }
      }
    }
  }

  let explorerUrl: string | undefined = undefined;
  if (config && event.txHash && isUsableTxHash(event.txHash)) {
    try {
      explorerUrl = txExplorerUrl(config, event.txHash) || undefined;
    } catch {
      // Ignore
    }
  }

  return {
    type: p.name === "admin" ? (p as GenericAdminPayload).action : p.name,
    ledger: event.ledger,
    at: event.at,
    transactionHash: event.txHash || undefined,
    contractId: event.contractId || undefined,
    admin: adminAddr,
    details,
    explorerUrl,
  };
}

// ── CLI support (issue: offline XDR decode) ─────────────────────────────────

/**
 * Minimal raw event shape accepted by the offline decode CLI.
 *
 * Mirrors the subset of `rpc.Api.EventResponse` the decoder actually reads, so
 * a contributor can paste a base64 topic/value pair from an explorer or RPC log
 * without fabricating the rest of the RPC envelope.
 */
export interface RawEventInput {
  /** Base64-encoded `ScVal` topics, in order. `topic[0]` is the event name. */
  topic: string[];
  /** Base64-encoded `ScVal` value. */
  value?: string;
  /** Optional contract id, carried through to the decoded metadata. */
  contractId?: string;
  /** Optional ledger sequence. */
  ledger?: number | string;
  /** Optional transaction hash. */
  txHash?: string;
  /** Optional ledger close time (ISO string). */
  ledgerClosedAt?: string;
  /** Optional RPC event id / paging token. */
  id?: string;
}

/** Raised when a raw event cannot be turned into an `rpc.Api.EventResponse`. */
export class RawEventError extends Error {}

function decodeBase64ScVal(b64: unknown, what: string): xdr.ScVal {
  if (typeof b64 !== "string" || b64.trim() === "") {
    throw new RawEventError(`${what}: expected a non-empty base64 string`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64.trim(), "base64");
  } catch {
    throw new RawEventError(`${what}: invalid base64`);
  }
  // `Buffer.from` is lenient; reject anything that does not round-trip.
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== b64.trim().replace(/=+$/, "")) {
    throw new RawEventError(`${what}: invalid base64`);
  }
  try {
    return xdr.ScVal.fromXDR(bytes);
  } catch (err) {
    throw new RawEventError(
      diagnostic(`${what}: malformed XDR: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

/**
 * Build a minimal `rpc.Api.EventResponse` from a raw base64 topic/value pair.
 *
 * Throws {@link RawEventError} (bounded message) when base64 or XDR is
 * malformed, so the CLI can exit with code 2 without leaking unbounded input.
 */
export function buildRawEvent(input: RawEventInput): rpc.Api.EventResponse {
  if (!input || typeof input !== "object") {
    throw new RawEventError("event: expected an object");
  }
  if (!Array.isArray(input.topic) || input.topic.length === 0) {
    throw new RawEventError("event.topic: expected a non-empty array of base64 strings");
  }
  const topic = input.topic.map((t, i) => decodeBase64ScVal(t, `event.topic[${i}]`));
  const value =
    input.value === undefined || input.value === null
      ? undefined
      : decodeBase64ScVal(input.value, "event.value");

  return {
    type: "contract",
    topic,
    value,
    contractId: input.contractId,
    ledger: input.ledger,
    txHash: input.txHash,
    ledgerClosedAt: input.ledgerClosedAt,
    id: input.id,
  } as unknown as rpc.Api.EventResponse;
}

/**
 * JSON replacer for `JSON.stringify` that keeps `bigint` values pipeable to
 * `jq` (which has no bigint type) while leaving every other field intact.
 */
export function scanJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * Decode a raw base64 event and return a JSON-ready object.
 *
 * Combines {@link buildRawEvent} and {@link decodeEvent}, and — when the
 * decoder falls back to `unknown` — attaches the bounded reason so a CLI user
 * can see why. Throws {@link RawEventError} on malformed input.
 */
export function decodeRawEvent(
  source: ContractSource,
  input: RawEventInput,
  version: string = DEFAULT_CONTRACT_VERSION,
): DecodedEvent {
  const event = buildRawEvent(input);
  return decodeEvent(source, event, version);
}

export {
  DECODER_FINGERPRINT_VERSION,
  fingerprintDecodedEvent,
  fingerprintDecoderOutput,
  type SemanticFingerprint,
} from "./decoder-fingerprint.js";
