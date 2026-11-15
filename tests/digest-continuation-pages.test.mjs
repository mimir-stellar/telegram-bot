import assert from "node:assert/strict";
import test from "node:test";

import { paginateDigest } from "../dist/notifications/digest-grouping.js";
import {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  formatDigest,
} from "../dist/notifications/format.js";
import {
  ScheduleParseError,
  validateDigestPageLimit,
} from "../dist/notifications/schedule.js";

function makeEvent({
  source = "market",
  ledger = 1000,
  id = 1n,
  name = "claim_created",
  eventName,
} = {}) {
  const payload =
    name === "unknown"
      ? { name: "unknown", eventName: eventName ?? "custom_event" }
      : source === "squad"
        ? { name, marketId: id }
        : { name, claimId: id };

  return {
    source,
    contractId: "CDUMMY00000000000000000000000000000000000000000000000000",
    version: "v1",
    ledger,
    txHash: "a".repeat(64),
    at: 1_763_193_600 + ledger,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("single-page digest preserves exact formatDigest output and empty input returns empty array", () => {
  assert.deepEqual(paginateDigest([]), []);

  const events = [
    makeEvent({ source: "market", ledger: 100, id: 7n, name: "claim_created" }),
    makeEvent({ source: "market", ledger: 101, id: 7n, name: "claim_challenged" }),
    makeEvent({ source: "squad", ledger: 102, id: 3n, name: "market_created" }),
  ];

  const pages = paginateDigest(events, { grouped: true });
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageIndex, 0);
  assert.equal(pages[0].pageNumber, 1);
  assert.equal(pages[0].totalPages, 1);
  assert.equal(pages[0].eventCount, 3);
  assert.equal(pages[0].totalEvents, 3);
  assert.equal(pages[0].text, formatDigest(events, { grouped: true }));
});

test("oversized bursts split on complete event summaries within TELEGRAM_MAX_MESSAGE_LENGTH with stable counts", () => {
  const events = [];
  for (let i = 0; i < 140; i += 1) {
    events.push(
      makeEvent({
        source: i % 3 === 0 ? "squad" : "market",
        ledger: 5000 + i,
        id: BigInt((i % 12) + 1),
        name: "unknown",
        eventName: `evt_${i}_rocket_🚀_[check]*bold*`,
      }),
    );
  }

  const pages = paginateDigest(events, { grouped: true });
  assert.ok(pages.length >= 2, "expected multiple pages for 140-event burst");

  let sumCounts = 0;
  const flattenedLedgers = [];

  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    assert.equal(page.pageIndex, i);
    assert.equal(page.pageNumber, i + 1);
    assert.equal(page.totalPages, pages.length);
    assert.equal(page.totalEvents, 140);
    assert.equal(page.eventCount, page.events.length);
    assert.ok(page.eventCount >= 1);
    assert.ok(
      page.text.length <= TELEGRAM_MAX_MESSAGE_LENGTH,
      `page ${page.pageNumber} length ${page.text.length} exceeded ${TELEGRAM_MAX_MESSAGE_LENGTH}`,
    );

    // Every backtick span and bold marker on the page must be balanced (never split mid-entity).
    const unescapedBackticks = page.text.replace(/\\`/g, "").match(/`/g) ?? [];
    assert.equal(unescapedBackticks.length % 2, 0, "unbalanced code span on page");
    assert.equal(/(?<!\\)\\$/.test(page.text), false, "page ended on dangling backslash");

    // Header explicitly carries stable total event count + page index.
    assert.ok(page.text.includes("140 events in this cycle"));
    assert.ok(
      page.text.includes(`\\(page ${i + 1}/${pages.length}, ${page.eventCount} on this page\\)`),
    );

    sumCounts += page.eventCount;
    for (const ev of page.events) flattenedLedgers.push(ev.ledger);
  }

  assert.equal(sumCounts, 140);
  assert.equal(new Set(flattenedLedgers).size, 140);

  // Deterministic across repeated invocations.
  const secondRun = paginateDigest(events, { grouped: true });
  assert.deepEqual(
    secondRun.map((p) => p.text),
    pages.map((p) => p.text),
  );
});

test("group headers never sit orphaned at page bottom and repeat with (cont.) on continuation pages", () => {
  const events = [
    makeEvent({ source: "market", ledger: 201, id: 99n, name: "claim_created" }),
    makeEvent({ source: "market", ledger: 202, id: 99n, name: "claim_challenged" }),
    makeEvent({ source: "market", ledger: 203, id: 99n, name: "claim_resolved" }),
    makeEvent({ source: "market", ledger: 204, id: 99n, name: "market_settled" }),
  ];

  const pages = paginateDigest(events, { grouped: true, maxPageChars: 240 });
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    assert.ok(page.text.length <= 240);
    const lines = page.text.split("\n");
    const lastLine = lines[lines.length - 1];
    assert.ok(
      lastLine.includes("· mimir\\-"),
      `last line of page ${page.pageNumber} must be an event summary, got: ${lastLine}`,
    );
  }

  assert.ok(pages[0].text.includes("market:99\n"));
  assert.ok(pages[1].text.includes("market:99 \\(cont\\.\\)\n"));
  assert.equal(
    pages.reduce((acc, p) => acc + p.eventCount, 0),
    events.length,
  );
});

test("rejects page limits exceeding Telegram 4096 ceiling or too small for a single complete summary", () => {
  assert.equal(validateDigestPageLimit(4096), 4096);
  assert.throws(() => validateDigestPageLimit(4097), ScheduleParseError);
  assert.throws(() => validateDigestPageLimit(0), ScheduleParseError);
  assert.throws(() => validateDigestPageLimit(100.5), ScheduleParseError);

  const ev = makeEvent({ ledger: 300 });
  assert.throws(() => paginateDigest([ev], { maxPageChars: 40 }), RangeError);
  assert.throws(
    () => paginateDigest([ev, makeEvent({ ledger: 301 })], { maxPageChars: 110 }),
    RangeError,
  );
});
