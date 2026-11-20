/**
 * RPC budget saturation per target tests.
 *
 * Verifies:
 *  - RpcBudgetSaturationTracker tracks requests per target over a fixed window
 *  - Calculates saturation = used / budget
 *  - Avoids unbounded target identifiers in metric labels (bounds to known targets or "unknown")
 *  - Window sliding/expiration boundary behavior
 *  - Zero/negative budget boundary handling (clamped cleanly, no NaN/Infinity)
 *  - MetricsRegistry integration: mimir_bot_rpc_budget_* exposition in render()
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMetrics } from "../dist/metrics.js";
import {
  RpcBudgetSaturationTracker,
  normalizeTargetSource,
} from "../dist/stellar/metrics.js";

test("normalizeTargetSource: bounds target identifiers to allowed values", () => {
  assert.equal(normalizeTargetSource("market"), "market");
  assert.equal(normalizeTargetSource("squad"), "squad");
  assert.equal(normalizeTargetSource("MARKET"), "market");
  assert.equal(normalizeTargetSource(" squad "), "squad");

  // Unbounded or hostile inputs are normalized to "unknown"
  assert.equal(normalizeTargetSource(""), "unknown");
  assert.equal(normalizeTargetSource("custom_contract_12345"), "unknown");
  assert.equal(normalizeTargetSource("DROP TABLE users;"), "unknown");
  assert.equal(normalizeTargetSource(null), "unknown");
  assert.equal(normalizeTargetSource(undefined), "unknown");
  assert.equal(normalizeTargetSource(123), "unknown");
});

test("RpcBudgetSaturationTracker: records and tracks budget saturation per target", () => {
  let clock = 10_000;
  const tracker = new RpcBudgetSaturationTracker({
    budgetLimit: 10,
    windowMs: 60_000,
    now: () => clock,
  });

  // Initial state: used = 0, saturation = 0
  const initialMarket = tracker.getSnapshot("market");
  assert.equal(initialMarket.target, "market");
  assert.equal(initialMarket.used, 0);
  assert.equal(initialMarket.budget, 10);
  assert.equal(initialMarket.saturation, 0);

  // Record 5 requests for market
  tracker.record("market", 5);
  const snap1 = tracker.getSnapshot("market");
  assert.equal(snap1.used, 5);
  assert.equal(snap1.budget, 10);
  assert.equal(snap1.saturation, 0.5);

  // Record 2 requests for squad (independent tracking)
  tracker.record("squad", 2);
  const snapSquad = tracker.getSnapshot("squad");
  assert.equal(snapSquad.used, 2);
  assert.equal(snapSquad.saturation, 0.2);

  // Still 5 for market
  assert.equal(tracker.getSnapshot("market").used, 5);

  // Record 5 more for market: saturation reaches 1.0 (100%)
  tracker.record("market", 5);
  assert.equal(tracker.getSnapshot("market").saturation, 1.0);

  // Beyond budget: saturation exceeds 1.0
  tracker.record("market", 2);
  assert.equal(tracker.getSnapshot("market").saturation, 1.2);
});

test("RpcBudgetSaturationTracker: rolls off requests outside the fixed window", () => {
  let clock = 10_000;
  const tracker = new RpcBudgetSaturationTracker({
    budgetLimit: 10,
    windowMs: 60_000,
    now: () => clock,
  });

  tracker.record("market", 4);
  assert.equal(tracker.getUsed("market"), 4);

  // Advance clock by 30s (within window)
  clock += 30_000;
  tracker.record("market", 3);
  assert.equal(tracker.getUsed("market"), 7);

  // Advance clock past the first 60s window (clock is now 10,000 + 30,000 + 35,000 = 75,000)
  // The first 4 requests (recorded at 10,000) are older than 75,000 - 60,000 = 15,000, so they expire
  clock += 35_000;
  assert.equal(tracker.getUsed("market"), 3);

  // Advance clock past the second window (75,000 + 30,000 = 105,000)
  clock += 30_000;
  assert.equal(tracker.getUsed("market"), 0);
  assert.equal(tracker.getSnapshot("market").saturation, 0);
});

test("RpcBudgetSaturationTracker: handles boundary cases (zero budget, invalid counts, unknown targets)", () => {
  const tracker = new RpcBudgetSaturationTracker({
    budgetLimit: 0, // zero budget
    windowMs: 0,    // defaults to 60000
  });

  // Zero budget saturation: if used > 0 saturation is 1, else 0 (no division by zero or NaN)
  assert.equal(tracker.getSnapshot("market").saturation, 0);
  tracker.record("market", 1);
  assert.equal(tracker.getSnapshot("market").saturation, 1);

  // Invalid count ignored
  tracker.record("market", -5);
  tracker.record("market", NaN);
  assert.equal(tracker.getUsed("market"), 1);

  // Unbounded target identifier mapped to "unknown" label
  tracker.record("arbitrary-remote-target-id-1234567890", 2);
  const snapUnknown = tracker.getSnapshot("arbitrary-remote-target-id-1234567890");
  assert.equal(snapUnknown.target, "unknown");
  assert.equal(snapUnknown.used, 2);

  // getAllSnapshots includes known targets plus unknown
  const all = tracker.getAllSnapshots();
  assert.ok(all.some((s) => s.target === "market"));
  assert.ok(all.some((s) => s.target === "squad"));
  assert.ok(all.some((s) => s.target === "unknown"));
});

test("MetricsRegistry: renders RPC budget saturation metrics per target", () => {
  let clock = 100_000;
  const metrics = createMetrics({
    budgetLimit: 20,
    windowMs: 60_000,
    now: () => clock,
  });

  // Record 10 requests for market, 4 for squad
  metrics.recordRpcBudgetRequest("market", 10);
  metrics.recordRpcBudgetRequest("squad", 4);

  const marketSnap = metrics.getRpcBudgetSaturation("market");
  assert.equal(marketSnap.used, 10);
  assert.equal(marketSnap.budget, 20);
  assert.equal(marketSnap.saturation, 0.5);

  const squadSnap = metrics.getRpcBudgetSaturation("squad");
  assert.equal(squadSnap.used, 4);
  assert.equal(squadSnap.budget, 20);
  assert.equal(squadSnap.saturation, 0.2);

  const output = metrics.render();

  assert.ok(output.includes("# HELP mimir_bot_rpc_budget_used"), output);
  assert.ok(output.includes("# TYPE mimir_bot_rpc_budget_used gauge"), output);
  assert.ok(output.includes('mimir_bot_rpc_budget_used{target="market"} 10'), output);
  assert.ok(output.includes('mimir_bot_rpc_budget_used{target="squad"} 4'), output);

  assert.ok(output.includes("# HELP mimir_bot_rpc_budget_limit"), output);
  assert.ok(output.includes("# TYPE mimir_bot_rpc_budget_limit gauge"), output);
  assert.ok(output.includes('mimir_bot_rpc_budget_limit{target="market"} 20'), output);
  assert.ok(output.includes('mimir_bot_rpc_budget_limit{target="squad"} 20'), output);

  assert.ok(output.includes("# HELP mimir_bot_rpc_budget_saturation"), output);
  assert.ok(output.includes("# TYPE mimir_bot_rpc_budget_saturation gauge"), output);
  assert.ok(output.includes('mimir_bot_rpc_budget_saturation{target="market"} 0.5'), output);
  assert.ok(output.includes('mimir_bot_rpc_budget_saturation{target="squad"} 0.2'), output);
});
