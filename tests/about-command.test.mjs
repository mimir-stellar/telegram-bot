import test from "node:test";
import assert from "node:assert";
import { aboutMessage } from "../dist/commands/about.js";

// aboutMessage returns MarkdownV2, so `.` and `-` arrive escaped, and the
// network line uses networkLabel(): the operator's STELLAR_NETWORK name, or
// the name inferred from the passphrase ("testnet", "public").

test("aboutMessage reports testnet details", () => {
  const message = aboutMessage({ network: "testnet" }, "1.2.3");
  assert.match(message, /^\*Stellar Bot\*$/m);
  assert.match(message, /^Version: 1\\\.2\\\.3$/m);
  assert.match(message, /^Network: testnet$/m);
  assert.match(message, /^Repository: https:\/\/github\\\.com\/example\/stellar\\-bot$/m);
});

test("aboutMessage reports a named network", () => {
  const message = aboutMessage({ network: "public" }, "0.1.0");
  assert.match(message, /^Version: 0\\\.1\\\.0$/m);
  assert.match(message, /^Network: public$/m);
  assert.match(message, /^Repository: https:\/\/github\\\.com\/example\/stellar\\-bot$/m);
});

test("aboutMessage infers the network from the passphrase when none is named", () => {
  const message = aboutMessage(
    { networkPassphrase: "Test SDF Network ; September 2015" },
    "0.1.0",
  );
  assert.match(message, /^Network: testnet$/m);
});
