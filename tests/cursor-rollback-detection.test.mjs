import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  backupCursor,
  CursorRollbackError,
  detectCursorRollback,
  restoreCursor,
} from "../dist/cursor-cli.js";
import { createPoller } from "../dist/poller.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cursor-cli.js");

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

function makeConfig(cursorFile, overrides = {}) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "fake-bot",
    chatId: "-1001234567890",
    pollIntervalMs: 999_999,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 5,
    ...overrides,
  };
}

function makeServer(getLedger) {
  return {
    async getHealth() {
      const latestLedger = getLedger();
      return { status: "healthy", latestLedger, oldestLedger: 1000 };
    },
    async getEvents() {
      const latestLedger = getLedger();
      return {
        events: [],
        cursor: cursorAt(latestLedger),
        latestLedger,
      };
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-rollback-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("poller increments monotonic recoveryGeneration and rejects unacknowledged rollback at startup", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor-state.json");
    const earlySnap = path.join(dir, "early-backup.json");
    let chainTip = 5000;

    const first = createPoller({
      config: makeConfig(cursorFile),
      server: makeServer(() => chainTip),
      send: async () => {},
    });

    await first.runCycle();
    const afterCycle1 = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(afterCycle1.recoveryGeneration, 1);

    // Take an operator backup at generation 1 (ledger 5000)
    await backupCursor({ cursorFile, backupFile: earlySnap });

    // Advance two more cycles to generation 3 (ledger 5200)
    chainTip = 5100;
    await first.runCycle();
    chainTip = 5200;
    await first.runCycle();
    await first.stop();

    const afterCycle3 = JSON.parse(await readFile(cursorFile, "utf8"));
    const bakAfterCycle3 = JSON.parse(await readFile(`${cursorFile}.bak`, "utf8"));
    assert.equal(afterCycle3.recoveryGeneration, 3);
    assert.equal(bakAfterCycle3.recoveryGeneration, 3);

    // Normal restart at generation 3 succeeds without issue
    const normalRestart = createPoller({
      config: makeConfig(cursorFile),
      server: { getHealth: () => new Promise(() => {}) },
      send: async () => {},
    });
    await normalRestart.start();
    assert.equal(normalRestart.status().cursorRollback, null);
    await normalRestart.stop();

    // Simulate manual overwrite of cursor-state.json with older backup (gen 1 < bak gen 3)
    await copyFile(earlySnap, cursorFile);
    const rolledBackRaw = await readFile(cursorFile, "utf8");

    const unacknowledged = createPoller({
      config: makeConfig(cursorFile),
      server: { getHealth: () => new Promise(() => {}) },
      send: async () => {},
    });

    await assert.rejects(
      unacknowledged.start(),
      (err) => {
        assert.ok(err instanceof CursorRollbackError);
        assert.equal(err.details.candidateGeneration, 1);
        assert.equal(err.details.referenceGeneration, 3);
        assert.equal(err.details.reason, "generation_behind_backup");
        assert.equal(err.details.rolledBackTargets.length, 2);
        return true;
      },
    );

    // Lock must be released, no quarantine files created, and files preserved intact
    await assert.rejects(() => access(path.join(dir, "poller.lock")), /ENOENT/);
    const entries = await readdir(dir);
    assert.equal(entries.some((n) => n.includes(".corrupt.")), false);
    assert.equal(await readFile(cursorFile, "utf8"), rolledBackRaw);

    // Now start WITH explicit acknowledgement of intended replay
    const acknowledged = createPoller({
      config: makeConfig(cursorFile),
      server: { getHealth: () => new Promise(() => {}) },
      send: async () => {},
      acknowledgeReplay: true,
    });
    await acknowledged.start();
    const ackStatus = acknowledged.status();
    assert.equal(ackStatus.running, true);
    assert.equal(
      ackStatus.targets.find((t) => t.source === "market")?.cursor,
      cursorAt(5000),
    );
    await acknowledged.stop();

    const rewritten = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(rewritten.recoveryGeneration, 4, "acknowledged replay bumps generation above 3");
    assert.equal(rewritten.acknowledgedRollback.fromGeneration, 1);
    assert.equal(rewritten.acknowledgedRollback.previousGeneration, 3);
  });
});

test("cursor-cli restore requires --acknowledge-replay when restoring an older backup generation", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor-state.json");
    const oldBackup = path.join(dir, "old-backup.json");
    const lockFile = path.join(dir, "poller.lock");

    const liveBody = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-09-29T12:00:00.000Z",
        recoveryGeneration: 8,
        targets: {
          market: { cursor: cursorAt(9000), lastEventLedger: 9000 },
          squad: { cursor: cursorAt(8900), lastEventLedger: 8900 },
        },
      },
      null,
      2,
    )}\n`;
    const oldBody = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-09-28T12:00:00.000Z",
        recoveryGeneration: 3,
        targets: {
          market: { cursor: cursorAt(8200), lastEventLedger: 8200 },
          squad: { cursor: cursorAt(8100), lastEventLedger: 8100 },
        },
      },
      null,
      2,
    )}\n`;

    await writeFile(cursorFile, liveBody, "utf8");
    await writeFile(`${cursorFile}.bak`, liveBody, "utf8");
    await writeFile(oldBackup, oldBody, "utf8");

    // 1. Direct programmatic restore without acknowledgeReplay fails and preserves live cursor
    await assert.rejects(
      restoreCursor({ cursorFile, backupFile: oldBackup, lockFile, force: true }),
      (err) => {
        assert.ok(err instanceof CursorRollbackError);
        assert.equal(err.details.candidateGeneration, 3);
        assert.equal(err.details.referenceGeneration, 8);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveBody);
    await assert.rejects(() => access(lockFile), /ENOENT/);

    // 2. CLI restore without --acknowledge-replay exits 1
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [CLI_PATH, "restore", "--file", cursorFile, "--from", oldBackup, "--force"],
        {
          cwd: dir,
          env: { ...process.env, INSTANCE_LOCK_FILE: lockFile },
        },
      ),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /acknowledge-replay/);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveBody);

    // 3. CLI restore WITH --acknowledge-replay stamps generation 9 and boots cleanly in poller
    await execFileAsync(
      process.execPath,
      [
        CLI_PATH,
        "restore",
        "--file",
        cursorFile,
        "--from",
        oldBackup,
        "--force",
        "--acknowledge-replay",
      ],
      {
        cwd: dir,
        env: { ...process.env, INSTANCE_LOCK_FILE: lockFile },
      },
    );

    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.recoveryGeneration, 9);
    assert.equal(restored.acknowledgedRollback.fromGeneration, 3);
    assert.equal(restored.acknowledgedRollback.previousGeneration, 8);
    assert.equal(restored.targets.market.lastEventLedger, 8200);

    // Poller starts cleanly without needing CURSOR_ACKNOWLEDGE_REPLAY again
    const poller = createPoller({
      config: makeConfig(cursorFile),
      server: { getHealth: () => new Promise(() => {}) },
      send: async () => {},
    });
    await poller.start();
    assert.equal(
      poller.status().targets.find((t) => t.source === "market")?.cursor,
      cursorAt(8200),
    );
    await poller.stop();
  });
});

test("detectCursorRollback also catches ledger rollback across legacy generation-less files", () => {
  const details = detectCursorRollback(
    {
      version: 1,
      updatedAt: "2026-09-20T00:00:00.000Z",
      targets: { market: { cursor: cursorAt(1000), lastEventLedger: 1000 } },
    },
    {
      version: 1,
      updatedAt: "2026-09-21T00:00:00.000Z",
      targets: { market: { cursor: cursorAt(1500), lastEventLedger: 1500 } },
    },
  );
  assert.ok(details !== null);
  assert.equal(details.reason, "ledger_behind_backup");
  assert.equal(details.rolledBackTargets[0].replayedLedgers, 500);
});
