import assert from "node:assert/strict";
import test from "node:test";

import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { createDeadLetterQueue } from "../dist/deadLetter.js";
import { buildHealthReport, buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import { computeDeadLetterCapacity } from "../dist/stellar/metrics.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const FAKE_SECRET = ["999999:fake", "secret", "body", "marker"].join("-");
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const ADDR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();
const scStr = (s) => nativeToScVal(s, { type: "string" });
const scU64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const scAddress = (g) =>
  Address.account(Buffer.from(Keypair.fromPublicKey(g).rawPublicKey())).toScVal();
const cursorFor = (ledger) => `${BigInt(ledger) << 32n}-0`;

test("computeDeadLetterCapacity defines deterministic all-zero state when disabled", () => {
  assert.deepEqual(
    computeDeadLetterCapacity({ enabled: false, usedEntries: 42, maxEntries: 100 }),
    {
      enabled: false,
      usedEntries: 0,
      maxEntries: 0,
      utilizationRatio: 0,
      utilizationPercent: 0,
    },
  );

  assert.deepEqual(
    computeDeadLetterCapacity({ enabled: true, usedEntries: 10, maxEntries: 0 }),
    {
      enabled: false,
      usedEntries: 0,
      maxEntries: 0,
      utilizationRatio: 0,
      utilizationPercent: 0,
    },
  );

  assert.deepEqual(
    computeDeadLetterCapacity({ enabled: true, usedEntries: 5, maxEntries: Number.NaN }),
    {
      enabled: false,
      usedEntries: 0,
      maxEntries: 0,
      utilizationRatio: 0,
      utilizationPercent: 0,
    },
  );
});

test("computeDeadLetterCapacity bounds utilization ratio strictly within [0, 1]", () => {
  assert.deepEqual(
    computeDeadLetterCapacity({ enabled: true, usedEntries: 25, maxEntries: 100 }),
    {
      enabled: true,
      usedEntries: 25,
      maxEntries: 100,
      utilizationRatio: 0.25,
      utilizationPercent: 25,
    },
  );

  // Oversized usedEntries (e.g. hand-edited input before clamping) never exceeds 1.0
  const over = computeDeadLetterCapacity({ enabled: true, usedEntries: 150, maxEntries: 100 });
  assert.equal(over.enabled, true);
  assert.equal(over.usedEntries, 150);
  assert.equal(over.maxEntries, 100);
  assert.equal(over.utilizationRatio, 1);
  assert.equal(over.utilizationPercent, 100);

  // Negative or NaN usedEntries clamps to 0
  const under = computeDeadLetterCapacity({ enabled: true, usedEntries: -7, maxEntries: 50 });
  assert.equal(under.usedEntries, 0);
  assert.equal(under.utilizationRatio, 0);
});

test("MetricsRegistry exposes dead-letter capacity gauges without message bodies and supports disabled reset", () => {
  const m = createMetrics();
  const initial = m.render();
  assert.match(initial, /mimir_bot_dead_letter_enabled 0/);
  assert.match(initial, /mimir_bot_dead_letter_used_entries 0/);
  assert.match(initial, /mimir_bot_dead_letter_max_entries 0/);
  assert.match(initial, /mimir_bot_dead_letter_utilization_ratio 0/);

  const snap = m.deadLetterCapacity.update({
    enabled: true,
    usedEntries: 3,
    maxEntries: 8,
  });
  assert.equal(snap.utilizationRatio, 0.375);

  const active = m.render();
  assert.match(active, /mimir_bot_dead_letter_enabled 1/);
  assert.match(active, /mimir_bot_dead_letter_used_entries 3/);
  assert.match(active, /mimir_bot_dead_letter_max_entries 8/);
  assert.match(active, /mimir_bot_dead_letter_utilization_ratio 0\.375/);

  m.deadLetterCapacity.disable();
  const afterDisable = m.render();
  assert.match(afterDisable, /mimir_bot_dead_letter_enabled 0/);
  assert.match(afterDisable, /mimir_bot_dead_letter_used_entries 0/);
  assert.match(afterDisable, /mimir_bot_dead_letter_max_entries 0/);
  assert.match(afterDisable, /mimir_bot_dead_letter_utilization_ratio 0/);
});

test("DeadLetterQueue.capacity and poller/health integration report utilization without leaking message bodies", async () => {
  await withTempDataDir(async ({ file }) => {
    const bodyMarker = "CONFIDENTIAL_MESSAGE_BODY_MARKER_DO_NOT_EMIT";
    const disabledQueue = createDeadLetterQueue({
      filePath: null,
      maxEntries: 10,
      maxAttempts: 3,
    });
    await disabledQueue.load();
    await disabledQueue.enqueue({
      source: "market",
      ledger: 1,
      eventName: "claim_created",
      text: bodyMarker,
      error: "down",
    });
    // filePath === null defaults capacity() to disabled
    assert.deepEqual(disabledQueue.capacity(), {
      enabled: false,
      usedEntries: 0,
      maxEntries: 0,
      utilizationRatio: 0,
      utilizationPercent: 0,
    });

    let ledger = 200;
    const fakeServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 100, latestLedger: ledger };
      },
      async getEvents(req) {
        const id = req.filters?.[0]?.contractIds?.[0];
        if (id !== MARKET_ID) {
          return { events: [], cursor: cursorFor(ledger), latestLedger: ledger, oldestLedger: 100 };
        }
        ledger += 1;
        return {
          events: [
            {
              contractId: MARKET_ID,
              ledger,
              txHash: "deadbeef",
              ledgerClosedAt: "2026-06-01T00:00:00Z",
              id: `${ledger}-0`,
              topic: [scStr("claim_created"), scU64(ledger), scAddress(ADDR)],
              value: nativeToScVal({ category: bodyMarker }),
            },
          ],
          cursor: cursorFor(ledger),
          latestLedger: ledger,
          oldestLedger: 100,
        };
      },
    };

    const metrics = createMetrics();
    const enabledConfig = {
      version: "0.1.0",
      botToken: FAKE_SECRET,
      chatId: "-1001234567890",
      chatIds: ["-1001234567890"],
      marketContractId: MARKET_ID,
      marketContractVersion: "v1",
      squadContractId: SQUAD_ID,
      squadContractVersion: "v1",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      pollIntervalMs: 30_000,
      startLookbackLedgers: 60,
      cursorFile: file("cursor.json"),
      countersFile: file("counters.json"),
      auditFile: file("audit.jsonl"),
      deadLetterFile: file("dlq.json"),
      deadLetterMax: 4,
      deadLetterMaxAttempts: 3,
      maxNotificationsPerCycle: 20,
      healthHost: "127.0.0.1",
      healthPort: 0,
      healthStaleMs: 90_000,
      healthAuthToken: null,
    };

    const poller = createPoller({
      config: enabledConfig,
      server: fakeServer,
      metrics,
      send: async () => {
        throw new Error("Telegram 503");
      },
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      sleep: async () => {},
    });

    await poller.runCycle();
    await poller.runCycle();

    const status = poller.status();
    assert.deepEqual(status.deadLetterCapacity, {
      enabled: true,
      usedEntries: 2,
      maxEntries: 4,
      utilizationRatio: 0.5,
      utilizationPercent: 50,
    });

    const promText = metrics.render();
    assert.match(promText, /mimir_bot_dead_letter_enabled 1/);
    assert.match(promText, /mimir_bot_dead_letter_used_entries 2/);
    assert.match(promText, /mimir_bot_dead_letter_max_entries 4/);
    assert.match(promText, /mimir_bot_dead_letter_utilization_ratio 0\.5/);
    assert.equal(promText.includes(bodyMarker), false);
    assert.equal(promText.includes(FAKE_SECRET), false);

    const healthReport = buildHealthReport(enabledConfig, status, Date.now());
    assert.deepEqual(healthReport.poller.deadLetterCapacity, status.deadLetterCapacity);
    assert.equal(JSON.stringify(healthReport).includes(bodyMarker), false);

    const healthProm = buildMetricsReport(enabledConfig, status, Date.now());
    assert.match(healthProm, /mimir_telegram_dead_letter_utilization_ratio\{network="testnet"\} 0\.5/);
    assert.equal(healthProm.includes(bodyMarker), false);

    // Disabled poller configuration (no deadLetterFile)
    const disabledConfig = { ...enabledConfig, deadLetterFile: "" };
    const disabledMetrics = createMetrics();
    const disabledPoller = createPoller({
      config: disabledConfig,
      server: fakeServer,
      metrics: disabledMetrics,
      send: async () => {
        throw new Error("Telegram 503");
      },
      sendOptions: { maxSendRetries: 1, initialBackoffMs: 0, maxBackoffMs: 0, sendSpacingMs: 0 },
      sleep: async () => {},
    });
    await disabledPoller.runCycle();
    assert.deepEqual(disabledPoller.status().deadLetterCapacity, {
      enabled: false,
      usedEntries: 0,
      maxEntries: 0,
      utilizationRatio: 0,
      utilizationPercent: 0,
    });
    assert.match(disabledMetrics.render(), /mimir_bot_dead_letter_enabled 0/);
    assert.match(disabledMetrics.render(), /mimir_bot_dead_letter_utilization_ratio 0/);
  });
});
