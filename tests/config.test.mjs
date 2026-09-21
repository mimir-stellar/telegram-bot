import assert from "node:assert/strict";
import test from "node:test";

import { loadStellarConfig, networkLabel } from "../dist/config.js";

const contractId = `C${"A".repeat(55)}`;
const environmentKeys = [
  "MARKET_CONTRACT_ID",
  "SQUAD_CONTRACT_ID",
  "STELLAR_NETWORK_PASSPHRASE",
];

function withStellarEnvironment(passphrase, callback) {
  const previous = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.MARKET_CONTRACT_ID = contractId;
  process.env.SQUAD_CONTRACT_ID = contractId;
  process.env.STELLAR_NETWORK_PASSPHRASE = passphrase;

  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("loadStellarConfig accepts the public named network", () => {
  const config = withStellarEnvironment(
    "Public Global Stellar Network ; September 2015",
    () => loadStellarConfig(),
  );

  assert.equal(config.networkPassphrase, "Public Global Stellar Network ; September 2015");
  assert.equal(networkLabel(config), "public");
});

test("networkLabel distinguishes testnet and custom passphrases", () => {
  assert.equal(
    networkLabel({ networkPassphrase: "Test SDF Network ; September 2015" }),
    "testnet",
  );
  assert.equal(networkLabel({ networkPassphrase: "private integration network" }), "custom");
});
