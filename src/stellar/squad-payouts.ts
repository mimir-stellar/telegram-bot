/**
 * Squad market payout aggregations and accounting consistency checks.
 *
 * Computes gross, fees, and net payouts per squad market and per participant
 * from chain events (`SquadClaimedPayload`, `SquadResolvedPayload`).
 *
 * Invariant: For every claimed event, gross = fee + net.
 * Violations are returned as structured records, never thrown.
 *
 * Deterministic ordering and bigint arithmetic are preserved throughout.
 */

import type {
  DecodedEvent,
  SquadClaimedPayload,
  SquadEvent,
  SquadResolvedPayload,
} from "./decode.js";

export type SquadPayoutEvent =
  | DecodedEvent
  | SquadEvent
  | { payload: SquadClaimedPayload | SquadResolvedPayload | unknown }
  | SquadClaimedPayload
  | SquadResolvedPayload
  | unknown;

export interface SquadPayoutViolation {
  marketId: number;
  participant: string;
  gross: bigint;
  fee: bigint;
  net: bigint;
  expectedGross: bigint;
  expected: bigint;
  actual: bigint;
  difference: bigint;
  reason: string;
  message: string;
  ledger?: number | undefined;
  txHash?: string | undefined;
  eventId?: string | undefined;
}

export interface SquadParticipantPayout {
  participant: string;
  recipient: string;
  gross: bigint;
  fee: bigint;
  fees: bigint;
  net: bigint;
  claimsCount: number;
  marketIds: number[];
}

export interface SquadMarketPayout {
  marketId: number;
  gross: bigint;
  fee: bigint;
  fees: bigint;
  net: bigint;
  claimsCount: number;
  resolved: boolean;
  result?: number | undefined;
  poolA?: bigint | undefined;
  poolB?: bigint | undefined;
  participants: SquadParticipantPayout[];
  topRecipients: SquadParticipantPayout[];
  byParticipant: Map<string, SquadParticipantPayout>;
  violations: SquadPayoutViolation[];
}

export interface SquadPayoutReport {
  markets: SquadMarketPayout[];
  topRecipients: SquadParticipantPayout[];
  participants: SquadParticipantPayout[];
  byMarket: Map<number, SquadMarketPayout>;
  byParticipant: Map<string, SquadParticipantPayout>;
  violations: SquadPayoutViolation[];
  totalGross: bigint;
  totalFees: bigint;
  totalFee: bigint;
  totalNet: bigint;
  totalClaims: number;
  gross: bigint;
  fee: bigint;
  fees: bigint;
  net: bigint;
}

export interface SquadPayoutsOptions {
  topLimit?: number | undefined;
}

function toBigInt(val: unknown): bigint | null {
  if (typeof val === "bigint") return val;
  if (typeof val === "number" && Number.isInteger(val)) return BigInt(val);
  if (typeof val === "string" && /^-?\d+$/.test(val.trim())) {
    try {
      return BigInt(val.trim());
    } catch {
      return null;
    }
  }
  return null;
}

function toMarketId(val: unknown): number | null {
  if (typeof val === "number" && Number.isInteger(val) && val >= 0) return val;
  if (typeof val === "bigint" && val >= 0n && val <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(val);
  }
  if (typeof val === "string" && /^\d+$/.test(val.trim())) {
    const num = Number(val.trim());
    if (Number.isSafeInteger(num) && num >= 0) return num;
  }
  return null;
}

function compareRecipients(a: SquadParticipantPayout, b: SquadParticipantPayout): number {
  if (b.net !== a.net) {
    return b.net > a.net ? 1 : -1;
  }
  if (b.gross !== a.gross) {
    return b.gross > a.gross ? 1 : -1;
  }
  return a.participant.localeCompare(b.participant);
}

function compareViolations(a: SquadPayoutViolation, b: SquadPayoutViolation): number {
  if (a.marketId !== b.marketId) {
    return a.marketId - b.marketId;
  }
  if (a.participant !== b.participant) {
    return a.participant.localeCompare(b.participant);
  }
  if (a.difference !== b.difference) {
    return a.difference > b.difference ? 1 : -1;
  }
  return a.reason.localeCompare(b.reason);
}

interface RawEventMeta {
  ledger?: number | undefined;
  txHash?: string | undefined;
  eventId?: string | undefined;
}

function extractPayloadAndMeta(event: unknown): { payload: unknown; meta: RawEventMeta } {
  if (!event || typeof event !== "object") {
    return { payload: event, meta: {} };
  }

  const record = event as Record<string, unknown>;
  const meta: RawEventMeta = {};
  if (typeof record.ledger === "number") meta.ledger = record.ledger;
  if (typeof record.txHash === "string") meta.txHash = record.txHash;
  if (typeof record.eventId === "string") meta.eventId = record.eventId;

  if ("payload" in record && record.payload && typeof record.payload === "object") {
    return { payload: record.payload, meta };
  }

  return { payload: event, meta };
}

/**
 * Aggregate payouts from squad events (claims and resolutions).
 *
 * Computes per-market gross, fee, net totals and per-participant top recipients.
 * Validates that gross = fee + net for every claim event, collecting any violations
 * without throwing.
 */
export function squadPayouts(
  events: Iterable<SquadPayoutEvent>,
  options?: SquadPayoutsOptions,
): SquadPayoutReport {
  interface MarketAccumulator {
    marketId: number;
    gross: bigint;
    fee: bigint;
    net: bigint;
    claimsCount: number;
    resolved: boolean;
    result?: number | undefined;
    poolA?: bigint | undefined;
    poolB?: bigint | undefined;
    participants: Map<
      string,
      {
        participant: string;
        gross: bigint;
        fee: bigint;
        net: bigint;
        claimsCount: number;
      }
    >;
    violations: SquadPayoutViolation[];
  }

  interface ParticipantAccumulator {
    participant: string;
    gross: bigint;
    fee: bigint;
    net: bigint;
    claimsCount: number;
    marketIds: Set<number>;
  }

  const marketMap = new Map<number, MarketAccumulator>();
  const participantMap = new Map<string, ParticipantAccumulator>();
  const allViolations: SquadPayoutViolation[] = [];

  let totalGross = 0n;
  let totalFees = 0n;
  let totalNet = 0n;
  let totalClaims = 0;

  function getOrCreateMarket(marketId: number): MarketAccumulator {
    let m = marketMap.get(marketId);
    if (!m) {
      m = {
        marketId,
        gross: 0n,
        fee: 0n,
        net: 0n,
        claimsCount: 0,
        resolved: false,
        participants: new Map(),
        violations: [],
      };
      marketMap.set(marketId, m);
    }
    return m;
  }

  function getOrCreateParticipant(address: string): ParticipantAccumulator {
    let p = participantMap.get(address);
    if (!p) {
      p = {
        participant: address,
        gross: 0n,
        fee: 0n,
        net: 0n,
        claimsCount: 0,
        marketIds: new Set(),
      };
      participantMap.set(address, p);
    }
    return p;
  }

  if (events && typeof (events as Iterable<unknown>)[Symbol.iterator] === "function") {
    for (const item of events) {
      const { payload, meta } = extractPayloadAndMeta(item);
      if (!payload || typeof payload !== "object") continue;

      const p = payload as Record<string, unknown>;
      const eventName = typeof p.name === "string" ? p.name : "";

      if (eventName === "claimed") {
        const rawMarketId = p.marketId;
        const marketId = toMarketId(rawMarketId);
        const participant = typeof p.participant === "string" ? p.participant.trim() : "";
        const rawGross = toBigInt(p.gross);
        const rawFee = toBigInt(p.fee);
        const rawNet = toBigInt(p.net);

        if (marketId === null || !participant || rawGross === null || rawFee === null || rawNet === null) {
          const effectiveMarketId = marketId ?? -1;
          const fallbackGross = rawGross ?? 0n;
          const fallbackFee = rawFee ?? 0n;
          const fallbackNet = rawNet ?? 0n;
          const expectedGross = fallbackFee + fallbackNet;
          const violation: SquadPayoutViolation = {
            marketId: effectiveMarketId,
            participant: participant || "unknown",
            gross: fallbackGross,
            fee: fallbackFee,
            net: fallbackNet,
            expectedGross,
            expected: expectedGross,
            actual: fallbackGross,
            difference: fallbackGross - expectedGross,
            reason: `Malformed claimed event payload for market ${rawMarketId}, participant ${p.participant}`,
            message: `Malformed claimed event payload for market ${rawMarketId}, participant ${p.participant}`,
            ...meta,
          };
          allViolations.push(violation);
          if (effectiveMarketId >= 0) {
            getOrCreateMarket(effectiveMarketId).violations.push(violation);
          }
          continue;
        }

        const expectedGross = rawFee + rawNet;
        const isSumConsistent = rawGross === expectedGross;
        const hasNegativeAmounts = rawGross < 0n || rawFee < 0n || rawNet < 0n;

        if (!isSumConsistent || hasNegativeAmounts) {
          const reason = !isSumConsistent
            ? `Payout invariant violation: gross (${rawGross}) != fee (${rawFee}) + net (${rawNet})`
            : `Negative amount in payout: gross=${rawGross}, fee=${rawFee}, net=${rawNet}`;

          const violation: SquadPayoutViolation = {
            marketId,
            participant,
            gross: rawGross,
            fee: rawFee,
            net: rawNet,
            expectedGross,
            expected: expectedGross,
            actual: rawGross,
            difference: rawGross - expectedGross,
            reason,
            message: reason,
            ...meta,
          };
          allViolations.push(violation);
          getOrCreateMarket(marketId).violations.push(violation);
        }

        // Aggregate amounts
        const m = getOrCreateMarket(marketId);
        m.gross += rawGross;
        m.fee += rawFee;
        m.net += rawNet;
        m.claimsCount += 1;

        let marketPart = m.participants.get(participant);
        if (!marketPart) {
          marketPart = {
            participant,
            gross: 0n,
            fee: 0n,
            net: 0n,
            claimsCount: 0,
          };
          m.participants.set(participant, marketPart);
        }
        marketPart.gross += rawGross;
        marketPart.fee += rawFee;
        marketPart.net += rawNet;
        marketPart.claimsCount += 1;

        const globalPart = getOrCreateParticipant(participant);
        globalPart.gross += rawGross;
        globalPart.fee += rawFee;
        globalPart.net += rawNet;
        globalPart.claimsCount += 1;
        globalPart.marketIds.add(marketId);

        totalGross += rawGross;
        totalFees += rawFee;
        totalNet += rawNet;
        totalClaims += 1;
      } else if (eventName === "resolved") {
        const marketId = toMarketId(p.marketId);
        if (marketId === null) continue;

        const rawResult = typeof p.result === "number" ? p.result : undefined;
        const rawPoolA = toBigInt(p.poolA);
        const rawPoolB = toBigInt(p.poolB);

        const m = getOrCreateMarket(marketId);
        m.resolved = true;
        if (rawResult !== undefined) m.result = rawResult;
        if (rawPoolA !== null) m.poolA = rawPoolA;
        if (rawPoolB !== null) m.poolB = rawPoolB;

        if (rawPoolA !== null && rawPoolB !== null && (rawPoolA < 0n || rawPoolB < 0n)) {
          const violation: SquadPayoutViolation = {
            marketId,
            participant: "",
            gross: 0n,
            fee: 0n,
            net: 0n,
            expectedGross: 0n,
            expected: 0n,
            actual: 0n,
            difference: 0n,
            reason: `Negative pool amount in resolved event: poolA=${rawPoolA}, poolB=${rawPoolB}`,
            message: `Negative pool amount in resolved event: poolA=${rawPoolA}, poolB=${rawPoolB}`,
            ...meta,
          };
          allViolations.push(violation);
          m.violations.push(violation);
        }
      }
    }
  }

  // Build deterministically ordered market results
  const sortedMarketIds = Array.from(marketMap.keys()).sort((a, b) => a - b);
  const byMarket = new Map<number, SquadMarketPayout>();
  const markets: SquadMarketPayout[] = [];

  for (const marketId of sortedMarketIds) {
    const rawMarket = marketMap.get(marketId)!;

    const marketParticipants: SquadParticipantPayout[] = Array.from(
      rawMarket.participants.values(),
    ).map((p) => ({
      participant: p.participant,
      recipient: p.participant,
      gross: p.gross,
      fee: p.fee,
      fees: p.fee,
      net: p.net,
      claimsCount: p.claimsCount,
      marketIds: [marketId],
    }));

    marketParticipants.sort(compareRecipients);

    const marketByParticipant = new Map<string, SquadParticipantPayout>();
    for (const p of marketParticipants) {
      marketByParticipant.set(p.participant, p);
    }

    rawMarket.violations.sort(compareViolations);

    const marketPayout: SquadMarketPayout = {
      marketId: rawMarket.marketId,
      gross: rawMarket.gross,
      fee: rawMarket.fee,
      fees: rawMarket.fee,
      net: rawMarket.net,
      claimsCount: rawMarket.claimsCount,
      resolved: rawMarket.resolved,
      result: rawMarket.result,
      poolA: rawMarket.poolA,
      poolB: rawMarket.poolB,
      participants: marketParticipants,
      topRecipients: [...marketParticipants],
      byParticipant: marketByParticipant,
      violations: rawMarket.violations,
    };

    markets.push(marketPayout);
    byMarket.set(marketId, marketPayout);
  }

  // Build deterministically ordered global participant results
  const globalParticipants: SquadParticipantPayout[] = Array.from(
    participantMap.values(),
  ).map((p) => ({
    participant: p.participant,
    recipient: p.participant,
    gross: p.gross,
    fee: p.fee,
    fees: p.fee,
    net: p.net,
    claimsCount: p.claimsCount,
    marketIds: Array.from(p.marketIds).sort((a, b) => a - b),
  }));

  globalParticipants.sort(compareRecipients);

  const byParticipant = new Map<string, SquadParticipantPayout>();
  for (const p of globalParticipants) {
    byParticipant.set(p.participant, p);
  }

  allViolations.sort(compareViolations);

  let topRecipients = [...globalParticipants];
  if (options?.topLimit !== undefined && options.topLimit >= 0) {
    topRecipients = topRecipients.slice(0, options.topLimit);
  }

  return {
    markets,
    topRecipients,
    participants: globalParticipants,
    byMarket,
    byParticipant,
    violations: allViolations,
    totalGross,
    totalFees,
    totalFee: totalFees,
    totalNet,
    totalClaims,
    gross: totalGross,
    fee: totalFees,
    fees: totalFees,
    net: totalNet,
  };
}
