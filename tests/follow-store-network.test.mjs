import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NETWORK_PASSPHRASES } from "../dist/config.js";
import {
  FollowStoreMigrationRequiredError,
  FollowStoreNetworkMismatchError,
  NETWORK_BOUND_STORE_VERSION,
  createFollowStore,
  createNetworkBoundFollowStore,
  migrateFollowStoreNetwork,
  registerCommandHandlers,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "follow-network-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("records Stellar network identity in versioned v2 schema and reloads on matching network", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const testnetStore = createNetworkBoundFollowStore(filePath, {
      network: "testnet",
      networkPassphrase: NETWORK_PASSPHRASES.testnet,
    });

    assert.equal(testnetStore.follow("-100111", "market:42"), true);
    assert.equal(testnetStore.follow("-100111", "squad:7"), true);

    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(raw.version, NETWORK_BOUND_STORE_VERSION);
    assert.deepEqual(raw.network, {
      network: "testnet",
      networkPassphrase: NETWORK_PASSPHRASES.testnet,
    });

    const reopened = createFollowStore({
      filePath,
      networkPassphrase: NETWORK_PASSPHRASES.testnet,
    });
    assert.deepEqual(reopened.list("-100111"), ["market:42", "squad:7"]);
  });
});

test("refuses accidental cross-network reuse without quarantining or modifying the file", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const testnetStore = createFollowStore({
      filePath,
      network: "testnet",
    });
    testnetStore.follow("-100111", "market:100");
    const bytesBefore = await fs.readFile(filePath, "utf8");

    const mainnetStore = createFollowStore({
      filePath,
      network: "mainnet",
    });

    assert.throws(
      () => mainnetStore.list("-100111"),
      (err) => {
        assert.ok(err instanceof FollowStoreNetworkMismatchError);
        assert.equal(err.storedNetwork.network, "testnet");
        assert.equal(err.expectedNetwork.network, "mainnet");
        return true;
      },
    );

    assert.throws(
      () => mainnetStore.follow("-100222", "market:200"),
      FollowStoreNetworkMismatchError,
    );

    // Ensure bot command wiring also refuses mismatched follow-store network bindings.
    const fakeBot = { command: () => undefined };
    assert.throws(
      () =>
        registerCommandHandlers(fakeBot, {
          config: {
            network: "mainnet",
            networkPassphrase: NETWORK_PASSPHRASES.mainnet,
            marketContractId: "C" + "A".repeat(55),
            squadContractId: "C" + "B".repeat(55),
            rpcUrl: "https://mainnet.sorobanrpc.com",
            horizonUrl: "https://horizon.stellar.org",
            explorerBaseUrl: "https://stellar.expert/explorer",
            botToken: "placeholder",
            chatId: "-100111",
            allowedChatIds: [],
            operatorTelegramUserId: null,
          },
          status: () => ({ running: true }),
          pause: () => "paused",
          resume: () => "resumed",
          followStore: testnetStore,
        }),
      FollowStoreNetworkMismatchError,
    );

    // Original file bytes stay intact and no .corrupt quarantine copy is created.
    const bytesAfter = await fs.readFile(filePath, "utf8");
    assert.equal(bytesAfter, bytesBefore);
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ["follows.json"]);
  });
});

test("requires explicit migration for legacy v1 files and cross-network re-binding", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const legacyPayload = {
      version: 1,
      follows: {
        "-100111": ["market:9", "squad:3"],
      },
    };
    await fs.writeFile(filePath, JSON.stringify(legacyPayload, null, 2) + "\n", "utf8");

    const boundStore = createFollowStore({
      filePath,
      network: "testnet",
    });

    assert.throws(
      () => boundStore.list("-100111"),
      (err) => {
        assert.ok(err instanceof FollowStoreMigrationRequiredError);
        assert.equal(err.fromVersion, 1);
        return true;
      },
    );

    // Explicit v1 -> v2 migration binds to testnet while preserving subscriptions.
    const migResult = migrateFollowStoreNetwork(filePath, { network: "testnet" });
    assert.equal(migResult.migrated, true);
    assert.equal(migResult.previousVersion, 1);
    assert.equal(migResult.totalFollows, 2);
    assert.deepEqual(boundStore.list("-100111"), ["market:9", "squad:3"]);

    // Cross-network migration without source confirmation is refused.
    assert.throws(
      () => migrateFollowStoreNetwork(filePath, { network: "mainnet" }),
      FollowStoreNetworkMismatchError,
    );

    // Explicit source network confirmation re-binds cleanly.
    const crossMig = migrateFollowStoreNetwork(
      filePath,
      { network: "mainnet" },
      { expectedSourceNetwork: "testnet" },
    );
    assert.equal(crossMig.migrated, true);
    assert.equal(crossMig.network.network, "mainnet");

    const mainnetStore = createFollowStore({ filePath, network: "mainnet" });
    assert.deepEqual(mainnetStore.list("-100111"), ["market:9", "squad:3"]);
  });
});
