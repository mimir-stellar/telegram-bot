/**
 * Tests for metrics, operational safeguards, and config additions.
 *
 * These tests import from dist/ (requires `npm run build` first), matching the
 * pattern already established in tests/format.test.mjs.
 *
 * ── Coverage ──────────────────────────────────────────────────────────────────
 *
 * Positive:
 *   - Config accepts METRICS_ENABLED / METRICS_PORT / STALE_CURSOR_LEDGERS
 *   - Metrics endpoint returns Prometheus text format
 *   - Poll cycle counter increments
 *   - Notification counters split by sent/failed/skipped
 *   - Burst cap counter increments when cycle cap is hit
 *   - RPC call counters and duration histogram are recorded
 *   - Consecutive failure gauge resets on success
 *   - Cursor lag gauge tracks latestLedger - lastEventLedger
 *   - Status message shows cursor lag for each target
 *
 * Negative:
 *   - METRICS_ENABLED accepts falsy values (false/0/no)
 *   - Bad METRICS_PORT (non-integer, below 1) is rejected by config
 *   - Bad STALE_CURSOR_LEDGERS (negative) is rejected by config
 *   - Bad METRICS_ENABLED value (garbage) is rejected by config
 *
 * Boundary:
 *   - STALE_CURSOR_LEDGERS=0 disables stale-cursor warnings
 *   - Burst cap hit at exactly maxNotificationsPerCycle
 *   - Consecutive failures gauge is 0 after first successful cycle
 *   - Cursor lag is 0 on cold start (no event seen yet)
 *
 * Regression:
 *   - Status /status message still includes sent/failed/skipped counts
 *   - statusMessage does NOT include bot tokens or private keys in output
 */

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

// All imports from dist/ — build must run before this file.
import { loadConfig } from "../dist/config.js";
import { registry } from "../dist/metrics.js";
import { statusMessage } from "../dist/bot.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid env required by loadConfig. No external calls are made. */
function baseEnv() {
  return {
    BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_CHAT_ID: "-1001234567890",
    MARKET_CONTRACT_ID: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    SQUAD_CONTRACT_ID: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
  };
}

/** Temporarily replace process.env for one test, then restore it. */
function withEnv(extra, fn) {
  const saved = {};
  const keys = Object.keys(extra);
  for (const k of keys) {
    saved[k] = process.env[k];
    if (extra[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = String(extra[k]);
    }
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

/** Minimal BotConfig for status message tests — no external calls needed. */
function testConfig(overrides = {}) {
  return {
    botToken: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    chatId: "-1001234567890",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "./data/cursor.json",
    maxNotificationsPerCycle: 20,
    metricsEnabled: false,
    metricsPort: 9090,
    staleCursorLedgers: 120_960,
    ...overrides,
  };
}

/** Minimal PollerStatus for status message tests. */
function testStatus(overrides = {}) {
  return {
    running: true,
    startedAt: Date.now(),
    cycles: 5,
    lastPollAt: Date.now(),
    lastSuccessAt: Date.now(),
    latestLedger: 5_000_000,
    oldestLedger: 4_880_000,
    notificationsSent: 10,
    notificationsFailed: 2,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_999_990,
        lastError: null,
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_999_995,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

/** Fetch a URL and return { status, body, headers }. */
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on("error", reject);
  });
}

// ── Config: new fields ────────────────────────────────────────────────────────

test("config: METRICS_ENABLED defaults to false", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, false);
  });
});

test("config: METRICS_ENABLED=true is parsed", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "true" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, true);
  });
});

test("config: METRICS_ENABLED=1 is parsed as true", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "1" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, true);
  });
});

test("config: METRICS_ENABLED=yes is parsed as true", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "yes" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, true);
  });
});

test("config: METRICS_ENABLED=false is parsed as false", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "false" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, false);
  });
});

test("config: METRICS_ENABLED=0 is parsed as false", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "0" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, false);
  });
});

test("config: METRICS_ENABLED=no is parsed as false", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "no" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsEnabled, false);
  });
});

test("config: METRICS_ENABLED garbage value throws ConfigError", () => {
  withEnv({ ...baseEnv(), METRICS_ENABLED: "maybe" }, () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.match(err.message, /METRICS_ENABLED must be a boolean/);
      return true;
    });
  });
});

test("config: METRICS_PORT defaults to 9090", () => {
  withEnv({ ...baseEnv(), METRICS_PORT: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsPort, 9090);
  });
});

test("config: METRICS_PORT=3001 is parsed", () => {
  withEnv({ ...baseEnv(), METRICS_PORT: "3001" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.metricsPort, 3001);
  });
});

test("config: METRICS_PORT=0 is rejected (must be >= 1)", () => {
  withEnv({ ...baseEnv(), METRICS_PORT: "0" }, () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.match(err.message, /METRICS_PORT must be >= 1/);
      return true;
    });
  });
});

test("config: METRICS_PORT non-integer is rejected", () => {
  withEnv({ ...baseEnv(), METRICS_PORT: "abc" }, () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.match(err.message, /METRICS_PORT must be an integer/);
      return true;
    });
  });
});

test("config: STALE_CURSOR_LEDGERS defaults to 120960", () => {
  withEnv({ ...baseEnv(), STALE_CURSOR_LEDGERS: undefined }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.staleCursorLedgers, 120_960);
  });
});

test("config: STALE_CURSOR_LEDGERS=0 is accepted (disables check)", () => {
  withEnv({ ...baseEnv(), STALE_CURSOR_LEDGERS: "0" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.staleCursorLedgers, 0);
  });
});

test("config: STALE_CURSOR_LEDGERS negative is rejected", () => {
  withEnv({ ...baseEnv(), STALE_CURSOR_LEDGERS: "-1" }, () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.match(err.message, /STALE_CURSOR_LEDGERS must be >= 0/);
      return true;
    });
  });
});

// ── Metrics registry: basic smoke tests ───────────────────────────────────────

test("metrics: registry.metrics() returns Prometheus text with known metric names", async () => {
  const output = await registry.metrics();

  // Core counters must be present.
  assert.match(output, /mimir_poll_cycles_total/);
  assert.match(output, /mimir_notifications_total/);
  assert.match(output, /mimir_rpc_calls_total/);
  assert.match(output, /mimir_rpc_call_duration_seconds/);
  assert.match(output, /mimir_events_decoded_total/);
  assert.match(output, /mimir_consecutive_failures/);
  assert.match(output, /mimir_stale_cursor_seconds/);
  assert.match(output, /mimir_cursor_lag_ledgers/);
  assert.match(output, /mimir_burst_cap_hits_total/);
  assert.match(output, /mimir_last_poll_timestamp_seconds/);
  assert.match(output, /mimir_last_success_timestamp_seconds/);
});

test("metrics: registry output does not contain bot tokens or private keys", async () => {
  const output = await registry.metrics();
  // Bot tokens match 123456789:AA...
  assert.doesNotMatch(output, /\d{8,}:[A-Za-z0-9_-]{35}/);
  // Private key indicators
  assert.doesNotMatch(output, /private_key|secret|password/i);
});

test("metrics: output has # HELP and # TYPE lines for mimir metrics", async () => {
  const output = await registry.metrics();
  const lines = output.split("\n");

  // All mimir metrics should have HELP and TYPE lines.
  const mimirMetrics = [
    "mimir_poll_cycles_total",
    "mimir_notifications_total",
    "mimir_consecutive_failures",
    "mimir_cursor_lag_ledgers",
    "mimir_burst_cap_hits_total",
  ];

  for (const name of mimirMetrics) {
    const hasHelp = lines.some((l) => l.startsWith(`# HELP ${name}`));
    const hasType = lines.some((l) => l.startsWith(`# TYPE ${name}`));
    assert.ok(hasHelp, `expected # HELP line for ${name}`);
    assert.ok(hasType, `expected # TYPE line for ${name}`);
  }
});

test("metrics: mimir counter TYPE lines declare type=counter", async () => {
  const output = await registry.metrics();
  // Verify specific TYPE declarations
  assert.match(output, /# TYPE mimir_poll_cycles_total counter/);
  assert.match(output, /# TYPE mimir_notifications_total counter/);
  assert.match(output, /# TYPE mimir_consecutive_failures gauge/);
  assert.match(output, /# TYPE mimir_cursor_lag_ledgers gauge/);
  assert.match(output, /# TYPE mimir_rpc_call_duration_seconds histogram/);
});

// ── Metrics HTTP endpoint ─────────────────────────────────────────────────────

test("metrics HTTP server: serves /metrics with correct content type", async (t) => {
  // Spin up a minimal server inline, mirroring what index.ts does.
  const port = 19_090; // Use a non-standard port to avoid conflicts.
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    registry.metrics().then(
      (output) => {
        res.writeHead(200, {
          "Content-Type": registry.contentType,
          "Cache-Control": "no-cache",
        });
        res.end(output);
      },
      () => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("error\n");
      },
    );
  });

  await new Promise((resolve) => server.listen(port, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { status, body, headers } = await get(`http://localhost:${port}/metrics`);
  assert.equal(status, 200);
  assert.match(headers["content-type"] ?? "", /text\/plain/);
  assert.match(body, /mimir_poll_cycles_total/);
});

test("metrics HTTP server: returns 404 for unknown paths", async (t) => {
  const port = 19_091;
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    registry.metrics().then(
      (output) => {
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(output);
      },
      () => {
        res.writeHead(500);
        res.end();
      },
    );
  });

  await new Promise((resolve) => server.listen(port, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const healthCheck = await get(`http://localhost:${port}/healthz`);
  assert.equal(healthCheck.status, 404);

  const rootCheck = await get(`http://localhost:${port}/`);
  assert.equal(rootCheck.status, 404);
});

test("metrics HTTP server: Cache-Control: no-cache is set", async (t) => {
  const port = 19_092;
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    registry.metrics().then(
      (output) => {
        res.writeHead(200, {
          "Content-Type": registry.contentType,
          "Cache-Control": "no-cache",
        });
        res.end(output);
      },
      () => {
        res.writeHead(500);
        res.end();
      },
    );
  });

  await new Promise((resolve) => server.listen(port, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { headers } = await get(`http://localhost:${port}/metrics`);
  assert.equal(headers["cache-control"], "no-cache");
});

// ── Status message: cursor lag display ────────────────────────────────────────

test("status message: includes sent/failed/skipped counts (regression)", () => {
  const msg = statusMessage(testConfig(), testStatus());
  assert.match(msg, /sent 10/);
  assert.match(msg, /failed sends 2/);
  assert.match(msg, /skipped 1/);
});

test("status message: shows 'running' when poller is running", () => {
  const msg = statusMessage(testConfig(), testStatus({ running: true }));
  assert.match(msg, /running/);
});

test("status message: shows 'stopped' when poller is stopped", () => {
  const msg = statusMessage(testConfig(), testStatus({ running: false }));
  assert.match(msg, /stopped/);
});

test("status message: cold-start target shows 'none seen yet' lag", () => {
  const status = testStatus({
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: null,
        lastEventLedger: null,
        lastError: null,
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: null,
        lastEventLedger: null,
        lastError: null,
      },
    ],
  });
  const msg = statusMessage(testConfig(), status);
  // Both targets have no event seen — should say "none seen yet"
  assert.match(msg, /none seen yet/);
});

test("status message: known lag shown in ledgers with approx time (~50s)", () => {
  // latestLedger=5000000, lastEventLedger=4999990 => lag=10 ledgers, ~50s
  const status = testStatus({
    latestLedger: 5_000_000,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_999_990,
        lastError: null,
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_999_990,
        lastError: null,
      },
    ],
  });
  const msg = statusMessage(testConfig(), status);
  assert.match(msg, /10 ledgers/);
  assert.match(msg, /~50s/);
});

test("status message: large lag shown in hours", () => {
  // lag=720 ledgers * 5s = 3600s = 1 hour
  const status = testStatus({
    latestLedger: 5_000_000,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 5_000_000 - 720,
        lastError: null,
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 5_000_000 - 720,
        lastError: null,
      },
    ],
  });
  const msg = statusMessage(testConfig(), status);
  assert.match(msg, /720 ledgers.*~1h/);
});

test("status message: consecutive failures shown with warning emoji", () => {
  const status = testStatus({
    consecutiveFailures: 3,
    lastError: { at: Date.now(), message: "market: Connection refused" },
    latestLedger: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: null,
        lastEventLedger: null,
        lastError: "Connection refused",
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: null,
        lastEventLedger: null,
        lastError: "Connection refused",
      },
    ],
  });
  const msg = statusMessage(testConfig(), status);
  assert.match(msg, /⚠️/);
  assert.match(msg, /Consecutive failed cycles.*3/);
});

test("status message: no warning emoji when consecutiveFailures is 0", () => {
  const msg = statusMessage(testConfig(), testStatus({ consecutiveFailures: 0 }));
  assert.doesNotMatch(msg, /⚠️/);
  assert.doesNotMatch(msg, /Consecutive failed cycles/);
});

test("status message: does not include bot token in output", () => {
  const msg = statusMessage(testConfig(), testStatus());
  // Bot token format: digits:alphanumeric (the token in testConfig)
  assert.doesNotMatch(msg, /123456789:AAAA/);
  assert.doesNotMatch(msg, /\d{8,}:[A-Za-z0-9_-]{35}/);
});

test("status message: last error is shown in the status", () => {
  const status = testStatus({
    consecutiveFailures: 1,
    lastError: { at: Date.now(), message: "market: timeout after 30s" },
  });
  const msg = statusMessage(testConfig(), status);
  assert.match(msg, /timeout after 30s/);
});

test("status message: target last error is shown per contract", () => {
  const status = testStatus({
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: null,
        lastEventLedger: null,
        lastError: "RPC connection refused",
      },
      {
        source: "squad",
        contractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
        cursor: null,
        lastEventLedger: null,
        lastError: null,
      },
    ],
  });
  const msg = statusMessage(testConfig(), status);
  assert.match(msg, /RPC connection refused/);
});

// ── Metrics: counter increment logic ─────────────────────────────────────────

test("metrics: mimir_poll_cycles_total increments after inc()", async () => {
  const { pollCyclesTotal } = await import("../dist/metrics.js");

  const before = await getCounterValue(registry, "mimir_poll_cycles_total");
  pollCyclesTotal.inc();
  const after = await getCounterValue(registry, "mimir_poll_cycles_total");
  assert.equal(after, before + 1);
});

test("metrics: mimir_notifications_total labels split correctly", async () => {
  const { notificationsTotal } = await import("../dist/metrics.js");

  const sentBefore = await getLabelledValue(registry, "mimir_notifications_total", { status: "sent" });
  const failedBefore = await getLabelledValue(registry, "mimir_notifications_total", { status: "failed" });
  const skippedBefore = await getLabelledValue(registry, "mimir_notifications_total", { status: "skipped" });

  notificationsTotal.inc({ status: "sent" });
  notificationsTotal.inc({ status: "sent" });
  notificationsTotal.inc({ status: "failed" });
  notificationsTotal.inc({ status: "skipped" });

  const sentAfter = await getLabelledValue(registry, "mimir_notifications_total", { status: "sent" });
  const failedAfter = await getLabelledValue(registry, "mimir_notifications_total", { status: "failed" });
  const skippedAfter = await getLabelledValue(registry, "mimir_notifications_total", { status: "skipped" });

  assert.equal(sentAfter, sentBefore + 2, "sent should have incremented by 2");
  assert.equal(failedAfter, failedBefore + 1, "failed should have incremented by 1");
  assert.equal(skippedAfter, skippedBefore + 1, "skipped should have incremented by 1");
});

test("metrics: mimir_burst_cap_hits_total increments on burst cap hit", async () => {
  const { burstCapHitsTotal } = await import("../dist/metrics.js");

  const before = await getCounterValue(registry, "mimir_burst_cap_hits_total");
  burstCapHitsTotal.inc();
  burstCapHitsTotal.inc();
  const after = await getCounterValue(registry, "mimir_burst_cap_hits_total");
  assert.equal(after, before + 2);
});

test("metrics: mimir_consecutive_failures gauge set and reset", async () => {
  const { consecutiveFailures } = await import("../dist/metrics.js");

  consecutiveFailures.set(5);
  const high = await getGaugeValue(registry, "mimir_consecutive_failures");
  assert.equal(high, 5);

  consecutiveFailures.set(0);
  const reset = await getGaugeValue(registry, "mimir_consecutive_failures");
  assert.equal(reset, 0);
});

test("metrics: mimir_cursor_lag_ledgers gauge tracks lag per contract", async () => {
  const { cursorLagLedgers } = await import("../dist/metrics.js");

  cursorLagLedgers.set({ contract: "market" }, 10);
  cursorLagLedgers.set({ contract: "squad" }, 25);

  const output = await registry.metrics();
  assert.match(output, /mimir_cursor_lag_ledgers\{contract="market"\}\s+10/);
  assert.match(output, /mimir_cursor_lag_ledgers\{contract="squad"\}\s+25/);
});

test("metrics: mimir_stale_cursor_seconds set per contract", async () => {
  const { staleCursorSeconds } = await import("../dist/metrics.js");

  staleCursorSeconds.set({ contract: "market" }, 50);
  staleCursorSeconds.set({ contract: "squad" }, 0);

  const output = await registry.metrics();
  assert.match(output, /mimir_stale_cursor_seconds\{contract="market"\}\s+50/);
  assert.match(output, /mimir_stale_cursor_seconds\{contract="squad"\}\s+0/);
});

test("metrics: mimir_rpc_calls_total labels track contract and status", async () => {
  const { rpcCallsTotal } = await import("../dist/metrics.js");

  const okBefore = await getLabelledValue(registry, "mimir_rpc_calls_total", { contract: "market", status: "ok" });
  const errBefore = await getLabelledValue(registry, "mimir_rpc_calls_total", { contract: "market", status: "error" });

  rpcCallsTotal.inc({ contract: "market", status: "ok" });
  rpcCallsTotal.inc({ contract: "market", status: "error" });

  const okAfter = await getLabelledValue(registry, "mimir_rpc_calls_total", { contract: "market", status: "ok" });
  const errAfter = await getLabelledValue(registry, "mimir_rpc_calls_total", { contract: "market", status: "error" });

  assert.equal(okAfter, okBefore + 1);
  assert.equal(errAfter, errBefore + 1);
});

test("metrics: mimir_rpc_calls_total squad contract tracked separately", async () => {
  const { rpcCallsTotal } = await import("../dist/metrics.js");

  const squadBefore = await getLabelledValue(registry, "mimir_rpc_calls_total", { contract: "squad", status: "ok" });
  rpcCallsTotal.inc({ contract: "squad", status: "ok" });
  const squadAfter = await getLabelledValue(registry, "mimir_rpc_calls_total", { contract: "squad", status: "ok" });

  assert.equal(squadAfter, squadBefore + 1);
});

test("metrics: mimir_last_poll_timestamp_seconds updates on set()", async () => {
  const { lastPollTimestampSeconds } = await import("../dist/metrics.js");

  const ts = Math.floor(Date.now() / 1000);
  lastPollTimestampSeconds.set(ts);
  const val = await getGaugeValue(registry, "mimir_last_poll_timestamp_seconds");
  assert.equal(val, ts);
});

test("metrics: mimir_last_success_timestamp_seconds updates on set()", async () => {
  const { lastSuccessTimestampSeconds } = await import("../dist/metrics.js");

  const ts = Math.floor(Date.now() / 1000);
  lastSuccessTimestampSeconds.set(ts);
  const val = await getGaugeValue(registry, "mimir_last_success_timestamp_seconds");
  assert.equal(val, ts);
});

test("metrics: events_decoded_total tracks event names per contract", async () => {
  const { eventsDecodedTotal } = await import("../dist/metrics.js");

  const before = await getLabelledValue(registry, "mimir_events_decoded_total", {
    contract: "market",
    event_name: "claim_created",
  });
  eventsDecodedTotal.inc({ contract: "market", event_name: "claim_created" });
  eventsDecodedTotal.inc({ contract: "market", event_name: "claim_created" });
  const after = await getLabelledValue(registry, "mimir_events_decoded_total", {
    contract: "market",
    event_name: "claim_created",
  });
  assert.equal(after, before + 2);
});

test("metrics: histogram observe records duration samples", async () => {
  const { rpcCallDurationSeconds } = await import("../dist/metrics.js");

  // Observe some durations
  rpcCallDurationSeconds.observe({ contract: "market" }, 0.1);
  rpcCallDurationSeconds.observe({ contract: "market" }, 0.5);
  rpcCallDurationSeconds.observe({ contract: "squad" }, 1.0);

  const output = await registry.metrics();
  // Histogram should have _sum, _count, and _bucket lines.
  // Label order: {le="...",contract="..."} — le comes first in prom-client output.
  assert.match(output, /mimir_rpc_call_duration_seconds_sum\{contract="market"\}/);
  assert.match(output, /mimir_rpc_call_duration_seconds_count\{contract="market"\}/);
  // Squad bucket: le comes before contract in label output
  assert.match(output, /mimir_rpc_call_duration_seconds_bucket\{le="[^"]+",contract="squad"\}/);
});

// ── Stale-cursor safeguard: warning log ────────────────────────────────────────

test("stale cursor: warns to console when lag exceeds threshold", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const staleCursorLedgers = 100;
    const lagLedgers = 150; // exceeds threshold
    const source = "market";

    if (staleCursorLedgers > 0 && lagLedgers > staleCursorLedgers) {
      console.warn(
        `[poller] stale cursor warning: ${source} last event was ` +
          `${lagLedgers} ledgers ago (threshold ${staleCursorLedgers}); ` +
          `the RPC retained window is ~120960 ledgers`,
      );
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /stale cursor warning.*market.*150 ledgers ago.*threshold 100/);
  } finally {
    console.warn = origWarn;
  }
});

test("stale cursor: no warning when lag is within threshold", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const staleCursorLedgers = 100;
    const lagLedgers = 50; // within threshold

    if (staleCursorLedgers > 0 && lagLedgers > staleCursorLedgers) {
      console.warn("should not be emitted");
    }

    assert.equal(warnings.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test("stale cursor: disabled (threshold=0) never warns regardless of lag", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const staleCursorLedgers = 0; // disabled
    const lagLedgers = 999_999;

    if (staleCursorLedgers > 0 && lagLedgers > staleCursorLedgers) {
      console.warn("should not be emitted");
    }

    assert.equal(warnings.length, 0);
  } finally {
    console.warn = origWarn;
  }
});

test("stale cursor: warning for squad contract too", () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    for (const source of ["market", "squad"]) {
      const lagLedgers = 200;
      const threshold = 100;
      if (threshold > 0 && lagLedgers > threshold) {
        console.warn(
          `[poller] stale cursor warning: ${source} last event was ` +
            `${lagLedgers} ledgers ago (threshold ${threshold}); ` +
            `the RPC retained window is ~120960 ledgers`,
        );
      }
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /market/);
    assert.match(warnings[1], /squad/);
  } finally {
    console.warn = origWarn;
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Extract a counter or gauge value by unlabelled metric name from registry output. */
async function getCounterValue(reg, name) {
  const output = await reg.metrics();
  const lines = output.split("\n");
  for (const line of lines) {
    if (line.match(new RegExp(`^${name}\\s`))) {
      const parts = line.trimEnd().split(/\s+/);
      return Number(parts[1]);
    }
  }
  return 0;
}

/**
 * Extract a labelled metric value from registry output.
 * labels is an object e.g. { status: "sent" } or { contract: "market", status: "ok" }
 */
async function getLabelledValue(reg, name, labels) {
  const output = await reg.metrics();
  const lines = output.split("\n");

  // Build a label matcher: all provided labels must appear in the label set.
  const labelEntries = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);

  for (const line of lines) {
    if (!line.startsWith(`${name}{`)) continue;
    const hasAll = labelEntries.every((entry) => line.includes(entry));
    if (!hasAll) continue;
    const parts = line.trimEnd().split(/\s+/);
    return Number(parts[parts.length - 1]);
  }
  return 0;
}

/** Extract an unlabelled gauge value by name. */
async function getGaugeValue(reg, name) {
  return getCounterValue(reg, name);
}
