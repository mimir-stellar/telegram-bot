import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { healthMessage } from "../dist/commands/health.js";
import { buildHealthReport, startHealthServer } from "../dist/health.js";
import { createPoller } from "../dist/poller.js";
import { registerSecrets } from "../dist/redact.js";
import { validate } from "./helpers/json-schema-lite.mjs";

const execFileAsync = promisify(execFile);
const HEALTHCHECK_SCRIPT = fileURLToPath(new URL("../dist/healthcheck.js", import.meta.url));
const schema = JSON.parse(
  readFileSync(new URL("../docs/schemas/health-report.schema.json", import.meta.url), "utf8"),
);

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const FAKE_BOT_SECRET = ["0000000000:SECRET", "-TOKEN-DO-NOT-LEAK"].join("");

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function makeConfig(cursorFile, overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    marketContractVersion: "v1",
    squadContractVersion: "v1",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: FAKE_BOT_SECRET,
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    operatorTelegramUserId: null,
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    healthAuthToken: null,
    ...overrides,
  };
}

function healthyRpcServer() {
  let latestLedger = 5_000;
  return {
    getHealth: async () => ({
      status: "healthy",
      oldestLedger: 4_000,
      latestLedger,
    }),
    getEvents: async () => {
      latestLedger += 1;
      return {
        events: [],
        cursor: `000000000000${latestLedger}-0000000001`,
        latestLedger,
        oldestLedger: 4_000,
      };
    },
  };
}

test("unwritable cursor degrades persistence health while RPC polling continues and recovers when writable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-persist-health-"));
  const cursorFile = path.join(dir, "cursor.json");
  const lockFile = path.join(dir, "poller.lock");
  let clock = 10_000;
  const port = await findFreePort();
  const cfg = makeConfig(cursorFile, { healthPort: port, lockFile });
  registerSecrets([FAKE_BOT_SECRET, cfg.chatId]);

  const poller = createPoller({
    config: cfg,
    server: healthyRpcServer(),
    send: async () => undefined,
    now: () => clock,
    persistAudit: false,
  });

  const server = startHealthServer({
    config: cfg,
    status: () => poller.status(),
    now: () => clock,
  });

  try {
    // Cold start before first flush: lastFlushAgeMs is null, persistence is ok
    await poller.loadCursors();
    const initial = poller.status();
    initial.running = true;
    const coldReport = JSON.parse(JSON.stringify(buildHealthReport(cfg, initial, clock)));
    assert.equal(coldReport.ok, true);
    assert.equal(coldReport.poller.lastFlushAgeMs, null);
    assert.equal(coldReport.poller.rpcStatus, "ok");
    assert.equal(coldReport.poller.persistence.status, "ok");
    assert.equal(coldReport.poller.persistence.cursorWritable, true);
    assert.deepEqual(validate(schema, coldReport), []);

    // Cycle 1 at t=10_000: RPC succeeds and cursor flush succeeds
    await poller.pollOnce();
    clock = 12_500;
    const okRes = await fetch(`${server.url}/health`);
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.status, "ok");
    assert.equal(okBody.poller.rpcStatus, "ok");
    assert.equal(okBody.poller.lastFlushAgeMs, 2_500);
    assert.equal(okBody.poller.persistence.status, "ok");
    assert.equal(okBody.poller.persistence.cursorWritable, true);
    assert.equal(okBody.poller.persistence.lastFlushAgeMs, 2_500);
    assert.equal(okBody.poller.persistence.consecutiveFlushFailures, 0);
    assert.equal(okBody.poller.persistence.lastFlushError, null);
    assert.deepEqual(validate(schema, okBody), []);

    // Block `${cursorFile}.tmp` with a directory (deterministic cross-platform write fault)
    await mkdir(`${cursorFile}.tmp`);

    // Cycle 2 at t=40_000: RPC still succeeds (polling continues!), cursor flush fails
    clock = 40_000;
    await poller.runCycle();

    clock = 45_000;
    const degRes = await fetch(`${server.url}/health`);
    assert.equal(degRes.status, 503);
    const degBody = await degRes.json();
    assert.equal(degBody.ok, false);
    assert.equal(degBody.status, "degraded");
    // RPC health remains "ok" while persistence is "degraded"
    assert.equal(degBody.poller.rpcStatus, "ok");
    assert.equal(degBody.poller.consecutiveFailures, 0);
    assert.equal(degBody.poller.cycles, 2);
    assert.equal(degBody.poller.lastSuccessAt, new Date(40_000).toISOString());
    // Flush age reflects age since t=10_000 (the last successful flush)
    assert.equal(degBody.poller.lastFlushAgeMs, 35_000);
    assert.equal(degBody.poller.persistence.status, "degraded");
    assert.equal(degBody.poller.persistence.cursorWritable, false);
    assert.equal(degBody.poller.persistence.lastFlushAgeMs, 35_000);
    assert.equal(degBody.poller.persistence.consecutiveFlushFailures, 1);
    assert.ok(degBody.poller.persistence.lastFlushError !== null);
    assert.equal(JSON.stringify(degBody).includes(FAKE_BOT_SECRET), false);
    assert.deepEqual(validate(schema, degBody), []);

    // Container healthcheck CLI surfaces persistence=degraded with rpc=ok on exit 1
    await assert.rejects(
      execFileAsync("node", [HEALTHCHECK_SCRIPT], {
        env: { ...process.env, HEALTH_HOST: "127.0.0.1", HEALTH_PORT: String(port) },
      }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /\[healthcheck\] Failed: HTTP 503/);
        assert.match(err.stderr, /rpc=ok persistence=degraded/);
        return true;
      },
    );

    // Telegram /health message highlights RPC ok vs Persistence degraded
    const msg = healthMessage(cfg, poller.status(), clock);
    assert.ok(msg.includes("RPC: `ok` · Persistence: `degraded`"));
    assert.ok(msg.includes("Cursor persistence error"));
    assert.equal(msg.includes(FAKE_BOT_SECRET), false);

    // Restore writability before Cycle 3 at t=70_000: persistence self-heals
    await rm(`${cursorFile}.tmp`, { recursive: true, force: true });
    clock = 70_000;
    await poller.runCycle();

    const healedRes = await fetch(`${server.url}/health`);
    assert.equal(healedRes.status, 200);
    const healedBody = await healedRes.json();
    assert.equal(healedBody.ok, true);
    assert.equal(healedBody.status, "ok");
    assert.equal(healedBody.poller.rpcStatus, "ok");
    assert.equal(healedBody.poller.persistence.status, "ok");
    assert.equal(healedBody.poller.persistence.cursorWritable, true);
    assert.equal(healedBody.poller.persistence.consecutiveFlushFailures, 0);
    assert.equal(healedBody.poller.persistence.lastFlushError, null);
    assert.equal(healedBody.poller.lastFlushAgeMs, 0);
    assert.deepEqual(validate(schema, healedBody), []);
  } finally {
    await server.close();
    await poller.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("RPC degradation keeps persistence.status ok when state files remain writable", () => {
  const cfg = makeConfig("/tmp/unused-cursor.json");
  const report = JSON.parse(
    JSON.stringify(
      buildHealthReport(
        cfg,
        {
          running: true,
          paused: false,
          stopping: false,
          chainClockAt: null,
          startedAt: 1_000,
          cycles: 6,
          lastCorrelationId: "cycle-6",
          lastPollAt: 20_000,
          lastSuccessAt: 5_000,
          latestLedger: 100,
          oldestLedger: 50,
          notificationsSent: 0,
          notificationsFailed: 0,
          eventsSkipped: 0,
          emptyPages: 0,
          pagesScanned: 0,
          lastCycleEmptyPages: 0,
          lastCyclePages: 0,
          notificationsDropped: 0,
          eventsDeduplicated: 0,
          cursorRewinds: 0,
          restartGaps: 0,
          lastRestartGap: null,
          consecutiveFailures: 5,
          lastError: { at: 20_000, message: "RPC 503 Service Unavailable" },
          ledgerCache: { hits: 0, misses: 0 },
          lockFile: null,
          lockPid: null,
          pendingFlush: false,
          lastFlushAt: 20_000,
          cursorPersistFailures: 0,
          cursorPersistError: null,
          statusPersistError: null,
          countersPersistError: null,
          suppressedLogs: 0,
          deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
          persistentVolumeAvailable: true,
          persistentVolumeError: null,
          targets: [],
          sbomDigest: null,
          circuitBreaker: { open: true, openedAt: 20_000, failureCount: 5, lastFailureAt: 20_000 },
        },
        22_000,
      ),
    ),
  );

  assert.equal(report.ok, false);
  assert.equal(report.status, "degraded");
  assert.equal(report.poller.rpcStatus, "degraded");
  assert.equal(report.poller.persistence.status, "ok");
  assert.equal(report.poller.persistence.cursorWritable, true);
  assert.equal(report.poller.lastFlushAgeMs, 2_000);
  assert.deepEqual(validate(schema, report), []);
});

test("state-file persistence error (status or counters) also surfaces under persistence.stateFileError", () => {
  const cfg = makeConfig("/tmp/unused-cursor.json");
  registerSecrets([FAKE_BOT_SECRET]);
  const report = JSON.parse(
    JSON.stringify(
      buildHealthReport(
        cfg,
        {
          running: true,
          paused: false,
          stopping: false,
          chainClockAt: null,
          startedAt: 1_000,
          cycles: 2,
          lastCorrelationId: "cycle-2",
          lastPollAt: 10_000,
          lastSuccessAt: 10_000,
          latestLedger: 100,
          oldestLedger: 50,
          notificationsSent: 0,
          notificationsFailed: 0,
          eventsSkipped: 0,
          emptyPages: 0,
          pagesScanned: 0,
          lastCycleEmptyPages: 0,
          lastCyclePages: 0,
          notificationsDropped: 0,
          eventsDeduplicated: 0,
          cursorRewinds: 0,
          restartGaps: 0,
          lastRestartGap: null,
          consecutiveFailures: 0,
          lastError: null,
          ledgerCache: { hits: 0, misses: 0 },
          lockFile: null,
          lockPid: null,
          pendingFlush: false,
          lastFlushAt: 10_000,
          cursorPersistFailures: 0,
          cursorPersistError: null,
          statusPersistError: { at: 10_000, message: `status write failed ${FAKE_BOT_SECRET}` },
          countersPersistError: null,
          suppressedLogs: 0,
          deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
          persistentVolumeAvailable: true,
          persistentVolumeError: null,
          targets: [],
          sbomDigest: null,
          circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
        },
        15_000,
      ),
    ),
  );

  assert.equal(report.status, "degraded");
  assert.equal(report.poller.rpcStatus, "ok");
  assert.equal(report.poller.persistence.status, "degraded");
  assert.equal(report.poller.persistence.cursorWritable, true);
  assert.ok(report.poller.persistence.stateFileError !== null);
  assert.equal(JSON.stringify(report).includes(FAKE_BOT_SECRET), false);
  assert.deepEqual(validate(schema, report), []);
});
