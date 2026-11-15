import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig, loadStellarConfig } from "../dist/config.js";
import {
  assertCredentialFreeRpcUrl,
  createRpcServer,
  hasEmbeddedUrlCredentials,
  RpcEndpointUrlError,
  validateEndpointUrl,
} from "../dist/stellar/client.js";

const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4";

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function baseBotEnv(overrides = {}) {
  return {
    MIMIR_PROFILE: undefined,
    BOT_TOKEN: "123456789:" + "A".repeat(35),
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: VALID_CONTRACT_A,
    SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
    STELLAR_RPC_URL: undefined,
    STELLAR_HORIZON_URL: undefined,
    STELLAR_EXPLORER_BASE_URL: undefined,
    TELEGRAM_WEBHOOK_URL: undefined,
    MIMIR_APP_URL: undefined,
    TELEGRAM_API_ROOT: undefined,
    ...overrides,
  };
}

test("validateEndpointUrl accepts clean http and https RPC URLs without credentials", () => {
  const httpsParsed = validateEndpointUrl("https://soroban-testnet.stellar.org/rpc", "STELLAR_RPC_URL");
  assert.equal(httpsParsed.origin, "https://soroban-testnet.stellar.org");

  const httpLocal = assertCredentialFreeRpcUrl("  http://127.0.0.1:8000/soroban/rpc  ", "STELLAR_RPC_URL");
  assert.equal(httpLocal, "http://127.0.0.1:8000/soroban/rpc");

  assert.equal(hasEmbeddedUrlCredentials("https://soroban-testnet.stellar.org/path?ref=a@b"), false);
  assert.equal(hasEmbeddedUrlCredentials("https://soroban-testnet.stellar.org/#anchor@here"), false);
});

test("validateEndpointUrl rejects all embedded userinfo variants and reports ONLY the config key", () => {
  const userOnly = "rpcAccountAlpha";
  const passOnly = "privateAuthVal77";
  const host = "private-node-internal.example.org";

  const credentialUrls = [
    `https://${userOnly}:${passOnly}@${host}/soroban`,
    `http://${userOnly}@${host}:8000/rpc`,
    `https://:${passOnly}@${host}/rpc`,
    `https://${userOnly}:@${host}/rpc`,
    `https://@${host}/rpc`,
    `https:\\\\${userOnly}:${passOnly}@${host}/rpc`,
    `ftp://${userOnly}:${passOnly}@${host}/rpc`,
    `https://${userOnly}:${passOnly}@[invalid-host`,
  ];

  for (const url of credentialUrls) {
    assert.equal(hasEmbeddedUrlCredentials(url), true);
    assert.throws(
      () => validateEndpointUrl(url, "STELLAR_RPC_URL"),
      (err) => {
        assert.ok(err instanceof RpcEndpointUrlError);
        assert.equal(err.configKey, "STELLAR_RPC_URL");
        assert.equal(err.problem, "embedded-credentials");
        assert.equal(err.message, "STELLAR_RPC_URL must not contain embedded credentials");
        assert.equal(err.message.includes(userOnly), false);
        assert.equal(err.message.includes(passOnly), false);
        assert.equal(err.message.includes(host), false);
        return true;
      },
    );
  }
});

test("loadStellarConfig and loadConfig reject embedded URL credentials before startup and report only affected keys", () => {
  const u = "hiddenUser42";
  const p = "hiddenCredential99";
  const h = "secret-rpc-host.internal";

  withEnv(
    baseBotEnv({
      STELLAR_RPC_URL: `https://${u}:${p}@${h}/rpc`,
      STELLAR_HORIZON_URL: `https://${u}@${h}/horizon`,
      STELLAR_EXPLORER_BASE_URL: `https://:${p}@${h}/explorer`,
    }),
    () => {
      assert.throws(
        () => loadStellarConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.deepEqual(err.problems, [
            "STELLAR_RPC_URL must not contain embedded credentials",
            "STELLAR_HORIZON_URL must not contain embedded credentials",
            "STELLAR_EXPLORER_BASE_URL must not contain embedded credentials",
          ]);
          assert.equal(err.message.includes(u), false);
          assert.equal(err.message.includes(p), false);
          assert.equal(err.message.includes(h), false);
          return true;
        },
      );
    },
  );

  withEnv(
    baseBotEnv({
      TELEGRAM_WEBHOOK_URL: `https://${u}:${p}@${h}/webhook`,
      MIMIR_APP_URL: `https://${u}:${p}@${h}/app`,
      TELEGRAM_API_ROOT: `http://${u}:${p}@127.0.0.1:8081`,
    }),
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.deepEqual(err.problems, [
            "TELEGRAM_WEBHOOK_URL must not contain embedded credentials",
            "TELEGRAM_API_ROOT must not contain embedded credentials",
            "MIMIR_APP_URL must not contain embedded credentials",
          ]);
          assert.equal(err.message.includes(u), false);
          assert.equal(err.message.includes(p), false);
          assert.equal(err.message.includes(h), false);
          return true;
        },
      );
    },
  );
});

test("malformed or non-http URLs also report only the affected config key without echoing untrusted values", () => {
  const sensitiveQuery = "sensitiveQueryValue888";
  withEnv(
    baseBotEnv({
      STELLAR_RPC_URL: `ws://private-host.internal/rpc?k=${sensitiveQuery}`,
      STELLAR_HORIZON_URL: `not-a-valid-url-${sensitiveQuery}`,
    }),
    () => {
      assert.throws(
        () => loadStellarConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.deepEqual(err.problems, [
            "STELLAR_RPC_URL must be an http(s) URL",
            "STELLAR_HORIZON_URL is not a valid URL",
          ]);
          assert.equal(err.message.includes(sensitiveQuery), false);
          assert.equal(err.message.includes("private-host.internal"), false);
          return true;
        },
      );
    },
  );
});

test("createRpcServer defends against direct StellarConfig objects carrying embedded credentials", () => {
  const u = "directUser";
  const p = "directPass";
  const baseConfig = {
    marketContractId: VALID_CONTRACT_A,
    squadContractId: VALID_CONTRACT_B,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };

  assert.throws(
    () => createRpcServer({ ...baseConfig, rpcUrl: `https://${u}:${p}@rpc.example.org` }),
    (err) => {
      assert.ok(err instanceof RpcEndpointUrlError);
      assert.equal(err.configKey, "STELLAR_RPC_URL");
      assert.equal(err.message, "STELLAR_RPC_URL must not contain embedded credentials");
      assert.equal(err.message.includes(u), false);
      assert.equal(err.message.includes(p), false);
      return true;
    },
  );

  assert.throws(
    () => createRpcServer({ ...baseConfig, horizonUrl: `https://${u}:${p}@horizon.example.org` }),
    (err) => {
      assert.ok(err instanceof RpcEndpointUrlError);
      assert.equal(err.configKey, "STELLAR_HORIZON_URL");
      assert.equal(err.message, "STELLAR_HORIZON_URL must not contain embedded credentials");
      return true;
    },
  );
});
