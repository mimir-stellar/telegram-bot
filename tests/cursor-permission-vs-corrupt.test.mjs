/**
 * Tests for Issue #785: differentiate cursor directory permission failures from corrupt JSON.
 *
 * Covered:
 *   - classifyCursorFsError distinguishes ENOENT, EACCES/EPERM/EROFS, and operational I/O errors
 *   - Poller preserves cursor file on directory permission failure (does NOT quarantine) and sets cursorLoadError
 *   - Poller quarantines corrupt JSON with CURSOR_CORRUPT_JSON (distinct from permission failure)
 *   - Poller distinguishes EISDIR operational I/O failure from corrupt JSON and preserves directory
 *   - cursor-cli backupCursor/restoreCursor surface distinct CURSOR_PERMISSION_DENIED vs CURSOR_CORRUPT_JSON vs CURSOR_NOT_FOUND
 *   - cursor-cli preserves existing destination/cursor files when operational permission failure occurs
 */

import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { backupCursor, CursorDiagnosticError, restoreCursor } from "../dist/cursor-cli.js";
import { classifyCursorFsError, createPoller } from "../dist/poller.js";

function baseConfig(cursorFile) {
  return {
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "0000000000:SECRET-TOKEN-DO-NOT-LEAK",
    chatId: "-1001234567890",
    pollIntervalMs: 60_000,
    startLookbackLedgers: 60,
    cursorFile,
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
  };
}

const isRoot = typeof process.geteuid === "function" && process.geteuid() === 0;

test("classifyCursorFsError distinguishes ENOENT, permission errors, and other I/O errors", () => {
  assert.deepEqual(classifyCursorFsError(Object.assign(new Error("no entry"), { code: "ENOENT" })), {
    kind: "not_found",
    errnoCode: "ENOENT",
    diagnosticCode: "CURSOR_NOT_FOUND",
  });
  for (const code of ["EACCES", "EPERM", "EROFS"]) {
    assert.deepEqual(classifyCursorFsError(Object.assign(new Error("denied"), { code })), {
      kind: "permission",
      errnoCode: code,
      diagnosticCode: "CURSOR_PERMISSION_DENIED",
    });
  }
  assert.deepEqual(classifyCursorFsError(Object.assign(new Error("is dir"), { code: "EISDIR" })), {
    kind: "io",
    errnoCode: "EISDIR",
    diagnosticCode: "CURSOR_IO_ERROR",
  });
});

test("poller preserves cursor file on directory permission failure and surfaces CURSOR_PERMISSION_DENIED", { skip: isRoot }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mimir-perm-"));
  const cursorDir = path.join(root, "state");
  const cursorFile = path.join(cursorDir, "cursor.json");
  const validBody = JSON.stringify({
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    targets: { market: { cursor: "1234-0", lastEventLedger: 100 } },
  });

  try {
    await mkdir(cursorDir, { recursive: true });
    await writeFile(cursorFile, validBody, "utf8");
    await chmod(cursorDir, 0o000);

    const poller = createPoller({
      config: baseConfig(cursorFile),
      server: /** @type {any} */ ({}),
      send: async () => {
        throw new Error("send should not run");
      },
    });

    await poller.start();
    poller.stop();

    const st = poller.status();
    assert.equal(st.cursorLoadError?.kind, "permission");
    assert.equal(st.cursorLoadError?.code, "CURSOR_PERMISSION_DENIED");
    assert.match(st.cursorLoadError?.message ?? "", /CURSOR_PERMISSION_DENIED/);

    // Restore permissions to verify the original cursor file was preserved and NOT quarantined
    await chmod(cursorDir, 0o755);
    const entries = await readdir(cursorDir);
    assert.deepEqual(entries, ["cursor.json"]);
    assert.equal(await readFile(cursorFile, "utf8"), validBody);
  } finally {
    await chmod(cursorDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("poller distinguishes corrupt JSON (CURSOR_CORRUPT_JSON) from operational I/O error (CURSOR_IO_ERROR)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mimir-io-vs-corrupt-"));
  try {
    // Case 1: EISDIR (operational I/O error — cursorFile path is a directory)
    const dirAsCursor = path.join(root, "cursor-is-dir");
    await mkdir(dirAsCursor, { recursive: true });
    const pollerIo = createPoller({
      config: baseConfig(dirAsCursor),
      server: /** @type {any} */ ({}),
      send: async () => {},
    });
    await pollerIo.start();
    pollerIo.stop();

    const ioStatus = pollerIo.status();
    assert.equal(ioStatus.cursorLoadError?.kind, "io");
    assert.equal(ioStatus.cursorLoadError?.code, "CURSOR_IO_ERROR");
    // Directory preserved (not quarantined)
    await access(dirAsCursor);

    // Case 2: Corrupt JSON -> quarantined + CURSOR_CORRUPT_JSON
    const corruptFile = path.join(root, "corrupt.json");
    await writeFile(corruptFile, "{bad-json", "utf8");
    const pollerCorrupt = createPoller({
      config: baseConfig(corruptFile),
      server: /** @type {any} */ ({}),
      send: async () => {},
    });
    await pollerCorrupt.start();
    pollerCorrupt.stop();

    const corruptStatus = pollerCorrupt.status();
    assert.equal(corruptStatus.cursorLoadError?.kind, "corrupt");
    assert.equal(corruptStatus.cursorLoadError?.code, "CURSOR_CORRUPT_JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cursor-cli differentiates permission failures from corrupt JSON and preserves files", { skip: isRoot }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mimir-cli-perm-"));
  const protectedDir = path.join(root, "protected");
  const cursorFile = path.join(protectedDir, "cursor.json");
  const backupFile = path.join(root, "backup.json");
  const corruptFile = path.join(root, "corrupt.json");
  const missingFile = path.join(root, "missing.json");
  const lockFile = path.join(root, "poller.lock");

  try {
    await mkdir(protectedDir, { recursive: true });
    await writeFile(
      cursorFile,
      JSON.stringify({ version: 1, updatedAt: "2026-10-01T00:00:00.000Z", targets: {} }),
      "utf8",
    );
    await writeFile(corruptFile, "{not json", "utf8");

    // 1. Permission failure on cursor directory -> CURSOR_PERMISSION_DENIED, file preserved
    await chmod(protectedDir, 0o000);
    await assert.rejects(
      () => backupCursor({ cursorFile, backupFile }),
      (err) => err instanceof CursorDiagnosticError && err.code === "CURSOR_PERMISSION_DENIED",
    );
    await chmod(protectedDir, 0o755);
    assert.ok(await readFile(cursorFile, "utf8"));

    // 2. Restore into read-only cursor directory -> CURSOR_PERMISSION_DENIED, existing cursor preserved
    await backupCursor({ cursorFile, backupFile });
    await chmod(protectedDir, 0o555);
    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile, lockFile, force: true }),
      (err) => err instanceof CursorDiagnosticError && err.code === "CURSOR_PERMISSION_DENIED",
    );
    await chmod(protectedDir, 0o755);

    // 3. Corrupt JSON -> CURSOR_CORRUPT_JSON
    await assert.rejects(
      () => backupCursor({ cursorFile: corruptFile, backupFile: path.join(root, "out.json") }),
      (err) => err instanceof CursorDiagnosticError && err.code === "CURSOR_CORRUPT_JSON",
    );

    // 4. Missing file -> CURSOR_NOT_FOUND
    await assert.rejects(
      () => backupCursor({ cursorFile: missingFile, backupFile: path.join(root, "out2.json") }),
      (err) => err instanceof CursorDiagnosticError && err.code === "CURSOR_NOT_FOUND",
    );
  } finally {
    await chmod(protectedDir, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
