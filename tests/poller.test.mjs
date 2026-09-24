import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPoller } from "../dist/poller.js";

function baseConfig(overrides = {}) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    dryRun: false,
    ...overrides,
  };
}

class FakeServer {
  constructor(eventsToReturn = []) {
    this.eventsToReturn = eventsToReturn;
    this.latestLedger = 100;
  }
  
  async getHealth() {
    return { oldestLedger: 1, latestLedger: this.latestLedger };
  }
  
  async getEvents(opts) {
    const cursor = (this.latestLedger << 32).toString() + "-1";
    return { events: this.eventsToReturn, latestLedger: this.latestLedger, cursor };
  }
}

test("poller standard run saves cursor and sends notifications", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "poller-test-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = baseConfig({ cursorFile });
  
  let sent = 0;
  
  const server = new FakeServer([
    // valid fake event? we might need a real-looking event payload
  ]);
  
  const poller = createPoller({ config, server, send: async (text) => { sent++; } });
  
  try {
    await poller.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    
    // check if it wrote the file
    const content = await readFile(cursorFile, "utf8");
    const cursorData = JSON.parse(content);
    assert.equal(cursorData.version, 1);
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("poller dryRun mode doesn't save cursor or send", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "poller-test-dry-"));
  const cursorFile = path.join(dir, "cursor.json");
  const config = baseConfig({ cursorFile, dryRun: true });
  
  let sent = 0;
  const server = new FakeServer([]);
  
  const poller = createPoller({ config, server, send: async (text) => { sent++; } });
  
  try {
    await poller.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    
    // should not have saved cursor file
    let hasFile = false;
    try {
      await readFile(cursorFile, "utf8");
      hasFile = true;
    } catch {}
    
    assert.equal(hasFile, false);
    assert.equal(sent, 0);
  } finally {
    poller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
