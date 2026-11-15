import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { buildHealthReport, startHealthServer } from "../dist/health.js";
import { createMetrics } from "../dist/metrics.js";
import { createPoller } from "../dist/poller.js";
import {
  DEFAULT_SLI_MAX_SAMPLES,
  DEFAULT_SLI_WINDOW_MS,
  SERVICE_LEVEL_WINDOW_SCHEMA_VERSION,
  ServiceLevelWindow,
} from "../dist/stellar/metrics.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, timeout: 3000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

test("ServiceLevelWindow flags warming_up and no_cycles_observed before window matures", () => {
  let now = 1_000_000;
  const win = new ServiceLevelWindow({
    windowMs: 60_000,
    maxSamples: 16,
    startedAtMs: now,
    clock: () => now,
  });

  const cold = win.report();
  assert.equal(cold.schemaVersion, SERVICE_LEVEL_WINDOW_SCHEMA_VERSION);
  assert.equal(cold.windowMs, 60_000);
  assert.equal(cold.sampleCapacity, 16);
  assert.equal(cold.observedDurationMs, 0);
  assert.equal(cold.coverageRatio, 0);
  assert.equal(cold.complete, false);
  assert.deepEqual(cold.incompleteReasons, ["warming_up", "no_cycles_observed"]);
  assert.equal(cold.indicators.delivery.successRatio, null);
  assert.equal(cold.indicators.lag.p95Ms, null);
  assert.equal(cold.indicators.dataGap.gapFree, null);

  // Advance halfway through window with one healthy cycle: still warming_up.
  now += 30_000;
  win.recordCycle({ gapDetected: false });
  const warming = win.report();
  assert.equal(warming.complete, false);
  assert.deepEqual(warming.incompleteReasons, ["warming_up"]);
  assert.equal(warming.coverageRatio, 0.5);
  assert.equal(warming.indicators.dataGap.gapFree, true);
});

test("ServiceLevelWindow computes delivery success, lag quantiles, and data-gap indicators on a complete window", () => {
  let now = 2_000_000;
  const win = new ServiceLevelWindow({
    windowMs: 60_000,
    maxSamples: 32,
    startedAtMs: now,
    clock: () => now,
  });

  now += 60_000;
  win.recordCycle({ atMs: now - 40_000, gapDetected: false });
  win.recordCycle({
    atMs: now - 20_000,
    gapDetected: true,
    missedLedgers: 15,
    truncatedScans: 1,
    failedScans: 0,
  });
  win.recordCycle({ atMs: now - 5_000, gapDetected: false, failedScans: 1 });
  win.recordCycle({ atMs: now - 1_000, gapDetected: false });

  // 4 deliveries: 3 succeeded (two with lag, one missing chain timestamp), 1 failed
  win.recordDelivery({ atMs: now - 35_000, ok: true, lagMs: 1_200 });
  win.recordDelivery({ atMs: now - 25_000, ok: true, lagMs: 3_400 });
  win.recordDelivery({ atMs: now - 15_000, ok: true, lagMs: null });
  win.recordDelivery({ atMs: now - 5_000, ok: false, lagMs: null });

  const report = win.report();
  assert.equal(report.complete, true);
  assert.deepEqual(report.incompleteReasons, []);
  assert.equal(report.coverageRatio, 1);

  assert.deepEqual(report.indicators.delivery, {
    attempts: 4,
    succeeded: 3,
    failed: 1,
    successRatio: 0.75,
  });

  assert.deepEqual(report.indicators.lag, {
    samples: 2,
    missingTimestampCount: 2,
    minMs: 1_200,
    p50Ms: 1_200,
    p95Ms: 3_400,
    maxMs: 3_400,
  });

  assert.deepEqual(report.indicators.dataGap, {
    cyclesObserved: 4,
    gapEvents: 1,
    missedLedgers: 15,
    truncatedScans: 1,
    failedScans: 1,
    gapFree: false,
    healthyCycleRatio: 0.5,
  });
});

test("ServiceLevelWindow marks sample_buffer_truncated when burst exceeds maxSamples and recovers once aged out", () => {
  let now = 5_000_000;
  const win = new ServiceLevelWindow({
    windowMs: 10_000,
    maxSamples: 4,
    startedAtMs: now - 20_000,
    clock: () => now,
  });

  win.recordCycle({ atMs: now - 9_000 });
  // Push 6 deliveries within [now - 6000, now - 1000] into a 4-sample ring
  for (let i = 6; i >= 1; i -= 1) {
    win.recordDelivery({ atMs: now - i * 1_000, ok: true, lagMs: i * 100 });
  }

  const truncated = win.report();
  assert.equal(truncated.complete, false);
  assert.deepEqual(truncated.incompleteReasons, ["sample_buffer_truncated"]);
  assert.equal(truncated.indicators.delivery.attempts, 4);
  assert.ok(truncated.coverageRatio < 1 && truncated.coverageRatio > 0);

  // Advance past the window so the evicted sample at (prevNow - 5000) falls outside [now - 10000, now]
  now += 6_000;
  win.recordCycle({ atMs: now - 500 });
  const recovered = win.report();
  assert.equal(recovered.complete, true);
  assert.deepEqual(recovered.incompleteReasons, []);
  assert.equal(recovered.coverageRatio, 1);
});

test("ServiceLevelWindow rejects invalid options and defaults to bounded constants", () => {
  const defaults = new ServiceLevelWindow();
  assert.equal(defaults.windowMs, DEFAULT_SLI_WINDOW_MS);
  assert.equal(defaults.maxSamples, DEFAULT_SLI_MAX_SAMPLES);

  assert.throws(() => new ServiceLevelWindow({ windowMs: 0 }), RangeError);
  assert.throws(() => new ServiceLevelWindow({ maxSamples: -3 }), RangeError);
  assert.throws(() => new ServiceLevelWindow({ windowMs: Number.NaN }), RangeError);
});

test("GET /metrics/window and GET /health/window serve machine-readable SLI window JSON without secrets", async () => {
  let now = 10_000_000;
  const metrics = createMetrics({
    serviceLevelWindow: {
      windowMs: 30_000,
      maxSamples: 16,
      startedAtMs: now - 30_000,
      clock: () => now,
    },
  });
  metrics.serviceLevelWindow.recordCycle({ atMs: now - 5_000, gapDetected: false });
  metrics.serviceLevelWindow.recordDelivery({ atMs: now - 2_000, ok: true, lagMs: 850 });

  const metricsSrv = await metrics.startServer(0);
  try {
    const winRes = await httpGet(metricsSrv.port, "/metrics/window");
    assert.equal(winRes.status, 200);
    assert.match(winRes.headers["content-type"] ?? "", /application\/json/);
    assert.equal(winRes.headers["cache-control"], "no-store");

    const parsed = JSON.parse(winRes.body);
    assert.equal(parsed.complete, true);
    assert.equal(parsed.indicators.delivery.successRatio, 1);
    assert.equal(parsed.indicators.lag.p50Ms, 850);
    assert.equal(parsed.indicators.dataGap.gapFree, true);
    assert.equal(winRes.body.toLowerCase().includes("token"), false);

    const promRes = await httpGet(metricsSrv.port, "/metrics");
    assert.match(promRes.body, /mimir_bot_sli_window_complete 1/);
  } finally {
    await metricsSrv.close();
  }

  await withTempDataDir(async ({ file }) => {
    const fakeToken = ["111111:fake", "bot", "credential"].join("-");
    const config = {
      version: "0.1.0",
      marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      marketContractVersion: "v1",
      squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
      squadContractVersion: "v1",
      rpcUrl: "https://soroban-testnet.stellar.org",
      horizonUrl: "https://horizon-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      botToken: fakeToken,
      chatId: "-1001234567890",
      chatIds: ["-1001234567890"],
      operatorTelegramUserId: null,
      pollIntervalMs: 30_000,
      startLookbackLedgers: 60,
      cursorFile: file("cursors.json"),
      countersFile: file("counters.json"),
      auditFile: file("audit.jsonl"),
      deadLetterFile: file("dlq.json"),
      deadLetterMax: 50,
      deadLetterMaxAttempts: 5,
      maxNotificationsPerCycle: 20,
      healthHost: "127.0.0.1",
      healthPort: 18793,
      healthStaleMs: 90_000,
      healthAuthToken: null,
    };

    let pollerClock = Date.UTC(2026, 9, 19, 12, 0, 0);
    const fakeServer = {
      getHealth: async () => ({
        status: "healthy",
        latestLedger: 500,
        oldestLedger: 100,
      }),
      getEvents: async () => ({
        events: [],
        latestLedger: 500,
        oldestLedger: 100,
        cursor: "0000500-0001",
      }),
    };

    const poller = createPoller({
      config,
      server: fakeServer,
      send: async () => {},
      now: () => pollerClock,
      sleep: async () => {},
      serviceLevelWindowOptions: {
        windowMs: 10_000,
        maxSamples: 16,
        startedAtMs: pollerClock - 10_000,
      },
    });

    await poller.runCycle();

    const report = buildHealthReport(config, poller.status(), pollerClock);
    assert.equal(report.poller.serviceLevelWindow.complete, true);
    assert.equal(report.poller.serviceLevelWindow.indicators.dataGap.cyclesObserved, 1);
    assert.equal(report.poller.serviceLevelWindow.indicators.dataGap.gapFree, true);

    const healthSrv = startHealthServer({
      config,
      status: () => poller.status(),
      now: () => pollerClock,
    });
    try {
      const res = await fetch(`${healthSrv.url}/health/window`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.schemaVersion, 1);
      assert.equal(body.complete, true);
      assert.equal(body.indicators.dataGap.cyclesObserved, 1);
      assert.equal(JSON.stringify(body).includes(fakeToken), false);
    } finally {
      await healthSrv.close();
    }
  });
});
