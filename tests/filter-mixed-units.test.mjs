import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig } from "../dist/config.js";
import {
  InvalidThresholdError,
  parseUsdcThreshold,
} from "../dist/notifications/amount-threshold.js";
import {
  FilterParseError,
  MixedUnitFilterError,
  evaluateFilterRule,
  parseFilterExpression,
} from "../dist/notifications/filter-expr.js";
import { createPoller } from "../dist/poller.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const SAMPLE_ADDR = "GBMGZ4WXIR2YQMJTLKJMCTVF3LGVQHSNXKGN6JD5MSHH4SLIRM4IR2Y";
const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SQUAD_ID = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBF4";
const FAKE_BOT_TOKEN = ["123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghi"].join("_");

function mockEvent(source, payload, ledger = 5120) {
  return {
    source,
    contractId: source === "market" ? MARKET_ID : SQUAD_ID,
    version: "v1",
    ledger,
    txHash: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    at: 1700000000,
    eventId: "0000005120-0000000001",
    eventType: "contract",
    transactionIndex: 1,
    operationIndex: 1,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("parseFilterExpression: rejects mixed-unit literal comparisons across USDC amounts, identifiers, ledgers, and shares", () => {
  const mixedCases = [
    {
      expr: "claim_created where claimId == 100 USDC",
      leftUnit: "identifier",
      rightUnit: "usdc_amount",
    },
    {
      expr: "where marketId >= $10",
      leftUnit: "identifier",
      rightUnit: "usdc_amount",
    },
    {
      expr: "claim_created where ledger >= 1000 USDC",
      leftUnit: "ledger",
      rightUnit: "usdc_amount",
    },
    {
      expr: "where ledger == $50",
      leftUnit: "ledger",
      rightUnit: "usdc_amount",
    },
    {
      expr: "claim_challenged where stake >= 5000 ledger",
      leftUnit: "usdc_amount",
      rightUnit: "ledger",
    },
    {
      expr: "claim_created where claimId == 5000 ledgers",
      leftUnit: "identifier",
      rightUnit: "ledger",
    },
    {
      expr: "claim_challenged where stake == #42",
      leftUnit: "usdc_amount",
      rightUnit: "identifier",
    },
    {
      expr: "claim_created where ledger == #42",
      leftUnit: "ledger",
      rightUnit: "identifier",
    },
    {
      expr: "deposited where shares >= 100 USDC",
      leftUnit: "shares",
      rightUnit: "usdc_amount",
    },
    {
      expr: "claim_created where claimId == 10.5",
      leftUnit: "identifier",
      rightUnit: "decimal",
    },
    {
      expr: "where ledger >= 100.25",
      leftUnit: "ledger",
      rightUnit: "decimal",
    },
    {
      expr: "deposited where shares >= 10.5",
      leftUnit: "shares",
      rightUnit: "decimal",
    },
  ];

  for (const c of mixedCases) {
    assert.throws(
      () => parseFilterExpression(c.expr),
      (err) => {
        assert.ok(err instanceof FilterParseError, `Expected FilterParseError for: ${c.expr}`);
        assert.ok(
          err instanceof MixedUnitFilterError,
          `Expected MixedUnitFilterError for: ${c.expr}`,
        );
        assert.equal(err.code, "MIXED_UNIT_COMPARISON");
        assert.equal(err.leftUnit, c.leftUnit, `leftUnit mismatch for: ${c.expr}`);
        assert.equal(err.rightUnit, c.rightUnit, `rightUnit mismatch for: ${c.expr}`);
        return true;
      },
    );
  }
});

test("parseFilterExpression: rejects cross-unit field comparisons while allowing same-unit field comparisons", () => {
  const invalidFieldComparisons = [
    {
      expr: "claim_challenged where stake == claimId",
      leftUnit: "usdc_amount",
      rightUnit: "identifier",
    },
    {
      expr: "deposited where amount == ledger",
      leftUnit: "usdc_amount",
      rightUnit: "ledger",
    },
    {
      expr: "claim_created where claimId == ledger",
      leftUnit: "identifier",
      rightUnit: "ledger",
    },
    {
      expr: "deposited where amount >= shares",
      leftUnit: "usdc_amount",
      rightUnit: "shares",
    },
    {
      expr: "where stake == claimId",
      leftUnit: "usdc_amount",
      rightUnit: "identifier",
    },
  ];

  for (const c of invalidFieldComparisons) {
    assert.throws(
      () => parseFilterExpression(c.expr),
      (err) =>
        err instanceof MixedUnitFilterError &&
        err.leftUnit === c.leftUnit &&
        err.rightUnit === c.rightUnit,
      `Expected MixedUnitFilterError for: ${c.expr}`,
    );
  }

  // Same-unit USDC atomic amount field comparisons succeed and evaluate cleanly
  const sameUnitRule = parseFilterExpression("claimed where net >= fee and gross > net");
  const matchingClaimed = mockEvent("squad", {
    name: "claimed",
    marketId: 7,
    participant: SAMPLE_ADDR,
    gross: 100_000_000n,
    fee: 5_000_000n,
    net: 95_000_000n,
  });
  const failingClaimed = mockEvent("squad", {
    name: "claimed",
    marketId: 7,
    participant: SAMPLE_ADDR,
    gross: 10_000_000n,
    fee: 8_000_000n,
    net: 2_000_000n,
  });

  assert.equal(evaluateFilterRule(sameUnitRule, matchingClaimed), true);
  assert.equal(evaluateFilterRule(sameUnitRule, failingClaimed), false);
});

test("evaluateFilterRule: evaluates compatible USDC atomic amounts, #id identifiers, and ledger numbers accurately", () => {
  const rule = parseFilterExpression(
    "claim_challenged where claimId == #42 and ledger >= 5000 ledger and stake >= 12.5 USDC",
  );

  const match = mockEvent(
    "market",
    {
      name: "claim_challenged",
      claimId: 42,
      challenger: SAMPLE_ADDR,
      stake: 125_000_000n,
    },
    5120,
  );
  const wrongLedger = mockEvent(
    "market",
    {
      name: "claim_challenged",
      claimId: 42,
      challenger: SAMPLE_ADDR,
      stake: 125_000_000n,
    },
    4999,
  );
  const wrongStake = mockEvent(
    "market",
    {
      name: "claim_challenged",
      claimId: 42,
      challenger: SAMPLE_ADDR,
      stake: 124_999_999n,
    },
    5120,
  );

  assert.equal(evaluateFilterRule(rule, match), true);
  assert.equal(evaluateFilterRule(rule, wrongLedger), false);
  assert.equal(evaluateFilterRule(rule, wrongStake), false);
});

test("parseUsdcThreshold: rejects non-USDC unit tokens with InvalidThresholdError", () => {
  for (const bad of ["1000 ledger", "500 ledgers", "#42", "claimId"]) {
    assert.throws(
      () => parseUsdcThreshold(bad),
      (err) => err instanceof InvalidThresholdError && /mixed-unit/i.test(err.message),
      `Expected InvalidThresholdError for: ${bad}`,
    );
  }
});

test("startup fails before live polling starts when NOTIFY_FILTER or config.filterExpression mixes units", async () => {
  await withTempDataDir(async (dir) => {
    // 1. loadConfig() fails fast on mixed-unit NOTIFY_FILTER before creating RPC or poller
    const envKeys = [
      "BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
      "MARKET_CONTRACT_ID",
      "SQUAD_CONTRACT_ID",
      "NOTIFY_FILTER",
    ];
    const savedEnv = new Map(envKeys.map((k) => [k, process.env[k]]));
    try {
      process.env.BOT_TOKEN = FAKE_BOT_TOKEN;
      process.env.TELEGRAM_CHAT_ID = "-1001234567890";
      process.env.MARKET_CONTRACT_ID = MARKET_ID;
      process.env.SQUAD_CONTRACT_ID = SQUAD_ID;
      process.env.NOTIFY_FILTER = "claim_created where claimId == 100 USDC";

      assert.throws(
        () => loadConfig(),
        (err) =>
          err instanceof ConfigError &&
          err.problems.some((p) => p.includes("NOTIFY_FILTER is invalid") && p.includes("Mixed-unit")),
      );

      process.env.NOTIFY_FILTER = "claim_challenged where stake >= 25 USDC";
      const validCfg = loadConfig();
      assert.equal(validCfg.filterExpression, "claim_challenged where stake >= 25 USDC");
    } finally {
      for (const [k, v] of savedEnv.entries()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // 2. createPoller() rejects mixed-unit filterExpression synchronously before any RPC or send call
    let rpcCalls = 0;
    let telegramSends = 0;
    const fakeServer = {
      async getHealth() {
        rpcCalls += 1;
        return { status: "healthy", oldestLedger: 100, latestLedger: 200 };
      },
      async getEvents() {
        rpcCalls += 1;
        return { events: [], latestLedger: 200 };
      },
    };

    assert.throws(
      () =>
        createPoller({
          config: {
            botToken: FAKE_BOT_TOKEN,
            chatId: "-1001234567890",
            chatIds: ["-1001234567890"],
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
            pollIntervalMs: 100_000,
            startLookbackLedgers: 60,
            cursorFile: dir.file("cursor.json"),
            lockFile: dir.file("poller.lock"),
            statusFile: dir.file("status.json"),
            maxNotificationsPerCycle: 5,
            interSendDelayMs: 0,
            metricsPort: null,
            notificationCategories: [],
            silentEvents: [],
            csvOutputFile: dir.file("events.csv"),
            featureFlags: { enabled: true, market: true, squad: true },
            filterExpression: "where ledger >= $50",
            auditFile: "",
            dedupWindow: 64,
            deadLetterFile: "",
            deadLetterMax: 50,
            deadLetterMaxAttempts: 3,
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
          },
          server: fakeServer,
          send: async () => {
            telegramSends += 1;
          },
        }),
      (err) => err instanceof MixedUnitFilterError && err.leftUnit === "ledger",
    );

    assert.equal(rpcCalls, 0);
    assert.equal(telegramSends, 0);
  });
});
