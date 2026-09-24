/**
 * Deterministic tests for health-port resolution in `loadConfig`.
 *
 * Railway injects `PORT` and probes it for the deploy healthcheck, so the
 * health endpoint falls back to it when `HEALTH_PORT` is unset — without
 * changing the loopback default on a desktop where `PORT` does not exist.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../dist/config.js";

const baseEnv = () => ({
  BOT_TOKEN: "fake-token",
  TELEGRAM_CHAT_ID: "-1001234567890",
  MARKET_CONTRACT_ID: "C" + "A".repeat(55),
  SQUAD_CONTRACT_ID: "C" + "B".repeat(55),
});

/**
 * Call `loadConfig` with a clean environment made of the base vars plus a
 * patch. Each call replaces `process.env`, so leftover variables from an
 * earlier test can never leak in (dotenv never overrides explicitly-set ones).
 * Returns the resolved `healthPort`.
 */
function healthPortWith(patch) {
  process.env = { ...baseEnv(), ...patch };
  return loadConfig().healthPort;
}

test("explicit HEALTH_PORT wins over an injected PORT", () => {
  assert.equal(healthPortWith({ HEALTH_PORT: "9999", PORT: "8888" }), 9999);
});

test("falls back to the injected PORT when HEALTH_PORT is unset", () => {
  assert.equal(healthPortWith({ PORT: "8080" }), 8080);
});

test("keeps the loopback default when neither HEALTH_PORT nor PORT is set", () => {
  assert.equal(healthPortWith({}), 8787);
});

test("ignores a non-numeric injected PORT", () => {
  assert.equal(healthPortWith({ PORT: "not-a-port" }), 8787);
});

test("ignores a zero injected PORT (Railway disables it in some plans)", () => {
  assert.equal(healthPortWith({ PORT: "0" }), 8787);
});

test("HEALTH_PORT=0 still disables the listener on a platform with PORT", () => {
  assert.equal(healthPortWith({ HEALTH_PORT: "0", PORT: "8443" }), 0);
});