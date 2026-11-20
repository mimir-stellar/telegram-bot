import type { DecodedEvent } from "../stellar/decode.js";
import type { StellarConfig } from "../config.js";

const DEFAULT_MARKET_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const DEFAULT_SQUAD_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M";
const DEFAULT_TX_HASH = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const SAMPLE_TIMESTAMP = 1770000000;

function createMarketMeta(config?: Partial<StellarConfig>): Omit<DecodedEvent, "payload"> {
  return {
    source: "market",
    contractId: config?.marketContractId ?? DEFAULT_MARKET_CONTRACT,
    version: "v1",
    ledger: 1000000,
    txHash: DEFAULT_TX_HASH,
    at: SAMPLE_TIMESTAMP,
    eventId: "1000000-0",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  };
}

function createSquadMeta(config?: Partial<StellarConfig>): Omit<DecodedEvent, "payload"> {
  return {
    source: "squad",
    contractId: config?.squadContractId ?? DEFAULT_SQUAD_CONTRACT,
    version: "v1",
    ledger: 1000000,
    txHash: DEFAULT_TX_HASH,
    at: SAMPLE_TIMESTAMP,
    eventId: "1000000-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  };
}

export type SampleEventName =
  | "claim_created"
  | "claim_challenged"
  | "claim_resolved"
  | "claim_cancelled"
  | "market_settled"
  | "challenger_paid"
  | "fee_claimed"
  | "withdrawal"
  | "withdrawal_pending"
  | "market_created"
  | "deposited"
  | "withdrawn"
  | "resolved"
  | "claimed"
  | "fees_claimed";

/**
 * Build one sample DecodedEvent per market and squad event name.
 * Can be called with a StellarConfig (or partial) to use configured contract IDs.
 */
export function buildSampleEvents(config?: Partial<StellarConfig>): Record<SampleEventName, DecodedEvent> {
  const marketBase = createMarketMeta(config);
  const squadBase = createSquadMeta(config);

  return {
    // ── mimir-market events ───────────────────────────────────────────────────
    claim_created: {
      ...marketBase,
      payload: {
        name: "claim_created",
        claimId: 1,
        category: "crypto",
        creator: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      },
    },
    claim_challenged: {
      ...marketBase,
      payload: {
        name: "claim_challenged",
        claimId: 1,
        challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        stake: 20_000_000n, // 2 USDC
      },
    },
    claim_resolved: {
      ...marketBase,
      payload: {
        name: "claim_resolved",
        claimId: 1,
        winnerSide: 2, // challengers
        confidence: 95,
        summary: "Claim validated by oracle consensus.",
        evidenceHash: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      },
    },
    claim_cancelled: {
      ...marketBase,
      payload: {
        name: "claim_cancelled",
        claimId: 1,
      },
    },
    market_settled: {
      ...marketBase,
      payload: {
        name: "market_settled",
        claimId: 1,
        totalPaid: 180_000_000n, // 18 USDC
        totalFees: 20_000_000n, // 2 USDC
        owedToChallengers: 160_000_000n, // 16 USDC
        dust: 0n,
      },
    },
    challenger_paid: {
      ...marketBase,
      payload: {
        name: "challenger_paid",
        claimId: 1,
        challenger: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        stake: 20_000_000n, // 2 USDC
        gross: 38_000_000n, // 3.8 USDC
        fee: 2_000_000n, // 0.2 USDC
        net: 36_000_000n, // 3.6 USDC
      },
    },
    fee_claimed: {
      ...marketBase,
      payload: {
        name: "fee_claimed",
        recipient: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        amount: 50_000_000n, // 5 USDC
      },
    },
    withdrawal: {
      ...marketBase,
      payload: {
        name: "withdrawal",
        to: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        amount: 50_000_000n, // 5 USDC
      },
    },
    withdrawal_pending: {
      ...marketBase,
      payload: {
        name: "withdrawal_pending",
        to: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        amount: 30_000_000n, // 3 USDC
      },
    },

    // ── mimir-squad events ────────────────────────────────────────────────────
    market_created: {
      ...squadBase,
      payload: {
        name: "market_created",
        marketId: 1,
        question: "Will Stellar process 1M Soroban operations in 24 hours?",
        captain: "GDZCB3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        feeBps: 100,
        deadline: 1770000000,
      },
    },
    deposited: {
      ...squadBase,
      payload: {
        name: "deposited",
        marketId: 1,
        side: 1, // Side A
        participant: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        amount: 20_000_000n, // 2 USDC
        shares: 20_000_000n,
      },
    },
    withdrawn: {
      ...squadBase,
      payload: {
        name: "withdrawn",
        marketId: 1,
        side: 1, // Side A
        participant: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        amount: 5_000_000n, // 0.5 USDC
      },
    },
    resolved: {
      ...squadBase,
      payload: {
        name: "resolved",
        marketId: 1,
        result: 1, // Side A
        poolA: 100_000_000n, // 10 USDC
        poolB: 80_000_000n, // 8 USDC
      },
    },
    claimed: {
      ...squadBase,
      payload: {
        name: "claimed",
        marketId: 1,
        participant: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        gross: 50_000_000n, // 5 USDC
        fee: 1_000_000n, // 0.1 USDC
        net: 49_000_000n, // 4.9 USDC
      },
    },
    fees_claimed: {
      ...squadBase,
      payload: {
        name: "fees_claimed",
        recipient: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        amount: 3_000_000n, // 0.3 USDC
      },
    },
  };
}

/** Static default samples for direct import */
export const SAMPLE_EVENTS: Record<SampleEventName, DecodedEvent> = buildSampleEvents();

/** Valid event names that have sample DecodedEvents. */
export const VALID_SAMPLE_NAMES = Object.keys(SAMPLE_EVENTS) as readonly SampleEventName[];
