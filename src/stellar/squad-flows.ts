/**
 * Squad market net deposit and withdrawal flow aggregations.
 *
 * Computes per-market, per-side deposit and withdrawal totals, net flows,
 * and unique participant counts from squad events (`SquadDepositedPayload`,
 * `SquadWithdrawnPayload`).
 *
 * Deterministic ordering and bigint arithmetic are preserved throughout.
 * Net amounts are strictly kept as bigint and never converted to floating-point numbers.
 */

import {
  squadSideLabel,
  type DecodedEvent,
  type SquadDepositedPayload,
  type SquadEvent,
  type SquadWithdrawnPayload,
} from "./decode.js";

export type SquadFlowEvent =
  | DecodedEvent
  | SquadEvent
  | { payload: SquadDepositedPayload | SquadWithdrawnPayload | unknown }
  | SquadDepositedPayload
  | SquadWithdrawnPayload
  | unknown;

export interface SquadSideFlow {
  side: number;
  sideLabel: string;
  deposits: bigint;
  withdrawals: bigint;
  net: bigint;
  uniqueParticipants: number;
  participantsCount: number;
  participants: string[];
}

export interface SquadMarketFlow {
  marketId: number;
  deposits: bigint;
  withdrawals: bigint;
  net: bigint;
  totalDeposits: bigint;
  totalWithdrawals: bigint;
  totalNet: bigint;
  uniqueParticipants: number;
  participantsCount: number;
  participants: string[];
  sides: SquadSideFlow[] & { get(side: number): SquadSideFlow | undefined };
  bySide: Map<number, SquadSideFlow>;
}

export type SquadFlowsResult = SquadMarketFlow[] & {
  byMarket: Map<number, SquadMarketFlow>;
  markets: SquadMarketFlow[];
  get(marketId: number): SquadMarketFlow | undefined;
  has(marketId: number): boolean;
  size: number;
  totalDeposits: bigint;
  totalWithdrawals: bigint;
  totalNet: bigint;
  uniqueParticipants: number;
};

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

function toSide(val: unknown): number | null {
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

interface RawEventPayload {
  name?: unknown;
  marketId?: unknown;
  side?: unknown;
  participant?: unknown;
  amount?: unknown;
  [key: string]: unknown;
}

function extractPayload(event: unknown): RawEventPayload | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if ("payload" in record && record.payload && typeof record.payload === "object") {
    return record.payload as RawEventPayload;
  }
  return record as RawEventPayload;
}

interface SideAccumulator {
  side: number;
  deposits: bigint;
  withdrawals: bigint;
  participants: Set<string>;
}

interface MarketAccumulator {
  marketId: number;
  sides: Map<number, SideAccumulator>;
  participants: Set<string>;
}

function buildEmptyResult(): SquadFlowsResult {
  const result: SquadMarketFlow[] = [];
  const byMarket = new Map<number, SquadMarketFlow>();

  const flowsResult = result as SquadFlowsResult;
  flowsResult.byMarket = byMarket;
  flowsResult.markets = result;
  flowsResult.get = (marketId: number) => byMarket.get(marketId);
  flowsResult.has = (marketId: number) => byMarket.has(marketId);
  Object.defineProperty(flowsResult, "size", {
    get() {
      return byMarket.size;
    },
    enumerable: false,
    configurable: true,
  });
  flowsResult.totalDeposits = 0n;
  flowsResult.totalWithdrawals = 0n;
  flowsResult.totalNet = 0n;
  flowsResult.uniqueParticipants = 0;

  return flowsResult;
}

/**
 * Aggregate deposits and withdrawals from squad events per market and per side.
 *
 * Ignores non-squad and unrelated events. Amounts and net flows are maintained
 * strictly in bigint atomic USDC units. Participants are tracked uniquely per side.
 */
export function aggregateSquadFlows(
  events?: Iterable<SquadFlowEvent> | readonly any[] | null,
): SquadFlowsResult {
  if (!events) {
    return buildEmptyResult();
  }

  const marketMap = new Map<number, MarketAccumulator>();
  const allGlobalParticipants = new Set<string>();

  for (const event of events) {
    const payload = extractPayload(event);
    if (!payload || typeof payload !== "object") continue;

    const eventName = payload.name;
    if (eventName !== "deposited" && eventName !== "withdrawn") {
      continue;
    }

    const marketId = toMarketId(payload.marketId);
    const side = toSide(payload.side);
    const participant =
      typeof payload.participant === "string" ? payload.participant.trim() : "";
    const amount = toBigInt(payload.amount);

    if (marketId === null || side === null || !participant || amount === null || amount < 0n) {
      continue;
    }

    let marketAcc = marketMap.get(marketId);
    if (!marketAcc) {
      marketAcc = {
        marketId,
        sides: new Map(),
        participants: new Set(),
      };
      marketMap.set(marketId, marketAcc);
    }

    let sideAcc = marketAcc.sides.get(side);
    if (!sideAcc) {
      sideAcc = {
        side,
        deposits: 0n,
        withdrawals: 0n,
        participants: new Set(),
      };
      marketAcc.sides.set(side, sideAcc);
    }

    if (eventName === "deposited") {
      sideAcc.deposits += amount;
    } else {
      sideAcc.withdrawals += amount;
    }

    sideAcc.participants.add(participant);
    marketAcc.participants.add(participant);
    allGlobalParticipants.add(participant);
  }

  const sortedMarketIds = Array.from(marketMap.keys()).sort((a, b) => a - b);
  const markets: SquadMarketFlow[] = [];
  const byMarket = new Map<number, SquadMarketFlow>();

  let overallDeposits = 0n;
  let overallWithdrawals = 0n;

  for (const marketId of sortedMarketIds) {
    const marketAcc = marketMap.get(marketId)!;
    const sortedSides = Array.from(marketAcc.sides.keys()).sort((a, b) => a - b);

    const sideFlows: SquadSideFlow[] = [];
    const bySide = new Map<number, SquadSideFlow>();

    let marketDeposits = 0n;
    let marketWithdrawals = 0n;

    for (const side of sortedSides) {
      const sideAcc = marketAcc.sides.get(side)!;
      const net = sideAcc.deposits - sideAcc.withdrawals;
      const participants = Array.from(sideAcc.participants).sort();
      const count = participants.length;

      const sideFlow: SquadSideFlow = {
        side,
        sideLabel: squadSideLabel(side),
        deposits: sideAcc.deposits,
        withdrawals: sideAcc.withdrawals,
        net,
        uniqueParticipants: count,
        participantsCount: count,
        participants,
      };

      sideFlows.push(sideFlow);
      bySide.set(side, sideFlow);

      marketDeposits += sideAcc.deposits;
      marketWithdrawals += sideAcc.withdrawals;
    }

    const marketNet = marketDeposits - marketWithdrawals;
    const marketParticipants = Array.from(marketAcc.participants).sort();
    const marketParticipantCount = marketParticipants.length;

    const sideList = sideFlows as SquadSideFlow[] & {
      get(side: number): SquadSideFlow | undefined;
    };
    sideList.get = (side: number) => bySide.get(side);

    const marketFlow: SquadMarketFlow = {
      marketId,
      deposits: marketDeposits,
      withdrawals: marketWithdrawals,
      net: marketNet,
      totalDeposits: marketDeposits,
      totalWithdrawals: marketWithdrawals,
      totalNet: marketNet,
      uniqueParticipants: marketParticipantCount,
      participantsCount: marketParticipantCount,
      participants: marketParticipants,
      sides: sideList,
      bySide,
    };

    markets.push(marketFlow);
    byMarket.set(marketId, marketFlow);

    overallDeposits += marketDeposits;
    overallWithdrawals += marketWithdrawals;
  }

  const result = markets as SquadFlowsResult;
  result.byMarket = byMarket;
  result.markets = markets;
  result.get = (marketId: number) => byMarket.get(marketId);
  result.has = (marketId: number) => byMarket.has(marketId);
  Object.defineProperty(result, "size", {
    get() {
      return byMarket.size;
    },
    enumerable: false,
    configurable: true,
  });
  result.totalDeposits = overallDeposits;
  result.totalWithdrawals = overallWithdrawals;
  result.totalNet = overallDeposits - overallWithdrawals;
  result.uniqueParticipants = allGlobalParticipants.size;

  return result;
}
