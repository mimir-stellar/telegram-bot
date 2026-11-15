import assert from "node:assert/strict";
import test from "node:test";

import {
  admitRpcProvider,
  assertNetworkIdentity,
  normalizeAdmissionProviderLabel,
  RpcProviderAdmissionError,
  RpcProviderAdmissionGate,
} from "../dist/stellar/client.js";
import { defaultMockScenario, startMockRpc } from "../dist/stellar/mock-rpc.js";
import { MOCK_NETWORK_PASSPHRASE } from "../dist/stellar/mock-constants.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function makeFakeServer({
  health = { status: "healthy", oldestLedger: 1000, latestLedger: 2000 },
  network = { passphrase: TESTNET_PASSPHRASE, protocolVersion: 22 },
  events = { events: [], cursor: "2000-0", latestLedger: 2000 },
} = {}) {
  let getEventsCalls = 0;
  return {
    get getEventsCalls() {
      return getEventsCalls;
    },
    getHealth: async () => (typeof health === "function" ? health() : health),
    getNetwork: async () => (typeof network === "function" ? network() : network),
    getEvents: async () => {
      getEventsCalls += 1;
      return typeof events === "function" ? events() : events;
    },
  };
}

test("assertNetworkIdentity accepts matching passphrase and normalizes protocolVersion", () => {
  const resNum = assertNetworkIdentity(
    { passphrase: TESTNET_PASSPHRASE, protocolVersion: 22 },
    TESTNET_PASSPHRASE,
    "https://soroban-testnet.stellar.org/",
  );
  assert.deepEqual(resNum, { protocolVersion: 22 });

  const resStr = assertNetworkIdentity(
    { passphrase: TESTNET_PASSPHRASE, protocolVersion: "22.1.0" },
    TESTNET_PASSPHRASE,
    "https://soroban-testnet.stellar.org",
  );
  assert.deepEqual(resStr, { protocolVersion: "22.1.0" });

  const resMissingProto = assertNetworkIdentity(
    { passphrase: TESTNET_PASSPHRASE },
    TESTNET_PASSPHRASE,
    "testnet-primary",
  );
  assert.deepEqual(resMissingProto, { protocolVersion: null });
});

test("assertNetworkIdentity rejects mismatched network without leaking either passphrase", () => {
  assert.throws(
    () =>
      assertNetworkIdentity(
        { passphrase: MAINNET_PASSPHRASE, protocolVersion: 22 },
        TESTNET_PASSPHRASE,
        "https://mainnet-rpc.example.org",
      ),
    (err) => {
      assert(err instanceof RpcProviderAdmissionError);
      assert.equal(err.problem, "network-mismatch");
      assert.equal(err.provider, "https://mainnet-rpc.example.org");
      assert(!err.message.includes("Test SDF Network"));
      assert(!err.message.includes("Public Global Stellar"));
      assert.match(err.message, /configured=33 chars, received=46 chars/);
      return true;
    },
  );
});

test("assertNetworkIdentity rejects malformed network payloads and empty expected passphrases", () => {
  for (const invalidResp of [null, undefined, "bad", 42, [], {}, { passphrase: null }, { passphrase: 99 }]) {
    assert.throws(
      () => assertNetworkIdentity(invalidResp, TESTNET_PASSPHRASE, "https://rpc.example.org"),
      (err) => {
        assert(err instanceof RpcProviderAdmissionError);
        assert.equal(err.problem, "malformed-network");
        assert(!err.message.includes(TESTNET_PASSPHRASE));
        return true;
      },
    );
  }

  for (const badExpected of ["", "   ", null, undefined, 123]) {
    assert.throws(
      () =>
        assertNetworkIdentity(
          { passphrase: TESTNET_PASSPHRASE },
          badExpected,
          "https://rpc.example.org",
        ),
      (err) => {
        assert(err instanceof RpcProviderAdmissionError);
        assert.equal(err.problem, "invalid-expected-passphrase");
        return true;
      },
    );
  }
});

test("normalizeAdmissionProviderLabel strips embedded URL userinfo, query strings, and fragments", () => {
  const userInfo = ["operator", "cred99"].join(":");
  const rawUrl = `https://${userInfo}@RPC.Example.ORG:8443/soroban/v1/?key=alpha#frag`;
  const normalized = normalizeAdmissionProviderLabel(rawUrl);

  assert.equal(normalized, "https://rpc.example.org:8443/soroban/v1");
  assert(!normalized.includes("operator"));
  assert(!normalized.includes("cred99"));
  assert(!normalized.includes("alpha"));
  assert(!normalized.includes("frag"));
});

test("admitRpcProvider admits a healthy provider serving the configured network", async () => {
  const server = makeFakeServer();
  const admitted = await admitRpcProvider(
    { provider: "https://soroban-testnet.stellar.org/rpc/", server },
    { networkPassphrase: TESTNET_PASSPHRASE },
    { now: () => 1_700_000_000_000 },
  );

  assert.equal(admitted.provider, "https://soroban-testnet.stellar.org/rpc");
  assert.equal(admitted.admittedAtMs, 1_700_000_000_000);
  assert.deepEqual(admitted.ledgerWindow, { oldestLedger: 1000, latestLedger: 2000 });
  assert.equal(admitted.protocolVersion, 22);
  assert.equal(admitted.server, server);
});

test("admitRpcProvider rejects a healthy provider serving another network", async () => {
  const healthyWrongNetwork = makeFakeServer({
    health: { status: "healthy", oldestLedger: 50_000, latestLedger: 150_000 },
    network: { passphrase: MAINNET_PASSPHRASE, protocolVersion: 22 },
  });

  await assert.rejects(
    () =>
      admitRpcProvider(
        { provider: "https://healthy-mainnet.example.org", server: healthyWrongNetwork },
        { networkPassphrase: TESTNET_PASSPHRASE },
      ),
    (err) => {
      assert(err instanceof RpcProviderAdmissionError);
      assert.equal(err.problem, "network-mismatch");
      assert.equal(err.provider, "https://healthy-mainnet.example.org");
      assert(!err.message.includes(TESTNET_PASSPHRASE));
      assert(!err.message.includes(MAINNET_PASSPHRASE));
      return true;
    },
  );
  assert.equal(healthyWrongNetwork.getEventsCalls, 0);
});

test("admitRpcProvider rejects unhealthy endpoints, malformed windows, and RPC timeouts", async () => {
  const unhealthy = makeFakeServer({
    health: { status: "syncing", oldestLedger: 100, latestLedger: 200 },
  });
  await assert.rejects(
    () =>
      admitRpcProvider(
        { provider: "https://syncing.example.org", server: unhealthy },
        { networkPassphrase: TESTNET_PASSPHRASE },
      ),
    (err) => err instanceof RpcProviderAdmissionError && err.problem === "unhealthy-status",
  );

  const invertedWindow = makeFakeServer({
    health: { status: "healthy", oldestLedger: 500, latestLedger: 100 },
  });
  await assert.rejects(
    () =>
      admitRpcProvider(
        { provider: "https://inverted.example.org", server: invertedWindow },
        { networkPassphrase: TESTNET_PASSPHRASE },
      ),
    (err) => err instanceof RpcProviderAdmissionError && err.problem === "malformed-health-window",
  );

  const slowNetwork = makeFakeServer({
    network: () => new Promise((resolve) => setTimeout(resolve, 200)),
  });
  await assert.rejects(
    () =>
      admitRpcProvider(
        { provider: "https://slow-net.example.org", server: slowNetwork },
        { networkPassphrase: TESTNET_PASSPHRASE },
        { timeoutMs: 25 },
      ),
    (err) =>
      err instanceof RpcProviderAdmissionError &&
      err.problem === "network-failed" &&
      /timed out/i.test(err.message),
  );
});

test("RpcProviderAdmissionGate.admitMany filters out healthy wrong-network providers", async () => {
  let clock = 5_000;
  const gate = new RpcProviderAdmissionGate(
    { networkPassphrase: TESTNET_PASSPHRASE },
    { now: () => (clock += 100), maxRecords: 4 },
  );

  const goodA = makeFakeServer({
    health: { status: "healthy", oldestLedger: 100, latestLedger: 500 },
    network: { passphrase: TESTNET_PASSPHRASE, protocolVersion: 22 },
  });
  const wrongNet = makeFakeServer({
    health: { status: "healthy", oldestLedger: 100, latestLedger: 500 },
    network: { passphrase: MAINNET_PASSPHRASE, protocolVersion: 22 },
  });
  const downNet = makeFakeServer({
    health: () => Promise.reject(new Error("ECONNREFUSED")),
  });
  const goodB = makeFakeServer({
    health: { status: "healthy", oldestLedger: 120, latestLedger: 505 },
    network: { passphrase: TESTNET_PASSPHRASE, protocolVersion: 22 },
  });

  const result = await gate.admitMany([
    { provider: "https://testnet-a.example.org", server: goodA },
    { provider: "https://mainnet-wrong.example.org", server: wrongNet },
    { provider: "https://offline.example.org", server: downNet },
    { provider: "https://testnet-b.example.org", server: goodB },
  ]);

  assert.deepEqual(
    result.admitted.map((p) => p.provider),
    ["https://testnet-a.example.org", "https://testnet-b.example.org"],
  );
  assert.equal(result.rejected.length, 2);
  assert.equal(result.rejected[0].provider, "https://mainnet-wrong.example.org");
  assert.equal(result.rejected[0].problem, "network-mismatch");
  assert.equal(result.rejected[1].provider, "https://offline.example.org");
  assert.equal(result.rejected[1].problem, "health-failed");

  const snap = gate.snapshot();
  assert.equal(snap.admitted.length, 2);
  assert.equal(snap.rejections.length, 2);
});

test("RpcProviderAdmissionGate.guardServer blocks getEvents until network identity is admitted", async () => {
  const gate = new RpcProviderAdmissionGate({ networkPassphrase: TESTNET_PASSPHRASE });
  const matchingServer = makeFakeServer();
  const guarded = gate.guardServer({
    provider: "https://guarded-testnet.example.org",
    server: matchingServer,
  });

  assert.equal(guarded.isAdmitted(), false);
  await assert.rejects(
    () => guarded.getEvents({ startLedger: 1500, filters: [] }),
    (err) => err instanceof RpcProviderAdmissionError && err.problem === "provider-not-admitted",
  );
  assert.equal(matchingServer.getEventsCalls, 0);

  await guarded.admit();
  assert.equal(guarded.isAdmitted(), true);
  const page = await guarded.getEvents({ startLedger: 1500, filters: [] });
  assert.equal(page.latestLedger, 2000);
  assert.equal(matchingServer.getEventsCalls, 1);

  guarded.evict();
  assert.equal(guarded.isAdmitted(), false);
  await assert.rejects(
    () => guarded.getEvents({ startLedger: 1500, filters: [] }),
    (err) => err instanceof RpcProviderAdmissionError && err.problem === "provider-not-admitted",
  );

  const wrongNetServer = makeFakeServer({
    network: { passphrase: MAINNET_PASSPHRASE, protocolVersion: 22 },
  });
  const guardedWrong = gate.guardServer({
    provider: "https://guarded-mainnet.example.org",
    server: wrongNetServer,
  });
  await assert.rejects(
    () => guardedWrong.admit(),
    (err) => err instanceof RpcProviderAdmissionError && err.problem === "network-mismatch",
  );
  assert.equal(guardedWrong.isAdmitted(), false);
  await assert.rejects(
    () => guardedWrong.getEvents({ startLedger: 1500, filters: [] }),
    (err) => err instanceof RpcProviderAdmissionError && err.problem === "provider-not-admitted",
  );
  assert.equal(wrongNetServer.getEventsCalls, 0);
});

test("admitRpcProvider integrates with loopback mock RPC and rejects mismatched config", async () => {
  const mock = await startMockRpc({
    port: 0,
    scenario: defaultMockScenario(),
    quiet: true,
  });
  try {
    const rpcClient = {
      async getHealth() {
        const res = await fetch(mock.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
        });
        const body = await res.json();
        return body.result;
      },
      async getNetwork() {
        const res = await fetch(mock.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getNetwork" }),
        });
        const body = await res.json();
        return body.result;
      },
    };

    const admitted = await admitRpcProvider(
      { provider: mock.url, server: rpcClient },
      { networkPassphrase: MOCK_NETWORK_PASSPHRASE },
    );
    assert.equal(admitted.ledgerWindow.latestLedger, defaultMockScenario().latestLedger);

    await assert.rejects(
      () =>
        admitRpcProvider(
          { provider: mock.url, server: rpcClient },
          { networkPassphrase: TESTNET_PASSPHRASE },
        ),
      (err) => err instanceof RpcProviderAdmissionError && err.problem === "network-mismatch",
    );
  } finally {
    await mock.close();
  }
});
