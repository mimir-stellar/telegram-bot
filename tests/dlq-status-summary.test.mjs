import assert from "node:assert/strict";
import test from "node:test";

import { statusMessage } from "../dist/commands/status.js";
import {
  classifyDeadLetterReason,
  createDeadLetterQueue,
} from "../dist/deadLetter.js";
import { runDlqCli, statusDeadLetters } from "../dist/dlq-cli.js";
import { buildStatusSnapshot, redactChatId, serializeStatus } from "../dist/status.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";
import { tokenize } from "./markdown-lint.test.mjs";

const RAW_MARKET_CHAT = "-1009876543210";
const RAW_SQUAD_CHANNEL = "@mimir_squad_ops";
const FAKE_BOT_TOKEN = ["1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALD", "saw"].join("_");
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

test("classifyDeadLetterReason maps upstream failures into closed reason categories", () => {
  assert.equal(classifyDeadLetterReason("Telegram API 429: Too Many Requests: retry after 5"), "rate_limited");
  assert.equal(classifyDeadLetterReason("send timed out after 15000ms"), "timeout");
  assert.equal(classifyDeadLetterReason("403 Forbidden: bot was blocked by the user"), "auth_or_permission");
  assert.equal(classifyDeadLetterReason("400 Bad Request: can't parse entities"), "bad_request");
  assert.equal(classifyDeadLetterReason("502 Bad Gateway"), "server_error");
  assert.equal(classifyDeadLetterReason("fetch failed: ECONNRESET"), "network");
  assert.equal(classifyDeadLetterReason(null), "unknown");
  assert.equal(classifyDeadLetterReason(""), "unknown");
  assert.equal(classifyDeadLetterReason("something unexpected"), "unknown");
});

test("dlq status CLI and statusDeadLetters report counts and reason categories without raw message text or chat ids", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const sensitiveBodyA = "SENSITIVE_FAILED_CLAIM_BODY_ALPHA_9911";
    const sensitiveBodyB = "SENSITIVE_FAILED_DEPOSIT_BODY_BETA_8822";

    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 5,
      secrets: [FAKE_BOT_TOKEN],
      now: () => 1_700_000_000_000,
    });
    await queue.load();
    await queue.enqueue({
      source: "market",
      ledger: 101,
      eventName: "claim_created",
      text: sensitiveBodyA,
      error: `429 Too Many Requests for chat ${RAW_MARKET_CHAT} via ${FAKE_BOT_TOKEN}`,
    });
    await queue.enqueue({
      source: "squad",
      ledger: 102,
      eventName: "deposited",
      text: sensitiveBodyB,
      error: `send timed out for ${RAW_SQUAD_CHANNEL}`,
    });

    const savedMarket = process.env.TELEGRAM_MARKET_CHAT_ID;
    const savedSquad = process.env.TELEGRAM_SQUAD_CHAT_ID;
    try {
      process.env.TELEGRAM_MARKET_CHAT_ID = RAW_MARKET_CHAT;
      process.env.TELEGRAM_SQUAD_CHAT_ID = RAW_SQUAD_CHANNEL;

      const summary = await statusDeadLetters({ filePath });
      assert.equal(summary.depth, 2);
      assert.deepEqual(summary.reasons, { rate_limited: 1, timeout: 1 });
      assert.equal(summary.destinations.length, 2);

      const stdoutJson = [];
      const resJson = await runDlqCli({
        argv: ["status", "--file", filePath, "--json"],
        stdout: (line) => stdoutJson.push(line),
        stderr: () => {},
      });
      assert.equal(resJson.exitCode, 0);
      const rawJson = stdoutJson.join("\n");
      assert.equal(rawJson.includes(sensitiveBodyA), false);
      assert.equal(rawJson.includes(sensitiveBodyB), false);
      assert.equal(rawJson.includes(RAW_MARKET_CHAT), false);
      assert.equal(rawJson.includes(RAW_SQUAD_CHANNEL), false);
      assert.equal(rawJson.includes(FAKE_BOT_TOKEN), false);

      const parsed = JSON.parse(rawJson);
      assert.equal(parsed.depth, 2);
      assert.equal(parsed.reasons.rate_limited, 1);
      assert.equal(parsed.reasons.timeout, 1);
      assert.ok(parsed.destinations.some((d) => d.destination === redactChatId(RAW_MARKET_CHAT) && d.count === 1));
      assert.ok(parsed.destinations.some((d) => d.destination === redactChatId(RAW_SQUAD_CHANNEL) && d.count === 1));

      const stdoutText = [];
      const resText = await runDlqCli({
        argv: ["status", "--file", filePath],
        stdout: (line) => stdoutText.push(line),
        stderr: () => {},
      });
      assert.equal(resText.exitCode, 0);
      const textOut = stdoutText.join("\n");
      assert.match(textOut, /depth=2/);
      assert.match(textOut, /rate_limited=1/);
      assert.match(textOut, /timeout=1/);
      assert.equal(textOut.includes(sensitiveBodyA), false);
      assert.equal(textOut.includes(RAW_MARKET_CHAT), false);
    } finally {
      if (savedMarket === undefined) delete process.env.TELEGRAM_MARKET_CHAT_ID;
      else process.env.TELEGRAM_MARKET_CHAT_ID = savedMarket;
      if (savedSquad === undefined) delete process.env.TELEGRAM_SQUAD_CHAT_ID;
      else process.env.TELEGRAM_SQUAD_CHAT_ID = savedSquad;
    }
  });
});

test("statusMessage and buildStatusSnapshot surface destination-safe dead-letter summaries with valid MarkdownV2", async () => {
  await withTempDataDir(async (dir) => {
    const sensitiveBody = "UNREDACTED_CLAIM_TEXT_DO_NOT_EXPOSE_776";
    const queue = createDeadLetterQueue({
      filePath: null,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
    });
    await queue.load();
    await queue.enqueue({
      source: "market",
      ledger: 500,
      eventName: "claim_created",
      text: sensitiveBody,
      error: "Telegram 429: Too Many Requests",
    });
    await queue.enqueue({
      source: "squad",
      ledger: 501,
      eventName: "deposited",
      text: sensitiveBody,
      error: "403 Forbidden: bot was blocked",
    });

    const cfg = {
      botToken: FAKE_BOT_TOKEN,
      chatId: RAW_MARKET_CHAT,
      marketChatId: RAW_MARKET_CHAT,
      squadChatId: RAW_SQUAD_CHANNEL,
      allowedChatIds: [],
      operatorTelegramUserId: null,
      marketContractId: MARKET_ID,
      squadContractId: SQUAD_ID,
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      explorerBaseUrl: "https://stellar.expert/explorer",
      locale: "en",
      version: "0.1.0",
      pollIntervalMs: 30_000,
      startLookbackLedgers: 60,
      cursorFile: dir.file("cursor.json"),
      lockFile: dir.file("poller.lock"),
      statusFile: dir.file("status.json"),
      maxNotificationsPerCycle: 20,
      interSendDelayMs: 0,
      metricsPort: null,
      notificationCategories: [],
      silentEvents: [],
      csvOutputFile: dir.file("events.csv"),
      featureFlags: { enabled: true, market: true, squad: true },
      auditFile: "",
      dedupWindow: 64,
      deadLetterFile: dir.file("dead-letter.json"),
      deadLetterMax: 10,
      deadLetterMaxAttempts: 5,
      sendJournalFile: "",
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
      logSampleMaxPerWindow: 5,
      logSampleWindowMs: 60_000,
      logBufferLines: 0,
      telegramWebhookUrl: null,
      telegramApiRoot: null,
      mimirAppUrl: null,
      healthAuthToken: null,
    };

    const pollerStatus = {
      running: true,
      paused: false,
      stopping: false,
      chainClockAt: 1_700_000_000_000,
      startedAt: 1_699_999_940_000,
      cycles: 4,
      lastCorrelationId: "corr-1",
      lastPollAt: 1_700_000_000_000,
      lastSuccessAt: 1_700_000_000_000,
      latestLedger: 510,
      oldestLedger: 400,
      notificationsSent: 3,
      notificationsFailed: 2,
      eventsSkipped: 0,
      emptyPages: 1,
      pagesScanned: 2,
      lastCycleEmptyPages: 0,
      lastCyclePages: 2,
      notificationsDropped: 0,
      eventsDeduplicated: 0,
      cursorRewinds: 0,
      restartGaps: 0,
      lastRestartGap: null,
      consecutiveFailures: 0,
      lastError: null,
      ledgerCache: { hits: 3, misses: 4 },
      lockFile: null,
      lockPid: null,
      pendingFlush: false,
      lastFlushAt: null,
      suppressedLogs: 0,
      deadLetter: queue.stats(),
      targets: [
        {
          source: "market",
          contractId: MARKET_ID,
          version: "v1",
          lastCycleMs: 5,
          maxCycleMs: 8,
          cursor: "123-0",
          lastEventLedger: 500,
          rewindFromLedger: null,
          cursorStale: false,
          gapLedgers: 0,
          cursorResetAt: null,
          cursorUnreadable: false,
          lastError: null,
          cyclesWithoutAdvance: 0,
          cursorStalled: false,
          consecutiveFailures: 0,
          nextEligibleAt: null,
        },
      ],
      sbomDigest: null,
      circuitBreaker: { open: false, openedAt: null },
    };

    const md = statusMessage(cfg, pollerStatus, 1_700_000_010_000);
    assert.match(md, /Parked sends: 2 waiting/);
    assert.match(md, /Parked reasons: rate\\_limited \\\(1\\\) · auth\\_or\\_permission \\\(1\\\)/);
    assert.match(md, /Parked destinations:/);
    assert.equal(md.includes(sensitiveBody), false);
    assert.equal(md.includes(RAW_MARKET_CHAT), false);
    assert.equal(md.includes(RAW_SQUAD_CHANNEL), false);

    // Verify zero MarkdownV2 syntax errors
    const tokens = tokenize(md, { allowPlaceholders: false });
    const badTokens = tokens.filter(
      (t) => t.type === "reserved" || t.type === "unclosed" || t.type === "error",
    );
    assert.deepEqual(badTokens, []);

    // Verify status.json snapshot
    const snap = buildStatusSnapshot(cfg, pollerStatus, 1_700_000_010_000);
    const serialized = serializeStatus(snap);
    assert.equal(serialized.includes(sensitiveBody), false);
    assert.equal(serialized.includes(RAW_MARKET_CHAT), false);
    assert.equal(serialized.includes(RAW_SQUAD_CHANNEL), false);
    assert.equal(snap.deadLetter.depth, 2);
    assert.deepEqual(snap.deadLetter.reasons, { rate_limited: 1, auth_or_permission: 1 });
  });
});
