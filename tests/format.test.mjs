import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { escapeMd, formatEvent } from "../dist/notifications/format.js";

const reserved = "_*[]()~`>#+-=|{}.\\!";
const reservedSet = new Set(Array.from(reserved));

function expectedEscape(value) {
  return Array.from(value, (char) =>
    reservedSet.has(char) ? `\\${char}` : char,
  ).join("");
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

test("escapeMd escapes every MarkdownV2 reserved character exactly once", () => {
  assert.equal(escapeMd(reserved), expectedEscape(reserved));
  assert.equal(escapeMd("plain café 🛰️\nnext line"), "plain café 🛰️\nnext line");
});

test("escapeMd matches the character-wise rule for deterministic fuzz inputs", () => {
  const alphabet = Array.from(`${reserved}abcXYZ09 café\n\r\t\0🛰️e\u0301`);
  const random = seededRandom(0x5eedc0de);

  for (let sample = 0; sample < 1000; sample += 1) {
    const length = Math.floor(random() * 257);
    let input = "";
    for (let index = 0; index < length; index += 1) {
      input += alphabet[Math.floor(random() * alphabet.length)];
    }
    assert.equal(escapeMd(input), expectedEscape(input), `sample ${sample}`);
  }
});

test("formatted untrusted event text reaches Telegram as exact MarkdownV2", async () => {
  const config = {
    chatId: "-1001234567890",
    marketContractId: "market",
    squadContractId: "squad",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  };
  const event = {
    source: "market",
    contractId: "market",
    ledger: 42,
    txHash: "",
    at: 0,
    eventId: "42-0",
    payload: {
      name: "claim_created",
      claimId: 7,
      creator: "GABCD",
      category: reserved,
    },
  };
  const message = formatEvent(config, event);
  const expectedMessage =
    `🆕 *New claim* \\#7\nCategory: ${expectedEscape(reserved)}\n` +
    "Creator: `GABCD`\n_ledger 42_";
  const sent = [];
  const fakeBot = {
    api: {
      sendMessage: async (...args) => {
        sent.push(args);
        return {};
      },
    },
  };

  assert.equal(message, expectedMessage);
  await createNotifier(fakeBot, config)(message);
  assert.deepEqual(sent, [
    [
      config.chatId,
      expectedMessage,
      {
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      },
    ],
  ]);
});

test("createNotifier preserves Telegram send failures for the poller", async () => {
  const error = new Error("Telegram API unavailable");
  const fakeBot = { api: { sendMessage: async () => Promise.reject(error) } };
  const notify = createNotifier(fakeBot, { chatId: "-1001234567890" });
  await assert.rejects(notify("message"), error);
});

test("escapeMd handles a long adversarial string without dropping characters", () => {
  const input = reserved.repeat(10_000);
  const escaped = escapeMd(input);
  assert.equal(escaped, expectedEscape(input));
});
