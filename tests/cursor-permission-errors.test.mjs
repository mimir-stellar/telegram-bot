import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backupCursor,
  CursorCliError,
  restoreCursor,
} from "../dist/cursor-cli.js";
import {
  classifyCursorFailure,
  createPoller,
  quarantineCorruptCursorFile,
} from "../dist/poller.js";

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

function makeErrno(code, message = `${code}: simulated failure`) {
  const err = new Error(message);
  err.code = code;
  return err;
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

function makeServer({ latestLedger = 5100, oldestLedger = 1000 } = {}) {
  return {
    async getHealth() {
      return { status: "healthy", latestLedger, oldestLedger };
    },
    async getEvents() {
      return {
        events: [],
        cursor: cursorAt(latestLedger),
        latestLedger,
      };
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-perm-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("classifyCursorFailure differentiates permission, operational FS, missing, corrupt JSON, and schema errors", () => {
  for (const code of ["EACCES", "EPERM", "EROFS"]) {
    const diag = classifyCursorFailure(makeErrno(code), "/tmp/cursor-state.json");
    assert.equal(diag.category, "permission_denied");
    assert.equal(diag.diagnosticCode, "CURSOR_PERMISSION_DENIED");
    assert.equal(diag.operational, true);
    assert.equal(diag.errnoCode, code);
  }

  for (const code of ["EISDIR", "ENOTDIR", "EBUSY", "EIO"]) {
    const diag = classifyCursorFailure(makeErrno(code), "/tmp/cursor-state.json");
    assert.equal(diag.category, "operational_fs_error");
    assert.equal(diag.diagnosticCode, "CURSOR_FS_OPERATIONAL_ERROR");
    assert.equal(diag.operational, true);
    assert.equal(diag.errnoCode, code);
  }

  const missing = classifyCursorFailure(makeErrno("ENOENT"), "/tmp/cursor-state.json");
  assert.equal(missing.category, "missing");
  assert.equal(missing.diagnosticCode, "CURSOR_MISSING");
  assert.equal(missing.operational, false);

  const corruptJson = classifyCursorFailure(
    new SyntaxError("Unexpected token } in JSON at position 4"),
    "/tmp/cursor-state.json",
  );
  assert.equal(corruptJson.category, "corrupt_json");
  assert.equal(corruptJson.diagnosticCode, "CURSOR_CORRUPT_JSON");
  assert.equal(corruptJson.operational, false);

  const invalidSchema = classifyCursorFailure(
    new Error("cursor file: unsupported schema version 99"),
    "/tmp/cursor-state.json",
  );
  assert.equal(invalidSchema.category, "invalid_schema");
  assert.equal(invalidSchema.diagnosticCode, "CURSOR_INVALID_SCHEMA");
  assert.equal(invalidSchema.operational, false);
});

test("poller preserves existing cursor file without quarantine or overwrite when readFile fails with EACCES", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor-state.json");
    const preservedRaw = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-09-24T00:00:00.000Z",
        targets: {
          market: { cursor: cursorAt(5000), lastEventLedger: 5000 },
          squad: { cursor: cursorAt(4950), lastEventLedger: 4950 },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(cursorFile, preservedRaw, "utf8");

    const poller = createPoller({
      config: makeConfig(cursorFile),
      server: makeServer({ latestLedger: 5100, oldestLedger: 1000 }),
      send: async () => {},
      cursorFs: {
        readFile: async (target, enc) => {
          if (path.resolve(String(target)) === path.resolve(cursorFile)) {
            throw makeErrno("EACCES", "EACCES: permission denied, open cursor");
          }
          return readFile(target, enc);
        },
      },
    });

    await poller.loadCursors();
    const bootStatus = poller.status();
    assert.equal(bootStatus.cursorDiagnostic?.diagnosticCode, "CURSOR_PERMISSION_DENIED");
    assert.equal(bootStatus.cursorDiagnostic?.errnoCode, "EACCES");
    assert.equal(bootStatus.cursorDiagnostic?.operational, true);

    // Run a full scan cycle that advances in-memory cursors; on-disk file must remain untouched!
    await poller.runCycle();
    await poller.stop();

    const entries = await readdir(dir);
    assert.equal(
      entries.some((name) => name.includes(".corrupt.")),
      false,
      "permission failure must never quarantine the cursor file",
    );
    assert.equal(await readFile(cursorFile, "utf8"), preservedRaw);
  });
});

test("poller preserves directory at cursor path (real OS EISDIR) and differentiates from corrupt JSON", async () => {
  await withTempDir(async (dir) => {
    const cursorDirCollision = path.join(dir, "cursor-is-a-dir");
    await mkdir(cursorDirCollision, { recursive: true });
    const markerFile = path.join(cursorDirCollision, "keep.txt");
    await writeFile(markerFile, "intact", "utf8");

    const poller = createPoller({
      config: makeConfig(cursorDirCollision),
      server: makeServer(),
      send: async () => {},
    });

    await poller.loadCursors();
    const diag = poller.status().cursorDiagnostic;
    assert.equal(diag?.diagnosticCode, "CURSOR_FS_OPERATIONAL_ERROR");
    assert.equal(diag?.operational, true);
    assert.equal(await readFile(markerFile, "utf8"), "intact");
    await poller.stop();

    // Contrast with genuinely corrupt JSON on the same filesystem:
    const corruptCursor = path.join(dir, "corrupt-cursor.json");
    await writeFile(corruptCursor, "{broken-json", "utf8");
    const pollerCorrupt = createPoller({
      config: makeConfig(corruptCursor),
      server: makeServer(),
      send: async () => {},
    });
    await pollerCorrupt.loadCursors();
    assert.equal(pollerCorrupt.status().cursorDiagnostic?.diagnosticCode, "CURSOR_CORRUPT_JSON");
    await assert.rejects(() => access(corruptCursor), /ENOENT/);
    const entries = await readdir(dir);
    assert.equal(entries.some((name) => name.startsWith("corrupt-cursor.json.corrupt.")), true);
    await pollerCorrupt.stop();
  });
});

test("quarantineCorruptCursorFile leaves file intact when directory rename fails with EPERM", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor-state.json");
    await writeFile(cursorFile, "{corrupt", "utf8");

    const result = await quarantineCorruptCursorFile(
      cursorFile,
      "invalid JSON: unexpected end",
      new Date("2026-09-24T12:00:00.000Z"),
      {
        fsOps: {
          rename: async () => {
            throw makeErrno("EPERM", "EPERM: operation not permitted");
          },
        },
      },
    );

    assert.equal(result, null);
    assert.equal(await readFile(cursorFile, "utf8"), "{corrupt");
  });
});

test("cursor-cli surfaces distinct CursorCliError codes and preserves live/backup files on permission failures", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor-state.json");
    const backupFile = path.join(dir, "backup-state.json");
    const lockFile = path.join(dir, "poller.lock");

    const liveBody = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-09-24T00:00:00.000Z",
        targets: { market: { cursor: cursorAt(420), lastEventLedger: 420 } },
      },
      null,
      2,
    )}\n`;
    const previousBackupBody = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-09-23T00:00:00.000Z",
        targets: { market: { cursor: cursorAt(400), lastEventLedger: 400 } },
      },
      null,
      2,
    )}\n`;
    await writeFile(cursorFile, liveBody, "utf8");
    await writeFile(backupFile, previousBackupBody, "utf8");

    // 1. Permission denied writing backup with --force preserves existing backupFile and cleans temp files
    await assert.rejects(
      backupCursor({
        cursorFile,
        backupFile,
        force: true,
        fsOps: {
          writeFile: async () => {
            throw makeErrno("EACCES", "EACCES: directory not writable");
          },
        },
      }),
      (err) => {
        assert.ok(err instanceof CursorCliError);
        assert.equal(err.diagnosticCode, "CURSOR_PERMISSION_DENIED");
        assert.equal(err.operational, true);
        assert.equal(err.errnoCode, "EACCES");
        return true;
      },
    );
    assert.equal(await readFile(backupFile, "utf8"), previousBackupBody);
    assert.equal(await readFile(cursorFile, "utf8"), liveBody);
    assert.equal((await readdir(dir)).some((n) => n.includes(".tmp-")), false);

    // 2. Permission denied renaming restored cursor preserves live cursorFile and releases lock
    await assert.rejects(
      restoreCursor({
        cursorFile,
        backupFile,
        lockFile,
        force: true,
        fsOps: {
          rename: async () => {
            throw makeErrno("EROFS", "EROFS: read-only file system");
          },
        },
      }),
      (err) => {
        assert.ok(err instanceof CursorCliError);
        assert.equal(err.diagnosticCode, "CURSOR_PERMISSION_DENIED");
        assert.equal(err.errnoCode, "EROFS");
        assert.equal(err.operational, true);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveBody);
    await assert.rejects(() => access(lockFile), /ENOENT/);
    assert.equal((await readdir(dir)).some((n) => n.includes(".tmp-")), false);

    // 3. Corrupt JSON vs unsupported schema produce distinct diagnostic codes
    const badJsonFile = path.join(dir, "bad-json.json");
    const badSchemaFile = path.join(dir, "bad-schema.json");
    await writeFile(badJsonFile, "{bad", "utf8");
    await writeFile(badSchemaFile, JSON.stringify({ version: 99, targets: {} }), "utf8");

    await assert.rejects(
      backupCursor({ cursorFile: badJsonFile, backupFile: path.join(dir, "out1.json") }),
      (err) => {
        assert.ok(err instanceof CursorCliError);
        assert.equal(err.diagnosticCode, "CURSOR_CORRUPT_JSON");
        assert.equal(err.operational, false);
        return true;
      },
    );
    await assert.rejects(
      backupCursor({ cursorFile: badSchemaFile, backupFile: path.join(dir, "out2.json") }),
      (err) => {
        assert.ok(err instanceof CursorCliError);
        assert.equal(err.diagnosticCode, "CURSOR_INVALID_SCHEMA");
        assert.equal(err.operational, false);
        return true;
      },
    );
  });
});
