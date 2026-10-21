import assert from "node:assert/strict";
import test from "node:test";

import { createEventsHandler, eventsMessage } from "../dist/commands/events.js";
import { RecentEvents } from "../dist/notifications/recent.js";

function recentEvent({ source, ledger, eventId, eventName, marketId, txHash, at }) {
  return {
    source,
    contractId: "C" + "A".repeat(55),
    version: "v1",
    ledger,
    txHash,
    at,
    eventId,
    eventType: "contract",
    payload: { name: eventName, ...(marketId !== undefined ? { marketId } : {}) },
  };
}

function config(overrides = {}) {
  return {
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    ...overrides,
  };
}

function replyCtx() {
  const parts = [];
  const ctx = {
    message: { text: "/events" },
    chat: { id: 42 },
    reply: async (text) => {
      parts.push(text);
    },
  };
  return { ctx, parts };
}

test("eventsMessage renders newest first with one-line summaries", () => {
  const recent = new RecentEvents({ maxEvents: 10 });
  recent.record(
    recentEvent({
      source: "market",
      ledger: 10,
      eventId: "10-0",
      eventName: "claim_created",
      txHash: "1".repeat(64),
      at: 1000,
    }),
  );
  recent.record(
    recentEvent({
      source: "squad",
      ledger: 20,
      eventId: "20-0",
      eventName: "deposited",
      marketId: 3,
      txHash: "",
      at: 2000,
    }),
  );

  const text = eventsMessage(recent, config());
  assert.match(text, /\*Recent events\*/);
  assert.match(text, /mimir-market claim\\_created at ledger 10/);
  assert.match(text, /mimir-squad #3 deposited at ledger 20/);
  assert.ok(text.indexOf("ledger 20") < text.indexOf("ledger 10"), "newest first");
  assert.ok(text.includes("· [tx]("), "explorer link should be rendered");
});

test("eventsMessage filters by source", () => {
  const recent = new RecentEvents({ maxEvents: 10 });
  recent.record(
    recentEvent({
      source: "market",
      ledger: 1,
      eventId: "1-0",
      eventName: "claim_created",
      txHash: "",
      at: 1,
    }),
  );
  recent.record(
    recentEvent({
      source: "squad",
      ledger: 2,
      eventId: "2-0",
      eventName: "deposited",
      marketId: 1,
      txHash: "",
      at: 2,
    }),
  );

  const market = eventsMessage(recent, config(), { source: "market" });
  assert.match(market, /mimir-market/);
  assert.ok(!market.includes("mimir-squad"));

  const squad = eventsMessage(recent, config(), { source: "squad" });
  assert.match(squad, /mimir-squad/);
  assert.ok(!squad.includes("mimir-market"));
});

test("eventsMessage empty buffer", () => {
  assert.match(eventsMessage(new RecentEvents(), config()), /No recent events/);
});

test("eventsMessage default limit is 10 and caps at 30", () => {
  const recent = new RecentEvents({ maxEvents: 100 });
  for (let i = 1; i <= 40; i++) {
    recent.record(
      recentEvent({
        source: "market",
        ledger: i,
        eventId: `${i}-0`,
        eventName: "claim_created",
        txHash: "",
        at: i,
      }),
    );
  }
  const text = eventsMessage(recent, config());
  assert.ok(!text.includes("ledger 1"), "oldest should be excluded by default limit");
  assert.ok(text.includes("ledger 40"), "newest should be present");

  const capped = eventsMessage(recent, config(), { limit: 30 });
  const count = (capped.match(/at ledger /g) || []).length;
  assert.equal(count, 30);
});

test("RecentEvents evicts oldest when full", () => {
  const recent = new RecentEvents({ maxEvents: 3 });
  for (let i = 1; i <= 5; i++) {
    recent.record(
      recentEvent({
        source: "market",
        ledger: i,
        eventId: `${i}-0`,
        eventName: "claim_created",
        txHash: "",
        at: i,
      }),
    );
  }
  assert.equal(recent.size, 3);
  const listed = recent.list();
  assert.equal(listed.length, 3);
  assert.ok(!listed.some((e) => e.ledger === 1), "ledger 1 evicted");
  assert.ok(listed.some((e) => e.ledger === 5));
});

test("createEventsHandler respects chat allowlist", async () => {
  const recent = new RecentEvents({ maxEvents: 10 });
  recent.record(
    recentEvent({
      source: "market",
      ledger: 1,
      eventId: "1-0",
      eventName: "claim_created",
      txHash: "",
      at: 1,
    }),
  );
  const handler = createEventsHandler(recent, config({ allowedChatIds: ["99"] }));
  const { ctx, parts } = replyCtx();
  await handler(ctx);
  assert.equal(parts.length, 0, "non-allowed chat must not receive a reply");

  const openHandler = createEventsHandler(recent, config({ allowedChatIds: [] }));
  const { ctx: openCtx, parts: openParts } = replyCtx();
  await openHandler(openCtx);
  assert.equal(openParts.length, 1, "allowed chat receives a reply");
});
