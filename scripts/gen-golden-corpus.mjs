#!/usr/bin/env node
/**
 * scripts/gen-golden-corpus.mjs
 *
 * Generates tests/fixtures/golden/<event>.json for every market and squad
 * event type, covering typical values and a comprehensive set of edge
 * payloads (max amounts, zero amounts, empty strings, hostile MarkdownV2
 * text, missing optional fields, every enum variant, etc.).
 *
 * Each fixture file is a JSON object:
 *   {
 *     "event":  <DecodedEvent with bigint amounts as decimal strings>,
 *     "md":     <string | null>,   // output of formatEvent
 *     "plain":  <string | null>    // output of formatPlainTextEvent
 *   }
 *
 * Usage
 * ──────
 *   # First run – write all fixtures
 *   node scripts/gen-golden-corpus.mjs
 *
 *   # Re-generate after a formatting change
 *   node scripts/gen-golden-corpus.mjs --update
 *
 * The script is deterministic: the same source code always produces the same
 * files. Running it twice without --update on an unchanged codebase is a no-op.
 *
 * Exit codes
 *   0  All fixtures written (or already up-to-date with --update).
 *   1  One or more fixtures exist but differ from the generated output and
 *      --update was NOT passed.  Run with --update to accept the new output.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";

// ── Config ────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = path.join(root, "tests", "fixtures", "golden");

/** Shared config used for every render call.  No real endpoints or secrets. */
const CONFIG = {
  chatIds: ["-1001234567890"],
  marketContractId: "CFIXTUREMARKET00000000000000000000000000000000000000000",
  squadContractId: "CFIXTURESQUAD0000000000000000000000000000000000000000000",
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
};

// ── Fixture addresses ─────────────────────────────────────────────────────────

/** 56-character Stellar address used as a generic actor. */
const ADDR_A = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
/** Second address for two-party events. */
const ADDR_B = "GCAPTAINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ── USDC atom constants (7 decimals) ─────────────────────────────────────────

const USDC = 10_000_000n;          // 1.0000000 USDC
const MAX_AMOUNT = 9_999_999_999_999n; // ~999 999.9999999 USDC (large but < i128 max)

// ── EventMeta defaults ────────────────────────────────────────────────────────

function marketMeta(ledger) {
  return {
    source: "market",
    contractId: CONFIG.marketContractId,
    version: "v1",
    ledger,
    txHash: "",
    at: 1_724_000_000 + ledger,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: null,
    operationIndex: null,
    inSuccessfulContractCall: null,
  };
}

function squadMeta(ledger) {
  return {
    ...marketMeta(ledger),
    source: "squad",
    contractId: CONFIG.squadContractId,
  };
}

// ── BigInt serialisation ──────────────────────────────────────────────────────

/**
 * JSON.stringify replacer that converts BigInt values to decimal strings so the
 * fixture files are valid JSON.  The test runner re-hydrates them with BigInt().
 */
function bigintReplacer(_key, value) {
  return typeof value === "bigint" ? String(value) : value;
}

// ── Matrix definition ─────────────────────────────────────────────────────────
//
// Each entry is { id, event } where `event` is a plain JS object with BigInt
// amounts (not strings — the renderer needs real BigInts).
//
// IDs are <event_name>__<variant> — double underscore separates event name from
// variant so the test file can group by event name easily.

let ledger = 5_000; // starting ledger counter – increment per entry for uniqueness

function nextLedger() {
  return ledger++;
}

const matrix = [
  // ── claim_created ───────────────────────────────────────────────────────────

  {
    id: "claim_created__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_created",
        claimId: 1,
        creator: ADDR_A,
        category: "crypto",
      },
    },
  },
  {
    id: "claim_created__empty_category",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_created",
        claimId: 2,
        creator: ADDR_A,
        category: "",
      },
    },
  },
  {
    id: "claim_created__hostile_md_category",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_created",
        claimId: 3,
        creator: ADDR_A,
        // Contains every MarkdownV2 reserved character
        category: "*bold* _italic_ `code` [link](url) ~strike~ >quote .!-",
      },
    },
  },
  {
    id: "claim_created__long_category",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_created",
        claimId: 4,
        creator: ADDR_A,
        // 300 chars — should be clipped to 199 chars + "…" by clip()
        category: "x".repeat(300),
      },
    },
  },
  {
    id: "claim_created__unicode_category",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_created",
        claimId: 5,
        creator: ADDR_B,
        category: "🚀 crypto & DeFi — 星 한국어",
      },
    },
  },

  // ── claim_challenged ────────────────────────────────────────────────────────

  {
    id: "claim_challenged__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_challenged",
        claimId: 10,
        challenger: ADDR_A,
        stake: 2n * USDC,
      },
    },
  },
  {
    id: "claim_challenged__max_stake",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_challenged",
        claimId: 11,
        challenger: ADDR_A,
        stake: MAX_AMOUNT,
      },
    },
  },
  {
    id: "claim_challenged__one_atom",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_challenged",
        claimId: 12,
        challenger: ADDR_B,
        stake: 1n, // smallest representable non-zero amount
      },
    },
  },
  {
    id: "claim_challenged__zero_stake",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_challenged",
        claimId: 13,
        challenger: ADDR_A,
        stake: 0n,
      },
    },
  },

  // ── claim_resolved ──────────────────────────────────────────────────────────

  {
    id: "claim_resolved__challengers_with_summary",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 20,
        winnerSide: 2, // challengers
        summary: "Onchain data confirms the claim — challengers win.",
        confidence: 95,
        evidenceHash: "deadbeef01234567",
      },
    },
  },
  {
    id: "claim_resolved__creator_no_summary",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 21,
        winnerSide: 1, // creator
        summary: "",   // empty string — no summary line expected
        confidence: 100,
        evidenceHash: "cafecafe",
      },
    },
  },
  {
    id: "claim_resolved__draw",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 22,
        winnerSide: 3, // draw
        summary: "Evidence equally supports both sides.",
        confidence: 50,
        evidenceHash: "aaaabbbb",
      },
    },
  },
  {
    id: "claim_resolved__unresolved",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 23,
        winnerSide: 0, // unresolved
        summary: "",
        confidence: 0,
        evidenceHash: "",
      },
    },
  },
  {
    id: "claim_resolved__unresolvable",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 24,
        winnerSide: 4, // unresolvable
        summary: "",
        confidence: 0,
        evidenceHash: "",
      },
    },
  },
  {
    id: "claim_resolved__hostile_summary",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 25,
        winnerSide: 2,
        // Summary with reserved MarkdownV2 chars — must be escaped in md output
        summary: "Result: *yes* (confidence_high). See [evidence](https://example.com).",
        confidence: 99,
        evidenceHash: "ff00ff00",
      },
    },
  },
  {
    id: "claim_resolved__long_summary",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "claim_resolved",
        claimId: 26,
        winnerSide: 1,
        // 400 chars — should be clipped to 199 + "…"
        summary: "s".repeat(400),
        confidence: 75,
        evidenceHash: "00aabb",
      },
    },
  },

  // ── claim_cancelled ─────────────────────────────────────────────────────────

  {
    id: "claim_cancelled__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "claim_cancelled", claimId: 30 },
    },
  },
  {
    id: "claim_cancelled__id_zero",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "claim_cancelled", claimId: 0 },
    },
  },
  {
    id: "claim_cancelled__large_id",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "claim_cancelled", claimId: 4_294_967_295 }, // u32::MAX
    },
  },

  // ── market_settled ──────────────────────────────────────────────────────────

  {
    id: "market_settled__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "market_settled",
        claimId: 40,
        totalPaid: 18n * USDC,
        totalFees: 2n * USDC,
        owedToChallengers: 16n * USDC,
        dust: 0n,
      },
    },
  },
  {
    id: "market_settled__with_dust",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "market_settled",
        claimId: 41,
        totalPaid: 100n * USDC + 3n,      // leaves a dust remainder
        totalFees: 10n * USDC,
        owedToChallengers: 90n * USDC,
        dust: 3n,
      },
    },
  },
  {
    id: "market_settled__zero_fees",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "market_settled",
        claimId: 42,
        totalPaid: 50n * USDC,
        totalFees: 0n,
        owedToChallengers: 50n * USDC,
        dust: 0n,
      },
    },
  },
  {
    id: "market_settled__max_amounts",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "market_settled",
        claimId: 43,
        totalPaid: MAX_AMOUNT,
        totalFees: MAX_AMOUNT / 10n,
        owedToChallengers: MAX_AMOUNT - MAX_AMOUNT / 10n,
        dust: 7n,
      },
    },
  },

  // ── challenger_paid ─────────────────────────────────────────────────────────

  {
    id: "challenger_paid__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "challenger_paid",
        claimId: 50,
        challenger: ADDR_A,
        stake: 2n * USDC,
        gross: 38n * USDC / 10n,
        fee: 2n * USDC / 10n,
        net: 36n * USDC / 10n,
      },
    },
  },
  {
    id: "challenger_paid__zero_fee",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "challenger_paid",
        claimId: 51,
        challenger: ADDR_B,
        stake: 5n * USDC,
        gross: 10n * USDC,
        fee: 0n,
        net: 10n * USDC,
      },
    },
  },
  {
    id: "challenger_paid__net_equals_gross",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "challenger_paid",
        claimId: 52,
        challenger: ADDR_A,
        stake: 1n * USDC,
        gross: 1n * USDC,
        fee: 0n,
        net: 1n * USDC,
      },
    },
  },
  {
    id: "challenger_paid__max_amounts",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "challenger_paid",
        claimId: 53,
        challenger: ADDR_A,
        stake: MAX_AMOUNT,
        gross: MAX_AMOUNT * 2n,
        fee: MAX_AMOUNT / 10n,
        net: MAX_AMOUNT * 2n - MAX_AMOUNT / 10n,
      },
    },
  },

  // ── fee_claimed ─────────────────────────────────────────────────────────────

  {
    id: "fee_claimed__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "fee_claimed", recipient: ADDR_A, amount: 5n * USDC / 10n },
    },
  },
  {
    id: "fee_claimed__zero",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "fee_claimed", recipient: ADDR_A, amount: 0n },
    },
  },
  {
    id: "fee_claimed__max",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "fee_claimed", recipient: ADDR_B, amount: MAX_AMOUNT },
    },
  },

  // ── withdrawal ──────────────────────────────────────────────────────────────

  {
    id: "withdrawal__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "withdrawal", to: ADDR_A, amount: 5n * USDC },
    },
  },
  {
    id: "withdrawal__one_atom",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "withdrawal", to: ADDR_B, amount: 1n },
    },
  },
  {
    id: "withdrawal__max",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "withdrawal", to: ADDR_A, amount: MAX_AMOUNT },
    },
  },

  // ── withdrawal_pending ──────────────────────────────────────────────────────

  {
    id: "withdrawal_pending__typical",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "withdrawal_pending", to: ADDR_A, amount: 3n * USDC },
    },
  },
  {
    id: "withdrawal_pending__zero",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "withdrawal_pending", to: ADDR_B, amount: 0n },
    },
  },
  {
    id: "withdrawal_pending__max",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "withdrawal_pending", to: ADDR_A, amount: MAX_AMOUNT },
    },
  },

  // ── squad: market_created ───────────────────────────────────────────────────

  {
    id: "squad_market_created__typical",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "market_created",
        marketId: 1,
        captain: ADDR_A,
        deadline: 1_730_000_000,
        feeBps: 100,
        question: "Will BTC hit 100k by end of year?",
      },
    },
  },
  {
    id: "squad_market_created__hostile_question",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "market_created",
        marketId: 2,
        captain: ADDR_B,
        deadline: 1_730_000_000,
        feeBps: 0,
        question: "Will *price* reach $100 (see [chart](url))? — `yes` or _no_.",
      },
    },
  },
  {
    id: "squad_market_created__zero_fee",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "market_created",
        marketId: 3,
        captain: ADDR_A,
        deadline: 1_000_000_000,
        feeBps: 0,
        question: "Zero fee market",
      },
    },
  },
  {
    id: "squad_market_created__max_fee",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "market_created",
        marketId: 4,
        captain: ADDR_A,
        deadline: 1_730_000_000,
        feeBps: 10_000, // 100%
        question: "Max fee market",
      },
    },
  },
  {
    id: "squad_market_created__long_question",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "market_created",
        marketId: 5,
        captain: ADDR_B,
        deadline: 1_730_000_000,
        feeBps: 50,
        question: "Q".repeat(300), // should be clipped
      },
    },
  },

  // ── squad: deposited ────────────────────────────────────────────────────────

  {
    id: "squad_deposited__side_a",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "deposited",
        marketId: 1,
        side: 1, // Side A
        participant: ADDR_A,
        amount: 2n * USDC,
        shares: 2n * USDC,
      },
    },
  },
  {
    id: "squad_deposited__side_b",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "deposited",
        marketId: 1,
        side: 2, // Side B
        participant: ADDR_B,
        amount: 1n * USDC,
        shares: 1n * USDC,
      },
    },
  },
  {
    id: "squad_deposited__max_amount",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "deposited",
        marketId: 2,
        side: 1,
        participant: ADDR_A,
        amount: MAX_AMOUNT,
        shares: MAX_AMOUNT,
      },
    },
  },
  {
    id: "squad_deposited__one_atom",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "deposited",
        marketId: 3,
        side: 2,
        participant: ADDR_B,
        amount: 1n,
        shares: 1n,
      },
    },
  },

  // ── squad: withdrawn ────────────────────────────────────────────────────────

  {
    id: "squad_withdrawn__side_a",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "withdrawn",
        marketId: 1,
        side: 1, // Side A
        participant: ADDR_A,
        amount: 5n * USDC / 10n,
      },
    },
  },
  {
    id: "squad_withdrawn__side_b",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "withdrawn",
        marketId: 1,
        side: 2, // Side B
        participant: ADDR_B,
        amount: 1n * USDC,
      },
    },
  },
  {
    id: "squad_withdrawn__max_amount",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "withdrawn",
        marketId: 2,
        side: 1,
        participant: ADDR_A,
        amount: MAX_AMOUNT,
      },
    },
  },

  // ── squad: resolved ─────────────────────────────────────────────────────────

  {
    id: "squad_resolved__side_a_wins",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "resolved",
        marketId: 1,
        result: 1, // Side A
        poolA: 10n * USDC,
        poolB: 8n * USDC,
      },
    },
  },
  {
    id: "squad_resolved__side_b_wins",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "resolved",
        marketId: 2,
        result: 2, // Side B
        poolA: 5n * USDC,
        poolB: 9n * USDC,
      },
    },
  },
  {
    id: "squad_resolved__cancelled",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "resolved",
        marketId: 3,
        result: 3, // cancelled
        poolA: 20n * USDC,
        poolB: 15n * USDC,
      },
    },
  },
  {
    id: "squad_resolved__equal_pools",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "resolved",
        marketId: 4,
        result: 1,
        poolA: 50n * USDC,
        poolB: 50n * USDC,
      },
    },
  },
  {
    id: "squad_resolved__zero_pools",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "resolved",
        marketId: 5,
        result: 3,
        poolA: 0n,
        poolB: 0n,
      },
    },
  },

  // ── squad: claimed ──────────────────────────────────────────────────────────

  {
    id: "squad_claimed__typical",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "claimed",
        marketId: 1,
        participant: ADDR_A,
        gross: 5n * USDC,
        fee: 1n * USDC / 10n,
        net: 49n * USDC / 10n,
      },
    },
  },
  {
    id: "squad_claimed__zero_fee",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "claimed",
        marketId: 2,
        participant: ADDR_B,
        gross: 3n * USDC,
        fee: 0n,
        net: 3n * USDC,
      },
    },
  },
  {
    id: "squad_claimed__max",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "claimed",
        marketId: 3,
        participant: ADDR_A,
        gross: MAX_AMOUNT,
        fee: MAX_AMOUNT / 20n,
        net: MAX_AMOUNT - MAX_AMOUNT / 20n,
      },
    },
  },

  // ── squad: fees_claimed ─────────────────────────────────────────────────────

  {
    id: "squad_fees_claimed__typical",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "fees_claimed",
        recipient: ADDR_A,
        amount: 3n * USDC / 10n,
      },
    },
  },
  {
    id: "squad_fees_claimed__zero",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "fees_claimed",
        recipient: ADDR_B,
        amount: 0n,
      },
    },
  },
  {
    id: "squad_fees_claimed__max",
    event: {
      ...squadMeta(nextLedger()),
      payload: {
        name: "fees_claimed",
        recipient: ADDR_A,
        amount: MAX_AMOUNT,
      },
    },
  },

  // ── skip / null-output cases ────────────────────────────────────────────────
  // These cover event names for which both formatEvent and formatPlainTextEvent
  // must return null (admin events, unknown shapes).

  {
    id: "unknown__skip",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "unknown", eventName: "oracle_changed", reason: "admin event" },
    },
  },
  {
    id: "unknown__malformed",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "unknown", eventName: "claim_challenged", reason: "malformed amount" },
    },
  },
  {
    id: "admin__oracle_changed",
    event: {
      ...marketMeta(nextLedger()),
      payload: { name: "oracle_changed", newOracle: ADDR_A, details: {} },
    },
  },
  {
    id: "admin__ownership_transferred",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "ownership_transferred",
        previousOwner: ADDR_A,
        newOwner: ADDR_B,
        details: {},
      },
    },
  },
  {
    id: "admin__fee_accrued",
    event: {
      ...marketMeta(nextLedger()),
      payload: {
        name: "fee_accrued",
        recipient: ADDR_A,
        amount: 5n * USDC,
        details: {},
      },
    },
  },
];

// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Render one fixture entry: call both formatters and return a plain object
 * ready for JSON serialisation.
 */
function render(entry) {
  const md = formatEvent(CONFIG, entry.event);
  const plain = formatPlainTextEvent(CONFIG, entry.event);
  return {
    event: entry.event,
    md,
    plain,
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────

const UPDATE = process.argv.includes("--update");

async function run() {
  await mkdir(outDir, { recursive: true });

  let driftCount = 0;

  for (const entry of matrix) {
    const rendered = render(entry);
    const outPath = path.join(outDir, `${entry.id}.json`);
    const newContent = JSON.stringify(rendered, bigintReplacer, 2) + "\n";

    if (!UPDATE && existsSync(outPath)) {
      const existing = await readFile(outPath, "utf8");
      if (existing !== newContent) {
        console.error(
          `DRIFT: ${entry.id}.json differs from generated output.\n` +
            `       Run with --update to accept the new output.\n` +
            `       Existing:\n${existing.slice(0, 300)}\n` +
            `       Generated:\n${newContent.slice(0, 300)}`,
        );
        driftCount++;
      }
      continue;
    }

    await writeFile(outPath, newContent, "utf8");
    console.log(`wrote ${path.relative(root, outPath)}`);
  }

  if (driftCount > 0) {
    console.error(`\n${driftCount} fixture(s) drifted. Re-run with --update to accept changes.`);
    process.exitCode = 1;
  } else {
    const total = matrix.length;
    const eventNames = new Set(matrix.map((e) => e.event.payload.name));
    console.log(`\nCorpus: ${total} fixtures across ${eventNames.size} event types.`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
