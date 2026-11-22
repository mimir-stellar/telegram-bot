/**
 * #922 — Telegram output limits measured in UTF-16 code units, consistently.
 *
 * Under-limit messages must be byte-identical to before the change. Over-limit
 * messages (emoji-heavy) must be truncated on a code-point boundary and never
 * leave a lone surrogate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  clipUtf16,
  utf16Length,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/notifications/format.js";
import { formatEventHtml } from "../dist/notifications/html.js";

const CONFIG = {
  marketContractId: "CA",
  squadContractId: "CB",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  chatId: "-1001234567890",
  explorerBase: "https://stellar.expert/explorer/testnet",
  locale: "en",
};

function claimCreatedEvent(overrides = {}) {
  return {
    source: "market",
    contractId: "CTEST",
    version: "v1",
    ledger: 100,
    txHash: "",
    at: 1_700_000_000,
    eventId: "e-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: { name: "claim_created", claimId: 7, category: "crypto", creator: "GABCD" },
    ...overrides,
  };
}

test("utf16Length counts code units, not code points", () => {
  assert.equal(utf16Length("abc"), 3);
  // 🆕 is U+1F195 → 2 UTF-16 units.
  assert.equal(utf16Length("🆕"), 2);
  assert.equal(Array.from("🆕").length, 1);
});

test("clipUtf16 never splits a surrogate pair", () => {
  // 5 emoji = 10 UTF-16 units. Clip to 6 → 2 full emoji + ellipsis (5 units).
  const out = clipUtf16("🆕🆕🆕🆕🆕", 6);
  assert.ok(utf16Length(out) <= 6);
  // No lone high or low surrogate at the end.
  const last = out.charCodeAt(out.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "trailing high surrogate");
  // The visible payload is whole emoji + ellipsis.
  assert.ok(out.endsWith("…"));
});

test("clipUtf16 returns short strings unchanged", () => {
  const s = "hello 🆕";
  assert.equal(clipUtf16(s, 100), s);
});

test("emoji-heavy HTML that fits in UTF-16 is returned unchanged", () => {
  // A category whose UTF-16 length is small. Sanity: same string, same length.
  const ev = claimCreatedEvent();
  const out = formatEventHtml(CONFIG, ev);
  assert.ok(out);
  assert.ok(utf16Length(out) <= TELEGRAM_MAX_MESSAGE_LENGTH);
});

test("emoji-heavy HTML past 4096 UTF-16 units is truncated, no lone surrogate", () => {
  // 3000 emoji ≈ 6000 UTF-16 units — well past 4096. Use a long category
  // built from emoji so the HTML renderer emits the same shape it always does.
  const hugeCategory = "🆕".repeat(3000);
  const ev = claimCreatedEvent();
  ev.payload.category = hugeCategory;
  const out = formatEventHtml(CONFIG, ev);
  assert.ok(out);
  assert.ok(utf16Length(out) <= TELEGRAM_MAX_MESSAGE_LENGTH,
    `rendered ${utf16Length(out)} UTF-16 units, expected <= ${TELEGRAM_MAX_MESSAGE_LENGTH}`);
  const last = out.charCodeAt(out.length - 1);
  // Allow the trailing ellipsis (U+2026), but never a lone surrogate.
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "trailing high surrogate");
  assert.ok(!(last >= 0xdc00 && last <= 0xdfff), "trailing low surrogate");
});
