import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../dist/exitCodes.js";
import {
  evaluateOfflineStatusContent,
  formatOfflineHealthReport,
  readOfflineHealthReport,
} from "../dist/health.js";
import { runOfflineHealthCli } from "../dist/healthcheck.js";
import { buildStatusSnapshot, writeStatusFile } from "../dist/status.js";

const execFileAsync = promisify(execFile);
const DIST_HEALTHCHECK = fileURLToPath(new URL("../dist/healthcheck.js", import.meta.url));
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

const MARKET_ID = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_ID = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-offline-health-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function sampleConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://user:rpc-secret-pass@soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 30_000,
    maxNotificationsPerCycle: 20,
    ...overrides,
  };
}

function samplePollerStatus(overrides = {}) {
  return {
    running: true,
    startedAt: NOW - 60_000,
    cycles: 5,
    lastPollAt: NOW - 5_000,
    lastSuccessAt: NOW - 5_000,
    latestLedger: 1200,
    oldestLedger: 1000,
    notificationsSent: 4,
    notificationsFailed: 0,
    eventsSkipped: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [
      {
        source: "market",
        contractId: MARKET_ID,
        lastCycleMs: 210,
        maxCycleMs: 450,
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 1198,
        rewindFromLedger: null,
        cursorStale: false,
        lastError: null,
      },
      {
        source: "squad",
        contractId: SQUAD_ID,
        lastCycleMs: 180,
        maxCycleMs: 390,
        cursor: "0018276211125911552-1",
        lastEventLedger: 1195,
        rewindFromLedger: null,
        cursorStale: false,
        lastError: null,
      },
    ],
    ...overrides,
  };
}

test("readOfflineHealthReport evaluates a healthy persisted status snapshot without credentials or server", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "status.json");
    const snapshot = buildStatusSnapshot(sampleConfig(), samplePollerStatus(), NOW - 4_000);
    await writeStatusFile(file, snapshot);

    const report = await readOfflineHealthReport(file, { nowMs: NOW });
    assert.equal(report.ok, true);
    assert.equal(report.status, "ok");
    assert.equal(report.mode, "offline");
    assert.deepEqual(report.problems, []);
    assert.ok(report.snapshot);
    assert.equal(report.snapshot.ageMs, 4_000);
    assert.equal(report.snapshot.stale, false);
    assert.equal(report.snapshot.chatId, "-…7890");
    assert.equal(report.snapshot.rpcUrl.includes("rpc-secret-pass"), false);
    assert.equal(report.snapshot.targets[0].cursorPreview.endsWith("…"), true);

    const text = formatOfflineHealthReport(report);
    assert.match(text, /\[health:offline\] status=OK ok=true/);
    assert.equal(text.includes("rpc-secret-pass"), false);
    assert.equal(text.includes("-1001234567890"), false);
  });
});

test("evaluateOfflineStatusContent explicitly identifies stale snapshots and stale lastSuccessAt", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "status.json");
    const oldSnapshot = buildStatusSnapshot(
      sampleConfig(),
      samplePollerStatus({ lastPollAt: NOW - 300_000, lastSuccessAt: NOW - 300_000 }),
      NOW - 300_000,
    );
    await writeStatusFile(file, oldSnapshot);

    const staleReport = await readOfflineHealthReport(file, { nowMs: NOW, staleMs: 90_000 });
    assert.equal(staleReport.ok, false);
    assert.equal(staleReport.status, "stale");
    assert.equal(staleReport.snapshot?.stale, true);
    assert.ok(
      staleReport.problems.some((p) => p.includes("status snapshot is stale")),
      `expected snapshot staleness reason, got: ${staleReport.problems.join("; ")}`,
    );

    // Fresh snapshot write, but poller has not succeeded inside staleMs
    const recentWriteStaleSuccess = buildStatusSnapshot(
      sampleConfig(),
      samplePollerStatus({ lastPollAt: NOW - 2_000, lastSuccessAt: NOW - 120_000 }),
      NOW - 2_000,
    );
    const successStale = evaluateOfflineStatusContent(
      JSON.stringify(recentWriteStaleSuccess),
      file,
      { nowMs: NOW, staleMs: 90_000 },
    );
    assert.equal(successStale.ok, false);
    assert.equal(successStale.status, "stale");
    assert.ok(successStale.problems.some((p) => p.includes("last successful poll is stale")));
  });
});

test("evaluateOfflineStatusContent explicitly identifies malformed JSON, schema versions, and missing fields", () => {
  const brokenJson = evaluateOfflineStatusContent("{not-json", "/bundle/status.json", {
    nowMs: NOW,
  });
  assert.equal(brokenJson.ok, false);
  assert.equal(brokenJson.status, "malformed");
  assert.equal(brokenJson.snapshot, null);
  assert.match(brokenJson.problems[0], /not valid JSON/);

  const arrayPayload = evaluateOfflineStatusContent("[]", "/bundle/status.json", { nowMs: NOW });
  assert.equal(arrayPayload.status, "malformed");
  assert.deepEqual(arrayPayload.problems, ["status snapshot must be a JSON object"]);

  const wrongVersion = buildStatusSnapshot(sampleConfig(), samplePollerStatus(), NOW);
  wrongVersion.schemaVersion = 99;
  const badVerReport = evaluateOfflineStatusContent(
    JSON.stringify(wrongVersion),
    "/bundle/status.json",
    { nowMs: NOW },
  );
  assert.equal(badVerReport.status, "malformed");
  assert.match(badVerReport.problems[0], /unsupported status schemaVersion 99/);

  const missingFields = {
    schemaVersion: 1,
    generatedAt: "not-a-date",
    running: "yes",
    targets: "none",
  };
  const missingReport = evaluateOfflineStatusContent(
    JSON.stringify(missingFields),
    "/bundle/status.json",
    { nowMs: NOW },
  );
  assert.equal(missingReport.status, "malformed");
  assert.ok(missingReport.problems.some((p) => p.includes("generatedAt")));
  assert.ok(missingReport.problems.some((p) => p.includes("running")));
  assert.ok(missingReport.problems.some((p) => p.includes("targets")));
});

test("readOfflineHealthReport identifies missing, stopped, and degraded status files", async () => {
  await withTempDir(async (dir) => {
    const missing = await readOfflineHealthReport(path.join(dir, "absent.json"), { nowMs: NOW });
    assert.equal(missing.ok, false);
    assert.equal(missing.status, "missing");
    assert.match(missing.problems[0], /status file not found/);

    const stoppedSnap = buildStatusSnapshot(
      sampleConfig(),
      samplePollerStatus({ running: false }),
      NOW - 1_000,
    );
    const stoppedReport = evaluateOfflineStatusContent(
      JSON.stringify(stoppedSnap),
      "status.json",
      { nowMs: NOW },
    );
    assert.equal(stoppedReport.ok, false);
    assert.equal(stoppedReport.status, "stopped");

    const degradedSnap = buildStatusSnapshot(
      sampleConfig(),
      samplePollerStatus({ consecutiveFailures: 5 }),
      NOW - 1_000,
    );
    const degradedReport = evaluateOfflineStatusContent(
      JSON.stringify(degradedSnap),
      "status.json",
      { nowMs: NOW },
    );
    assert.equal(degradedReport.ok, false);
    assert.equal(degradedReport.status, "degraded");
    assert.ok(degradedReport.problems.some((p) => p.includes("consecutive poll failures")));
  });
});

test("runOfflineHealthCli and dist/healthcheck.js --offline support --file, --json, and exit codes", async () => {
  await withTempDir(async (dir) => {
    const okFile = path.join(dir, "ok-status.json");
    const staleFile = path.join(dir, "stale-status.json");
    const badFile = path.join(dir, "malformed-status.json");

    await writeStatusFile(
      okFile,
      buildStatusSnapshot(sampleConfig(), samplePollerStatus(), NOW - 5_000),
    );
    await writeStatusFile(
      staleFile,
      buildStatusSnapshot(sampleConfig(), samplePollerStatus(), NOW - 500_000),
    );
    await writeFile(badFile, "{corrupt", "utf8");

    const lines = [];
    const okCode = await runOfflineHealthCli(
      ["--offline", "--file", okFile, "--now", String(NOW), "--json"],
      { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) },
    );
    assert.equal(okCode, EXIT_OK);
    const parsedOk = JSON.parse(lines.join("\n"));
    assert.equal(parsedOk.status, "ok");

    // Subprocess CLI without BOT_TOKEN or TELEGRAM_CHAT_ID
    const env = { PATH: process.env.PATH };
    const { stdout } = await execFileAsync(
      process.execPath,
      [DIST_HEALTHCHECK, "--offline", "--file", okFile, "--now", new Date(NOW).toISOString(), "--json"],
      { cwd: dir, env },
    );
    assert.equal(JSON.parse(stdout).status, "ok");

    // Stale file exits 1
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [DIST_HEALTHCHECK, "--offline", "--file", staleFile, "--now", String(NOW)],
        { cwd: dir, env },
      ),
      (err) => {
        assert.equal(err.code, EXIT_ERROR);
        assert.match(err.stderr, /status=STALE/);
        return true;
      },
    );

    // Malformed file exits 1
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [DIST_HEALTHCHECK, "--offline", "--file", badFile, "--now", String(NOW)],
        { cwd: dir, env },
      ),
      (err) => {
        assert.equal(err.code, EXIT_ERROR);
        assert.match(err.stderr, /status=MALFORMED/);
        return true;
      },
    );

    // Invalid usage exits EXIT_USAGE (4)
    const usageCode = await runOfflineHealthCli(["--offline", "--stale-ms", "-5"], {
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(usageCode, EXIT_USAGE);
  });
});
