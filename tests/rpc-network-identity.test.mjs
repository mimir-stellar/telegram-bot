/**
 * Focused tests for endpoint network identity validation before admitting an RPC provider.
 *
 * Covers:
 * - assertNetworkIdentity() boundary guard in src/stellar/rpc-guard.ts
 * - admitRpcProvider() in src/stellar/client.ts:
 *   - admits a healthy provider matching the configured network passphrase
 *   - rejects a healthy provider serving another network (e.g. Mainnet vs Testnet)
 *   - rejects malformed or failing getNetwork responses
 *   - rejects unhealthy providers before network identity admission
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertNetworkIdentity,
  RpcNetworkIdentityError,
} from "../dist/stellar/rpc-guard.js";
import {
  admitRpcProvider,
  LedgerWindowError,
  NetworkPassphraseMismatchError,
} from "../dist/stellar/client.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function makeHealthyProvider(passphrase) {
  return {
    getHealth: async () => ({
      status: "healthy",
      oldestLedger: 1000,
      latestLedger: 2000,
    }),
    getNetwork: async () => ({
      passphrase,
      protocolVersion: 22,
    }),
  };
}

// ── assertNetworkIdentity (rpc-guard) ─────────────────────────────────────────

test("assertNetworkIdentity accepts a matching passphrase", () => {
  const identity = assertNetworkIdentity(
    { passphrase: TESTNET_PASSPHRASE, protocolVersion: 22 },
    TESTNET_PASSPHRASE,
  );
  assert.deepEqual(identity, { passphrase: TESTNET_PASSPHRASE });
});

test("assertNetworkIdentity rejects a different network passphrase without leaking raw values", () => {
  assert.throws(
    () =>
      assertNetworkIdentity(
        { passphrase: MAINNET_PASSPHRASE },
        TESTNET_PASSPHRASE,
      ),
    (err) => {
      assert.ok(err instanceof RpcNetworkIdentityError);
      assert.equal(err.problem, "passphrase-mismatch");
      assert.ok(!err.message.includes(TESTNET_PASSPHRASE));
      assert.ok(!err.message.includes(MAINNET_PASSPHRASE));
      assert.ok(err.message.includes("chars"));
      return true;
    },
  );
});

test("assertNetworkIdentity rejects non-object responses", () => {
  for (const input of [null, undefined, "Test SDF Network ; September 2015", 42, []]) {
    assert.throws(
      () => assertNetworkIdentity(input, TESTNET_PASSPHRASE),
      (err) => {
        assert.ok(err instanceof RpcNetworkIdentityError);
        assert.equal(err.problem, "not-an-object");
        return true;
      },
    );
  }
});

test("assertNetworkIdentity rejects missing or non-string passphrase", () => {
  for (const input of [{}, { passphrase: null }, { passphrase: 123 }]) {
    assert.throws(
      () => assertNetworkIdentity(input, TESTNET_PASSPHRASE),
      (err) => {
        assert.ok(err instanceof RpcNetworkIdentityError);
        assert.equal(err.problem, "malformed-passphrase");
        return true;
      },
    );
  }
});

// ── admitRpcProvider (client) ─────────────────────────────────────────────────

test("admitRpcProvider admits a healthy provider serving the configured network", async () => {
  const provider = makeHealthyProvider(TESTNET_PASSPHRASE);
  const admitted = await admitRpcProvider(provider, {
    networkPassphrase: TESTNET_PASSPHRASE,
  });

  assert.equal(admitted.server, provider);
  assert.deepEqual(admitted.health, {
    status: "healthy",
    oldestLedger: 1000,
    latestLedger: 2000,
  });
  assert.deepEqual(admitted.network, {
    passphrase: TESTNET_PASSPHRASE,
  });
});

test("admitRpcProvider rejects a healthy provider serving another network", async () => {
  // Provider is completely healthy, with a valid ledger window,
  // but serves Mainnet while Testnet is configured.
  const wrongNetworkProvider = makeHealthyProvider(MAINNET_PASSPHRASE);

  await assert.rejects(
    () =>
      admitRpcProvider(wrongNetworkProvider, {
        networkPassphrase: TESTNET_PASSPHRASE,
      }),
    (err) => {
      assert.ok(err instanceof NetworkPassphraseMismatchError);
      assert.equal(err.problem, "mismatch");
      assert.ok(!err.message.includes(TESTNET_PASSPHRASE));
      assert.ok(!err.message.includes(MAINNET_PASSPHRASE));
      return true;
    },
  );
});

test("admitRpcProvider rejects a healthy provider when getNetwork returns malformed payload", async () => {
  const provider = {
    getHealth: async () => ({
      status: "healthy",
      oldestLedger: 1000,
      latestLedger: 2000,
    }),
    getNetwork: async () => ({ protocolVersion: 22 }),
  };

  await assert.rejects(
    () => admitRpcProvider(provider, { networkPassphrase: TESTNET_PASSPHRASE }),
    (err) => {
      assert.ok(err instanceof NetworkPassphraseMismatchError);
      assert.equal(err.problem, "malformed");
      return true;
    },
  );
});

test("admitRpcProvider rejects a healthy provider when getNetwork throws", async () => {
  const provider = {
    getHealth: async () => ({
      status: "healthy",
      oldestLedger: 1000,
      latestLedger: 2000,
    }),
    getNetwork: async () => {
      throw new Error("network probe failed");
    },
  };

  await assert.rejects(
    () => admitRpcProvider(provider, { networkPassphrase: TESTNET_PASSPHRASE }),
    (err) => {
      assert.ok(err instanceof NetworkPassphraseMismatchError);
      assert.equal(err.problem, "missing");
      assert.ok(err.message.includes("getNetwork failed"));
      return true;
    },
  );
});

test("admitRpcProvider rejects an unhealthy provider before calling getNetwork", async () => {
  let getNetworkCalled = false;
  const unhealthyProvider = {
    getHealth: async () => ({
      status: "unhealthy",
      oldestLedger: 1000,
      latestLedger: 2000,
    }),
    getNetwork: async () => {
      getNetworkCalled = true;
      return { passphrase: TESTNET_PASSPHRASE };
    },
  };

  await assert.rejects(
    () =>
      admitRpcProvider(unhealthyProvider, {
        networkPassphrase: TESTNET_PASSPHRASE,
      }),
    (err) => {
      assert.ok(err instanceof LedgerWindowError);
      assert.equal(err.problem, "malformed-window");
      return true;
    },
  );
  assert.equal(getNetworkCalled, false);
});
