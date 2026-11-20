import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backupCursor,
  CursorConflictError,
  inspectCursor,
  restoreCursor,
  runCursorCli,
} from "../dist/cursor-cli.js";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-backup-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("backup preserves a validated cursor and refuses overwrite by default", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const raw = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "opaque-cursor", lastEventLedger: 42 } },
    }, null, 2)}\n`;
    await writeFile(cursorFile, raw);

    await backupCursor({ cursorFile, backupFile });
    assert.equal(await readFile(backupFile, "utf8"), raw);
    await assert.rejects(backupCursor({ cursorFile, backupFile }), /already exists/);
  });
});

test("malformed cursor backup is rejected without creating a destination", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    await writeFile(cursorFile, "{not json");

    await assert.rejects(backupCursor({ cursorFile, backupFile }), /malformed|unsupported/);
    assert.equal(await exists(backupFile), false);
  });
});

test("restore requires force and atomically writes a compatible cursor under lock", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");
    const original = JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "restored-cursor", lastEventLedger: 42 } },
    });
    await writeFile(backupFile, original);
    await writeFile(cursorFile, "existing cursor");

    await assert.rejects(
      restoreCursor({ cursorFile, backupFile, lockFile }),
      /pass --force/,
    );
    assert.equal(await readFile(cursorFile, "utf8"), "existing cursor");

    await restoreCursor({ cursorFile, backupFile, lockFile, force: true });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.version, 1);
    assert.equal(restored.targets.market.cursor, "restored-cursor");
    assert.equal(restored.targets.market.lastEventLedger, 42);
    assert.equal(await exists(lockFile), false);
  });
});

test("restore normalizes supported legacy cursor files to version 1", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "legacy.json");
    const lockFile = path.join(directory, "poller.lock");
    await writeFile(backupFile, JSON.stringify({ market: "legacy-cursor" }));

    await restoreCursor({ cursorFile, backupFile, lockFile });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.version, 1);
    assert.equal(restored.targets.market.cursor, "legacy-cursor");
    assert.equal(restored.targets.market.lastEventLedger, null);
  });
});

test("restore refuses write with conflict when live cursor changed since inspection", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");
    const liveV1 = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "live-v1", lastEventLedger: 10 } },
    }, null, 2)}\n`;
    const liveV2 = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:01:00.000Z",
      targets: { market: { cursor: "live-v2", lastEventLedger: 11 } },
    }, null, 2)}\n`;
    const backupRaw = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-28T00:00:00.000Z",
      targets: { market: { cursor: "backup-cursor", lastEventLedger: 5 } },
    }, null, 2)}\n`;

    await writeFile(cursorFile, liveV1);
    await writeFile(backupFile, backupRaw);

    const inspected = await inspectCursor({ cursorFile });
    assert.equal(inspected.exists, true);
    assert.ok(inspected.digest);

    // Simulate another writer advancing the live cursor after inspection.
    await writeFile(cursorFile, liveV2);

    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        expectedLiveDigest: inspected.digest,
      }),
      (err) => err instanceof CursorConflictError && err.target === "live",
    );

    // Live cursor must be preserved.
    assert.equal(await readFile(cursorFile, "utf8"), liveV2);
    assert.equal(await exists(lockFile), false);
  });
});

test("restore refuses write with conflict when source file changed since inspection", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");
    const liveRaw = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "live-cursor", lastEventLedger: 20 } },
    }, null, 2)}\n`;
    const backupV1 = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-28T00:00:00.000Z",
      targets: { market: { cursor: "backup-v1", lastEventLedger: 5 } },
    }, null, 2)}\n`;
    const backupV2 = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-28T00:05:00.000Z",
      targets: { market: { cursor: "backup-v2", lastEventLedger: 6 } },
    }, null, 2)}\n`;

    await writeFile(cursorFile, liveRaw);
    await writeFile(backupFile, backupV1);

    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        onBeforeWrite: async () => {
          await writeFile(backupFile, backupV2);
        },
      }),
      (err) => err instanceof CursorConflictError && err.target === "source",
    );

    // Live cursor must remain untouched.
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);
  });
});

test("cursor CLI inspect and restore --if-match report conflict in JSON and preserve live cursor", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const liveRaw = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "live-cursor", lastEventLedger: 20 } },
    }, null, 2)}\n`;
    const backupRaw = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-28T00:00:00.000Z",
      targets: { market: { cursor: "backup-cursor", lastEventLedger: 5 } },
    }, null, 2)}\n`;

    await writeFile(cursorFile, liveRaw);
    await writeFile(backupFile, backupRaw);

    const outLines = [];
    const errLines = [];
    const inspectRes = await runCursorCli({
      argv: ["inspect", "--file", cursorFile, "--json"],
      stdout: (line) => outLines.push(line),
      stderr: (line) => errLines.push(line),
    });
    assert.equal(inspectRes.exitCode, 0);
    const inspected = JSON.parse(outLines.join("\n"));
    assert.equal(inspected.exists, true);
    assert.equal(inspected.targets, 1);

    const conflictOut = [];
    const conflictErr = [];
    const conflictRes = await runCursorCli({
      argv: [
        "restore",
        "--file",
        cursorFile,
        "--from",
        backupFile,
        "--if-match",
        "0".repeat(64),
        "--force",
        "--json",
      ],
      stdout: (line) => conflictOut.push(line),
      stderr: (line) => conflictErr.push(line),
    });
    assert.equal(conflictRes.exitCode, 1);
    const conflictPayload = JSON.parse(conflictOut.join("\n"));
    assert.equal(conflictPayload.status, "conflict");
    assert.equal(conflictPayload.target, "live");
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);

    // Matching --if-match succeeds.
    const okOut = [];
    const okRes = await runCursorCli({
      argv: [
        "restore",
        "--file",
        cursorFile,
        "--from",
        backupFile,
        "--if-match",
        inspected.digest,
        "--force",
        "--json",
      ],
      stdout: (line) => okOut.push(line),
      stderr: (line) => conflictErr.push(line),
    });
    assert.equal(okRes.exitCode, 0);
    const okPayload = JSON.parse(okOut.join("\n"));
    assert.equal(okPayload.status, "restored");
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.targets.market.cursor, "backup-cursor");
  });
});