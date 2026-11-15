import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVENTS_PAGE_SIZE,
  EVENTS_PATH_REJECTED_MESSAGE,
  EVENTS_USAGE_MESSAGE,
  createBot,
  createRecentEventRing,
  eventsMessage,
  parseEventsPageArg,
  toCanonicalEventSummary,
} from "../dist/bot.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const BOT_INFO = {
  id: 101,
  is_bot: true,
  first_name: "MimirBot",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeConfig(overrides = {}) {
  return {
    botToken: ["123456:", "A".repeat(35)].join(""),
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    locale: "en",
    ...overrides,
  };
}

function makeStatus(targets = []) {
  return {
    running: true,
    paused: false,
    startedAt: 1_700_000_000_000,
    cycles: 2,
    lastPollAt: 1_700_000_005_000,
    lastSuccessAt: 1_700_000_005_000,
    latestLedger: 5000,
    oldestLedger: 4000,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    consecutiveFailures: 0,
    lastError: null,
    targets,
  };
}

function makeDecodedMarketEvent(index) {
  return {
    source: index % 2 === 0 ? "market" : "squad",
    contractId: "C" + "A".repeat(55),
    version: "v1",
    ledger: 1000 + index,
    txHash: String(index).padStart(64, "a"),
    at: 1_700_000_000 + index,
    eventId: `${1000 + index}-${index}`,
    payload:
      index % 2 === 0
        ? {
            name: "claim_created",
            claimId: index,
            category: "crypto",
            creator: "G" + "C".repeat(55),
          }
        : {
            name: "deposited",
            marketId: index,
            depositor: "G" + "D".repeat(55),
            side: 1,
            amount: 25_000_000n,
          },
  };
}

function makeCommandUpdate(text, { chatId = -1001234567890, fromId = 99, updateId = 1 } = {}) {
  const tokenLen = text.includes(" ") ? text.indexOf(" ") : text.length;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup" },
      from: { id: fromId, is_bot: false, first_name: "Reader" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: tokenLen }],
    },
  };
}

function makeCallbackUpdate(data, { chatId = -1001234567890, fromId = 99, updateId = 50 } = {}) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb_${updateId}`,
      from: { id: fromId, is_bot: false, first_name: "Reader" },
      message: {
        message_id: 200,
        date: 1_700_000_000,
        chat: { id: chatId, type: "supergroup" },
        text: "previous page",
      },
      data,
    },
  };
}

test("events command modules do not import filesystem APIs", () => {
  for (const rel of ["src/recent-events.ts", "src/commands/events.ts"]) {
    const source = readFileSync(path.join(repoRoot, rel), "utf8");
    assert.equal(
      /\bnode:fs\b|\bfs\/promises\b|\breadFileSync\b|\breadFile\b|\bopen\b/.test(source),
      false,
      `${rel} must remain strictly in-memory without filesystem imports`,
    );
  }
});

test("parseEventsPageArg accepts positive integers and rejects paths or arbitrary strings", () => {
  assert.deepEqual(parseEventsPageArg(""), { ok: true, page: 1 });
  assert.deepEqual(parseEventsPageArg("   "), { ok: true, page: 1 });
  assert.deepEqual(parseEventsPageArg("1"), { ok: true, page: 1 });
  assert.deepEqual(parseEventsPageArg(" 3 "), { ok: true, page: 3 });

  for (const pathAttempt of [
    "../secret.jsonl",
    "../../etc/passwd",
    "/var/log/events.jsonl",
    "C:\\Windows\\win.ini",
    "file:///tmp/events.jsonl",
    "%2fetc%2fpasswd",
    "archive.jsonl",
  ]) {
    assert.deepEqual(
      parseEventsPageArg(pathAttempt),
      { ok: false, reason: "path-rejected" },
      `expected path rejection for ${pathAttempt}`,
    );
  }

  for (const invalidPage of ["0", "-2", "1.5", "abc", "99999"]) {
    assert.deepEqual(
      parseEventsPageArg(invalidPage),
      { ok: false, reason: "invalid-page" },
      `expected invalid-page for ${invalidPage}`,
    );
  }
});

test("createRecentEventRing bounds capacity, deduplicates by eventId, and orders newest first", () => {
  const config = makeConfig();
  const ring = createRecentEventRing(4);

  for (let i = 1; i <= 6; i += 1) {
    ring.record(makeDecodedMarketEvent(i), config);
  }

  assert.equal(ring.size(), 4, "oldest summaries must be evicted past capacity");
  const entries = ring.entries();
  assert.deepEqual(
    entries.map((e) => e.ledger),
    [1006, 1005, 1004, 1003],
  );

  // Recording an already-retained event updates it without growing past capacity.
  const duplicate = toCanonicalEventSummary(makeDecodedMarketEvent(5), config);
  ring.record({ ...duplicate, summary: "Updated summary" }, config);
  assert.equal(ring.size(), 4);
  assert.equal(ring.entries().find((e) => e.ledger === 1005)?.summary, "Updated summary");
});

test("eventsMessage renders empty state, paginated pages, and out-of-range notices within bounds", () => {
  const config = makeConfig();
  const empty = eventsMessage([], config, 1);
  assert.equal(empty.page, 1);
  assert.equal(empty.totalPages, 1);
  assert.equal(empty.keyboard, undefined);
  assert.match(empty.text, /No recent contract events retained in memory yet/);

  const ring = createRecentEventRing(20);
  for (let i = 1; i <= 12; i += 1) {
    ring.record(makeDecodedMarketEvent(i), config);
  }

  const page1 = eventsMessage(ring.entries(), config, 1);
  assert.equal(page1.page, 1);
  assert.equal(page1.totalPages, Math.ceil(12 / EVENTS_PAGE_SIZE));
  assert.ok(page1.keyboard, "multi-page result includes pagination keyboard");
  assert.ok(page1.text.length < 4096);
  assert.match(page1.text, /ledger 1012/);
  assert.equal(page1.text.includes("ledger 1007"), false);

  const page2 = eventsMessage(ring.entries(), config, 2);
  assert.equal(page2.page, 2);
  assert.match(page2.text, /ledger 1007/);

  const outOfRange = eventsMessage(ring.entries(), config, 9);
  assert.match(outOfRange.text, /Page 9 is out of range/);
});

test("/events command and pagination callbacks enforce allowlist and reject path arguments", async () => {
  const config = makeConfig({ allowedChatIds: ["-1001234567890"] });
  const ring = createRecentEventRing(20);
  for (let i = 1; i <= 7; i += 1) {
    ring.record(makeDecodedMarketEvent(i), config);
  }

  const bot = createBot({
    config,
    status: () => makeStatus(),
    pause: () => "paused",
    resume: () => "resumed",
    recentEvents: () => ring.entries(),
    botInfo: BOT_INFO,
  });

  const apiCalls = [];
  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: apiCalls.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "supergroup" },
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });

  // 1. Unapproved chat is silently ignored on both /events and pagination callbacks.
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await bot.handleUpdate(makeCommandUpdate("/events", { chatId: -100999, updateId: 1 }));
    await bot.handleUpdate(makeCallbackUpdate("pg:v1:events:1", { chatId: -100999, updateId: 2 }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(
    apiCalls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").length,
    0,
  );

  // 2. Path traversal argument is rejected without reading disk.
  apiCalls.length = 0;
  await bot.handleUpdate(
    makeCommandUpdate("/events ../../etc/passwd", { chatId: -1001234567890, updateId: 3 }),
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload.text, EVENTS_PATH_REJECTED_MESSAGE);

  // 3. Invalid non-integer page returns usage guidance.
  apiCalls.length = 0;
  await bot.handleUpdate(
    makeCommandUpdate("/events zero", { chatId: -1001234567890, updateId: 4 }),
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].payload.text, EVENTS_USAGE_MESSAGE);

  // 4. Valid /events returns page 1 with Next button; callback navigates to page 2.
  apiCalls.length = 0;
  await bot.handleUpdate(makeCommandUpdate("/events", { chatId: -1001234567890, updateId: 5 }));
  assert.equal(apiCalls.length, 1);
  assert.match(apiCalls[0].payload.text, /page 1\/2, 7 retained/);
  assert.ok(apiCalls[0].payload.reply_markup);

  apiCalls.length = 0;
  await bot.handleUpdate(
    makeCallbackUpdate("pg:v1:events:1", { chatId: -1001234567890, updateId: 6 }),
  );
  const editCall = apiCalls.find((c) => c.method === "editMessageText");
  assert.ok(editCall, "pagination callback edits the message to page 2");
  assert.match(editCall.payload.text, /page 2\/2, 7 retained/);
});
