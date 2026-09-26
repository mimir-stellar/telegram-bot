import assert from "node:assert/strict";
import test from "node:test";

import {
  boundText,
  clearSecrets,
  DEFAULT_MAX_LEN,
  redactError,
  redactText,
  registerSecret,
  registerSecrets,
} from "../dist/redact.js";
import { buildHealthReport } from "../dist/health.js";

const BOT_TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const CHAT_ID = "-1001234567890";
/** Classic Stellar secret-key strkey shape (not a real key). */
// Ensure exact 56-char S strkey for the pattern S[A-Z2-7]{55}
const STELLAR_SECRET_56 = `S${"A".repeat(55)}`;

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test.beforeEach(() => {
  clearSecrets();
});

// ── Positive ──────────────────────────────────────────────────────────────────

test("positive: plain operational errors pass through unchanged", () => {
  const msg = "RPC getEvents failed: timeout after 5000ms";
  assert.equal(redactText(msg), msg);
  assert.equal(redactError(new Error(msg)), msg);
});

test("positive: short non-secret identifiers are preserved", () => {
  assert.equal(redactText("ledger 42 cursor none"), "ledger 42 cursor none");
  assert.equal(redactText("chat routing ok"), "chat routing ok");
});

// ── Negative ──────────────────────────────────────────────────────────────────

test("negative: Telegram bot tokens are redacted by shape", () => {
  const raw = `Unauthorized: call to https://api.telegram.org/bot${BOT_TOKEN}/sendMessage failed`;
  const out = redactText(raw);
  assert.equal(out.includes(BOT_TOKEN), false);
  assert.match(out, /\*\*\*BOT_TOKEN\*\*\*/);
});

test("negative: registered chat id is redacted", () => {
  registerSecret(CHAT_ID);
  const out = redactText(`failed to deliver to chat ${CHAT_ID}`);
  assert.equal(out.includes(CHAT_ID), false);
  assert.match(out, /\*\*\*REDACTED\*\*\*/);
});

test("negative: Stellar secret-key strkeys are redacted", () => {
  const out = redactText(`never paste ${STELLAR_SECRET_56} into logs`);
  assert.equal(out.includes(STELLAR_SECRET_56), false);
  assert.match(out, /\*\*\*STELLAR_SECRET\*\*\*/);
});

test("negative: long payment-proof style blobs are redacted", () => {
  const proof = "a".repeat(80);
  const hex = "ab".repeat(40); // 80 hex chars
  assert.equal(redactText(`proof=${proof}`).includes(proof), false);
  assert.equal(redactText(`sig=${hex}`).includes(hex), false);
});

// ── Boundary ──────────────────────────────────────────────────────────────────

test("boundary: empty and tiny inputs", () => {
  assert.equal(redactText(""), "");
  assert.equal(redactText("abc"), "abc");
  assert.equal(redactError(null), "null");
  assert.equal(redactError(undefined), "undefined");
});

test("boundary: token-like but too short is left alone", () => {
  const short = "123:short";
  assert.equal(redactText(short), short);
});

test("boundary: unbounded remote payload is truncated", () => {
  const huge = `ok ${"x".repeat(DEFAULT_MAX_LEN + 200)}`;
  const out = redactText(huge);
  assert.ok(out.length <= DEFAULT_MAX_LEN);
  assert.equal(out.endsWith("…"), true);
  assert.equal(boundText("abcdef", 4), "abc…");
});

test("boundary: Bearer header echoes are scrubbed", () => {
  const out = redactText("Authorization: Bearer super-secret-value-12345678");
  assert.equal(out.toLowerCase().includes("super-secret-value"), false);
  assert.match(out, /Bearer \*\*\*REDACTED\*\*\*/i);
});

// ── Restart ───────────────────────────────────────────────────────────────────

test("restart: secrets registered at boot remain effective after clear+re-register", () => {
  registerSecrets([BOT_TOKEN, CHAT_ID]);
  assert.equal(redactText(BOT_TOKEN).includes(BOT_TOKEN), false);

  // Simulate process restart of the module state (supervisor restart reloads process;
  // within one process, clear+register mirrors a fresh boot).
  clearSecrets();
  assert.equal(redactText(`shape still catches ${BOT_TOKEN}`).includes(BOT_TOKEN), false);

  registerSecrets([BOT_TOKEN, CHAT_ID]);
  const again = redactText(`chat ${CHAT_ID} token ${BOT_TOKEN}`);
  assert.equal(again.includes(BOT_TOKEN), false);
  assert.equal(again.includes(CHAT_ID), false);
});

// ── Regression (ops surfaces) ─────────────────────────────────────────────────

test("regression: health report redacts token embedded in lastError", () => {
  registerSecrets([BOT_TOKEN, CHAT_ID]);
  const report = buildHealthReport(
    baseConfig(),
    baseStatus({
      lastError: {
        at: 5_000,
        message: `Telegram send failed: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage 401`,
      },
      targets: [
        {
          source: "market",
          contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
          cursor: "0018276211125911551-4294967295",
          lastEventLedger: 40,
          lastError: `bot${BOT_TOKEN} rejected`,
        },
      ],
    }),
    5_500,
  );
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(BOT_TOKEN), false);
  assert.equal(blob.includes(CHAT_ID), false);
  assert.equal(blob.includes("SECRET"), false);
  assert.match(report.poller.lastError.message, /\*\*\*BOT_TOKEN\*\*\*/);
});

test("regression: health report never embeds secrets from config", () => {
  const config = baseConfig();
  const report = buildHealthReport(config, baseStatus(), 5_500);
  const blob = JSON.stringify(report);
  assert.equal(blob.includes(config.botToken), false);
  assert.equal(blob.includes(config.chatId), false);
});

test("regression: redactError handles Error, string, and JSON-able objects", () => {
  assert.equal(redactError(new Error(`tok ${BOT_TOKEN}`)).includes(BOT_TOKEN), false);
  assert.equal(redactError(`tok ${BOT_TOKEN}`).includes(BOT_TOKEN), false);
  const obj = redactError({ url: `https://api.telegram.org/bot${BOT_TOKEN}/getMe` });
  assert.equal(obj.includes(BOT_TOKEN), false);
});

test("regression: URL userinfo credentials are scrubbed", () => {
  const out = redactText("fetch failed for https://user:pass@rpc.example/path");
  assert.equal(out.includes("user:pass"), false);
  assert.match(out, /https:\/\/\*\*\*:\*\*\*@/);
});
