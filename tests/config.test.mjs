/**
 * Configuration validation property tests.
 *
 * Covers positive, negative, boundary, cross-property, and regression cases.
 * Tests are split into separate functions that each set up their own environment
 * since dotenv is evaluated at module import time.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ── Positive tests ───────────────────────────────────────────────────────────

test("loadStellarConfig() accepts valid default configuration", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  delete process.env.STELLAR_RPC_URL;
  delete process.env.STELLAR_HORIZON_URL;
  delete process.env.STELLAR_NETWORK_PASSPHRASE;

  try {
    // Act
    const { loadStellarConfig } = await import("../dist/config.js");
    const config = loadStellarConfig();

    // Assert
    assert.equal(config.marketContractId, "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI");
    assert.equal(config.squadContractId, "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY");
    assert.equal(config.rpcUrl, "https://soroban-testnet.stellar.org");
    assert.equal(config.horizonUrl, "https://horizon-testnet.stellar.org");
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("rejects empty contract IDs", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act & Assert
    const { loadStellarConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.length > 0);
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("rejects contract IDs with wrong prefix", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "GDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act & Assert
    const { loadStellarConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("MARKET_CONTRACT_ID")));
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("rejects contract IDs with lowercase letters", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "CDV6jxijcalsxqelcs6yuewjwg5dfxqk5pj5i7mwi6kvmqjbc5dlpkzi";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act & Assert
    const { loadStellarConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("MARKET_CONTRACT_ID")));
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("accumulates multiple contract ID errors", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "invalid";
  process.env.SQUAD_CONTRACT_ID = "also-invalid";

  try {
    // Act & Assert
    const { loadStellarConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert.equal(err.problems.length, 2);
        assert(err.problems.some((p) => p.includes("MARKET_CONTRACT_ID")));
        assert(err.problems.some((p) => p.includes("SQUAD_CONTRACT_ID")));
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

// ── Chat ID tests ────────────────────────────────────────────────────────────

test("accepts numeric chat IDs (negative)", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "-1001234567890";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.chatId, "-1001234567890");
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("accepts @channelusername chat IDs", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "@mimir_testnet";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.chatId, "@mimir_testnet");
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("rejects invalid chat IDs", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "not-a-chat-id";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act & Assert
    const { loadConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("TELEGRAM_CHAT_ID")));
        return true;
      }
    );
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

// ── URL tests ────────────────────────────────────────────────────────────────

test("accepts http and https URLs", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.STELLAR_RPC_URL = "http://localhost:8000";

  try {
    // Act
    const { loadStellarConfig } = await import("../dist/config.js");
    const config = loadStellarConfig();

    // Assert
    assert.equal(config.rpcUrl, "http://localhost:8000");
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.STELLAR_RPC_URL;
  }
});

test("rejects invalid URLs", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.STELLAR_RPC_URL = "not-a-url";

  try {
    // Act & Assert
    const { loadStellarConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("STELLAR_RPC_URL")));
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.STELLAR_RPC_URL;
  }
});

test("rejects ftp:// URLs", async () => {
  // Arrange
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.STELLAR_RPC_URL = "ftp://example.com";

  try {
    // Act & Assert
    const { loadStellarConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadStellarConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("STELLAR_RPC_URL")));
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.STELLAR_RPC_URL;
  }
});

// ── Poll interval tests ──────────────────────────────────────────────────────

test("accepts poll interval at minimum boundary (5000ms)", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.POLL_INTERVAL_MS = "5000";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.pollIntervalMs, 5000);
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.POLL_INTERVAL_MS;
  }
});

test("rejects poll interval below minimum (4999ms)", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.POLL_INTERVAL_MS = "4999";

  try {
    // Act & Assert
    const { loadConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("POLL_INTERVAL_MS")));
        return true;
      }
    );
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.POLL_INTERVAL_MS;
  }
});

// ── Start lookback tests ─────────────────────────────────────────────────────

test("accepts zero START_LOOKBACK_LEDGERS (start from oldest)", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.START_LOOKBACK_LEDGERS = "0";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.startLookbackLedgers, 0);
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.START_LOOKBACK_LEDGERS;
  }
});

test("rejects negative START_LOOKBACK_LEDGERS", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.START_LOOKBACK_LEDGERS = "-10";

  try {
    // Act & Assert
    const { loadConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("START_LOOKBACK_LEDGERS")));
        return true;
      }
    );
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.START_LOOKBACK_LEDGERS;
  }
});

// ── Max notifications tests ──────────────────────────────────────────────────

test("accepts MAX_NOTIFICATIONS_PER_CYCLE at minimum (1)", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.MAX_NOTIFICATIONS_PER_CYCLE = "1";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.maxNotificationsPerCycle, 1);
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.MAX_NOTIFICATIONS_PER_CYCLE;
  }
});

// ── Health port tests ────────────────────────────────────────────────────────

test("accepts HEALTH_PORT=0 to disable the listener", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.HEALTH_PORT = "0";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.healthPort, 0);
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.HEALTH_PORT;
  }
});

// ── Health stale tests ───────────────────────────────────────────────────────

test("accepts HEALTH_STALE_MS=0 to disable stale checking", async () => {
  // Arrange
  process.env.BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
  process.env.HEALTH_STALE_MS = "0";

  try {
    // Act
    const { loadConfig } = await import("../dist/config.js");
    const config = loadConfig();

    // Assert
    assert.equal(config.healthStaleMs, 0);
  } finally {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.HEALTH_STALE_MS;
  }
});

// ── Missing required fields ──────────────────────────────────────────────────

test("rejects missing BOT_TOKEN", async () => {
  // Arrange
  delete process.env.BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
  process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

  try {
    // Act & Assert
    const { loadConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.problems.some((p) => p.includes("BOT_TOKEN")));
        return true;
      }
    );
  } finally {
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
  }
});

test("accumulates multiple problems in one error", async () => {
  // Arrange
  delete process.env.BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.MARKET_CONTRACT_ID = "invalid";
  process.env.SQUAD_CONTRACT_ID = "also-invalid";
  process.env.POLL_INTERVAL_MS = "1000"; // too low

  try {
    // Act & Assert
    const { loadConfig, ConfigError } = await import("../dist/config.js");
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        // Should have at least 5 problems: missing BOT_TOKEN, missing CHAT_ID,
        // invalid MARKET_ID, invalid SQUAD_ID, poll interval too low
        assert(err.problems.length >= 5);
        return true;
      }
    );
  } finally {
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    delete process.env.POLL_INTERVAL_MS;
  }
});
