/**
 * tests/digest-pages.test.mjs
 *
 * Focused tests for bounded digest continuation pages (`formatDigestPages`):
 * - Empty input and single-page backward compatibility with `formatDigest`
 * - Deterministic multi-page splitting on complete event summaries (flat & grouped)
 * - Stable total event count across all continuation pages
 * - Grouped continuation semantics (no orphaned group headers; repeated headers on continuation)
 * - Multi-digit page count boundary (`>= 10` pages) and default 4096-char Telegram bound
 * - Failure / boundary cases (invalid `maxLength`, `maxLength` too small for a complete summary)
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDigest,
  formatDigestPages,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/notifications/format.js";

function makeEvent(overrides = {}) {
  return {
    source: "market",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 1000,
    txHash: "0".repeat(64),
    at: 1700000000,
    eventId: "evt-1",
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: { name: "claim_created", claimId: 1, creator: "G1", category: "crypto" },
    ...overrides,
  };
}

function eventLinesFromPages(pages) {
  const lines = [];
  for (const page of pages) {
    for (const line of page.split("\n")) {
      if (line.trimStart().startsWith("· ")) {
        lines.push(line.trimStart());
      }
    }
  }
  return lines;
}

test("formatDigestPages: returns empty array for empty events", () => {
  assert.deepEqual(formatDigestPages([]), []);
  assert.deepEqual(formatDigestPages([], { grouped: true, maxLength: 300 }), []);
});

test("formatDigestPages: single-page output matches formatDigest exactly (flat and grouped)", () => {
  const events = [
    makeEvent({ eventId: "e1", ledger: 1000, payload: { name: "claim_created", claimId: 1, creator: "G1", category: "crypto" } }),
    makeEvent({ eventId: "e2", ledger: 1001, payload: { name: "claim_challenged", claimId: 1, challenger: "G2", stake: 10_000_000n } }),
  ];

  assert.deepEqual(formatDigestPages(events), [formatDigest(events)]);
  assert.deepEqual(
    formatDigestPages(events, { grouped: true }),
    [formatDigest(events, { grouped: true })],
  );
});

test("formatDigestPages: flat mode splits on complete event summaries with stable event count", () => {
  const events = Array.from({ length: 12 }, (_, i) =>
    makeEvent({
      eventId: `evt-${i + 1}`,
      ledger: 2000 + i,
      payload: { name: "claim_created", claimId: i + 1, creator: "G1", category: "crypto" },
    }),
  );

  const maxLength = 260;
  const pages = formatDigestPages(events, { maxLength });
  const repeat = formatDigestPages(events, { maxLength });

  assert.deepEqual(pages, repeat, "pagination must be deterministic");
  assert.ok(pages.length > 1, `expected multiple pages, got ${pages.length}`);

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    assert.ok(page.length <= maxLength, `page ${i + 1} exceeded maxLength (${page.length} > ${maxLength})`);
    const firstLine = page.split("\n")[0];
    assert.equal(
      firstLine,
      `*Mimir Digest* \\(${i + 1}/${pages.length}\\) — 12 events in this cycle`,
      "each page must carry its (page/total) marker and the stable total event count",
    );
    assert.ok(!page.endsWith("\\"), "page must never end on a lone backslash");
  }

  const expectedEventLines = formatDigest(events)
    .split("\n")
    .filter((l) => l.startsWith("· "));
  assert.deepEqual(eventLinesFromPages(pages), expectedEventLines);
});

test("formatDigestPages: grouped mode repeats group header across continuation pages and never orphans headers", () => {
  const events = [
    // 5 events in market:42 so the group must span pages under tight maxLength
    ...Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        eventId: `m42-${i}`,
        ledger: 3000 + i,
        payload: { name: "claim_challenged", claimId: 42, challenger: "G2", stake: 10_000_000n },
      }),
    ),
    // 1 singleton event
    makeEvent({
      eventId: "s-1",
      source: "squad",
      ledger: 3010,
      payload: { name: "deposited", marketId: 7, participant: "G3", amount: 5_000_000n, side: 1 },
    }),
    // 3 events in squad:99
    ...Array.from({ length: 3 }, (_, i) =>
      makeEvent({
        eventId: `s99-${i}`,
        source: "squad",
        ledger: 3020 + i,
        payload: { name: "deposited", marketId: 99, participant: "G4", amount: 5_000_000n, side: 2 },
      }),
    ),
  ];

  const maxLength = 260;
  const pages = formatDigestPages(events, { grouped: true, maxLength });
  assert.ok(pages.length >= 3, `expected at least 3 pages, got ${pages.length}`);

  let market42HeaderPages = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    assert.ok(page.length <= maxLength, `page ${i + 1} exceeded maxLength (${page.length} > ${maxLength})`);
    const lines = page.split("\n");
    assert.equal(
      lines[0],
      `*Mimir Digest* \\(${i + 1}/${pages.length}\\) — 9 events in this cycle`,
    );

    // No orphaned group header at the end of a page
    const lastLine = lines[lines.length - 1];
    assert.ok(
      lastLine.trimStart().startsWith("· "),
      `page ${i + 1} ended with non-event line: ${lastLine}`,
    );

    // Every indented event line must be preceded by a group header on the same page
    let hasActiveGroup = false;
    for (const line of lines.slice(2)) {
      if (line.startsWith("  · ")) {
        assert.ok(hasActiveGroup, `indented event without group header on page ${i + 1}`);
      } else if (line.startsWith("· ")) {
        hasActiveGroup = false;
      } else {
        hasActiveGroup = true;
        if (line === "market:42") market42HeaderPages += 1;
      }
    }
  }

  assert.ok(
    market42HeaderPages >= 2,
    "multi-event group spanning pages should repeat its group header on continuation pages",
  );
  assert.equal(eventLinesFromPages(pages).length, events.length);
});

test("formatDigestPages: handles multi-digit page counts (>= 10 pages) without exceeding maxLength", () => {
  const events = Array.from({ length: 30 }, (_, i) =>
    makeEvent({
      eventId: `e-${i + 1}`,
      ledger: 4000 + i,
      payload: { name: "claim_created", claimId: i + 1, creator: "G1", category: "sports" },
    }),
  );

  // Tight enough to force >= 10 pages so header width grows from (1/2) to (10/15).
  const maxLength = 200;
  const pages = formatDigestPages(events, { maxLength });
  assert.ok(pages.length >= 10, `expected >= 10 pages, got ${pages.length}`);

  for (let i = 0; i < pages.length; i += 1) {
    assert.ok(
      pages[i].length <= maxLength,
      `page ${i + 1}/${pages.length} exceeded maxLength (${pages[i].length} > ${maxLength})`,
    );
    assert.ok(
      pages[i].startsWith(`*Mimir Digest* \\(${i + 1}/${pages.length}\\) — 30 events in this cycle\n\n`),
    );
  }
  assert.equal(eventLinesFromPages(pages).length, 30);
});

test("formatDigestPages: bounds large bursts to Telegram 4096-char limit by default", () => {
  const events = Array.from({ length: 120 }, (_, i) =>
    makeEvent({
      eventId: `burst-${i + 1}`,
      ledger: 5000 + i,
      payload: { name: "claim_created", claimId: (i % 10) + 1, creator: "G1", category: "crypto" },
    }),
  );

  const pages = formatDigestPages(events, { grouped: true });
  assert.ok(pages.length >= 2, `expected >= 2 pages for 120 events, got ${pages.length}`);
  for (let i = 0; i < pages.length; i += 1) {
    assert.ok(pages[i].length <= TELEGRAM_MAX_MESSAGE_LENGTH);
    assert.ok(
      pages[i].startsWith(`*Mimir Digest* \\(${i + 1}/${pages.length}\\) — 120 events in this cycle\n\n`),
    );
  }
  assert.equal(eventLinesFromPages(pages).length, 120);
});

test("formatDigestPages: throws RangeError for invalid or impossibly small maxLength", () => {
  const events = [
    makeEvent({ eventId: "e1", ledger: 6000 }),
    makeEvent({ eventId: "e2", ledger: 6001 }),
  ];

  assert.throws(() => formatDigestPages(events, { maxLength: 0 }), RangeError);
  assert.throws(() => formatDigestPages(events, { maxLength: -10 }), RangeError);
  assert.throws(() => formatDigestPages(events, { maxLength: Number.NaN }), RangeError);
  assert.throws(() => formatDigestPages(events, { maxLength: Number.POSITIVE_INFINITY }), RangeError);
  assert.throws(() => formatDigestPages(events, { maxLength: 60 }), RangeError);
});
