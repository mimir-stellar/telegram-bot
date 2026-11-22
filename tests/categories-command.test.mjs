import assert from "node:assert/strict";
import test from "node:test";

import {
  CategoryCounter,
  categoriesMessage,
  createCategoryCounter,
  sanitizeCategory,
  DEFAULT_MAX_CATEGORIES,
  DEFAULT_MAX_LIST_LENGTH,
  MAX_CATEGORY_NAME_LENGTH,
} from "../dist/commands/categories.js";
import { escapeMd } from "../dist/notifications/format.js";

// ── Empty counter ─────────────────────────────────────────────────────────────

test("categoriesMessage: empty counter renders 'no categories recorded yet'", () => {
  const counter = new CategoryCounter();
  const message = categoriesMessage(counter);

  assert.match(message, /\*Claim Categories\*/);
  assert.match(message, /No claim categories recorded yet/i);
});

test("categoriesMessage: empty plain Map or object renders empty notice", () => {
  assert.match(categoriesMessage(new Map()), /No claim categories recorded yet/i);
  assert.match(categoriesMessage({}), /No claim categories recorded yet/i);
});

// ── Unfiltered configuration ──────────────────────────────────────────────────

test("categoriesMessage: unfiltered config lists categories with counts and no (filtered) labels", () => {
  const counter = new CategoryCounter();
  counter.record("crypto");
  counter.record("crypto");
  counter.record("sports");

  const message = categoriesMessage(counter, { notificationCategories: [] });

  assert.match(message, /\*Claim Categories\*/);
  assert.match(message, /• `crypto`: 2/);
  assert.match(message, /• `sports`: 1/);
  assert.doesNotMatch(message, /filtered/i);
});

test("categoriesMessage: unfiltered config defaults when config is omitted", () => {
  const counter = new CategoryCounter();
  counter.record("prediction");

  const message = categoriesMessage(counter);

  assert.match(message, /• `prediction`: 1/);
  assert.doesNotMatch(message, /filtered/i);
});

test("categoriesMessage: MarkdownV2 reserved characters in categories are properly escaped", () => {
  const counter = new CategoryCounter();
  const trickyName = "defi_yield*v1.0-alpha(beta)";
  counter.record(trickyName);

  const message = categoriesMessage(counter);

  assert.ok(
    message.includes(escapeMd(trickyName)),
    `Expected "${escapeMd(trickyName)}" to be in message:\n${message}`,
  );
});

// ── Filtered configuration ────────────────────────────────────────────────────

test("categoriesMessage: filtered config marks categories not in allowlist with (filtered)", () => {
  const counter = new CategoryCounter();
  counter.record("crypto");
  counter.record("sports");
  counter.record("governance");

  const config = { notificationCategories: ["crypto", "defi"] };
  const message = categoriesMessage(counter, config);

  // "crypto" is allowed
  assert.match(message, /• `crypto`: 1(?!.*\(filtered\))/);
  assert.ok(!message.includes("`crypto`: 1 \\(filtered\\)"));

  // "sports" and "governance" are filtered
  assert.ok(message.includes("`sports`: 1 \\(filtered\\)"));
  assert.ok(message.includes("`governance`: 1 \\(filtered\\)"));
});

test("categoriesMessage: filtered config matching is case-insensitive and trims whitespace", () => {
  const counter = new CategoryCounter();
  counter.record("Crypto");
  counter.record("DeFi");

  const config = { notificationCategories: [" crypto ", "DEFI"] };
  const message = categoriesMessage(counter, config);

  assert.doesNotMatch(message, /filtered/i);
});

test("categoriesMessage: uses counter.config if config argument is omitted", () => {
  const counter = new CategoryCounter({
    config: { notificationCategories: ["allowed_category"] },
  });
  counter.record("allowed_category");
  counter.record("disallowed_category");

  const message = categoriesMessage(counter);

  assert.ok(!message.includes(`\`${escapeMd("allowed_category")}\`: 1 \\(filtered\\)`));
  assert.ok(message.includes(`\`${escapeMd("disallowed_category")}\`: 1 \\(filtered\\)`));
});

// ── Sorting ───────────────────────────────────────────────────────────────────

test("categoriesMessage: sorts primarily by count descending, secondarily by name ascending", () => {
  const counter = new CategoryCounter();
  counter.record("beta"); // count 1
  counter.record("alpha"); // count 2
  counter.record("alpha");
  counter.record("gamma"); // count 2
  counter.record("gamma");
  counter.record("delta"); // count 3
  counter.record("delta");
  counter.record("delta");

  const message = categoriesMessage(counter);
  const lines = message.split("\n").filter((l) => l.startsWith("•"));

  // delta (3) -> alpha (2) -> gamma (2) -> beta (1)
  assert.equal(lines.length, 4);
  assert.match(lines[0], /`delta`: 3/);
  assert.match(lines[1], /`alpha`: 2/);
  assert.match(lines[2], /`gamma`: 2/);
  assert.match(lines[3], /`beta`: 1/);
});

// ── Capping list length ───────────────────────────────────────────────────────

test("categoriesMessage: caps list length and renders remaining count indicator", () => {
  const counter = new CategoryCounter();
  for (let i = 1; i <= 25; i++) {
    const name = `cat_${String(i).padStart(2, "0")}`;
    for (let c = 0; c < i; c++) {
      counter.record(name);
    }
  }

  // Default maxListLength is 20
  const message = categoriesMessage(counter);
  const lines = message.split("\n").filter((l) => l.startsWith("•"));

  assert.equal(lines.length, DEFAULT_MAX_LIST_LENGTH);
  assert.match(message, /_…and 5 more_/);
});

test("categoriesMessage: honors custom maxListLength option", () => {
  const counter = new CategoryCounter();
  counter.record("first");
  counter.record("first");
  counter.record("second");
  counter.record("third");

  const message = categoriesMessage(counter, undefined, { maxListLength: 2 });
  const lines = message.split("\n").filter((l) => l.startsWith("•"));

  assert.equal(lines.length, 2);
  assert.match(message, /_…and 1 more_/);
});

// ── Bounded memory in CategoryCounter ─────────────────────────────────────────

test("CategoryCounter: caps distinct categories and evicts lowest-count entries", () => {
  const counter = new CategoryCounter({ maxCategories: 3 });

  counter.record("a");
  counter.record("a");
  counter.record("b");
  counter.record("b");
  counter.record("c"); // count 1

  assert.equal(counter.size, 3);
  assert.equal(counter.get("c"), 1);

  // Adding "d" should evict "c" (lowest count)
  counter.record("d");
  assert.equal(counter.size, 3);
  assert.equal(counter.has("c"), false);
  assert.equal(counter.has("d"), true);
  assert.equal(counter.get("d"), 1);

  // Increment "d" to count 3
  counter.record("d");
  counter.record("d");

  // Adding "e" should evict "a" (oldest among tie of count 2)
  counter.record("e");
  assert.equal(counter.size, 3);
  assert.equal(counter.has("a"), false);
  assert.equal(counter.has("b"), true);
  assert.equal(counter.has("d"), true);
  assert.equal(counter.has("e"), true);
});

test("CategoryCounter: total tracks all recorded events even across evictions", () => {
  const counter = new CategoryCounter({ maxCategories: 2 });
  counter.record("one");
  counter.record("two");
  counter.record("three"); // evicts one or two
  assert.equal(counter.total, 2); // 2 active entries with count 1 each
});

test("CategoryCounter: clear resets all entries and counters", () => {
  const counter = new CategoryCounter();
  counter.record("test");
  assert.equal(counter.size, 1);
  counter.clear();
  assert.equal(counter.size, 0);
  assert.equal(counter.get("test"), 0);
});

// ── Event ingestion ───────────────────────────────────────────────────────────

test("CategoryCounter: records category from delivered claim_created DecodedEvent", () => {
  const counter = new CategoryCounter();

  const claimCreatedEvent = {
    source: "market",
    contractId: "C123",
    ledger: 100,
    txHash: "0xabc",
    at: 1000,
    eventId: "100-0",
    payload: {
      name: "claim_created",
      claimId: 7,
      creator: "GAAA",
      category: "prediction_market",
    },
  };

  const recorded = counter.record(claimCreatedEvent);
  assert.equal(recorded, true);
  assert.equal(counter.get("prediction_market"), 1);
  assert.equal(counter.size, 1);
});

test("CategoryCounter: ignores non-claim_created events", () => {
  const counter = new CategoryCounter();

  const challengedEvent = {
    source: "market",
    contractId: "C123",
    ledger: 100,
    txHash: "0xabc",
    at: 1000,
    eventId: "100-1",
    payload: {
      name: "claim_challenged",
      claimId: 7,
      stake: 1000n,
      challenger: "GBBB",
    },
  };

  const recorded = counter.record(challengedEvent);
  assert.equal(recorded, false);
  assert.equal(counter.size, 0);
});

test("CategoryCounter: recordDelivered method delegates to record", () => {
  const counter = createCategoryCounter();
  const event = {
    payload: {
      name: "claim_created",
      claimId: 1,
      creator: "G1",
      category: "climate",
    },
  };

  assert.equal(counter.recordDelivered(event), true);
  assert.equal(counter.get("climate"), 1);
});

// ── Sanitisation & Escaping ───────────────────────────────────────────────────

test("sanitizeCategory: strips control characters, bidi overrides, and collapses whitespace", () => {
  const hostile = "\x00\x1b[31m\u202Ereversed\u202C\t  category  \r\n";
  const cleaned = sanitizeCategory(hostile);

  assert.equal(cleaned, "[31mreversed category");
  assert.ok(!/[\x00-\x1F\x7F\u202A-\u202E]/.test(cleaned));
});

test("sanitizeCategory: caps string length without breaking Unicode code points", () => {
  const longCategory = "🔥".repeat(150);
  const cleaned = sanitizeCategory(longCategory, 10);

  assert.equal(Array.from(cleaned).length, 10);
  assert.equal(cleaned, "🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥");
});

test("sanitizeCategory: rejects empty or non-string inputs", () => {
  assert.equal(sanitizeCategory("   "), "");
  assert.equal(sanitizeCategory(null), "");
  assert.equal(sanitizeCategory(undefined), "");
  assert.equal(sanitizeCategory(123), "");
});

test("CategoryCounter: rejects empty or whitespace-only category strings", () => {
  const counter = new CategoryCounter();
  assert.equal(counter.record(""), false);
  assert.equal(counter.record("   \t  "), false);
  assert.equal(counter.size, 0);
});

// ── Alternate counter shapes ──────────────────────────────────────────────────

test("categoriesMessage: accepts Map<string, number>", () => {
  const map = new Map([
    ["web3", 5],
    ["ai", 10],
  ]);

  const message = categoriesMessage(map);

  assert.match(message, /• `ai`: 10/);
  assert.match(message, /• `web3`: 5/);
});

test("categoriesMessage: accepts plain Record<string, number>", () => {
  const record = { oracle: 7, stellar: 12 };
  const message = categoriesMessage(record);

  assert.match(message, /• `stellar`: 12/);
  assert.match(message, /• `oracle`: 7/);
});

// ── Purity ────────────────────────────────────────────────────────────────────

test("categoriesMessage: pure across multiple calls with same inputs", () => {
  const counter = new CategoryCounter();
  counter.record("crypto");
  counter.record("defi");

  const config = { notificationCategories: ["crypto"] };
  const first = categoriesMessage(counter, config);
  const second = categoriesMessage(counter, config);

  assert.equal(first, second);
});

// ── Command registration & handler integration ────────────────────────────────

test("/categories is registered in the command catalogue with chatAllowlist gate", async () => {
  const { COMMANDS, createBot } = await import("../dist/bot.js");
  const { commandModule } = await import("../dist/commands/index.js");

  const meta = COMMANDS.find((c) => c.command === "categories");
  assert.ok(meta, "/categories must be advertised in COMMANDS");
  assert.equal(meta.operatorOnly, false);

  const mod = commandModule("categories");
  assert.ok(mod, "/categories module must be registered");
  assert.equal(mod.chatAllowlist, true);
  assert.notEqual(mod.operatorOnly, true);

  assert.equal(typeof createBot, "function");
});

test("/categories command replies with bounded category summary and empty boundary case", async () => {
  const { createBot } = await import("../dist/bot.js");

  const config = {
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: "123456789:TEST-ONLY-TOKEN-NEVER-USE",
    chatId: "-1001234567890",
    allowedChatIds: [],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    notificationCategories: ["crypto"],
  };

  let currentCategories;
  const bot = createBot({
    config,
    status: () => ({
      running: true,
      paused: false,
      startedAt: 1,
      cycles: 1,
      lastPollAt: null,
      lastSuccessAt: null,
      latestLedger: null,
      oldestLedger: null,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 0,
      lastError: null,
      targets: [],
      ...(currentCategories !== undefined ? { categories: currentCategories } : {}),
    }),
    pause: () => "paused",
    resume: () => "resumed",
    botInfo: {
      id: 999,
      is_bot: true,
      first_name: "MimirTestBot",
      username: "mimir_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    },
  });

  const sent = [];
  bot.api.config.use((prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return Promise.resolve({
        ok: true,
        result: {
          message_id: sent.length,
          date: 0,
          chat: { id: payload.chat_id, type: "private" },
          text: payload.text,
        },
      });
    }
    return prev(method, payload);
  });

  const makeUpdate = (id) => ({
    update_id: id,
    message: {
      message_id: id,
      date: 1700000000,
      chat: { id: 12345, type: "private" },
      from: { id: 12345, is_bot: false, first_name: "User" },
      text: "/categories",
      entities: [{ offset: 0, length: 11, type: "bot_command" }],
    },
  });

  // Boundary case: undefined categories in status
  await bot.handleUpdate(makeUpdate(1));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /No claim categories recorded yet/);

  // Observed categories, including one filtered out by notificationCategories
  currentCategories = { crypto: 3, sports: 1 };
  await bot.handleUpdate(makeUpdate(2));
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /• `crypto`: 3/);
  assert.match(sent[1].text, /• `sports`: 1 \\\(filtered\\\)/);
});

test("poller derives status().categories from observed claim_created events", async () => {
  const path = await import("node:path");
  const { rpc } = await import("@stellar/stellar-sdk");
  const { createPoller } = await import("../dist/poller.js");
  const {
    MOCK_BOT_TOKEN,
    MOCK_MARKET_CONTRACT_ID,
    MOCK_NETWORK_PASSPHRASE,
    MOCK_SQUAD_CONTRACT_ID,
  } = await import("../dist/stellar/mock-constants.js");
  const { startMockRpc } = await import("../dist/stellar/mock-rpc.js");
  const { withTempDataDir } = await import("./helpers/temp-data.mjs");

  const CAPTAIN = "GCLJONJVCLJGE6CSMCHCGYA563ADTCK5YGF3KERDMSNS3MNNDAIXHFA5";

  await withTempDataDir(async (dataDir) => {
    const mock = await startMockRpc({
      port: 0,
      scenario: {
        latestLedger: 12,
        oldestLedger: 1,
        ledgersPerPage: 50,
        events: [
          {
            source: "market",
            ledger: 9,
            eventName: "claim_created",
            topics: [1, { address: CAPTAIN }],
            fields: { category: "crypto" },
          },
          {
            source: "market",
            ledger: 10,
            eventName: "claim_created",
            topics: [2, { address: CAPTAIN }],
            fields: { category: "sports" },
          },
          {
            source: "market",
            ledger: 11,
            eventName: "claim_created",
            topics: [3, { address: CAPTAIN }],
            fields: { category: "crypto" },
          },
          {
            source: "squad",
            ledger: 12,
            eventName: "market_created",
            topics: [5, { address: CAPTAIN }],
            fields: { name: "Test Squad" },
          },
        ],
      },
    });

    try {
      const poller = createPoller({
        config: {
          version: "0.1.0",
          marketContractId: MOCK_MARKET_CONTRACT_ID,
          squadContractId: MOCK_SQUAD_CONTRACT_ID,
          rpcUrl: mock.url,
          horizonUrl: "https://example.invalid/horizon",
          networkPassphrase: MOCK_NETWORK_PASSPHRASE,
          explorerBaseUrl: "https://example.invalid/explorer",
          botToken: MOCK_BOT_TOKEN,
          chatId: "-1001234567890",
          operatorTelegramUserId: null,
          pollIntervalMs: 30_000,
          startLookbackLedgers: 10,
          cursorFile: dataDir.file("cursor.json"),
          maxNotificationsPerCycle: 20,
          healthHost: "127.0.0.1",
          healthPort: 0,
          healthStaleMs: 90_000,
          notificationCategories: ["crypto"],
        },
        server: new rpc.Server(mock.url, { allowHttp: true }),
        send: async () => undefined,
      });

      await poller.pollOnce();

      const status = poller.status();
      assert.deepEqual(status.categories, { crypto: 2, sports: 1 });

      const message = categoriesMessage(status.categories, {
        notificationCategories: ["crypto"],
      });
      assert.match(message, /• `crypto`: 2/);
      assert.match(message, /• `sports`: 1 \\\(filtered\\\)/);
    } finally {
      await mock.close();
    }
  });
});
