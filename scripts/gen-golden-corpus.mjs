/**
 * Generate golden corpus fixtures for all Mimir contract events across edge-case payloads.
 * Closes #526.
 *
 * Usage:
 *   node scripts/gen-golden-corpus.mjs
 *   node scripts/gen-golden-corpus.mjs --update
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, "../tests/fixtures/golden");

export const GOLDEN_CONFIG = {
  network: "testnet",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
  squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
};

const CREATOR = "GCATS35LUSYNDL4OHZJ5Z6R4LBNJ77L5G6Z5P2Y5GCP76C4T5P5I55U";
const CHALLENGER = "GCLJODG4L36N3Y4435S2F36Z5V57J3446T5Z7K5P7C6S5G5B7C6HFA5";
const CAPTAIN = "GB72Z4LBNJ77L5G6Z5P2Y5GCP76C4T5P5I55UGCLJODG4L36N3Y4435S";
const PARTICIPANT = "GAPARTICIPANT7L5G6Z5P2Y5GCP76C4T5P5I55UGCLJODG4L36N3Y443";
const RECIPIENT = "GDFEEADDR77L5G6Z5P2Y5GCP76C4T5P5I55UGCLJODG4L36N3Y4435S";
const TX_HASH = "2b386012af5ccc719db70a47b2f8cc486099de023055375f1b212f45ff53018e";

const MONEY_KEYS = new Set([
  "stake", "totalPaid", "totalFees", "owedToChallengers", "dust",
  "gross", "fee", "net", "amount", "shares", "poolA", "poolB",
]);

export function hydratePayload(payload) {
  const out = { ...payload };
  for (const key of MONEY_KEYS) {
    if (typeof out[key] === "string" && /^-?\d+$/.test(out[key])) {
      out[key] = BigInt(out[key]);
    }
  }
  return out;
}

export function hydrateEvent(raw) {
  return {
    ...raw,
    payload: hydratePayload(raw.payload),
  };
}

export const EVENT_DEFINITIONS = [
  // ── Market events ────────────────────────────────────────────────────────
  {
    name: "claim_created",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Typical claim created in crypto category",
        payload: { name: "claim_created", claimId: 42, category: "crypto", creator: CREATOR },
        txHash: TX_HASH,
        ledger: 1000,
      },
      {
        caseId: "empty_category",
        description: "Empty category string",
        payload: { name: "claim_created", claimId: 1, category: "", creator: CREATOR },
        txHash: TX_HASH,
        ledger: 1001,
      },
      {
        caseId: "hostile_characters",
        description: "Category with MarkdownV2 special chars",
        payload: { name: "claim_created", claimId: 999, category: "DeFi_v2*beta*[test]~`>#+-=|{}.!", creator: CREATOR },
        txHash: TX_HASH,
        ledger: 1002,
      },
      {
        caseId: "oversized_category",
        description: "Category exceeding 200 chars to test clipping",
        payload: { name: "claim_created", claimId: 1000, category: "A".repeat(250), creator: CREATOR },
        txHash: TX_HASH,
        ledger: 1003,
      },
      {
        caseId: "no_tx_hash",
        description: "Missing transaction hash (no explorer URL)",
        payload: { name: "claim_created", claimId: 5, category: "sports", creator: CREATOR },
        txHash: "",
        ledger: 1004,
      },
    ],
  },
  {
    name: "claim_challenged",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Standard claim challenged with typical stake",
        payload: { name: "claim_challenged", claimId: 42, stake: 25_000_000n, challenger: CHALLENGER },
        txHash: TX_HASH,
        ledger: 1010,
      },
      {
        caseId: "zero_stake",
        description: "Zero stake challenge",
        payload: { name: "claim_challenged", claimId: 43, stake: 0n, challenger: CHALLENGER },
        txHash: TX_HASH,
        ledger: 1011,
      },
      {
        caseId: "max_stake",
        description: "High maximum USDC stake",
        payload: { name: "claim_challenged", claimId: 44, stake: 100_000_000_000_000n, challenger: CHALLENGER },
        txHash: TX_HASH,
        ledger: 1012,
      },
    ],
  },
  {
    name: "claim_resolved",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical_creator_win",
        description: "Creator wins with high confidence and summary",
        payload: { name: "claim_resolved", claimId: 42, winnerSide: "creator", confidence: 95, summary: "Oracle verified truth" },
        txHash: TX_HASH,
        ledger: 1020,
      },
      {
        caseId: "challenger_win_no_summary",
        description: "Challenger wins with null summary",
        payload: { name: "claim_resolved", claimId: 43, winnerSide: "challenger", confidence: 80, summary: null },
        txHash: TX_HASH,
        ledger: 1021,
      },
      {
        caseId: "hostile_summary",
        description: "Summary with Markdown reserved chars",
        payload: { name: "claim_resolved", claimId: 44, winnerSide: 1, confidence: 100, summary: "*Resolution* confirmed (100%) -> [OK]!" },
        txHash: TX_HASH,
        ledger: 1022,
      },
      {
        caseId: "oversized_summary",
        description: "Summary exceeding max length for clipping",
        payload: { name: "claim_resolved", claimId: 45, winnerSide: 2, confidence: 90, summary: "Result: " + "X".repeat(250) },
        txHash: TX_HASH,
        ledger: 1023,
      },
    ],
  },
  {
    name: "claim_cancelled",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Claim cancelled normally",
        payload: { name: "claim_cancelled", claimId: 42 },
        txHash: TX_HASH,
        ledger: 1030,
      },
      {
        caseId: "max_id",
        description: "Large claimId value",
        payload: { name: "claim_cancelled", claimId: 999999999 },
        txHash: TX_HASH,
        ledger: 1031,
      },
    ],
  },
  {
    name: "market_settled",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Market settled with typical numbers",
        payload: { name: "market_settled", claimId: 42, totalPaid: 100_000_000n, totalFees: 5_000_000n, owedToChallengers: 95_000_000n },
        txHash: TX_HASH,
        ledger: 1040,
      },
      {
        caseId: "zero_amounts",
        description: "Market settled with all zero amounts",
        payload: { name: "market_settled", claimId: 43, totalPaid: 0n, totalFees: 0n, owedToChallengers: 0n },
        txHash: TX_HASH,
        ledger: 1041,
      },
    ],
  },
  {
    name: "challenger_paid",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Challenger paid with net, gross, and fee",
        payload: {
          name: "challenger_paid",
          claimId: 42,
          challenger: CHALLENGER,
          stake: 20_000_000n,
          gross: 38_000_000n,
          fee: 1_900_000n,
          net: 36_100_000n,
        },
        txHash: TX_HASH,
        ledger: 1050,
      },
      {
        caseId: "zero_fee",
        description: "Challenger paid with zero fee",
        payload: {
          name: "challenger_paid",
          claimId: 43,
          challenger: CHALLENGER,
          stake: 10_000_000n,
          gross: 20_000_000n,
          fee: 0n,
          net: 20_000_000n,
        },
        txHash: TX_HASH,
        ledger: 1051,
      },
    ],
  },
  {
    name: "fee_claimed",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Market fee claimed by recipient",
        payload: { name: "fee_claimed", amount: 15_000_000n, recipient: RECIPIENT },
        txHash: TX_HASH,
        ledger: 1060,
      },
      {
        caseId: "fractional_usdc",
        description: "Small fractional USDC fee claimed",
        payload: { name: "fee_claimed", amount: 12345n, recipient: RECIPIENT },
        txHash: TX_HASH,
        ledger: 1061,
      },
    ],
  },
  {
    name: "withdrawal",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Typical market withdrawal",
        payload: { name: "withdrawal", amount: 50_000_000n, to: CREATOR },
        txHash: TX_HASH,
        ledger: 1070,
      },
      {
        caseId: "max_amount",
        description: "Large market withdrawal",
        payload: { name: "withdrawal", amount: 999_999_999_000_000n, to: CREATOR },
        txHash: TX_HASH,
        ledger: 1071,
      },
    ],
  },
  {
    name: "withdrawal_pending",
    source: "market",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Pending withdrawal notification",
        payload: { name: "withdrawal_pending", amount: 25_000_000n, to: CREATOR },
        txHash: TX_HASH,
        ledger: 1080,
      },
    ],
  },

  // ── Squad events ──────────────────────────────────────────────────────────
  {
    name: "market_created",
    source: "squad",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Squad market created with deadline",
        payload: {
          name: "market_created",
          marketId: 101,
          question: "Will Stellar protocol 22 activate in 2026?",
          captain: CAPTAIN,
          feeBps: 250,
          deadline: 1800000000,
        },
        txHash: TX_HASH,
        ledger: 2000,
      },
      {
        caseId: "hostile_question",
        description: "Question with MarkdownV2 reserved characters",
        payload: {
          name: "market_created",
          marketId: 102,
          question: "BTC > $100k? [Yes/No] *Important* (2026+)! ~Test~",
          captain: CAPTAIN,
          feeBps: 100,
          deadline: 1800000000,
        },
        txHash: TX_HASH,
        ledger: 2001,
      },
      {
        caseId: "oversized_question",
        description: "Question exceeding 200 characters",
        payload: {
          name: "market_created",
          marketId: 103,
          question: "Question: " + "Q".repeat(250),
          captain: CAPTAIN,
          feeBps: 500,
          deadline: 1800000000,
        },
        txHash: TX_HASH,
        ledger: 2002,
      },
    ],
  },
  {
    name: "deposited",
    source: "squad",
    buildCases: () => [
      {
        caseId: "typical_side_a",
        description: "Deposit on side A",
        payload: { name: "deposited", marketId: 101, amount: 50_000_000n, side: "A", participant: PARTICIPANT },
        txHash: TX_HASH,
        ledger: 2010,
      },
      {
        caseId: "typical_side_b",
        description: "Deposit on side B",
        payload: { name: "deposited", marketId: 101, amount: 75_000_000n, side: "B", participant: PARTICIPANT },
        txHash: TX_HASH,
        ledger: 2011,
      },
    ],
  },
  {
    name: "withdrawn",
    source: "squad",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Withdrawal from squad market side A",
        payload: { name: "withdrawn", marketId: 101, participant: PARTICIPANT, amount: 30_000_000n, side: "A" },
        txHash: TX_HASH,
        ledger: 2020,
      },
    ],
  },
  {
    name: "resolved",
    source: "squad",
    buildCases: () => [
      {
        caseId: "typical_side_a_win",
        description: "Squad market resolved for side A",
        payload: { name: "resolved", marketId: 101, result: "A", poolA: 500_000_000n, poolB: 300_000_000n },
        txHash: TX_HASH,
        ledger: 2030,
      },
      {
        caseId: "typical_side_b_win",
        description: "Squad market resolved for side B",
        payload: { name: "resolved", marketId: 102, result: "B", poolA: 200_000_000n, poolB: 600_000_000n },
        txHash: TX_HASH,
        ledger: 2031,
      },
    ],
  },
  {
    name: "claimed",
    source: "squad",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Participant claims payout from resolved squad market",
        payload: {
          name: "claimed",
          marketId: 101,
          participant: PARTICIPANT,
          gross: 85_000_000n,
          fee: 2_125_000n,
          net: 82_875_000n,
        },
        txHash: TX_HASH,
        ledger: 2040,
      },
    ],
  },
  {
    name: "fees_claimed",
    source: "squad",
    buildCases: () => [
      {
        caseId: "typical",
        description: "Squad fee claimed by recipient",
        payload: { name: "fees_claimed", amount: 12_500_000n, recipient: RECIPIENT },
        txHash: TX_HASH,
        ledger: 2050,
      },
    ],
  },
];

export async function generateGoldenCorpus() {
  await mkdir(GOLDEN_DIR, { recursive: true });
  console.log(`Generating golden corpus for ${EVENT_DEFINITIONS.length} event types...`);

  for (const def of EVENT_DEFINITIONS) {
    const rawCases = def.buildCases();
    const cases = rawCases.map((c) => {
      const event = {
        source: def.source,
        ledger: c.ledger,
        txHash: c.txHash,
        eventId: `${BigInt(c.ledger) << 32n}-0`,
        payload: c.payload,
      };

      const markdownOutput = formatEvent(GOLDEN_CONFIG, event);
      const plainOutput = formatPlainTextEvent(GOLDEN_CONFIG, event);

      return {
        caseId: c.caseId,
        description: c.description,
        event: {
          ...event,
          payload: Object.fromEntries(
            Object.entries(c.payload).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
          ),
        },
        expectedMarkdown: markdownOutput,
        expectedPlain: plainOutput,
      };
    });

    const fileContent = JSON.stringify(
      {
        eventName: def.name,
        source: def.source,
        cases,
      },
      null,
      2
    ) + "\n";

    const targetPath = path.join(GOLDEN_DIR, `${def.name}.json`);
    await writeFile(targetPath, fileContent, "utf8");
    console.log(`- Wrote ${def.name}.json (${cases.length} cases)`);
  }

  console.log("Golden corpus generation complete!");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  generateGoldenCorpus().catch((err) => {
    console.error("Failed to generate golden corpus:", err);
    process.exit(1);
  });
}
