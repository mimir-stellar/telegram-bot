import test from "node:test";
import assert from "node:assert";

import {
  eventExplorerUrl,
  explorerKeyboard,
} from "../dist/notifications/format.js";

// #499: an event whose transaction hash is unusable gets no explorer link and
// no keyboard, for both contracts. Stellar transaction hashes are 64 hex
// characters with no `0x` prefix, and both functions take the config first.

const VALID_HASH = "abc123".repeat(11).slice(0, 64);
assert.strictEqual(VALID_HASH.length, 64);

const CONFIG = {
  marketContractId: "market",
  squadContractId: "squad",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  chatId: "-1001234567890",
};

const base = (source, txHash) => ({
  source,
  contractId: source,
  ledger: 100,
  txHash,
  at: 0,
  eventId: "0000000429496729600-0000000001",
});

const marketEvent = (txHash) => ({
  ...base("market", txHash),
  payload: { name: "market_created", marketId: 42 },
});

const squadEvent = (txHash) => ({
  ...base("squad", txHash),
  payload: { name: "deposited", squadId: 7, user: "GABCD", amount: 10_000_000n },
});

const UNUSABLE = [
  { name: "empty", txHash: "" },
  { name: "short", txHash: "abc123" },
  { name: "non-hex", txHash: "z".repeat(64) },
  { name: "0x-prefixed", txHash: "0x" + VALID_HASH.slice(2) },
  { name: "oversized", txHash: "ab".repeat(5000) },
];

for (const factory of [marketEvent, squadEvent]) {
  const label = factory === marketEvent ? "market" : "squad";

  test(`eventExplorerUrl returns the exact URL for a ${label} event with a valid hash`, () => {
    const url = eventExplorerUrl(CONFIG, factory(VALID_HASH));
    assert.strictEqual(url, `https://stellar.expert/explorer/testnet/tx/${VALID_HASH}`);
  });

  for (const { txHash, name } of UNUSABLE) {
    test(`eventExplorerUrl returns null for a ${label} event with a ${name} hash`, () => {
      assert.strictEqual(eventExplorerUrl(CONFIG, factory(txHash)), null);
    });

    test(`explorerKeyboard returns no keyboard for a ${label} event with a ${name} hash`, () => {
      assert.strictEqual(explorerKeyboard(CONFIG, factory(txHash)), undefined);
    });
  }

  test(`explorerKeyboard attaches the explorer button for a ${label} event with a valid hash`, () => {
    const event = factory(VALID_HASH);
    const kb = explorerKeyboard(CONFIG, event);
    assert.ok(kb, "expected a keyboard");
    const explorer = kb.inline_keyboard.flat().find((b) => b.url);
    assert.ok(explorer, "expected a button with a URL");
    assert.strictEqual(explorer.url, eventExplorerUrl(CONFIG, event));
  });
}
