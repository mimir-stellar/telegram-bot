import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig, loadStellarConfig } from "../dist/config.js";
import { createRpcServer } from "../dist/stellar/client.js";
import {
  assertRpcEndpointUrl,
  RpcEndpointUrlError,
} from "../dist/stellar/rpc-guard.js";
import {
  MOCK_BOT_TOKEN,
  MOCK_CHAT_ID,
  MOCK_MARKET_CONTRACT_ID,
  MOCK_NETWORK_PASSPHRASE,
  MOCK_SQUAD_CONTRACT_ID,
} from "../dist/stellar/mock-constants.js";

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = new Map();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const val = overrides[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, val] of previous) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  }
}

const BASE_STELLAR_ENV = {
  MIMIR_PROFILE: undefined,
  MARKET_CONTRACT_ID: MOCK_MARKET_CONTRACT_ID,
  SQUAD_CONTRACT_ID: MOCK_SQUAD_CONTRACT_ID,
  STELLAR_NETWORK: "testnet",
  STELLAR_RPC_URL: "https://rpc.example.invalid",
  STELLAR_HORIZON_URL: "https://horizon.example.invalid",
  STELLAR_EXPLORER_BASE_URL: "https://explorer.example.invalid",
  STELLAR_NETWORK_PASSPHRASE: MOCK_NETWORK_PASSPHRASE,
};

const BASE_BOT_ENV = {
  ...BASE_STELLAR_ENV,
  BOT_TOKEN: MOCK_BOT_TOKEN,
  TELEGRAM_CHAT_ID: MOCK_CHAT_ID,
};

// ── Unit tests for assertRpcEndpointUrl ──────────────────────────────────────

test("assertRpcEndpointUrl accepts valid http and https URLs without credentials", () => {
  const validUrls = [
    "https://soroban-testnet.stellar.org",
    "https://rpc.example.invalid:8443/soroban/rpc",
    "http://127.0.0.1:8420",
    "http://localhost:8000/rpc?network=testnet",
    "https://rpc.example.invalid/path/@tag?contact=ops@example.invalid",
  ];

  for (const url of validUrls) {
    assert.equal(assertRpcEndpointUrl(url, "STELLAR_RPC_URL"), url);
  }
});

test("assertRpcEndpointUrl rejects URLs with embedded credentials and reports only the config key", () => {
  const credentialUrls = [
    "https://alice:example-pass@rpc.example.invalid",
    "http://alice:example-pass@127.0.0.1:8420/rpc",
    "https://alice@rpc.example.invalid",
    "https://:example-pass@rpc.example.invalid",
    "https://@rpc.example.invalid",
  ];

  for (const url of credentialUrls) {
    assert.throws(
      () => assertRpcEndpointUrl(url, "STELLAR_RPC_URL"),
      (err) => {
        assert(err instanceof RpcEndpointUrlError);
        assert.equal(err.problem, "embedded-credentials");
        assert.equal(err.configKey, "STELLAR_RPC_URL");
        assert.equal(
          err.message,
          "STELLAR_RPC_URL must not contain embedded credentials",
        );
        assert(!err.message.includes("alice"));
        assert(!err.message.includes("example-pass"));
        assert(!err.message.includes("example.invalid"));
        assert(!err.message.includes("127.0.0.1"));
        return true;
      },
    );
  }
});

test("assertRpcEndpointUrl rejects malformed and non-http(s) URLs without echoing raw values", () => {
  assert.throws(
    () => assertRpcEndpointUrl("not-a-url-secret-value", "STELLAR_RPC_URL"),
    (err) => {
      assert(err instanceof RpcEndpointUrlError);
      assert.equal(err.problem, "invalid-url");
      assert.equal(err.configKey, "STELLAR_RPC_URL");
      assert.equal(err.message, "STELLAR_RPC_URL is not a valid URL");
      assert(!err.message.includes("secret-value"));
      return true;
    },
  );

  assert.throws(
    () =>
      assertRpcEndpointUrl(
        "ftp://alice:example-pass@rpc.example.invalid",
        "STELLAR_RPC_URL",
      ),
    (err) => {
      assert(err instanceof RpcEndpointUrlError);
      assert.equal(err.problem, "unsupported-protocol");
      assert.equal(err.configKey, "STELLAR_RPC_URL");
      assert.equal(err.message, "STELLAR_RPC_URL must be an http(s) URL");
      assert(!err.message.includes("alice"));
      assert(!err.message.includes("example-pass"));
      return true;
    },
  );
});

// ── Stellar client boundary (createRpcServer) ────────────────────────────────

test("createRpcServer rejects rpcUrl with embedded credentials before constructing Server", () => {
  const config = {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "https://alice:example-pass@rpc.example.invalid",
    horizonUrl: "https://horizon.example.invalid",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://explorer.example.invalid",
  };

  assert.throws(
    () => createRpcServer(config),
    (err) => {
      assert(err instanceof RpcEndpointUrlError);
      assert.equal(err.problem, "embedded-credentials");
      assert.equal(err.configKey, "STELLAR_RPC_URL");
      assert.equal(
        err.message,
        "STELLAR_RPC_URL must not contain embedded credentials",
      );
      assert(!err.message.includes("alice"));
      assert(!err.message.includes("example-pass"));
      return true;
    },
  );
});

test("createRpcServer accepts valid credential-free rpcUrl", () => {
  const config = {
    marketContractId: MOCK_MARKET_CONTRACT_ID,
    squadContractId: MOCK_SQUAD_CONTRACT_ID,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "http://127.0.0.1:8420",
    horizonUrl: "https://horizon.example.invalid",
    networkPassphrase: MOCK_NETWORK_PASSPHRASE,
    explorerBaseUrl: "https://explorer.example.invalid",
  };

  const server = createRpcServer(config);
  assert.ok(server);
  assert.equal(typeof server.getEvents, "function");
});

// ── Startup config validation (loadStellarConfig & loadConfig) ───────────────

test("loadStellarConfig rejects STELLAR_RPC_URL with embedded credentials and reports only the key", () => {
  assert.throws(
    () =>
      withEnv(
        {
          ...BASE_STELLAR_ENV,
          STELLAR_RPC_URL: "https://alice:example-pass@rpc.example.invalid",
        },
        () => loadStellarConfig(),
      ),
    (err) => {
      assert(err instanceof ConfigError);
      assert.deepEqual(err.problems, [
        "STELLAR_RPC_URL must not contain embedded credentials",
      ]);
      assert(!err.message.includes("alice"));
      assert(!err.message.includes("example-pass"));
      assert(!err.message.includes("rpc.example.invalid"));
      return true;
    },
  );
});

test("loadConfig rejects configured URLs with embedded credentials before startup", () => {
  assert.throws(
    () =>
      withEnv(
        {
          ...BASE_BOT_ENV,
          STELLAR_RPC_URL: "https://alice:example-pass@rpc.example.invalid",
          STELLAR_HORIZON_URL: "https://bob:other-pass@horizon.example.invalid",
        },
        () => loadConfig(),
      ),
    (err) => {
      assert(err instanceof ConfigError);
      assert(
        err.problems.includes(
          "STELLAR_RPC_URL must not contain embedded credentials",
        ),
      );
      assert(
        err.problems.includes(
          "STELLAR_HORIZON_URL must not contain embedded credentials",
        ),
      );
      assert(!err.message.includes("alice"));
      assert(!err.message.includes("example-pass"));
      assert(!err.message.includes("bob"));
      assert(!err.message.includes("other-pass"));
      return true;
    },
  );
});

test("loadStellarConfig continues to accept valid credential-free RPC URLs", () => {
  const cfg = withEnv(BASE_STELLAR_ENV, () => loadStellarConfig());
  assert.equal(cfg.rpcUrl, "https://rpc.example.invalid");
});
