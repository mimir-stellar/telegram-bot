import assert from "node:assert/strict";
import { mkdir as fsMkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { findUnknownPrefixKeys } from "../dist/config-cli.js";
import {
  DEFAULT_LOG_FILE_MAX_BYTES,
  DEFAULT_LOG_FILE_MAX_FILES,
  LOG_FILE_ENV,
  LOG_FILE_MAX_BYTES_ENV,
  LOG_FILE_MAX_FILES_ENV,
  Logger,
  MAX_LOG_FILE_COUNT,
  classifyJsonlDiskError,
  createRotatingJsonlWriter,
  parseLogFileMaxBytes,
  parseLogFileMaxFiles,
  parseLogFilePath,
} from "../dist/logger.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeErrno(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

test.afterEach(() => {
  Logger.reset();
});

test("env parsers enforce defaults and hard file-count bounds", () => {
  assert.equal(parseLogFilePath(undefined), null);
  assert.equal(parseLogFilePath("   "), null);
  assert.equal(parseLogFilePath(" /tmp/mimir.jsonl "), "/tmp/mimir.jsonl");

  assert.equal(parseLogFileMaxBytes(undefined), DEFAULT_LOG_FILE_MAX_BYTES);
  assert.equal(parseLogFileMaxBytes("0"), DEFAULT_LOG_FILE_MAX_BYTES);
  assert.equal(parseLogFileMaxBytes("-50"), DEFAULT_LOG_FILE_MAX_BYTES);
  assert.equal(parseLogFileMaxBytes("abc"), DEFAULT_LOG_FILE_MAX_BYTES);
  assert.equal(parseLogFileMaxBytes("4096"), 4096);

  assert.equal(parseLogFileMaxFiles(undefined), DEFAULT_LOG_FILE_MAX_FILES);
  assert.equal(parseLogFileMaxFiles("0"), DEFAULT_LOG_FILE_MAX_FILES);
  assert.equal(parseLogFileMaxFiles("1"), 1);
  assert.equal(parseLogFileMaxFiles("999"), MAX_LOG_FILE_COUNT);

  const warnings = findUnknownPrefixKeys({
    [LOG_FILE_ENV]: "/tmp/ops.jsonl",
    [LOG_FILE_MAX_BYTES_ENV]: "1048576",
    [LOG_FILE_MAX_FILES_ENV]: "4",
  });
  assert.deepEqual(warnings, []);
});

test("keeps a bounded number of local files and prunes stale higher-numbered archives", async () => {
  await withTempDataDir(async ({ root, file }) => {
    const logPath = file("ops.jsonl");
    await writeFile(`${logPath}.3`, '{"stale":3}\n', "utf8");
    await writeFile(`${logPath}.5`, '{"stale":5}\n', "utf8");
    await writeFile(file("unrelated.txt"), "keep-me", "utf8");

    const writer = createRotatingJsonlWriter({
      filePath: logPath,
      maxBytes: 120,
      maxFiles: 3,
    });

    for (let i = 0; i < 12; i += 1) {
      assert.equal(await writer.write(JSON.stringify({ seq: i, padding: "x".repeat(35) })), true);
    }
    await writer.flush();

    assert.deepEqual((await readdir(root)).sort(), [
      "ops.jsonl",
      "ops.jsonl.1",
      "ops.jsonl.2",
      "unrelated.txt",
    ]);
    const stats = writer.stats();
    assert.equal(stats.writesSucceeded, 12);
    assert.equal(stats.writesDropped, 0);
    assert.ok(stats.rotations >= 3, `expected multiple rotations, got ${stats.rotations}`);
    assert.equal(stats.failuresByStage.rotate, 0);
  });
});

test("maxFiles=1 keeps only the active JSONL file across rotations", async () => {
  await withTempDataDir(async ({ root, file }) => {
    const logPath = file("single.jsonl");
    await writeFile(`${logPath}.1`, '{"stale":1}\n', "utf8");

    const writer = createRotatingJsonlWriter({
      filePath: logPath,
      maxBytes: 90,
      maxFiles: 1,
    });

    for (let i = 0; i < 5; i += 1) {
      assert.equal(await writer.write(JSON.stringify({ seq: i, msg: "entry-payload-for-single-file" })), true);
    }
    await writer.flush();

    assert.deepEqual(await readdir(root), ["single.jsonl"]);
    const activeLines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.ok(activeLines.length >= 1 && activeLines.length <= 2);
    assert.equal(JSON.parse(activeLines[activeLines.length - 1]).seq, 4);
    assert.equal(writer.stats().maxFiles, 1);
  });
});

test("serialized burst writes survive rotations while console text and redaction stay intact", async () => {
  await withTempDataDir(async ({ root, file }) => {
    const logPath = file("live.jsonl");
    const secret = ["123456789:AA", "k".repeat(33)].join("");
    const consoleLines = [];

    Logger.configureFromEnv({
      LOG_LEVEL: "info",
      LOG_FORMAT: "text",
      [LOG_FILE_ENV]: logPath,
      [LOG_FILE_MAX_BYTES_ENV]: "450",
      [LOG_FILE_MAX_FILES_ENV]: "20",
    });
    Logger.configure({
      secrets: [secret],
      now: () => new Date("2026-11-15T12:00:00.000Z"),
      sink: (level, line) => consoleLines.push({ level, line }),
    });

    const totalWrites = 25;
    for (let seq = 0; seq < totalWrites; seq += 1) {
      Logger.info("poller", `cycle ${seq} auth=${secret}`, { seq, tokenEcho: secret });
    }

    const hostile = {};
    Object.defineProperty(hostile, "explode", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    Logger.warn("poller", "hostile metadata survived", { hostile });
    await Logger.flush();

    assert.equal(consoleLines.length, totalWrites + 1);
    assert.equal(consoleLines[0].line, "cycle 0 auth=[REDACTED]");

    const stats = Logger.getJsonlStats();
    assert.ok(stats !== null);
    assert.equal(stats.writesSucceeded, totalWrites + 1);
    assert.equal(stats.writesDropped, 0);
    assert.ok(stats.rotations >= 5, `expected >= 5 rotations, got ${stats.rotations}`);

    const archiveNumbers = (await readdir(root))
      .filter((name) => name.startsWith("live.jsonl."))
      .map((name) => Number.parseInt(name.slice("live.jsonl.".length), 10))
      .sort((a, b) => b - a);
    const orderedPaths = [...archiveNumbers.map((n) => path.join(root, `live.jsonl.${n}`)), logPath];

    const records = [];
    for (const currentPath of orderedPaths) {
      const raw = await readFile(currentPath, "utf8");
      assert.equal(raw.includes(secret), false);
      for (const line of raw.trim().split("\n")) {
        records.push(JSON.parse(line));
      }
    }

    assert.equal(records.length, totalWrites + 1);
    for (let seq = 0; seq < totalWrites; seq += 1) {
      assert.equal(records[seq].seq, seq);
      assert.equal(records[seq].tokenEcho, "[REDACTED]");
      assert.equal(records[seq].msg, `cycle ${seq} auth=[REDACTED]`);
      assert.equal(records[seq].level, "info");
      assert.equal(records[seq].component, "poller");
      assert.equal(records[seq].ts, "2026-11-15T12:00:00.000Z");
    }
    assert.equal(records[totalWrites].msg, "hostile metadata survived");
    assert.equal(records[totalWrites].level, "warn");
  });
});

test("a failed rotation reports its stage and still appends the pending record", async () => {
  await withTempDataDir(async ({ file }) => {
    const logPath = file("rotate-fault.jsonl");
    const observedFailures = [];
    let failRename = true;

    const writer = createRotatingJsonlWriter({
      filePath: logPath,
      maxBytes: 60,
      maxFiles: 3,
      now: () => new Date("2026-11-15T13:00:00.000Z"),
      onFailure: (failure) => observedFailures.push(failure),
      fsOps: {
        async rename(oldPath, newPath) {
          if (failRename) {
            throw makeErrno("EBUSY", `resource busy renaming ${oldPath} -> ${newPath}`);
          }
        },
      },
    });

    assert.equal(await writer.write(JSON.stringify({ seq: 1, pad: "aaaa" })), true);
    assert.equal(await writer.write(JSON.stringify({ seq: 2, pad: "bbbbbbbbbbbbbbbbbbbb" })), true);
    await writer.flush();

    assert.equal(observedFailures.length, 1);
    assert.equal(observedFailures[0].stage, "rotate");
    assert.equal(observedFailures[0].reason, "busy");
    assert.equal(observedFailures[0].code, "EBUSY");
    assert.equal(observedFailures[0].at, "2026-11-15T13:00:00.000Z");

    const stats = writer.stats();
    assert.equal(stats.writesSucceeded, 2);
    assert.equal(stats.writesDropped, 0);
    assert.equal(stats.failuresByStage.rotate, 1);
    assert.equal(stats.failuresByReason.busy, 1);

    const persisted = (await readFile(logPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      persisted.map((record) => record.seq),
      [1, 2],
    );
  });
});

test("disk failures are classified by stage and reason with redacted diagnostics", async () => {
  assert.deepEqual(classifyJsonlDiskError(makeErrno("ENOSPC", "no space")), {
    reason: "disk_full",
    code: "ENOSPC",
  });
  assert.deepEqual(classifyJsonlDiskError(makeErrno("EACCES", "denied")), {
    reason: "permission_denied",
    code: "EACCES",
  });
  assert.deepEqual(classifyJsonlDiskError(makeErrno("EROFS", "read-only")), {
    reason: "read_only_fs",
    code: "EROFS",
  });
  assert.deepEqual(classifyJsonlDiskError(makeErrno("EIO", "bad sector")), {
    reason: "io_error",
    code: "EIO",
  });

  await withTempDataDir(async ({ file }) => {
    const logPath = file("disk-full.jsonl");
    const secret = ["999888777:AA", "m".repeat(33)].join("");
    const failures = [];
    let mkdirBlocked = true;
    let diskFull = false;

    const writer = createRotatingJsonlWriter({
      filePath: logPath,
      maxBytes: 500,
      maxFiles: 3,
      secrets: [secret],
      onFailure: (failure) => failures.push(failure),
      fsOps: {
        async mkdir(targetDir) {
          if (mkdirBlocked) {
            throw makeErrno("EROFS", `read-only mount for ${targetDir} (${secret})`);
          }
          await fsMkdir(targetDir, { recursive: true });
        },
        async appendFile(targetFile, data) {
          if (diskFull) {
            throw makeErrno("ENOSPC", `no space left writing ${targetFile} token=${secret}`);
          }
          await writeFile(targetFile, data, { flag: "a" });
        },
      },
    });

    assert.equal(await writer.write('{"seq":1}'), false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, "mkdir");
    assert.equal(failures[0].reason, "read_only_fs");
    assert.equal(failures[0].message.includes(secret), false);
    assert.match(failures[0].message, /\[REDACTED\]/);

    mkdirBlocked = false;
    assert.equal(await writer.write('{"seq":2}'), true);

    diskFull = true;
    assert.equal(await writer.write('{"seq":3}'), false);
    assert.equal(failures.length, 2);
    assert.equal(failures[1].stage, "write");
    assert.equal(failures[1].reason, "disk_full");
    assert.equal(failures[1].code, "ENOSPC");
    assert.equal(failures[1].message.includes(secret), false);

    const stats = writer.stats();
    assert.equal(stats.writesSucceeded, 1);
    assert.equal(stats.writesDropped, 2);
    assert.equal(stats.failuresByStage.mkdir, 1);
    assert.equal(stats.failuresByStage.write, 1);
    assert.equal(stats.failuresByReason.read_only_fs, 1);
    assert.equal(stats.failuresByReason.disk_full, 1);
    assert.deepEqual(stats.lastFailure, failures[1]);
  });
});

test("an oversized record is persisted and rotates before the next write", async () => {
  await withTempDataDir(async ({ root, file }) => {
    const logPath = file("oversize.jsonl");
    const writer = createRotatingJsonlWriter({
      filePath: logPath,
      maxBytes: 40,
      maxFiles: 3,
    });

    const large = "l".repeat(200);
    assert.equal(await writer.write(JSON.stringify({ seq: 1, payload: large })), true);
    assert.equal(writer.stats().rotations, 0);
    assert.equal(await writer.write(JSON.stringify({ seq: 2 })), true);
    await writer.flush();

    assert.deepEqual((await readdir(root)).sort(), ["oversize.jsonl", "oversize.jsonl.1"]);
    assert.equal(writer.stats().rotations, 1);
    assert.deepEqual(JSON.parse((await readFile(`${logPath}.1`, "utf8")).trim()), {
      seq: 1,
      payload: large,
    });
    assert.deepEqual(JSON.parse((await readFile(logPath, "utf8")).trim()), { seq: 2 });
  });
});
