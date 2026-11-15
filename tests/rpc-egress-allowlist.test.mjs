import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, loadStellarConfig } from "../dist/config.js";
import {
  DEFAULT_MAX_RPC_REDIRECTS,
  RpcEgressError,
  assertRpcEgressAllowed,
  createRpcServer,
  isLoopbackHostname,
  normalizeRpcAllowlistEntry,
  parseRpcAllowlist,
} from "../dist/stellar/client.js";

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

function baseStellarConfig(overrides = {}) {
  return {
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    ...overrides,
  };
}

describe("parseRpcAllowlist & assertRpcEgressAllowed (#803)", () => {
  it("normalizes allowlist origins and bare host[:port] entries while rejecting wildcards, paths, or credentials", () => {
    const parsed = parseRpcAllowlist(
      " https://Soroban-Testnet.Stellar.ORG:443 , soroban-backup.stellar.org:8443 , http://127.0.0.1:8000 ",
    );
    assert.deepEqual(parsed, [
      "https://soroban-testnet.stellar.org",
      "https://soroban-backup.stellar.org:8443",
      "http://127.0.0.1:8000",
    ]);

    assert.throws(
      () => normalizeRpcAllowlistEntry("*.stellar.org"),
      (err) => err instanceof RpcEgressError && err.problem === "invalid-url",
    );
    assert.throws(
      () => normalizeRpcAllowlistEntry("https://soroban-testnet.stellar.org/rpc"),
      (err) => err instanceof RpcEgressError && err.problem === "invalid-url",
    );
    const cred = ["u", ":", "p"].join("");
    assert.throws(
      () => normalizeRpcAllowlistEntry(`https://${cred}@soroban-testnet.stellar.org`),
      (err) => err instanceof RpcEgressError && err.problem === "embedded-credentials",
    );
  });

  it("permits allowlisted initial URLs and rejects unapproved hosts or downgraded protocols", () => {
    const allowlist = ["https://soroban-testnet.stellar.org"];

    const ok = assertRpcEgressAllowed("https://soroban-testnet.stellar.org/rpc", {
      allowlist,
    });
    assert.equal(ok.origin, "https://soroban-testnet.stellar.org");

    assert.throws(
      () =>
        assertRpcEgressAllowed("https://unapproved.example.org/rpc", {
          allowlist,
        }),
      (err) =>
        err instanceof RpcEgressError &&
        err.problem === "disallowed-origin" &&
        err.phase === "initial",
    );

    // Scheme mismatch (plain http to an https-allowlisted host) is rejected
    assert.throws(
      () =>
        assertRpcEgressAllowed("http://soroban-testnet.stellar.org/rpc", {
          allowlist,
        }),
      (err) => err instanceof RpcEgressError && err.problem === "disallowed-origin",
    );
  });

  it("retains a credential-free loopback exception in mock mode while rejecting credentialed or non-loopback URLs", () => {
    const allowlist = ["https://soroban-testnet.stellar.org"];
    assert.equal(isLoopbackHostname("127.0.0.1"), true);
    assert.equal(isLoopbackHostname("localhost"), true);
    assert.equal(isLoopbackHostname("[::1]"), true);
    assert.equal(isLoopbackHostname("169.254.169.254"), false);

    // Allowed in mockMode: credential-free loopback URLs
    for (const loopbackUrl of [
      "http://127.0.0.1:8420/rpc",
      "http://localhost:8420/rpc",
      "http://[::1]:8420/rpc",
    ]) {
      const url = assertRpcEgressAllowed(loopbackUrl, {
        allowlist,
        mockMode: true,
      });
      assert.equal(url.protocol, "http:");
    }

    // Rejected outside mockMode: loopback not on allowlist
    assert.throws(
      () =>
        assertRpcEgressAllowed("http://127.0.0.1:8420/rpc", {
          allowlist,
          mockMode: false,
        }),
      (err) => err instanceof RpcEgressError && err.problem === "disallowed-origin",
    );

    // Rejected EVEN IN mockMode: loopback URL carrying embedded credentials!
    const cred = ["dev", ":", "secret"].join("");
    assert.throws(
      () =>
        assertRpcEgressAllowed(`http://${cred}@127.0.0.1:8420/rpc`, {
          allowlist,
          mockMode: true,
        }),
      (err) =>
        err instanceof RpcEgressError &&
        err.problem === "embedded-credentials" &&
        !err.message.includes("secret"),
    );

    // Rejected in mockMode: non-loopback unapproved host
    assert.throws(
      () =>
        assertRpcEgressAllowed("http://10.0.0.8:8420/rpc", {
          allowlist,
          mockMode: true,
        }),
      (err) => err instanceof RpcEgressError && err.problem === "disallowed-origin",
    );
  });
});

describe("createRpcServer redirect egress validation (#803)", () => {
  it("follows redirects to allowlisted origins and blocks redirects to disallowed destinations BEFORE fetching them", async () => {
    const requestedUrls = [];

    // 1. Disallowed redirect destination is blocked before second fetch executes
    const blockingServer = createRpcServer(
      baseStellarConfig({
        rpcUrl: "https://primary-rpc.example.org/rpc",
        rpcAllowlist: [
          "https://primary-rpc.example.org",
          "https://secondary-rpc.example.org",
        ],
      }),
      {
        fetchImpl: async (url, init) => {
          requestedUrls.push({ url: String(url), redirect: init?.redirect });
          if (String(url) === "https://primary-rpc.example.org/rpc") {
            return new Response(null, {
              status: 307,
              headers: { location: "http://169.254.169.254/latest/meta-data" },
            });
          }
          throw new Error("disallowed redirect target should NEVER be fetched");
        },
      },
    );

    await assert.rejects(
      () => blockingServer.getHealth(),
      (err) =>
        err instanceof RpcEgressError &&
        err.problem === "disallowed-origin" &&
        err.phase === "redirect",
    );
    assert.equal(requestedUrls.length, 1);
    assert.equal(requestedUrls[0].redirect, "manual");

    // 2. Redirect to a second allowlisted origin succeeds cleanly
    const hopLog = [];
    const allowedRedirectServer = createRpcServer(
      baseStellarConfig({
        rpcUrl: "https://primary-rpc.example.org/rpc",
        rpcAllowlist: [
          "https://primary-rpc.example.org",
          "https://secondary-rpc.example.org",
        ],
      }),
      {
        fetchImpl: async (url) => {
          hopLog.push(String(url));
          if (String(url) === "https://primary-rpc.example.org/rpc") {
            return new Response(null, {
              status: 307,
              headers: { location: "https://secondary-rpc.example.org/v2/rpc" },
            });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                status: "healthy",
                oldestLedger: 100,
                latestLedger: 250,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      },
    );

    const health = await allowedRedirectServer.getHealth();
    assert.equal(health.latestLedger, 250);
    assert.deepEqual(hopLog, [
      "https://primary-rpc.example.org/rpc",
      "https://secondary-rpc.example.org/v2/rpc",
    ]);
  });

  it("rejects redirect loops exceeding DEFAULT_MAX_RPC_REDIRECTS", async () => {
    const loopServer = createRpcServer(
      baseStellarConfig({
        rpcUrl: "https://primary-rpc.example.org/step0",
        rpcAllowlist: ["https://primary-rpc.example.org"],
      }),
      {
        fetchImpl: async (url) => {
          const nextIdx = Number(String(url).slice(-1)) + 1;
          return new Response(null, {
            status: 307,
            headers: { location: `/step${nextIdx}` },
          });
        },
      },
    );

    assert.equal(DEFAULT_MAX_RPC_REDIRECTS, 3);
    await assert.rejects(
      () => loopServer.getHealth(),
      (err) =>
        err instanceof RpcEgressError &&
        err.problem === "too-many-redirects" &&
        err.phase === "redirect",
    );
  });
});

describe("STELLAR_RPC_ALLOWLIST startup configuration (#803)", () => {
  it("enforces STELLAR_RPC_ALLOWLIST at config load while honouring MIMIR_PROFILE=mock loopback exception", () => {
    const keys = [
      "MIMIR_PROFILE",
      "MARKET_CONTRACT_ID",
      "SQUAD_CONTRACT_ID",
      "STELLAR_RPC_URL",
      "STELLAR_RPC_ALLOWLIST",
    ];
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

    try {
      process.env.MARKET_CONTRACT_ID = MARKET_ID;
      process.env.SQUAD_CONTRACT_ID = SQUAD_ID;
      delete process.env.MIMIR_PROFILE;
      process.env.STELLAR_RPC_URL = "https://soroban-testnet.stellar.org";
      process.env.STELLAR_RPC_ALLOWLIST = "https://soroban-testnet.stellar.org";

      const allowedCfg = loadStellarConfig();
      assert.deepEqual(allowedCfg.rpcAllowlist, ["https://soroban-testnet.stellar.org"]);

      // Non-allowlisted STELLAR_RPC_URL fails fast at config load
      process.env.STELLAR_RPC_URL = "https://unlisted-rpc.example.org";
      assert.throws(
        () => loadStellarConfig(),
        (err) =>
          err instanceof ConfigError &&
          err.message.includes("STELLAR_RPC_URL rejected by egress policy"),
      );

      // MIMIR_PROFILE=mock retains credential-free loopback exception even with strict allowlist
      delete process.env.STELLAR_RPC_URL;
      process.env.MIMIR_PROFILE = "mock";
      const mockCfg = loadStellarConfig();
      assert.equal(mockCfg.mockMode, true);
      assert.match(mockCfg.rpcUrl, /^http:\/\/127\.0\.0\.1:/);
      // And createRpcServer succeeds offline for mockCfg
      const mockServer = createRpcServer(mockCfg);
      assert.ok(mockServer);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});
