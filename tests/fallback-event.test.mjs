import assert from "node:assert/strict";
import test from "node:test";

import {
  formatFallbackEvent,
  TELEGRAM_MAX_MESSAGE_LENGTH,
} from "../dist/notifications/format.js";

function baseConfig(overrides = {}) {
  return {
    chatIds: ["-1001234567890"],
    marketContractId: "CCONTRACT12345678901234567890123456789012345678901234567890",
    squadContractId: "CSQUAD12345678901234567890123456789012345678901234567890",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

test("formatFallbackEvent: unknown event name renders bounded fallback and omits payload dump", () => {
  const config = baseConfig();
  const rawPayload = {
    name: "completely_unknown_event_type",
    sensitiveField: "SECRET_TOKEN_DO_NOT_DUMP_INTO_CHANNEL",
    nestedData: { secretKey: "PRIVATE_KEY_12345" },
    amount: 999999999n,
  };
  const event = {
    source: "market",
    contractId: config.marketContractId,
    ledger: 100,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: 1700000000,
    eventId: "100-0",
    payload: rawPayload,
  };

  const output = formatFallbackEvent(config, event);

  const expected =
    "⚠️ *Event Notification Fallback* \\(market\\)\n" +
    "Contract: `CCONT…7890` · Ledger: 100 · [tx](https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)\n" +
    "Reason: _malformed payload_";

  assert.equal(output, expected);
  assert.ok(!output.includes("completely_unknown_event_type"));
  assert.ok(!output.includes("SECRET_TOKEN_DO_NOT_DUMP_INTO_CHANNEL"));
  assert.ok(!output.includes("PRIVATE_KEY_12345"));
  assert.ok(!output.includes("999999999"));
  assert.ok(output.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
});

test("formatFallbackEvent: admin payload renders safe message without raw parameters", () => {
  const config = baseConfig();
  const adminPayload = {
    name: "admin",
    action: "oracle_changed",
    sensitiveConfig: "TOP_SECRET_ADMIN_TOKEN_999",
    caller: "GBBQSECRETKEYDONOTLEAK",
  };
  const event = {
    source: "admin",
    contractId: config.marketContractId,
    ledger: 200,
    txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    at: 1700000050,
    eventId: "200-1",
    payload: adminPayload,
  };

  const output = formatFallbackEvent(config, event, "admin event not supported");

  const expected =
    "⚠️ *Event Notification Fallback* \\(admin\\)\n" +
    "Contract: `CCONT…7890` · Ledger: 200 · [tx](https://stellar.expert/explorer/testnet/tx/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)\n" +
    "Reason: _admin event not supported_";

  assert.equal(output, expected);
  assert.ok(!output.includes("TOP_SECRET_ADMIN_TOKEN_999"));
  assert.ok(!output.includes("GBBQSECRETKEYDONOTLEAK"));
  assert.ok(output.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
});

test("formatFallbackEvent: event with unusable tx hash omits tx explorer link", () => {
  const config = baseConfig();
  const event = {
    source: "market",
    contractId: config.marketContractId,
    ledger: 300,
    txHash: "",
    at: 1700000100,
    eventId: "300-2",
    payload: {
      name: "claim_challenged",
      leakedField: "SECRET_VALUE_XYZ",
    },
  };

  const output = formatFallbackEvent(config, event);

  const expected =
    "⚠️ *Event Notification Fallback* \\(market\\)\n" +
    "Contract: `CCONT…7890` · Ledger: 300\n" +
    "Reason: _malformed payload_";

  assert.equal(output, expected);
  assert.ok(!output.includes("[tx]"));
  assert.ok(!output.includes("SECRET_VALUE_XYZ"));
  assert.ok(output.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
});

test("formatFallbackEvent: custom reason with markdown characters is safely escaped and bounded", () => {
  const config = baseConfig();
  const event = {
    source: "market",
    contractId: config.marketContractId,
    ledger: 400,
    txHash: "",
    at: 1700000150,
    eventId: "400-3",
    payload: { name: "invalid" },
  };

  const rawReason = "Error: unhandled [code_500] *crash* in path/to/file!";
  const output = formatFallbackEvent(config, event, rawReason);

  assert.ok(output.includes("Reason: _Error: unhandled \\[code\\_500\\] \\*crash\\* in path/to/file\\!_"));
  assert.ok(output.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
});
