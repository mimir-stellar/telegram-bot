/**
 * duplicate-routes.test.mjs
 *
 * Verifies that loadConfig() rejects duplicate chat+topic notification routes
 * at startup and reports the conflict without exposing the bot token.
 *
 * Issue #748: feat(bot): reject duplicate chat and topic notification routes
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig, routeIdentity } from "../dist/config.js";

const VALID_CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const VALID_CONTRACT_B = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBQMF4";
const VALID_TOKEN = "123456789:" + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function minEnv(overrides = {}) {
  return {
    BOT_TOKEN: VALID_TOKEN,
    TELEGRAM_CHAT_ID: "-1001111111111",
    MARKET_CONTRACT_ID: VALID_CONTRACT_A,
    SQUAD_CONTRACT_ID: VALID_CONTRACT_B,
    // Clear any test-environment values that could interfere.
    TELEGRAM_MARKET_CHAT_ID: undefined,
    TELEGRAM_SQUAD_CHAT_ID: undefined,
    TELEGRAM_MARKET_MESSAGE_THREAD_ID: undefined,
    TELEGRAM_SQUAD_MESSAGE_THREAD_ID: undefined,
    POLL_INTERVAL_MS: undefined,
    START_LOOKBACK_LEDGERS: undefined,
    CURSOR_FILE: undefined,
    MAX_NOTIFICATIONS_PER_CYCLE: undefined,
    INTER_SEND_DELAY_MS: undefined,
    STELLAR_RPC_URL: undefined,
    STELLAR_HORIZON_URL: undefined,
    STELLAR_NETWORK_PASSPHRASE: undefined,
    ...overrides,
  };
}

// ── Happy path: no duplicates ─────────────────────────────────────────────────

test("loadConfig: no routes error when market and squad use distinct chats", () => {
  withEnv(
    minEnv({
      TELEGRAM_MARKET_CHAT_ID: "-1002222222222",
      TELEGRAM_SQUAD_CHAT_ID: "-1003333333333",
    }),
    () => {
      const config = loadConfig();
      assert.ok(config.routes !== undefined);
      assert.strictEqual(config.routes.length, 3);
      const sources = config.routes.map((r) => r.source);
      assert.deepStrictEqual(sources, ["default", "market", "squad"]);
    },
  );
});

test("loadConfig: single-chat deployment (no per-contract overrides) loads fine", () => {
  // All three routes resolve to the same chatId through the default fallback —
  // that is the intended single-chat configuration, not a misconfiguration.
  withEnv(minEnv(), () => {
    const config = loadConfig();
    assert.ok(config.routes !== undefined);
    assert.strictEqual(config.routes.length, 3);
    for (const route of config.routes) {
      assert.strictEqual(route.chatId, "-1001111111111");
    }
  });
});

test("loadConfig: routes populated with correct source labels", () => {
  withEnv(
    minEnv({
      TELEGRAM_MARKET_CHAT_ID: "-1002222222222",
      TELEGRAM_SQUAD_CHAT_ID: "-1003333333333",
    }),
    () => {
      const config = loadConfig();
      const sources = config.routes.map((r) => r.source);
      assert.deepStrictEqual(sources, ["default", "market", "squad"]);
    },
  );
});

// ── routeIdentity helper ──────────────────────────────────────────────────────

test("routeIdentity: same chatId, no thread → same identity", () => {
  assert.strictEqual(
    routeIdentity({ chatId: "-1001234567890" }),
    routeIdentity({ chatId: "-1001234567890" }),
  );
});

test("routeIdentity: same chatId, different threads → different identities", () => {
  const a = routeIdentity({ chatId: "-1001234567890", messageThreadId: 1 });
  const b = routeIdentity({ chatId: "-1001234567890", messageThreadId: 2 });
  assert.notStrictEqual(a, b);
});

test("routeIdentity: same chatId, one with thread, one without → different identities", () => {
  const noThread = routeIdentity({ chatId: "-1001234567890" });
  const withThread = routeIdentity({ chatId: "-1001234567890", messageThreadId: 5 });
  assert.notStrictEqual(noThread, withThread);
});

// ── Duplicate detection ───────────────────────────────────────────────────────

test("loadConfig: rejects duplicate when market and squad are explicitly set to the same chat", () => {
  withEnv(
    minEnv({
      TELEGRAM_MARKET_CHAT_ID: "-1009999999999",
      TELEGRAM_SQUAD_CHAT_ID: "-1009999999999",
    }),
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError, "should throw ConfigError");
          const dup = err.problems.find((p) => /[Dd]uplicate/.test(p));
          assert.ok(dup, `expected a duplicate-route problem; got: ${JSON.stringify(err.problems)}`);
          // Must mention both sources.
          assert.ok(dup.includes("market"), "problem should name the market source");
          assert.ok(dup.includes("squad"), "problem should name the squad source");
          // Must NOT contain the bot token.
          assert.ok(!dup.includes(VALID_TOKEN), "problem must not expose the bot token");
          return true;
        },
      );
    },
  );
});

test("loadConfig: accepts same chatId when market and squad have distinct message thread ids", () => {
  withEnv(
    minEnv({
      TELEGRAM_MARKET_CHAT_ID: "-1009999999999",
      TELEGRAM_SQUAD_CHAT_ID: "-1009999999999",
      TELEGRAM_MARKET_MESSAGE_THREAD_ID: "10",
      TELEGRAM_SQUAD_MESSAGE_THREAD_ID: "20",
    }),
    () => {
      // Same chat, but different forum topics: should be accepted.
      const config = loadConfig();
      assert.strictEqual(config.marketMessageThreadId, 10);
      assert.strictEqual(config.squadMessageThreadId, 20);
      assert.strictEqual(config.routes.length, 3);
      const marketRoute = config.routes.find((r) => r.source === "market");
      assert.ok(marketRoute !== undefined);
      assert.strictEqual(marketRoute.messageThreadId, 10);
    },
  );
});

test("loadConfig: rejects duplicate when market and squad share the same chatId and messageThreadId", () => {
  withEnv(
    minEnv({
      TELEGRAM_MARKET_CHAT_ID: "-1009999999999",
      TELEGRAM_SQUAD_CHAT_ID: "-1009999999999",
      TELEGRAM_MARKET_MESSAGE_THREAD_ID: "42",
      TELEGRAM_SQUAD_MESSAGE_THREAD_ID: "42",
    }),
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          const dup = err.problems.find((p) => /[Dd]uplicate/.test(p));
          assert.ok(dup, `expected a duplicate-route problem; got: ${JSON.stringify(err.problems)}`);
          // The problem message should name the topic id, not the token.
          assert.ok(dup.includes("42"), "problem should name the conflicting topic id");
          assert.ok(!dup.includes(VALID_TOKEN), "problem must not expose the bot token");
          return true;
        },
      );
    },
  );
});

test("loadConfig: rejects non-positive message thread id", () => {
  withEnv(
    minEnv({ TELEGRAM_MARKET_MESSAGE_THREAD_ID: "0" }),
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(
            err.problems.some((p) => p.includes("TELEGRAM_MARKET_MESSAGE_THREAD_ID")),
            "should report invalid thread id",
          );
          return true;
        },
      );
    },
  );
});

test("loadConfig: rejects non-integer message thread id", () => {
  withEnv(
    minEnv({ TELEGRAM_SQUAD_MESSAGE_THREAD_ID: "abc" }),
    () => {
      assert.throws(
        () => loadConfig(),
        (err) => {
          assert.ok(err instanceof ConfigError);
          assert.ok(
            err.problems.some((p) => p.includes("TELEGRAM_SQUAD_MESSAGE_THREAD_ID")),
            "should report invalid thread id",
          );
          return true;
        },
      );
    },
  );
});

test("loadConfig: routes array is populated on the returned config", () => {
  withEnv(
    minEnv({
      TELEGRAM_MARKET_CHAT_ID: "-1002222222222",
      TELEGRAM_SQUAD_CHAT_ID: "-1003333333333",
    }),
    () => {
      const config = loadConfig();
      assert.ok(Array.isArray(config.routes));
      const marketRoute = config.routes.find((r) => r.source === "market");
      assert.ok(marketRoute !== undefined);
      assert.strictEqual(marketRoute.chatId, "-1002222222222");
      const squadRoute = config.routes.find((r) => r.source === "squad");
      assert.ok(squadRoute !== undefined);
      assert.strictEqual(squadRoute.chatId, "-1003333333333");
    },
  );
});
