import assert from "node:assert/strict";
import test from "node:test";

import {
  CategoryCounter,
  categoriesCommand,
  categoriesMessage,
  createCategoryCounter,
  deriveCategoryCounts,
  sanitizeCategory,
  DEFAULT_MAX_CATEGORIES,
  DEFAULT_MAX_LIST_LENGTH,
  MAX_CATEGORIES_MESSAGE_CHARS,
  MAX_CATEGORY_NAME_LENGTH,
} from "../dist/commands/categories.js";
import { createBot, helpDetailMessage } from "../dist/bot.js";
import { commandModule } from "../dist/commands/index.js";
import { escapeMd } from "../dist/notifications/format.js";
import { assertValidMarkdownV2 } from "./markdown-lint.test.mjs";

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

// ── Registered /categories command & dynamic observed-event derivation ───────

const BOT_INFO = {
  id: 909000,
  is_bot: true,
  first_name: "MimirBot",
  username: "mimir_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeBotHarness({ configOverrides = {}, observed = undefined, targets = [] } = {}) {
  const botCredential = ["123456789:", "A".repeat(35)].join("");
  const config = {
    locale: "en",
    version: "0.1.0",
    marketContractId: "C" + "A".repeat(55),
    squadContractId: "C" + "B".repeat(55),
    marketContractVersion: "v1",
    squadContractVersion: "v2",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    botToken: botCredential,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    allowedChatIds: [],
    operatorTelegramUserId: "42",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    lockFile: "/tmp/unused-poller.lock",
    statusFile: "/tmp/unused-status.json",
    maxNotificationsPerCycle: 20,
    interSendDelayMs: 1_500,
    metricsPort: null,
    notificationCategories: [],
    silentEvents: [],
    csvOutputFile: "/tmp/unused-scanner.csv",
    featureFlags: { enabled: true, market: true, squad: true },
    auditFile: "/tmp/unused-audit.jsonl",
    dedupWindow: 256,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    sendJournalFile: "/tmp/unused-send-journal.jsonl",
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    startupHealthDeadlineMs: 0,
    startupHealthRetryMs: 0,
    shutdownTimeoutMs: 1_000,
    telegramSendTimeoutMs: 5_000,
    channelPreviewMode: false,
    linkPreviewMarket: false,
    linkPreviewSquad: false,
    logSampleMaxPerWindow: 3,
    logSampleWindowMs: 300_000,
    logBufferLines: 0,
    telegramWebhookUrl: null,
    telegramApiRoot: null,
    mimirAppUrl: null,
    healthAuthToken: null,
    ...configOverrides,
  };

  const sent = [];
  const bot = createBot({
    config,
    botInfo: BOT_INFO,
    ...(observed !== undefined ? { observedEvents: observed } : {}),
    status: () => ({
      running: true,
      paused: false,
      startedAt: 1,
      cycles: 1,
      lastPollAt: 1,
      lastSuccessAt: 1,
      latestLedger: 100,
      oldestLedger: 50,
      notificationsSent: 0,
      notificationsFailed: 0,
      eventsSkipped: 0,
      consecutiveFailures: 0,
      lastError: null,
      targets,
    }),
    pause: () => "paused",
    resume: () => "resumed",
  });

  bot.api.config.use((prev, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return Promise.resolve({
        ok: true,
        result: {
          message_id: sent.length,
          date: 1_700_000_000,
          chat: { id: payload.chat_id, type: "supergroup" },
          text: payload.text,
        },
      });
    }
    return Promise.resolve({ ok: true, result: true });
  });

  return { bot, config, sent };
}

function slashUpdate(text, { updateId = 1, chatId = -1001234567890, userId = 100 } = {}) {
  const cmdLen = text.indexOf(" ") === -1 ? text.length : text.indexOf(" ");
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: chatId, type: "supergroup", title: "Mimir Group" },
      from: { id: userId, is_bot: false, first_name: "Member" },
      text,
      entities: [{ offset: 0, length: cmdLen, type: "bot_command" }],
    },
  };
}

test("/categories is registered in the command catalogue with allowlist gating and help detail", () => {
  const registered = commandModule("categories");
  assert.equal(registered, categoriesCommand);
  assert.equal(registered?.chatAllowlist, true);
  assert.notEqual(registered?.operatorOnly, true);

  const detail = helpDetailMessage("categories");
  assert.match(detail, /\*Command:\* \/categories/);
  assertValidMarkdownV2(detail, "helpDetailMessage(categories)");
});

test("/categories derives categories dynamically from observed events rather than a separate mutable list", async () => {
  let retainedEvents = [
    {
      source: "market",
      contractId: "C" + "A".repeat(55),
      ledger: 101,
      txHash: "a".repeat(64),
      at: 1_700_000_001,
      eventId: "101-0",
      payload: { name: "claim_created", claimId: 1, creator: "GAAA", category: "crypto" },
    },
    {
      source: "market",
      contractId: "C" + "A".repeat(55),
      ledger: 102,
      txHash: "b".repeat(64),
      at: 1_700_000_002,
      eventId: "102-0",
      payload: { name: "claim_created", claimId: 2, creator: "GAAA", category: "crypto" },
    },
    {
      source: "squad",
      contractId: "C" + "B".repeat(55),
      ledger: 103,
      txHash: "c".repeat(64),
      at: 1_700_000_003,
      eventId: "103-0",
      payload: {
        name: "market_created",
        marketId: 9,
        captain: "GBBB",
        deadline: 1_700_099_000,
        feeBps: 100,
        question: "Will X happen?",
        category: "sports",
      },
    },
    {
      source: "market",
      contractId: "C" + "A".repeat(55),
      ledger: 104,
      txHash: "d".repeat(64),
      at: 1_700_000_004,
      eventId: "104-0",
      payload: { name: "claim_challenged", claimId: 1, stake: 100n, challenger: "GCCC" },
    },
  ];

  const { bot, sent } = makeBotHarness({
    configOverrides: {
      allowedChatIds: ["-1001234567890"],
      notificationCategories: ["crypto"],
    },
    observed: () => retainedEvents,
  });

  await bot.handleUpdate(slashUpdate("/categories", { updateId: 1, chatId: -1001234567890 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parse_mode, "MarkdownV2");
  assertValidMarkdownV2(sent[0].text, "/categories initial");
  assert.ok(sent[0].text.includes("• `crypto`: 2"));
  assert.ok(sent[0].text.includes("• `sports`: 1 \\(filtered\\)"));

  // When retained observed events roll over, /categories reflects the current observed window directly
  retainedEvents = [
    {
      source: "market",
      contractId: "C" + "A".repeat(55),
      ledger: 200,
      txHash: "e".repeat(64),
      at: 1_700_000_100,
      eventId: "200-0",
      payload: { name: "claim_created", claimId: 10, creator: "GDDD", category: "macro" },
    },
  ];

  await bot.handleUpdate(slashUpdate("/categories", { updateId: 2, chatId: -1001234567890 }));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].text.includes("crypto"), false, "no stale mutable list retained");
  assert.ok(sent[1].text.includes("• `macro`: 1 \\(filtered\\)"));
  assertValidMarkdownV2(sent[1].text, "/categories updated window");
});

test("/categories enforces ALLOWED_CHAT_IDS, falls back to status target lastEvent, and bounds worst-case output", async () => {
  // 1. Fallback to status().targets[].lastEvent + allowlist enforcement
  const { bot: fallbackBot, sent: fallbackSent } = makeBotHarness({
    configOverrides: { allowedChatIds: ["-1001234567890"] },
    targets: [
      {
        source: "market",
        contractId: "C" + "A".repeat(55),
        lastEvent: {
          source: "market",
          contractId: "C" + "A".repeat(55),
          ledger: 55,
          txHash: "f".repeat(64),
          at: 1_700_000_000,
          eventId: "55-0",
          payload: { name: "claim_created", claimId: 3, creator: "GEEE", category: "science" },
        },
      },
    ],
  });

  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    await fallbackBot.handleUpdate(
      slashUpdate("/categories", { updateId: 1, chatId: -1009999999999 }),
    );
  } finally {
    console.warn = origWarn;
  }
  assert.equal(fallbackSent.length, 0, "unapproved chat must be ignored silently");

  await fallbackBot.handleUpdate(
    slashUpdate("/categories", { updateId: 2, chatId: -1001234567890 }),
  );
  assert.equal(fallbackSent.length, 1);
  assert.ok(fallbackSent[0].text.includes("• `science`: 1"));

  // 2. Worst-case 30 categories of 100 MarkdownV2 reserved characters stay strictly < 4096 chars
  const adversarialEvents = Array.from({ length: 30 }, (_, idx) => ({
    source: "market",
    contractId: "C" + "A".repeat(55),
    ledger: 300 + idx,
    txHash: "1".repeat(64),
    at: 1_700_000_300 + idx,
    eventId: `${300 + idx}-0`,
    payload: {
      name: "claim_created",
      claimId: idx + 1,
      creator: "GFFF",
      category: `${idx}_${"*.-!()[]{}".repeat(10)}`,
    },
  }));

  const derived = deriveCategoryCounts(adversarialEvents);
  const boundedText = categoriesMessage(derived, { notificationCategories: ["none"] });
  assert.ok(boundedText.length <= MAX_CATEGORIES_MESSAGE_CHARS);
  assert.ok(boundedText.length < 4096, "must fit within one Telegram message");
  assert.match(boundedText, /_…and \d+ more_/);
  assertValidMarkdownV2(boundedText, "worst-case bounded /categories output");
});
