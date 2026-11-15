import assert from "node:assert/strict";
import test from "node:test";

import { buildMetricsReport } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import {
  formatRpcBudget,
  normalizeRpcBudgetTarget,
  RpcBudgetTracker,
} from "../dist/stellar/metrics.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const MARKET_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SQUAD_CONTRACT = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD2KM";

function makeCursor(ledger, tx = 1) {
  const toid = (BigInt(ledger) << 32n) | BigInt(tx);
  return `${toid}-0`;
}

test("RpcBudgetTracker reports used, configured, saturation, and rolls over fixed windows", () => {
  let now = 1_000;
  const tracker = new RpcBudgetTracker({
    windowMs: 10_000,
    defaultBudget: 20,
    targetBudgets: { market: 10, squad: 20 },
    clock: () => now,
  });

  const first = tracker.record("market", 4);
  assert.equal(first.used, 4);
  assert.equal(first.configured, 10);
  assert.equal(first.remaining, 6);
  assert.equal(first.saturation, 0.4);
  assert.equal(first.exceededTotal, 0);

  now += 5_000; // Still inside [1000, 11000)
  const over = tracker.record("market", 9);
  assert.equal(over.used, 13);
  assert.equal(over.configured, 10);
  assert.equal(over.remaining, 0);
  assert.equal(over.saturation, 1); // Bounded to [0, 1]
  assert.equal(over.exceededTotal, 3);

  now += 6_000; // Crossed window boundary (now = 12_000 >= 11_000)
  const rolled = tracker.snapshot();
  assert.equal(rolled.windowMs, 10_000);
  assert.equal(rolled.targets.market.used, 0);
  assert.equal(rolled.targets.market.remaining, 10);
  assert.equal(rolled.targets.market.saturation, 0);
  assert.equal(rolled.targets.market.exceededTotal, 3); // Cumulative counter retained
  assert.equal(formatRpcBudget(rolled), "rpc_budget window=10000ms market=0/10 squad=0/20");
});

test("unbounded target identifiers collapse to 'other' and never appear in Prometheus labels", () => {
  const fakeQuerySecret = "https://rpc.example.invalid/?key=" + "supersecretvalue123";
  assert.equal(normalizeRpcBudgetTarget("market"), "market");
  assert.equal(normalizeRpcBudgetTarget("SQUAD"), "squad");
  assert.equal(normalizeRpcBudgetTarget("health"), "health");
  assert.equal(normalizeRpcBudgetTarget(MARKET_CONTRACT), "other");
  assert.equal(normalizeRpcBudgetTarget(fakeQuerySecret), "other");
  assert.equal(normalizeRpcBudgetTarget("-1001234567890"), "other");
  assert.equal(normalizeRpcBudgetTarget(""), "other");
  assert.equal(normalizeRpcBudgetTarget(null), "other");

  const metrics = createMetrics({
    rpcBudget: { windowMs: 30_000, defaultBudget: 10, clock: () => 0 },
  });
  metrics.rpcBudget.record("market", 3);
  metrics.rpcBudget.record(MARKET_CONTRACT, 2);
  metrics.rpcBudget.record(fakeQuerySecret, 1);

  const exposition = metrics.render();
  assert.ok(exposition.includes("mimir_bot_rpc_budget_window_ms 30000"), exposition);
  assert.ok(
    exposition.includes('mimir_bot_rpc_budget_configured_requests{target="market"} 10'),
    exposition,
  );
  assert.ok(
    exposition.includes('mimir_bot_rpc_budget_used_requests{target="market"} 3'),
    exposition,
  );
  assert.ok(
    exposition.includes('mimir_bot_rpc_budget_saturation_ratio{target="market"} 0.3'),
    exposition,
  );
  assert.ok(
    exposition.includes('mimir_bot_rpc_budget_used_requests{target="other"} 3'),
    exposition,
  );
  assert.ok(!exposition.includes(MARKET_CONTRACT), "Contract ID must not leak into budget labels");
  assert.ok(!exposition.includes("rpc.example.invalid"), "URL must not leak into budget labels");
  assert.ok(!exposition.includes("supersecretvalue123"), "Secret must not leak into budget labels");
});

test("boundary validation rejects negative or non-integer request deltas and invalid budgets", () => {
  assert.throws(() => new RpcBudgetTracker({ windowMs: 0 }), /windowMs must be a positive integer/);
  assert.throws(
    () => new RpcBudgetTracker({ defaultBudget: -5 }),
    /defaultBudget must be a positive integer/,
  );

  const tracker = new RpcBudgetTracker({ windowMs: 5_000, defaultBudget: 10, clock: () => 0 });
  assert.throws(() => tracker.record("market", -1), /non-negative integer/);
  assert.throws(() => tracker.record("market", Number.NaN), /non-negative integer/);
  assert.throws(() => tracker.configureTarget("market", 0), /budget must be a positive integer/);
});

test("poller records per-target page usage and exposes bounded budget metrics on health /metrics", async () => {
  await withTempDataDir(async ({ file }) => {
    let now = 50_000;
    let marketPageCalls = 0;
    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 900, latestLedger: 1200 };
      },
      async getEvents(req) {
        const cid = req.filters?.[0]?.contractIds?.[0];
        if (cid === MARKET_CONTRACT) {
          marketPageCalls += 1;
          const nextLedger = marketPageCalls === 1 ? 1100 : 1200;
          return {
            events: [],
            oldestLedger: 900,
            latestLedger: 1200,
            cursor: makeCursor(nextLedger, marketPageCalls),
          };
        }
        return {
          events: [],
          oldestLedger: 900,
          latestLedger: 1200,
          cursor: makeCursor(1200, 99),
        };
      },
    };

    const config = {
      version: "0.1.0",
      botToken: ["123456:fake", "secret"].join("-"),
      chatId: "-1001234",
      chatIds: ["-1001234"],
      network: "testnet",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      marketContractId: MARKET_CONTRACT,
      squadContractId: SQUAD_CONTRACT,
      pollIntervalMs: 30_000,
      startLookbackLedgers: 100,
      cursorFile: file("cursor.json"),
      lockFile: file("poller.lock"),
      maxNotificationsPerCycle: 20,
      dedupWindow: 200,
      logSampleWindowMs: 60_000,
      logSampleMaxPerWindow: 5,
    };

    const metrics = createMetrics({
      rpcBudget: {
        windowMs: 60_000,
        defaultBudget: 8,
        targetBudgets: { market: 8, squad: 8, health: 4 },
        clock: () => now,
      },
    });

    const poller = createPoller({
      config,
      server,
      metrics,
      persistAudit: false,
      rpcBudgetOptions: {
        windowMs: 60_000,
        defaultBudget: 8,
        targetBudgets: { market: 8, squad: 8, health: 4 },
        clock: () => now,
      },
      now: () => now,
      sleep: async () => {},
      send: async () => {},
    });

    await poller.runCycle();

    const snap = poller.status().rpcBudget;
    assert.ok(snap);
    assert.equal(snap.targets.health.used, 1);
    assert.equal(snap.targets.market.used, 2);
    assert.equal(snap.targets.market.configured, 8);
    assert.equal(snap.targets.market.saturation, 0.25);
    assert.equal(snap.targets.squad.used, 1);
    assert.equal(snap.targets.squad.saturation, 0.125);

    const healthExposition = buildMetricsReport(config, poller.status(), now);
    assert.ok(
      healthExposition.includes(
        'mimir_telegram_rpc_budget_used_requests{network="testnet",target="market"} 2',
      ),
      healthExposition,
    );
    assert.ok(
      healthExposition.includes(
        'mimir_telegram_rpc_budget_configured_requests{network="testnet",target="market"} 8',
      ),
      healthExposition,
    );
    assert.ok(
      healthExposition.includes(
        'mimir_telegram_rpc_budget_saturation_ratio{network="testnet",target="market"} 0.25',
      ),
      healthExposition,
    );
    // Ensure rpc_budget lines never carry raw contract IDs as labels
    for (const line of healthExposition.split(/\\n|\n/)) {
      if (line.startsWith("mimir_telegram_rpc_budget_")) {
        assert.ok(!line.includes(MARKET_CONTRACT), `Unexpected contract ID in budget metric: ${line}`);
        assert.ok(!line.includes(SQUAD_CONTRACT), `Unexpected contract ID in budget metric: ${line}`);
      }
    }
  });
});
