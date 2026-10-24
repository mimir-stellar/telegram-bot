/**
 * Bounded reducer for Mimir squad pools.
 *
 * Reconstructs per-market, per-side pool balances from delivered `deposited`
 * and `withdrawn` events, then verifies them against the `poolA`/`poolB`
 * values reported by `resolved` events. Detects decoder or indexing errors
 * (for example missed events across a restart gap) by flagging mismatches.
 * Markets whose creation was never observed are reported as unverifiable
 * rather than mismatched.
 *
 * Memory is bounded: tracked markets are capped and the oldest market is
 * evicted when the cap is reached.
 */

export type PoolSide = 0 | 1;

export interface PoolSnapshot {
  poolA: bigint;
  poolB: bigint;
}

export interface TrackedMarket {
  pools: PoolSnapshot;
  /** True when a `market_created` event for this market was observed. */
  created: boolean;
  /** Last resolution verification result, undefined until checked. */
  verified: MarketVerification | undefined;
}

export interface MismatchRecord {
  marketId: number;
  /** Pools reconstructed from balance events. */
  expected: PoolSnapshot;
  /** Pools reported by the resolved event. */
  observed: PoolSnapshot;
}

export type MarketVerification = "unverifiable" | "ok" | "mismatched";

/** Default ceiling on tracked markets in memory. */
export const DEFAULT_MAX_MARKETS = 256;

/** Default ceiling on retained mismatch records. */
export const DEFAULT_MAX_MISMATCHES = 64;

/** Side 0 accumulates into `poolA`; side 1 into `poolB`. */
function fieldForSide(side: number): "poolA" | "poolB" {
  return side === 1 ? "poolB" : "poolA";
}

/** Events the reducer consumes. */
export interface PoolEvent {
  marketId: number;
  name: "deposited" | "withdrawn";
  side: number;
  amount: bigint;
}

export interface SquadPoolsOptions {
  maxMarkets?: number;
  maxMismatches?: number;
}

/**
 * Pure reduction of delivered squad balance events into per-market pool
 * snapshots. Same input events always yield the same snapshots, with no side
 * effects and no dependence on ambient state.
 */
export function reduceSquadPools(events: readonly PoolEvent[]): Map<number, PoolSnapshot> {
  const pools = new Map<number, PoolSnapshot>();
  for (const event of events) {
    let snap = pools.get(event.marketId);
    if (!snap) {
      snap = { poolA: 0n, poolB: 0n };
      pools.set(event.marketId, snap);
    }
    const previous = { ...snap };
    const field = fieldForSide(event.side);
    snap[field] =
      event.name === "deposited" ? previous[field] + event.amount : previous[field] - event.amount;
  }
  return pools;
}

/**
 * Compares reconstructed pools against the values reported by a `resolved`
 * event. Side 0 is compared to `poolA`; side 1 to `poolB`. Returns a bounded
 * mismatch record when they differ, otherwise undefined. Pure: no side
 * effects.
 */
export function compareResolved(
  snapshot: PoolSnapshot | undefined,
  poolA: bigint,
  poolB: bigint,
): { expected: PoolSnapshot; observed: PoolSnapshot } | undefined {
  if (!snapshot) return undefined;
  if (snapshot.poolA === poolA && snapshot.poolB === poolB) return undefined;
  return { expected: { ...snapshot }, observed: { poolA, poolB } };
}

/**
 * Tracks squad pool balances and verifies them against resolutions.
 *
 * Layers bounded state and market lifecycle (created / resolved) on top of
 * the pure reducer above.
 */
export class SquadPools {
  private readonly markets = new Map<number, TrackedMarket>();
  private readonly order: number[] = [];
  private readonly mismatchRecords: MismatchRecord[] = [];
  private readonly maxMarkets: number;
  private readonly maxMismatches: number;

  constructor(options: SquadPoolsOptions = {}) {
    this.maxMarkets =
      typeof options.maxMarkets === "number" && options.maxMarkets > 0
        ? options.maxMarkets
        : DEFAULT_MAX_MARKETS;
    this.maxMismatches =
      typeof options.maxMismatches === "number" && options.maxMismatches > 0
        ? options.maxMismatches
        : DEFAULT_MAX_MISMATCHES;
  }

  /**
   * Record a `deposited` or `withdrawn` balance event for a market.
   * Side 0 accumulates into `poolA`; side 1 into `poolB`.
   */
  record(event: PoolEvent): void {
    let market = this.markets.get(event.marketId);
    if (!market) {
      this.evictIfNeeded();
      market = { pools: { poolA: 0n, poolB: 0n }, created: false, verified: undefined };
      this.markets.set(event.marketId, market);
      this.order.push(event.marketId);
    }
    const field = fieldForSide(event.side);
    const previous = market.pools[field];
    market.pools[field] =
      event.name === "deposited" ? previous + event.amount : previous - event.amount;
  }

  /** Mark that a `market_created` event was observed for this market. */
  observeCreated(marketId: number): void {
    let market = this.markets.get(marketId);
    if (!market) {
      this.evictIfNeeded();
      market = { pools: { poolA: 0n, poolB: 0n }, created: false, verified: undefined };
      this.markets.set(marketId, market);
      this.order.push(marketId);
    }
    market.created = true;
  }

  /**
   * Verify the reconstructed pools for a market against the values reported
   * by its `resolved` event. Side 0 is compared to `poolA`; side 1 to
   * `poolB`. Returns the verification status and, on mismatch, a mismatch
   * record including the market id and the expected/observed values.
   */
  checkResolved(marketId: number, poolA: bigint, poolB: bigint): {
    status: MarketVerification;
    mismatch: MismatchRecord | undefined;
  } {
    const market = this.markets.get(marketId);
    if (!market) {
      return { status: "unverifiable", mismatch: undefined };
    }
    if (!market.created) {
      market.verified = "unverifiable";
      return { status: "unverifiable", mismatch: undefined };
    }
    const mismatch = compareResolved(market.pools, poolA, poolB);
    const status: MarketVerification = mismatch ? "mismatched" : "ok";
    market.verified = status;
    if (mismatch) {
      const record: MismatchRecord = {
        marketId,
        expected: { ...market.pools },
        observed: { poolA, poolB },
      };
      this.mismatchRecords.push(record);
      if (this.mismatchRecords.length > this.maxMismatches) this.mismatchRecords.shift();
      return { status, mismatch: record };
    }
    return { status, mismatch: undefined };
  }

  /** Verification status for a market, or undefined when never tracked. */
  status(marketId: number): MarketVerification | undefined {
    const market = this.markets.get(marketId);
    if (!market) return undefined;
    if (!market.created) return "unverifiable";
    return market.verified;
  }

  /** Markets currently tracked in memory. */
  get size(): number {
    return this.markets.size;
  }

  /** Mismatch records retained so far (newest last), bounded by maxMismatches. */
  get mismatches(): readonly MismatchRecord[] {
    return this.mismatchRecords;
  }

  private evictIfNeeded(): void {
    if (this.markets.size < this.maxMarkets) return;
    const oldest = this.order.shift();
    if (oldest !== undefined) this.markets.delete(oldest);
  }
}

/** Factory function for creating a SquadPools tracker. */
export function createSquadPools(options?: SquadPoolsOptions): SquadPools {
  return new SquadPools(options);
}
