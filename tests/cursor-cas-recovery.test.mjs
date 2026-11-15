import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  backupCursor,
  computeCursorDigest,
  CursorCasConflictError,
  inspectCursorRecovery,
  restoreCursor,
  tryBackupCursor,
  tryRestoreCursor,
} from "../dist/cursor-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cursor-cli.js");

function cursorAt(ledger, index = 1) {
  return `${(BigInt(ledger) << 32n).toString()}-${index}`;
}

function makeCursorDoc(marketLedger, squadLedger = null, extraOpaqueSuffix = "") {
  const targets = {
    market: {
      cursor: `${cursorAt(marketLedger, 1)}${extraOpaqueSuffix}`,
      lastEventLedger: marketLedger,
    },
  };
  if (squadLedger !== null) {
    targets.squad = {
      cursor: cursorAt(squadLedger, 2),
      lastEventLedger: squadLedger,
    };
  }
  return `${JSON.stringify(
    {
      version: 1,
      updatedAt: "2026-10-15T12:00:00.000Z",
      targets,
    },
    null,
    2,
  )}\n`;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("inspectCursorRecovery computes digests and safe target summaries without exposing opaque cursor values", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const backupFile = dir.file("backup.json");
    const opaqueCursorValue = "opaque-rpc-cursor-value-999";
    const backupRaw = JSON.stringify({
      version: 1,
      updatedAt: "2026-10-15T00:00:00.000Z",
      targets: {
        market: { cursor: opaqueCursorValue, lastEventLedger: 4100 },
        squad: { cursor: cursorAt(4120, 2), lastEventLedger: 4120 },
      },
    });
    await writeFile(backupFile, backupRaw, "utf8");

    const inspection = await inspectCursorRecovery({
      action: "restore",
      cursorFile,
      backupFile,
    });

    assert.equal(inspection.action, "restore");
    assert.equal(inspection.sourceFile, backupFile);
    assert.equal(inspection.destinationFile, cursorFile);
    assert.equal(inspection.sourceDigest, computeCursorDigest(backupRaw));
    assert.equal(inspection.destinationDigest, null);
    assert.equal(inspection.destinationExists, false);
    assert.equal(inspection.schemaVersion, 1);
    assert.deepEqual(inspection.targets, [
      { source: "market", hasCursor: true, cursorLedger: null, lastEventLedger: 4100 },
      { source: "squad", hasCursor: true, cursorLedger: 4120, lastEventLedger: 4120 },
    ]);
    assert.equal(JSON.stringify(inspection).includes(opaqueCursorValue), false);
    assert.equal(await exists(cursorFile), false);
  }));

test("restore refuses recovery write when source file changed, truncated, or disappeared since inspection and preserves live cursor byte-for-byte", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const backupFile = dir.file("backup.json");
    const lockFile = dir.file("poller.lock");

    // Live cursor has unconventional spacing so byte-for-byte preservation is proven
    const liveRaw = `{\n  "version": 1,\n  "updatedAt": "2026-10-15T12:30:00.000Z",\n  "targets": { "market": { "cursor": "${cursorAt(5500)}", "lastEventLedger": 5500 } }\n}\n`;
    const backupV1 = makeCursorDoc(5400, 5405);
    await writeFile(cursorFile, liveRaw, "utf8");
    await writeFile(backupFile, backupV1, "utf8");

    const inspected = await inspectCursorRecovery({
      action: "restore",
      cursorFile,
      backupFile,
    });

    // 1. Source modified to a different valid cursor after inspection
    const backupV2 = makeCursorDoc(5100, 5105);
    await writeFile(backupFile, backupV2, "utf8");

    const conflictResult = await tryRestoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      inspected,
      quiet: true,
    });
    assert.equal(conflictResult.status, "conflict");
    assert.equal(conflictResult.command, "restore");
    assert.equal(conflictResult.reason, "source_changed");
    assert.equal(conflictResult.conflictingFile, backupFile);
    assert.equal(conflictResult.expectedSourceDigest, computeCursorDigest(backupV1));
    assert.equal(conflictResult.actualSourceDigest, computeCursorDigest(backupV2));
    assert.equal(conflictResult.liveCursorPreserved, true);
    assert.equal(conflictResult.liveCursorExists, true);
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);
    assert.equal(await exists(lockFile), false);

    const filesAfterConflict = await readdir(dir.root);
    assert.equal(
      filesAfterConflict.some((f) => f.includes(".tmp")),
      false,
      "must leave no temporary files behind on CAS conflict",
    );

    // 2. Source truncated to malformed JSON after inspection still reports CAS source_changed
    await writeFile(backupFile, "{truncated-mid-write", "utf8");
    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        expectedSourceDigest: inspected.sourceDigest,
        quiet: true,
      }),
      (err) => {
        assert.ok(err instanceof CursorCasConflictError);
        assert.equal(err.code, "CURSOR_CAS_CONFLICT");
        assert.equal(err.conflict.reason, "source_changed");
        assert.equal(err.conflict.liveCursorPreserved, true);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);

    // 3. Source removed after inspection reports CAS source_changed with actualSourceDigest: null
    await unlink(backupFile);
    const removedConflict = await tryRestoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      expectedSourceDigest: inspected.sourceDigest,
      quiet: true,
    });
    assert.equal(removedConflict.status, "conflict");
    assert.equal(removedConflict.reason, "source_changed");
    assert.equal(removedConflict.actualSourceDigest, null);
    assert.equal(removedConflict.liveCursorPreserved, true);
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);
  }));

test("restore detects live cursor changes since inspection (updated or newly created) and preserves live cursor", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const backupFile = dir.file("backup.json");
    const lockFile = dir.file("poller.lock");

    const backupRaw = makeCursorDoc(4800);
    await writeFile(backupFile, backupRaw, "utf8");

    // Case A: live cursor did not exist at inspection, then appeared before restore
    const inspectWhenMissing = await inspectCursorRecovery({
      action: "restore",
      cursorFile,
      backupFile,
    });
    assert.equal(inspectWhenMissing.destinationDigest, null);

    const newlyCreatedLive = makeCursorDoc(4999);
    await writeFile(cursorFile, newlyCreatedLive, "utf8");

    const createdConflict = await tryRestoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      inspected: inspectWhenMissing,
      quiet: true,
    });
    assert.equal(createdConflict.status, "conflict");
    assert.equal(createdConflict.reason, "live_changed");
    assert.equal(createdConflict.expectedDestinationDigest, null);
    assert.equal(createdConflict.actualDestinationDigest, computeCursorDigest(newlyCreatedLive));
    assert.equal(createdConflict.liveCursorPreserved, true);
    assert.equal(await readFile(cursorFile, "utf8"), newlyCreatedLive);

    // Case B: live cursor existed at inspection, then advanced before restore
    const inspectWhenPresent = await inspectCursorRecovery({
      action: "restore",
      cursorFile,
      backupFile,
    });
    const advancedLive = makeCursorDoc(5050);
    await writeFile(cursorFile, advancedLive, "utf8");

    const advancedConflict = await tryRestoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      inspected: inspectWhenPresent,
      quiet: true,
    });
    assert.equal(advancedConflict.status, "conflict");
    assert.equal(advancedConflict.reason, "live_changed");
    assert.equal(await readFile(cursorFile, "utf8"), advancedLive);

    // Case C: fresh inspection matches both source and live -> atomic restore succeeds
    const matchingInspect = await inspectCursorRecovery({
      action: "restore",
      cursorFile,
      backupFile,
    });
    const applied = await tryRestoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      inspected: matchingInspect,
      quiet: true,
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.sourceDigest, matchingInspect.sourceDigest);
    assert.equal(applied.previousDestinationDigest, computeCursorDigest(advancedLive));
    const restoredParsed = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restoredParsed.targets.market.lastEventLedger, 4800);
  }));

test("in-command TOCTOU race: source mutation between initial inspection and lock-guarded write is refused", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const backupFile = dir.file("backup.json");
    const lockFile = dir.file("poller.lock");

    const liveOriginal = makeCursorDoc(6000);
    const backupInitial = makeCursorDoc(5900);
    const backupConcurrentMutation = makeCursorDoc(5200);
    await writeFile(cursorFile, liveOriginal, "utf8");
    await writeFile(backupFile, backupInitial, "utf8");

    // Even without passing expectedSourceDigest, concurrent source mutation after initial inspection is caught under lock
    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        quiet: true,
        onAfterInspect: async () => {
          await writeFile(backupFile, backupConcurrentMutation, "utf8");
        },
      }),
      (err) => {
        assert.ok(err instanceof CursorCasConflictError);
        assert.equal(err.conflict.reason, "source_changed");
        assert.equal(err.conflict.expectedSourceDigest, computeCursorDigest(backupInitial));
        assert.equal(
          err.conflict.actualSourceDigest,
          computeCursorDigest(backupConcurrentMutation),
        );
        assert.equal(err.conflict.liveCursorPreserved, true);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveOriginal);
    assert.equal(await exists(lockFile), false);
  }));

test("backupCursor enforces CAS when live cursor changes since inspection and validates CAS arguments", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const backupFile = dir.file("backup.json");
    const otherBackup = dir.file("other-backup.json");
    const lockFile = dir.file("poller.lock");

    const liveV1 = makeCursorDoc(7000);
    const existingBackup = makeCursorDoc(6800);
    await writeFile(cursorFile, liveV1, "utf8");
    await writeFile(backupFile, existingBackup, "utf8");

    const backupInspect = await inspectCursorRecovery({
      action: "backup",
      cursorFile,
      backupFile,
    });

    // Reject passing a backup inspection into restoreCursor or mismatched paths
    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        inspected: backupInspect,
        quiet: true,
      }),
      /cannot authorize "restore"/,
    );
    await assert.rejects(
      backupCursor({
        cursorFile,
        backupFile: otherBackup,
        force: true,
        inspected: backupInspect,
        quiet: true,
      }),
      /paths do not match/,
    );
    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        expectedSourceDigest: "not-a-valid-sha256",
        quiet: true,
      }),
      /64-character hex SHA-256/,
    );

    // Live cursor advances before backupCursor runs -> backup write refused, existing backup & live cursor preserved
    const liveV2 = makeCursorDoc(7010);
    await writeFile(cursorFile, liveV2, "utf8");

    const conflict = await tryBackupCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      inspected: backupInspect,
      quiet: true,
    });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.command, "backup");
    assert.equal(conflict.reason, "source_changed");
    assert.equal(conflict.liveCursorPreserved, true);
    assert.equal(await readFile(backupFile, "utf8"), existingBackup);
    assert.equal(await readFile(cursorFile, "utf8"), liveV2);
  }));

test("CLI inspect and restore enforce CAS end-to-end with exit code 2 and JSON conflict output on drift", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const backupFile = dir.file("backup.json");
    const lockFile = dir.file("poller.lock");
    const envFile = dir.file("empty.env");
    await writeFile(envFile, "", "utf8");

    const liveRaw = makeCursorDoc(8100);
    const backupV1 = makeCursorDoc(8000);
    await writeFile(cursorFile, liveRaw, "utf8");
    await writeFile(backupFile, backupV1, "utf8");

    const env = {
      ...process.env,
      DOTENV_CONFIG_PATH: envFile,
      INSTANCE_LOCK_FILE: lockFile,
    };

    // 1. CLI inspect
    const { stdout: inspectStdout } = await execFileAsync(
      process.execPath,
      [CLI_PATH, "inspect", "--from", backupFile, "--file", cursorFile, "--json"],
      { cwd: dir.root, env },
    );
    const inspected = JSON.parse(inspectStdout);
    assert.equal(inspected.sourceDigest, computeCursorDigest(backupV1));
    assert.equal(inspected.destinationDigest, computeCursorDigest(liveRaw));

    // 2. Mutate backup file after CLI inspect -> CLI restore fails with exit code 2, preserves live cursor, emits conflict JSON
    const backupV2 = makeCursorDoc(7900);
    await writeFile(backupFile, backupV2, "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          CLI_PATH,
          "restore",
          "--from",
          backupFile,
          "--file",
          cursorFile,
          "--expected-source-digest",
          inspected.sourceDigest,
          "--expected-live-digest",
          inspected.destinationDigest,
          "--force",
          "--json",
        ],
        { cwd: dir.root, env },
      ),
      (err) => {
        assert.equal(err.code, 2);
        const conflictJson = JSON.parse(err.stdout);
        assert.equal(conflictJson.status, "conflict");
        assert.equal(conflictJson.reason, "source_changed");
        assert.equal(conflictJson.expectedSourceDigest, inspected.sourceDigest);
        assert.equal(conflictJson.actualSourceDigest, computeCursorDigest(backupV2));
        assert.equal(conflictJson.liveCursorPreserved, true);
        assert.match(err.stderr, /status=conflict.*reason=source_changed.*live_cursor_preserved=true/);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);

    // 3. Re-inspect backupV2 and restore with matching CAS digests -> exit code 0
    const { stdout: restoreStdout } = await execFileAsync(
      process.execPath,
      [
        CLI_PATH,
        "restore",
        "--from",
        backupFile,
        "--file",
        cursorFile,
        "--expected-source-digest",
        computeCursorDigest(backupV2),
        "--expected-live-digest",
        computeCursorDigest(liveRaw),
        "--force",
        "--json",
      ],
      { cwd: dir.root, env },
    );
    const appliedJson = JSON.parse(restoreStdout);
    assert.equal(appliedJson.status, "applied");
    const restoredDoc = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restoredDoc.targets.market.lastEventLedger, 7900);
  }));
