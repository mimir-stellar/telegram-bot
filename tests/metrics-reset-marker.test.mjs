import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { buildHealthReport, buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller, parseCountersFile } from "../dist/poller.js";
import {
  METRICS_RESET_MARKER_VERSION,
  advanceMetricsResetMarker,
  loadAndAdvanceMetricsResetMarker,
  parseMetricsResetMarker,
} from "../dist/stellar/metrics.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const FAKE_CRED = ["777777:fake", "bot", "cred"].join("-");
const MARKET_A = "C" + "A".repeat(55);
const MARKET_B = "C" + "C".repeat(55);
const SQUAD_A = "C" + "B".repeat(55);
const CREATOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x21)).publicKey();

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

function makeEvent(ledger) {
  const creatorScVal = Address.account(
    Buffer.from(Keypair.fromPublicKey(CREATOR).rawPublicKey()),
  ).toScVal();
  return {
    id: `${ledger}-1`,
    ledger,
    ledgerClosedAt: "2026-08-01T12:00:00Z",
    txHash: "b".repeat(64),
    topic: [
      nativeToScVal("claim_created", { type: "string" }),
      nativeToScVal(BigInt(ledger), { type: "u64" }),
      creatorScVal,
    ],
    value: nativeToScVal({ category: "crypto" }),
  };
}

function makeServer(marketPages) {
  let idx = 0;
  return {
    async getHealth() {
      return { status: "healthy", latestLedger: 2000, oldestLedger: 1000 };
    },
    async getEvents(req) {
      const cid = req.filters?.[0]?.contractIds?.[0];
      if (cid === MARKET_A || cid === MARKET_B) {
        const events = marketPages[idx] ?? [];
        idx += 1;
        return { events, latestLedger: 2000, oldestLedger: 1000, cursor: makeCursor(2000, idx) };
      }
      return { events: [], latestLedger: 2000, oldestLedger: 1000, cursor: makeCursor(2000, 99) };
    },
  };
}

test("standalone MetricsResetMarker persists across restarts and recovers from corrupt or future-version files", async () => {
  await withTempDataDir(async ({ file }) => {
    const markerPath = file("metrics-reset.json");
    let now = Date.UTC(2026, 7, 1, 10, 0, 0);

    const m1 = createMetrics();
    assert.equal(m1.resetMarker.get(), null);
    assert.match(m1.render(), /mimir_bot_metrics_reset_generation 0/);

    const r1 = await m1.resetMarker.loadAndAdvance(markerPath, { now: () => now });
    assert.equal(r1.corrupted, false);
    assert.equal(r1.persisted, true);
    assert.deepEqual(r1.marker, {
      version: METRICS_RESET_MARKER_VERSION,
      resetGeneration: 1,
      retainedEpoch: 1,
      lastResetAt: new Date(now).toISOString(),
      lastResetReason: "initial",
    });
    assert.match(m1.render(), /mimir_bot_metrics_reset_generation 1/);
    assert.match(m1.render(), /mimir_bot_metrics_retained_epoch 1/);

    // Restart #2: generation advances to 2, retainedEpoch stays 1
    now += 60_000;
    const m2 = createMetrics();
    const r2 = await m2.resetMarker.loadAndAdvance(markerPath, { now: () => now });
    assert.equal(r2.corrupted, false);
    assert.equal(r2.marker.resetGeneration, 2);
    assert.equal(r2.marker.retainedEpoch, 1);
    assert.equal(r2.marker.lastResetReason, "process_restart");
    assert.match(m2.render(), /mimir_bot_metrics_reset_generation 2/);

    // Corrupt file on disk -> recovers cleanly with corrupt_state and overwrites valid v1 JSON
    await writeFile(markerPath, "{truncated", "utf8");
    now += 60_000;
    const rCorrupt = await loadAndAdvanceMetricsResetMarker(markerPath, { now: () => now });
    assert.equal(rCorrupt.corrupted, true);
    assert.equal(rCorrupt.marker.resetGeneration, 1);
    assert.equal(rCorrupt.marker.lastResetReason, "corrupt_state");
    const repaired = parseMetricsResetMarker(await readFile(markerPath, "utf8"));
    assert.equal(repaired.version, 1);

    // Unsupported future schema version is rejected by parser and safely recovered by loader
    const futureJson = JSON.stringify({ ...repaired, version: 99 });
    assert.throws(() => parseMetricsResetMarker(futureJson), /unsupported schema version 99/);
    await writeFile(markerPath, futureJson, "utf8");
    const rFuture = await loadAndAdvanceMetricsResetMarker(markerPath, { now: () => now });
    assert.equal(rFuture.corrupted, true);
    assert.equal(rFuture.marker.lastResetReason, "corrupt_state");
  });
});

test("poller distinguishes a quiet-chain activity drop from a process restart and from a contract-change reset", async () => {
  await withTempDataDir(async ({ file }) => {
    let clock = Date.UTC(2026, 7, 1, 12, 0, 0);
    const baseCfg = {
      version: "0.1.0",
      botToken: FAKE_CRED,
      chatId: "-1001234",
      chatIds: ["-1001234"],
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      marketContractId: MARKET_A,
      marketContractVersion: "v1",
      squadContractId: SQUAD_A,
      squadContractVersion: "v1",
      pollIntervalMs: 30_000,
      startLookbackLedgers: 60,
      cursorFile: file("cursors.json"),
      countersFile: file("counters.json"),
      statusFile: file("status.json"),
      auditFile: file("audit.jsonl"),
      maxNotificationsPerCycle: 20,
      healthHost: "127.0.0.1",
      healthPort: 0,
      healthStaleMs: 90_000,
      healthAuthToken: null,
    };

    const metrics1 = createMetrics();
    const poller1 = createPoller({
      config: baseCfg,
      server: makeServer([[makeEvent(1501)], [], []]),
      metrics: metrics1,
      send: async () => {},
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      now: () => clock,
      sleep: async () => {},
    });

    await poller1.loadCursors();
    await poller1.loadCounters();
    await poller1.runCycle(); // active cycle: 1 sent

    const genAfterActive = poller1.status().resetMarker.resetGeneration;
    assert.equal(genAfterActive, 1);
    assert.equal(poller1.status().resetMarker.retainedEpoch, 1);
    assert.equal(poller1.status().resetMarker.lastResetReason, "initial");

    // Real activity drop: two quiet cycles with 0 events — resetGeneration MUST NOT change!
    clock += 30_000;
    await poller1.runCycle();
    clock += 30_000;
    await poller1.runCycle();
    await poller1.shutdown({ timeoutMs: 200 });

    assert.equal(poller1.status().cumulative.notificationsSent, 1);
    assert.equal(poller1.status().resetMarker.resetGeneration, 1);
    assert.equal(metrics1.resetMarker.get().resetGeneration, 1);

    // Process restart with same contracts: cumulative counters retained, resetGeneration -> 2, retainedEpoch stays 1
    clock += 60_000;
    const metrics2 = createMetrics();
    const poller2 = createPoller({
      config: baseCfg,
      server: makeServer([[]]),
      metrics: metrics2,
      send: async () => {},
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      now: () => clock,
      sleep: async () => {},
    });
    await poller2.loadCursors();
    await poller2.loadCounters();

    const status2 = poller2.status();
    assert.equal(status2.cumulative.notificationsSent, 1);
    assert.equal(status2.sinceStart.notificationsSent, 0);
    assert.equal(status2.resetMarker.resetGeneration, 2);
    assert.equal(status2.resetMarker.retainedEpoch, 1);
    assert.equal(status2.resetMarker.lastResetReason, "process_restart");
    assert.match(metrics2.render(), /mimir_bot_metrics_reset_generation 2/);
    assert.match(metrics2.render(), /mimir_bot_metrics_retained_epoch 1/);

    const healthProm = buildMetricsReport(baseCfg, status2, clock);
    assert.match(healthProm, /mimir_telegram_notifications_sent_total\{network="testnet"\} 1/);
    assert.match(healthProm, /mimir_telegram_metrics_reset_generation\{network="testnet"\} 2/);
    assert.match(healthProm, /mimir_telegram_metrics_retained_epoch\{network="testnet"\} 1/);

    const healthJson = buildHealthReport(baseCfg, status2, clock);
    assert.equal(healthJson.poller.resetMarker.resetGeneration, 2);

    await poller2.runCycle();
    await poller2.shutdown({ timeoutMs: 200 });

    const saved2 = parseCountersFile(await readFile(baseCfg.countersFile, "utf8"));
    assert.equal(saved2.resetMarker.resetGeneration, 2);
    assert.equal(saved2.resetMarker.retainedEpoch, 1);

    // Restart #3 with changed contract ID: cumulative counters reset to 0, resetGeneration -> 3, retainedEpoch -> 2
    clock += 60_000;
    const metrics3 = createMetrics();
    const poller3 = createPoller({
      config: { ...baseCfg, marketContractId: MARKET_B },
      server: makeServer([[]]),
      metrics: metrics3,
      send: async () => {},
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      now: () => clock,
      sleep: async () => {},
    });
    await poller3.loadCursors();
    await poller3.loadCounters();

    const status3 = poller3.status();
    assert.equal(status3.cumulative.notificationsSent, 0);
    assert.equal(status3.resetMarker.resetGeneration, 3);
    assert.equal(status3.resetMarker.retainedEpoch, 2);
    assert.equal(status3.resetMarker.lastResetReason, "contract_changed");
    assert.match(metrics3.render(), /mimir_bot_metrics_reset_generation 3/);
    assert.match(metrics3.render(), /mimir_bot_metrics_retained_epoch 2/);
  });
});

test("advanceMetricsResetMarker handles manual_reset and initial transitions deterministically", () => {
  const m1 = advanceMetricsResetMarker(null, "process_restart", 1_000);
  assert.equal(m1.resetGeneration, 1);
  assert.equal(m1.retainedEpoch, 1);
  assert.equal(m1.lastResetReason, "initial");

  const m2 = advanceMetricsResetMarker(m1, "manual_reset", 2_000);
  assert.equal(m2.resetGeneration, 2);
  assert.equal(m2.retainedEpoch, 2);
  assert.equal(m2.lastResetReason, "manual_reset");
});
