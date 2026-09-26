import test from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { loadConfig, loadStellarConfig, networkLabel, ConfigError } from "../dist/config.js";

test("config loader", async (t) => {
  const envSnapshot = { ...process.env };

  t.afterEach(() => {
    process.env = { ...envSnapshot };
  });

  await t.test("loads valid configuration", () => {
    process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
    process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
    process.env.BOT_TOKEN = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
    process.env.TELEGRAM_CHAT_ID = "-1001234567890";
    
    const config = loadConfig();
    assert.strictEqual(config.marketContractId, "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI");
    assert.strictEqual(config.squadContractId, "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY");
    assert.strictEqual(config.botToken, "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
    assert.strictEqual(config.chatId, "-1001234567890");
    assert.strictEqual(config.pollIntervalMs, 30000); // default
  });

  await t.test("rejects missing required fields", () => {
    delete process.env.BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.MARKET_CONTRACT_ID;
    delete process.env.SQUAD_CONTRACT_ID;
    
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert.strictEqual(err.problems.length, 4);
        assert(err.message.includes("MARKET_CONTRACT_ID is required but not set"));
        assert(err.message.includes("SQUAD_CONTRACT_ID is required but not set"));
        assert(err.message.includes("BOT_TOKEN is required but not set"));
        assert(err.message.includes("TELEGRAM_CHAT_ID is required but not set"));
        return true;
      }
    );
  });

  await t.test("rejects invalid contract ids", () => {
    process.env.MARKET_CONTRACT_ID = "invalid";
    process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
    process.env.BOT_TOKEN = "token";
    process.env.TELEGRAM_CHAT_ID = "12345";
    
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.message.includes("MARKET_CONTRACT_ID is not a Soroban contract id"));
        return true;
      }
    );
  });

  await t.test("rejects invalid urls", () => {
    process.env.MARKET_CONTRACT_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
    process.env.SQUAD_CONTRACT_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
    process.env.BOT_TOKEN = "token";
    process.env.TELEGRAM_CHAT_ID = "12345";
    process.env.STELLAR_RPC_URL = "not-a-url";
    
    assert.throws(
      () => loadConfig(),
      (err) => {
        assert(err instanceof ConfigError);
        assert(err.message.includes("STELLAR_RPC_URL is not a valid URL"));
        return true;
      }
    );
  });

  await t.test("networkLabel resolves correctly", () => {
    assert.strictEqual(networkLabel({ networkPassphrase: "Test SDF Network ; September 2015" }), "testnet");
    assert.strictEqual(networkLabel({ networkPassphrase: "Public Global Stellar Network ; September 2015" }), "public");
    assert.strictEqual(networkLabel({ networkPassphrase: "Custom" }), "custom");
  });
});
