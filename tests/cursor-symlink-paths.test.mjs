import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  areSameCursorFile,
  assertDistinctCursorPaths,
  backupCursor,
  CursorPathAliasError,
  restoreCursor,
} from "../dist/cursor-cli.js";
import { createPoller } from "../dist/poller.js";

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-symlink-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function tryFileSymlink(target, linkPath) {
  try {
    await symlink(target, linkPath, "file");
    return true;
  } catch (err) {
    if (process.platform === "win32" && (err.code === "EPERM" || err.code === "ENOTSUP")) {
      return false;
    }
    throw err;
  }
}

test("directory symlink/junction alias is rejected before opening live cursor for writing", async () => {
  await withTempDir(async (root) => {
    const realDir = path.join(root, "real-state");
    const aliasDir = path.join(root, "alias-state");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");

    const liveCursor = path.join(realDir, "cursor.json");
    const aliasedCursor = path.join(aliasDir, "cursor.json");
    const lockFile = path.join(root, "poller.lock");

    // Even before cursor.json exists, canonical ancestor resolution detects the alias.
    const preCheck = await areSameCursorFile(liveCursor, aliasedCursor);
    assert.equal(preCheck.same, true);

    const originalRaw =
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-08T00:00:00.000Z",
          targets: {
            market: { cursor: cursorAt(5000), lastEventLedger: 5000 },
          },
        },
        null,
        2,
      ) + "\n";
    await writeFile(liveCursor, originalRaw, "utf8");
    const beforeStat = await stat(liveCursor, { bigint: true });

    await assert.rejects(
      () =>
        restoreCursor({
          cursorFile: liveCursor,
          backupFile: aliasedCursor,
          lockFile,
          force: true,
        }),
      (err) => {
        assert.ok(err instanceof CursorPathAliasError);
        assert.equal(err.code, "CURSOR_PATH_ALIAS");
        assert.match(err.message, /backup and live cursor paths must be different/);
        return true;
      },
    );

    await assert.rejects(
      () =>
        backupCursor({
          cursorFile: liveCursor,
          backupFile: aliasedCursor,
          force: true,
        }),
      (err) => err instanceof CursorPathAliasError,
    );

    // Live cursor was never opened for writing or replaced, and no temp files remain.
    const afterStat = await stat(liveCursor, { bigint: true });
    assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs);
    assert.equal(afterStat.ino, beforeStat.ino);
    assert.equal(await readFile(liveCursor, "utf8"), originalRaw);
    assert.deepEqual(await readdir(realDir), ["cursor.json"]);
  });
});

test("file symlinks, dangling symlinks, and hard links are detected as same-file aliases", async () => {
  await withTempDir(async (root) => {
    const liveCursor = path.join(root, "cursor.json");
    const hardlinkBackup = path.join(root, "hardlink-backup.json");
    const lockFile = path.join(root, "poller.lock");

    const originalRaw =
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-08T01:00:00.000Z",
        targets: { market: { cursor: cursorAt(5100), lastEventLedger: 5100 } },
      }) + "\n";
    await writeFile(liveCursor, originalRaw, "utf8");
    await link(liveCursor, hardlinkBackup);

    await assert.rejects(
      () =>
        restoreCursor({
          cursorFile: liveCursor,
          backupFile: hardlinkBackup,
          lockFile,
          force: true,
        }),
      (err) => err instanceof CursorPathAliasError,
    );
    assert.equal(await readFile(liveCursor, "utf8"), originalRaw);

    const symlinkBackup = path.join(root, "symlink-backup.json");
    if (await tryFileSymlink(liveCursor, symlinkBackup)) {
      await assert.rejects(
        () =>
          restoreCursor({
            cursorFile: liveCursor,
            backupFile: symlinkBackup,
            lockFile,
            force: true,
          }),
        (err) => err instanceof CursorPathAliasError,
      );
      await assert.rejects(
        () =>
          backupCursor({
            cursorFile: liveCursor,
            backupFile: symlinkBackup,
            force: true,
          }),
        (err) => err instanceof CursorPathAliasError,
      );
      assert.equal(await readFile(liveCursor, "utf8"), originalRaw);

      // Dangling symlink pointing to a not-yet-created cursor path is also caught.
      const missingTarget = path.join(root, "future-cursor.json");
      const danglingAlias = path.join(root, "dangling-alias.json");
      await symlink(missingTarget, danglingAlias, "file");
      await assert.rejects(
        () => assertDistinctCursorPaths(missingTarget, danglingAlias),
        (err) => err instanceof CursorPathAliasError,
      );
    }
  });
});

test("poller saveCursors refuses to overwrite live cursor if .bak is a hardlink/symlink alias", async () => {
  await withTempDir(async (root) => {
    const cursorFile = path.join(root, "cursor.json");
    const backupAlias = `${cursorFile}.bak`;
    const initialRaw =
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-08T02:00:00.000Z",
          targets: {
            market: { cursor: cursorAt(5200), lastEventLedger: 5200 },
            squad: { cursor: cursorAt(5200), lastEventLedger: 5200 },
          },
        },
        null,
        2,
      ) + "\n";
    await writeFile(cursorFile, initialRaw, "utf8");
    // Make `cursor.json.bak` a hardlink (or symlink) to `cursor.json`.
    await link(cursorFile, backupAlias);

    const poller = createPoller({
      config: {
        marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN",
        rpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        botToken: "000000:synthetic-token",
        chatId: "-1001234567890",
        pollIntervalMs: 999_999,
        startLookbackLedgers: 60,
        maxNotificationsPerCycle: 5,
        cursorFile,
        deadLetterFile: path.join(root, "dead-letter.json"),
        auditFile: path.join(root, "audit.jsonl"),
        statusFile: path.join(root, "status.json"),
        instanceLockFile: path.join(root, "poller.lock"),
      },
      server: {
        async getHealth() {
          return { status: "healthy", latestLedger: 5300, oldestLedger: 5000 };
        },
        async getEvents() {
          return { events: [], cursor: cursorAt(5300), latestLedger: 5300 };
        },
      },
      send: async () => undefined,
      persistAudit: false,
    });

    await poller.loadCursors();
    await poller.runCycle();

    // Persist failed safely before opening `.tmp` or truncating `cursor.json`, leaving initialRaw intact!
    assert.equal(poller.status().pendingFlush, true);
    assert.equal(await readFile(cursorFile, "utf8"), initialRaw);
  });
});

test("distinct cursor and backup paths inside symlinked directories continue to work", async () => {
  await withTempDir(async (root) => {
    const realDir = path.join(root, "real");
    const aliasDir = path.join(root, "alias");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");

    const liveCursor = path.join(realDir, "cursor.json");
    const distinctBackup = path.join(aliasDir, "cursor-snapshot.json");
    const lockFile = path.join(root, "poller.lock");

    const raw =
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-08T03:00:00.000Z",
        targets: { market: { cursor: cursorAt(5400), lastEventLedger: 5400 } },
      }) + "\n";
    await writeFile(liveCursor, raw, "utf8");

    await backupCursor({ cursorFile: liveCursor, backupFile: distinctBackup });
    assert.equal(await readFile(distinctBackup, "utf8"), raw);

    await restoreCursor({
      cursorFile: liveCursor,
      backupFile: distinctBackup,
      lockFile,
      force: true,
    });
    const restored = JSON.parse(await readFile(liveCursor, "utf8"));
    assert.equal(restored.targets.market.lastEventLedger, 5400);
  });
});
