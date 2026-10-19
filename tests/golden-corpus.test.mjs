/**
 * tests/golden-corpus.test.mjs
 *
 * Golden corpus test for formatEvent and formatPlainTextEvent.
 *
 * Reads every JSON file from tests/fixtures/golden/ and re-renders the
 * stored event with both formatters, then compares against the committed
 * expected outputs.  A mismatch means a formatting change altered an
 * observable notification — either the change is correct (regenerate with
 * `node scripts/gen-golden-corpus.mjs --update`) or it's a regression.
 *
 * Usage
 * ──────
 *   npm test                          # runs as part of the full suite
 *   node --test tests/golden-corpus.test.mjs   # run in isolation
 *
 * To regenerate after an intentional formatting change:
 *   node scripts/gen-golden-corpus.mjs --update
 *   npm test
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { formatEvent, formatPlainTextEvent } from "../dist/notifications/format.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(here, "fixtures", "golden");

// ── Config (same as the generator uses) ──────────────────────────────────────

const CONFIG = {
  chatIds: ["-1001234567890"],
  marketContractId: "CFIXTUREMARKET00000000000000000000000000000000000000000",
  squadContractId: "CFIXTURESQUAD0000000000000000000000000000000000000000000",
  rpcUrl: "https://example.invalid/rpc",
  horizonUrl: "https://example.invalid/horizon",
  networkPassphrase: "Test SDF Network ; September 2015",
};

// ── BigInt hydration ──────────────────────────────────────────────────────────

/**
 * Money keys on decoded payloads — stored as decimal strings in JSON, must be
 * converted back to BigInt before the formatters can use them.
 */
const MONEY_KEYS = new Set([
  "stake",
  "totalPaid",
  "totalFees",
  "owedToChallengers",
  "dust",
  "gross",
  "fee",
  "net",
  "amount",
  "shares",
  "poolA",
  "poolB",
]);

function hydratePayload(payload) {
  const out = { ...payload };
  for (const key of MONEY_KEYS) {
    if (typeof out[key] === "string" && /^-?\d+$/.test(out[key])) {
      out[key] = BigInt(out[key]);
    }
  }
  return out;
}

function hydrateEvent(raw) {
  return { ...raw, payload: hydratePayload(raw.payload) };
}

// ── Load corpus ───────────────────────────────────────────────────────────────

async function loadCorpus() {
  let entries;
  try {
    entries = await readdir(goldenDir);
  } catch {
    throw new Error(
      `Golden corpus directory not found: ${goldenDir}\n` +
        "Run `node scripts/gen-golden-corpus.mjs` to generate fixtures.",
    );
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    throw new Error(
      `No fixture files found in ${goldenDir}.\n` +
        "Run `node scripts/gen-golden-corpus.mjs` to generate fixtures.",
    );
  }

  const corpus = [];
  for (const file of jsonFiles) {
    const raw = await readFile(path.join(goldenDir, file), "utf8");
    const fixture = JSON.parse(raw);
    corpus.push({ id: path.basename(file, ".json"), fixture, file });
  }
  return corpus;
}

// ── Helper: describe a diff clearly ──────────────────────────────────────────

function describeDiff(id, field, expected, actual) {
  return (
    `Golden corpus mismatch for "${id}" (${field}):\n` +
    `  expected: ${JSON.stringify(expected)}\n` +
    `  actual  : ${JSON.stringify(actual)}\n` +
    `\n` +
    `  If this change is intentional, regenerate with:\n` +
    `    node scripts/gen-golden-corpus.mjs --update`
  );
}

// ── Meta tests ────────────────────────────────────────────────────────────────

test("golden corpus: fixtures directory exists and is non-empty", async () => {
  const corpus = await loadCorpus();
  assert.ok(corpus.length > 0, "No golden fixtures found");
});

test("golden corpus: covers every market event name", async () => {
  const corpus = await loadCorpus();
  const names = new Set(corpus.map((c) => c.fixture.event.payload.name));

  const required = [
    "claim_created",
    "claim_challenged",
    "claim_resolved",
    "claim_cancelled",
    "market_settled",
    "challenger_paid",
    "fee_claimed",
    "withdrawal",
    "withdrawal_pending",
  ];

  for (const name of required) {
    assert.ok(names.has(name), `Golden corpus missing market event: ${name}`);
  }
});

test("golden corpus: covers every squad event name", async () => {
  const corpus = await loadCorpus();
  const names = new Set(corpus.map((c) => c.fixture.event.payload.name));

  const required = [
    "market_created",
    "deposited",
    "withdrawn",
    "resolved",
    "claimed",
    "fees_claimed",
  ];

  for (const name of required) {
    assert.ok(names.has(name), `Golden corpus missing squad event: ${name}`);
  }
});

test("golden corpus: includes null-output (skip) cases for admin/unknown events", async () => {
  const corpus = await loadCorpus();
  const nullMd = corpus.filter((c) => c.fixture.md === null);
  assert.ok(
    nullMd.length >= 2,
    `Expected at least 2 skip-output fixtures, found ${nullMd.length}`,
  );
});

test("golden corpus: no fixture embeds real credentials or live endpoints", async () => {
  const corpus = await loadCorpus();
  for (const { id, fixture } of corpus) {
    const blob = JSON.stringify(fixture);
    assert.doesNotMatch(blob, /BOT_TOKEN|ghp_|sk_live/, `${id}: contains credential pattern`);
    assert.doesNotMatch(blob, /api\.telegram\.org/i, `${id}: contains live Telegram URL`);
    assert.doesNotMatch(blob, /mainnet\.stellar\.org/i, `${id}: contains live mainnet URL`);
  }
});

test("golden corpus: generation is deterministic (re-render matches stored output)", async () => {
  const corpus = await loadCorpus();

  for (const { id, fixture } of corpus) {
    const event = hydrateEvent(fixture.event);

    const actualMd = formatEvent(CONFIG, event);
    const actualPlain = formatPlainTextEvent(CONFIG, event);

    assert.equal(
      actualMd,
      fixture.md,
      describeDiff(id, "md", fixture.md, actualMd),
    );

    assert.equal(
      actualPlain,
      fixture.plain,
      describeDiff(id, "plain", fixture.plain, actualPlain),
    );
  }
});

// ── Per-event-type smoke tests ────────────────────────────────────────────────
// These verify that notifiable events produce non-null, non-empty strings and
// that skippable events correctly produce null.

test("golden corpus: all notifiable fixtures produce non-empty md and plain strings", async () => {
  const corpus = await loadCorpus();
  const notifiable = corpus.filter((c) => c.fixture.md !== null);

  assert.ok(notifiable.length > 0, "No notifiable fixtures found");

  for (const { id, fixture } of notifiable) {
    assert.equal(typeof fixture.md, "string", `${id}: md should be a string`);
    assert.ok(fixture.md.length > 0, `${id}: md should not be empty`);
    assert.equal(typeof fixture.plain, "string", `${id}: plain should be a string`);
    assert.ok(fixture.plain.length > 0, `${id}: plain should not be empty`);
  }
});

test("golden corpus: skip fixtures return null for both md and plain", async () => {
  const corpus = await loadCorpus();
  const skips = corpus.filter((c) => c.fixture.md === null);

  for (const { id, fixture } of skips) {
    assert.equal(fixture.md, null, `${id}: expected md to be null`);
    assert.equal(fixture.plain, null, `${id}: expected plain to be null`);
  }
});

test("golden corpus: md output for each notifiable fixture starts with a known emoji", async () => {
  const corpus = await loadCorpus();

  // Every notifiable event type maps to a specific leading emoji defined in
  // NOTIFICATION_MD.  Checking this ensures the correct template branch fired.
  const EMOJI_BY_EVENT = {
    claim_created: "🆕",
    claim_challenged: "⚔️",
    claim_resolved: "⚖️",
    claim_cancelled: "🚫",
    market_settled: "💰",
    challenger_paid: "🏆",
    fee_claimed: "🧾",
    withdrawal: "📤",
    withdrawal_pending: "⏳",
    market_created: "🆕",
    deposited: "➕",
    withdrawn: "➖",
    resolved: "🏁",
    claimed: "💸",
    fees_claimed: "🧾",
  };

  for (const { id, fixture } of corpus) {
    if (fixture.md === null) continue;
    const name = fixture.event.payload.name;
    const expected = EMOJI_BY_EVENT[name];
    if (!expected) continue; // unknown/admin — no expectation
    assert.ok(
      fixture.md.startsWith(expected),
      `${id}: expected md to start with ${expected}, got: ${fixture.md.slice(0, 10)}`,
    );
  }
});

test("golden corpus: plain output contains no MarkdownV2 backslash escape sequences", async () => {
  const corpus = await loadCorpus();

  // The plain formatter must never emit backslash-escape sequences like \. or \*
  // because plain output is sent to Telegram without parse_mode and those
  // backslashes would appear literally in the chat message.
  const MD_ESCAPE = /\\[_*[\]()~`>#+\-=|{}.!\\]/;

  for (const { id, fixture } of corpus) {
    if (fixture.plain === null) continue;
    assert.doesNotMatch(
      fixture.plain,
      MD_ESCAPE,
      `${id}: plain output contains a MarkdownV2 backslash-escape sequence`,
    );
  }
});

test("golden corpus: md and plain outputs for the same event carry the same key values", async () => {
  const corpus = await loadCorpus();

  for (const { id, fixture } of corpus) {
    if (fixture.md === null || fixture.plain === null) continue;

    // Both outputs should reference the same claimId / marketId number
    const p = fixture.event.payload;
    const numericId = p.claimId ?? p.marketId;
    if (numericId !== undefined) {
      assert.ok(
        fixture.md.includes(String(numericId)),
        `${id}: md missing claim/market id ${numericId}`,
      );
      assert.ok(
        fixture.plain.includes(String(numericId)),
        `${id}: plain missing claim/market id ${numericId}`,
      );
    }
  }
});
