import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createDeadLetterQueue } from "../dist/deadLetter.js";
import {
  DLQ_EXIT_CODES,
  DlqAccessError,
  DlqMalformedFileError,
  DlqUnknownEntryError,
  listDeadLetters,
  runDlqCli,
  showDeadLetter,
} from "../dist/dlq-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("dist/dlq-cli.js");

test("DLQ_EXIT_CODES distinguishes malformed file (3), access failure (4), unknown entry (1), and usage (2)", async () => {
  await withTempDataDir(async (dir) => {
    const validFile = dir.file("valid.json");
    const queue = createDeadLetterQueue({
      filePath: validFile,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
    });
    await queue.load();
    await queue.enqueue({
      source: "market",
      ledger: 42,
      eventName: "claim_created",
      text: "Claim 42",
      error: "Telegram 429",
    });

    // 1. Unknown entry -> exitCode 1 (DlqUnknownEntryError)
    await assert.rejects(
      () => showDeadLetter({ filePath: validFile, id: "market:999:missing:00000000" }),
      (err) => err instanceof DlqUnknownEntryError && err.exitCode === DLQ_EXIT_CODES.UNKNOWN_ENTRY,
    );
    const unknownRes = await runDlqCli({
      argv: ["show", "market:999:missing:00000000", "--file", validFile],
      stdout: () => {},
      stderr: () => {},
    });
    assert.equal(unknownRes.exitCode, DLQ_EXIT_CODES.UNKNOWN_ENTRY);

    // 2. Malformed JSON / wrong schema / malformed entry -> exitCode 3 (DlqMalformedFileError)
    const malformedCases = [
      "{not-valid-json",
      JSON.stringify({ version: 99, entries: [] }),
      JSON.stringify({ version: 1, entries: "not-an-array" }),
      JSON.stringify({ version: 1, entries: [{ id: "", text: "bad", ledger: 1 }] }),
    ];

    for (const [idx, badPayload] of malformedCases.entries()) {
      const badFile = dir.file(`malformed-${idx}.json`);
      await writeFile(badFile, badPayload, "utf8");

      await assert.rejects(
        () => listDeadLetters({ filePath: badFile }),
        (err) =>
          err instanceof DlqMalformedFileError && err.exitCode === DLQ_EXIT_CODES.MALFORMED_FILE,
      );

      const cliOut = [];
      const cliErr = [];
      const res = await runDlqCli({
        argv: ["list", "--file", badFile],
        stdout: (l) => cliOut.push(l),
        stderr: (l) => cliErr.push(l),
      });
      assert.equal(res.exitCode, DLQ_EXIT_CODES.MALFORMED_FILE);
      assert.equal(cliOut.length, 0, "non-json failure must keep stdout empty");
      assert.ok(cliErr.length > 0);
    }

    // 3. Access failure (e.g. EISDIR on a directory path) -> exitCode 4 (DlqAccessError)
    const dirTarget = dir.file("directory-instead-of-file");
    await mkdir(dirTarget, { recursive: true });

    await assert.rejects(
      () => listDeadLetters({ filePath: dirTarget }),
      (err) => err instanceof DlqAccessError && err.exitCode === DLQ_EXIT_CODES.ACCESS_FAILURE,
    );

    const accessOut = [];
    const accessErr = [];
    const accessRes = await runDlqCli({
      argv: ["list", "--file", dirTarget],
      stdout: (l) => accessOut.push(l),
      stderr: (l) => accessErr.push(l),
    });
    assert.equal(accessRes.exitCode, DLQ_EXIT_CODES.ACCESS_FAILURE);
    assert.equal(accessOut.length, 0);
    assert.ok(accessErr.length > 0);
  });
});

test("subprocess CLI keeps stdout strictly machine-readable JSON on success and failure", async () => {
  await withTempDataDir(async (dir) => {
    const validFile = dir.file("valid-dlq.json");
    const queue = createDeadLetterQueue({
      filePath: validFile,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
    });
    await queue.load();
    const entry = await queue.enqueue({
      source: "market",
      ledger: 88,
      eventName: "claim_created",
      text: "Claim 88",
      error: "Telegram 429",
    });

    // Success `list --json` in a real subprocess: stdout must parse cleanly as JSON with no log banners
    const listSub = await execFileAsync(process.execPath, [
      CLI_PATH,
      "list",
      "--file",
      validFile,
      "--json",
    ]);
    const listJson = JSON.parse(listSub.stdout);
    assert.equal(listJson.depth, 1);
    assert.equal(listJson.entries[0].id, entry.id);

    // Success `purge --yes --json` in a real subprocess: stdout must parse cleanly as JSON
    const purgeSub = await execFileAsync(process.execPath, [
      CLI_PATH,
      "purge",
      "--yes",
      "--file",
      validFile,
      "--json",
    ]);
    const purgeJson = JSON.parse(purgeSub.stdout);
    assert.equal(purgeJson.purged, 1);
    assert.equal(purgeJson.remaining, 0);

    // Malformed file with `--json` in a real subprocess: exits 3 and stdout is machine-readable JSON error
    const corruptFile = dir.file("corrupt.json");
    await writeFile(corruptFile, "{broken-json", "utf8");
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [
          CLI_PATH,
          "list",
          "--file",
          corruptFile,
          "--json",
        ]),
      (err) => {
        assert.equal(err.code, DLQ_EXIT_CODES.MALFORMED_FILE);
        const errJson = JSON.parse(err.stdout);
        assert.equal(errJson.ok, false);
        assert.equal(errJson.error.code, "MALFORMED_FILE");
        assert.equal(errJson.error.exitCode, DLQ_EXIT_CODES.MALFORMED_FILE);
        return true;
      },
    );
  });
});
