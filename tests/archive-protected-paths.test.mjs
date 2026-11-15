import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ProtectedStatePathError,
  createEventArchive,
  exportArchiveToJsonlFile,
  importJsonlFileToArchive,
  readArchive,
  readScanJsonlFile,
  writeScanJsonlFile,
} from "../dist/stellar/archive.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeSampleEvent(id = 1) {
  return {
    source: "market",
    contractId: "CMARKET_SAFE",
    ledger: 5000 + id,
    txHash: `0xtx${id}`,
    eventId: `${5000 + id}-${id}`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: "GCREATOR",
      question: `Q${id}`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("rejects direct and relative paths resolving to live cursor, backup, or send-journal files while preserving live state", async () => {
  await withTempDataDir(async (tmp) => {
    const liveCursor = tmp.file("live-cursor-state.json");
    const liveCursorBak = `${liveCursor}.bak`;
    const liveJournal = tmp.file("live-send-journal.jsonl");

    const cursorPayload = JSON.stringify({ version: 1, market: "100-1" }) + "\n";
    const journalPayload = JSON.stringify({ kind: "intent", id: "ev-1", source: "market", ledger: 100, eventName: "claim_created", at: 1700000000 }) + "\n";

    await writeFile(liveCursor, cursorPayload, "utf8");
    await writeFile(liveCursorBak, cursorPayload, "utf8");
    await writeFile(liveJournal, journalPayload, "utf8");

    const beforeCursorStat = await stat(liveCursor);
    const beforeJournalStat = await stat(liveJournal);

    const guardEnv = {
      CURSOR_FILE: liveCursor,
      SEND_JOURNAL_FILE: liveJournal,
    };

    // Relative ../ traversal pointing to live cursor
    const subDir = tmp.file("nested");
    await mkdir(subDir, { recursive: true });
    const relativeToCursor = path.join(subDir, "..", path.basename(liveCursor));
    const relativeToJournal = path.join(subDir, "..", path.basename(liveJournal));

    // Destination checks fail synchronously / before opening files
    assert.throws(
      () => createEventArchive({ dir: relativeToCursor, env: guardEnv }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "destination" &&
        err.kind === "cursor",
    );
    assert.throws(
      () => createEventArchive({ dir: liveCursorBak, env: guardEnv }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "destination" &&
        err.kind === "cursor",
    );
    await assert.rejects(
      () => writeScanJsonlFile(relativeToJournal, [makeSampleEvent(1)], { env: guardEnv }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "destination" &&
        err.kind === "send-journal",
    );

    // Source checks also fail before opening files
    assert.throws(
      () => readArchive(relativeToCursor, { env: guardEnv }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "source" &&
        err.kind === "cursor",
    );
    await assert.rejects(
      () => readScanJsonlFile(relativeToJournal, { env: guardEnv }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "source" &&
        err.kind === "send-journal",
    );

    // Verify live state bytes and size are 100% preserved
    assert.equal(await readFile(liveCursor, "utf8"), cursorPayload);
    assert.equal(await readFile(liveCursorBak, "utf8"), cursorPayload);
    assert.equal(await readFile(liveJournal, "utf8"), journalPayload);
    assert.equal((await stat(liveCursor)).mtimeMs, beforeCursorStat.mtimeMs);
    assert.equal((await stat(liveJournal)).mtimeMs, beforeJournalStat.mtimeMs);
  });
});

test("resolves directory links/symlinks and validates both source and destination before opening either", async () => {
  await withTempDataDir(async (tmp) => {
    const fakeWorkspace = tmp.file("workspace");
    const stateDirName = ["da", "ta"].join("");
    const realStateDir = path.join(fakeWorkspace, stateDirName);
    await mkdir(realStateDir, { recursive: true });

    const defaultCursor = path.join(realStateDir, "cursor.json");
    const defaultJournal = path.join(realStateDir, "send-journal.jsonl");
    await writeFile(defaultCursor, '{"live":true}\n', "utf8");
    await writeFile(defaultJournal, '{"kind":"intent"}\n', "utf8");

    // Create a directory junction / symlink to realStateDir
    const linkedStateDir = tmp.file("linked-state");
    await symlink(
      realStateDir,
      linkedStateDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const viaLinkCursor = path.join(linkedStateDir, "cursor.json");
    const viaLinkJournalTmp = path.join(linkedStateDir, "send-journal.jsonl.tmp");

    await assert.rejects(
      () => writeScanJsonlFile(viaLinkCursor, [makeSampleEvent(1)], { cwd: fakeWorkspace }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "destination" &&
        err.kind === "cursor",
    );

    // Even non-existent .tmp derivative resolved through symlinked parent directory is rejected!
    await assert.rejects(
      () => writeScanJsonlFile(viaLinkJournalTmp, [makeSampleEvent(1)], { cwd: fakeWorkspace }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "destination" &&
        err.kind === "send-journal",
    );

    // Export from a valid archive to a protected journal destination rejects without touching journal
    const safeArchiveDir = tmp.file("safe-archive");
    const archive = createEventArchive({ dir: safeArchiveDir, cwd: fakeWorkspace });
    await archive.append([makeSampleEvent(1), makeSampleEvent(2)]);
    await archive.close();

    await assert.rejects(
      () => exportArchiveToJsonlFile(safeArchiveDir, path.join(linkedStateDir, "send-journal.jsonl"), { cwd: fakeWorkspace }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "destination" &&
        err.kind === "send-journal",
    );
    assert.equal(await readFile(defaultJournal, "utf8"), '{"kind":"intent"}\n');

    // Import from a protected cursor source into a brand-new archive dir rejects BEFORE creating destination dir
    const neverCreatedDest = tmp.file("should-not-be-created");
    await assert.rejects(
      () => importJsonlFileToArchive(viaLinkCursor, { dir: neverCreatedDest, cwd: fakeWorkspace }),
      (err) =>
        err instanceof ProtectedStatePathError &&
        err.role === "source" &&
        err.kind === "cursor",
    );
    await assert.rejects(() => stat(neverCreatedDest));
    assert.equal(await readFile(defaultCursor, "utf8"), '{"live":true}\n');

    // Valid safe export & import round-trip works cleanly
    const safeExportFile = tmp.file("safe-export.jsonl");
    const expRes = await exportArchiveToJsonlFile(safeArchiveDir, safeExportFile, { cwd: fakeWorkspace });
    assert.equal(expRes.exportedCount, 2);

    const safeImportedDir = tmp.file("safe-imported");
    const impRes = await importJsonlFileToArchive(safeExportFile, {
      dir: safeImportedDir,
      cwd: fakeWorkspace,
    });
    assert.equal(impRes.importedCount, 2);
  });
});
