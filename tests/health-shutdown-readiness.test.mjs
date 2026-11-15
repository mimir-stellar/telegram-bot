import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { healthMessage } from "../dist/bot.js";
import {
  buildHealthReport,
  runGracefulShutdownSequence,
  startHealthServer,
} from "../dist/health.js";
import { createPoller } from "../dist/poller.js";

const FAKE_BOT_CRED = ["0000000000:SECRET", "-DO-NOT-LEAK"].join("");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function baseConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: FAKE_BOT_CRED,
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/tmp/unused-cursor.json",
    maxNotificationsPerCycle: 20,
    deadLetterFile: "/tmp/unused-dead-letter.json",
    deadLetterMax: 100,
    deadLetterMaxAttempts: 10,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    shutdownTimeoutMs: 2_000,
    ...overrides,
  };
}

function baseStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    startedAt: 1_000,
    cycles: 4,
    lastPollAt: 5_000,
    lastSuccessAt: 5_000,
    latestLedger: 42,
    oldestLedger: 1,
    chainClockAt: 5_000,
    notificationsSent: 2,
    notificationsFailed: 0,
    eventsSkipped: 1,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 40,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test("beginShutdown marks readiness false while liveness stays true before polling stops", async () => {
  const port = await getFreePort();
  const status = baseStatus({ running: true, stopping: false });
  const server = startHealthServer({
    config: baseConfig({ healthPort: port }),
    status: () => status,
    now: () => 5_500,
  });

  try {
    assert.equal(server.draining, false);

    // Before shutdown transition: readiness and liveness are both 200
    const readyBefore = await fetch(`${server.url}/health`);
    assert.equal(readyBefore.status, 200);
    const readyBeforeBody = await readyBefore.json();
    assert.equal(readyBeforeBody.ok, true);
    assert.equal(readyBeforeBody.status, "ok");

    // Transition readiness BEFORE poller.shutdown() flips status.stopping
    server.beginShutdown();
    server.beginShutdown(); // idempotent
    assert.equal(server.draining, true);
    assert.equal(status.stopping, false, "poller has not started stopping yet");

    const readyDuring = await fetch(`${server.url}/health`);
    const readyAliasDuring = await fetch(`${server.url}/healthz`);
    assert.equal(readyDuring.status, 503);
    assert.equal(readyAliasDuring.status, 503);
    const readyDuringBody = await readyDuring.json();
    assert.equal(readyDuringBody.ok, false);
    assert.equal(readyDuringBody.status, "draining");
    assert.equal(readyDuringBody.poller.running, true);
    assert.equal(readyDuringBody.poller.stopping, false);

    // Liveness stays 200 / ok: true throughout drain
    const liveDuring = await fetch(`${server.url}/health/live`);
    const liveAliasDuring = await fetch(`${server.url}/livez`);
    assert.equal(liveDuring.status, 200);
    assert.equal(liveAliasDuring.status, 200);
    const liveDuringBody = await liveDuring.json();
    assert.equal(liveDuringBody.ok, true);
    assert.equal(liveDuringBody.status, "live");
  } finally {
    await server.close();
  }
});

test("POST /telegram-webhook stops accepting operational work immediately during drain before server close", async () => {
  const port = await getFreePort();
  let webhookCalls = 0;
  const server = startHealthServer({
    config: baseConfig({ healthPort: port }),
    status: () => baseStatus({ running: true, stopping: false }),
    webhookHandler: (_req, res) => {
      webhookCalls += 1;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    },
  });

  try {
    // Operational webhook work is accepted while ready
    const accepted = await fetch(`${server.url}/telegram-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(webhookCalls, 1);

    // Begin shutdown readiness transition: HTTP server stays open for probes,
    // but operational webhook updates are rejected with 503.
    server.beginShutdown();

    const rejected = await fetch(`${server.url}/telegram-webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 2 }),
    });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
    const rejectedBody = await rejected.json();
    assert.deepEqual(rejectedBody, { ok: false, error: "shutting_down" });
    assert.equal(webhookCalls, 1, "webhookHandler must not be invoked during drain");

    // Liveness probe still succeeds on the open HTTP server
    const live = await fetch(`${server.url}/health/live`);
    assert.equal(live.status, 200);
  } finally {
    await server.close();
  }
});

test("live poller drain + runGracefulShutdownSequence transitions readiness, drains work, stops bot, then closes HTTP", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "mimir-drain-readiness-"));
  const port = await getFreePort();
  const order = [];
  let releaseInFlightScan;
  let scanEnteredResolve;
  const scanEntered = new Promise((resolve) => {
    scanEnteredResolve = resolve;
  });
  let blockScan = false;

  try {
    const config = baseConfig({
      healthPort: port,
      cursorFile: path.join(tmpDir, "cursor.json"),
      deadLetterFile: path.join(tmpDir, "dead-letter.json"),
      pollIntervalMs: 60_000,
      shutdownTimeoutMs: 5_000,
    });

    const poller = createPoller({
      config,
      server: {
        async getHealth() {
          return { status: "healthy", oldestLedger: 100, latestLedger: 200 };
        },
        async getEvents() {
          if (blockScan) {
            blockScan = false;
            scanEnteredResolve();
            await new Promise((resolve) => {
              releaseInFlightScan = resolve;
            });
          }
          return { events: [], latestLedger: 200 };
        },
      },
      send: async () => undefined,
    });

    // Warm up running state with one quick cycle, then block the next cycle deterministically
    await poller.pollOnce();

    let webhookAccepted = 0;
    const healthServer = startHealthServer({
      config,
      status: () => poller.status(),
      webhookHandler: (_req, res) => {
        webhookAccepted += 1;
        res.writeHead(200);
        res.end("ok");
      },
    });

    try {
      // Start an in-flight cycle that blocks inside getEvents
      blockScan = true;
      const cyclePromise = poller.runCycle();
      await scanEntered;

      const shutdownPromise = runGracefulShutdownSequence({
        healthServer: {
          beginShutdown() {
            order.push("health.beginShutdown");
            healthServer.beginShutdown();
          },
          async close() {
            order.push("health.close");
            await healthServer.close();
          },
        },
        drainPoller: async () => {
          // Verify readiness is ALREADY false (503) and liveness true (200) before poller.shutdown() starts!
          const preStopHealth = await fetch(`${healthServer.url}/health`);
          assert.equal(preStopHealth.status, 503);
          const preStopBody = await preStopHealth.json();
          assert.equal(preStopBody.status, "draining");
          assert.equal(preStopBody.ok, false);

          order.push("poller.shutdown:start");
          const drainTask = poller.shutdown({ timeoutMs: 2_000 });

          // While poller.shutdown() is actively waiting on the in-flight scan:
          const midDrainHealth = await fetch(`${healthServer.url}/health`);
          const midDrainLive = await fetch(`${healthServer.url}/health/live`);
          const midDrainWebhook = await fetch(`${healthServer.url}/telegram-webhook`, { method: "POST" });
          assert.equal(midDrainHealth.status, 503);
          const midDrainBody = await midDrainHealth.json();
          assert.equal(midDrainBody.status, "draining");
          assert.equal(midDrainBody.poller.stopping, true);
          assert.equal(midDrainLive.status, 200);
          assert.equal(midDrainWebhook.status, 503);
          assert.equal(webhookAccepted, 0);

          releaseInFlightScan();
          await drainTask;
          await cyclePromise;
          order.push("poller.shutdown:done");
        },
        stopBot: async () => {
          // HTTP server is still open while bot.stop() stops operational Telegram intake
          const liveDuringBotStop = await fetch(`${healthServer.url}/health/live`);
          assert.equal(liveDuringBotStop.status, 200);
          order.push("bot.stop");
        },
        closeMetrics: async () => {
          order.push("metrics.close");
        },
        flushAudit: async () => {
          order.push("audit.flush");
        },
      });

      await shutdownPromise;

      assert.deepEqual(order, [
        "health.beginShutdown",
        "poller.shutdown:start",
        "poller.shutdown:done",
        "bot.stop",
        "health.close",
        "metrics.close",
        "audit.flush",
      ]);
    } finally {
      if (releaseInFlightScan) releaseInFlightScan();
      await healthServer.close().catch(() => undefined);
      await poller.stop().catch(() => undefined);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("boundary: runGracefulShutdownSequence still stops bot and closes HTTP when drainPoller or stopBot throws", async () => {
  const order = [];
  const errors = [];
  const disabledHealth = startHealthServer({ config: baseConfig({ healthPort: 0 }), status: () => baseStatus() });
  assert.equal(disabledHealth.draining, false);

  await runGracefulShutdownSequence({
    healthServer: {
      beginShutdown() {
        order.push("health.beginShutdown");
        disabledHealth.beginShutdown();
      },
      async close() {
        order.push("health.close");
        await disabledHealth.close();
      },
    },
    drainPoller: async () => {
      order.push("poller.shutdown");
      throw new Error("simulated drain error");
    },
    stopBot: async () => {
      order.push("bot.stop");
      throw new Error("simulated bot stop error");
    },
    onError: (stage, err) => {
      errors.push([stage, err instanceof Error ? err.message : String(err)]);
    },
  });

  assert.equal(disabledHealth.draining, true);
  assert.deepEqual(order, ["health.beginShutdown", "poller.shutdown", "bot.stop", "health.close"]);
  assert.deepEqual(errors, [
    ["poller", "simulated drain error"],
    ["bot", "simulated bot stop error"],
  ]);

  // Verify healthMessage renders draining status cleanly without "(action required)"
  const msg = healthMessage(baseConfig(), baseStatus({ stopping: true }), 5_500);
  assert.match(msg, /\*Health\* — DRAINING on Stellar testnet/);
  assert.match(msg, /Status: `draining` \\\(draining\\\)/);
  assert.equal(buildHealthReport(baseConfig(), baseStatus(), 5_500, undefined, { draining: true }).status, "draining");
});
