/**
 * Tests for Issue #791: detect replay output and progress paths pointing to the same file.
 *
 * Covered:
 *   - Identical --output and --progress-file paths reject with exit code 2 before RPC or file opens
 *   - Lexically distinct relative/dot-segment spellings resolving to the same uncreated file reject
 *   - Pre-existing bytes in a shared target file are preserved byte-for-byte on rejection
 *   - Parent directory junction/symlink aliases resolving to the same target file reject before creation
 *   - Hard-linked files resolving to the same inode reject and preserve existing bytes
 *   - Directory paths and missing flag arguments reject with exit code 2
 *   - Distinct --output and --progress-file paths succeed and write independent valid JSON files
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  resolveCanonicalReplayPath,
  runReplayCli,
  validateReplayFilePaths,
} from "../dist/stellar/replay.js";
import { MARKET_CONTRACT, SQUAD_CONTRACT, claimCreatedEvent } from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeConfig() {
  return {
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://fake-rpc.invalid",
    horizonUrl: "http://fake-horizon.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
  };
}

function rejectingServer() {
  let calls = 0;
  return {
    get callCount() {
      return calls;
    },
    async getHealth() {
      calls += 1;
      throw new Error("getHealth must not be called when replay paths collide");
    },
    async getEvents() {
      calls += 1;
      throw new Error("getEvents must not be called when replay paths collide");
    },
  };
}

test("identical --output and --progress-file paths reject before touching files or RPC", async () => {
  await withTempDataDir(async (tmp) => {
    const sharedFile = tmp.file("replay-shared.json");
    const server = rejectingServer();

    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--output",
        sharedFile,
        "--progress-file",
        sharedFile,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });

    assert.equal(exitCode, 2);
    assert.equal(report, null);
    assert.equal(server.callCount, 0);
    assert.equal(existsSync(sharedFile), false, "colliding target file must not be created");
  });
});

test("relative dot-segment paths resolving to the same file reject and preserve existing bytes", async () => {
  await withTempDataDir(async (tmp) => {
    const nestedDir = path.join(tmp.root, "nested", "inner");
    await mkdir(nestedDir, { recursive: true });

    const realTarget = path.join(tmp.root, "nested", "checkpoint.json");
    const sentinelBytes = Buffer.from('{"sentinel":"do-not-clobber-me","bytes":[1,2,3]}\n', "utf8");
    await writeFile(realTarget, sentinelBytes);
    const beforeStat = await stat(realTarget);

    const dottedAlias = path.join(nestedDir, "..", ".", "checkpoint.json");
    const server = rejectingServer();

    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--out",
        dottedAlias,
        "--progress-file",
        realTarget,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });

    assert.equal(exitCode, 2);
    assert.equal(report, null);
    assert.equal(server.callCount, 0);

    const afterBytes = await readFile(realTarget);
    const afterStat = await stat(realTarget);
    assert.equal(Buffer.compare(afterBytes, sentinelBytes), 0, "existing bytes must remain untouched");
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "existing file mtime must not change");
  });
});

test("directory junction/symlink alias to an uncreated file is detected before opening either path", async () => {
  await withTempDataDir(async (tmp) => {
    const realDir = path.join(tmp.root, "real-dir");
    const aliasDir = path.join(tmp.root, "alias-dir");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, aliasDir, process.platform === "win32" ? "junction" : "dir");

    const viaReal = path.join(realDir, "future-file.json");
    const viaAlias = path.join(aliasDir, "future-file.json");

    assert.equal(
      await resolveCanonicalReplayPath(viaReal),
      await resolveCanonicalReplayPath(viaAlias),
    );

    const server = rejectingServer();
    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--output",
        viaAlias,
        "--progress-file",
        viaReal,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });

    assert.equal(exitCode, 2);
    assert.equal(report, null);
    assert.equal(server.callCount, 0);
    assert.equal(existsSync(viaReal), false);
  });
});

test("hard-linked paths pointing to the same underlying file reject and preserve bytes", async () => {
  await withTempDataDir(async (tmp) => {
    const firstPath = tmp.file("primary.json");
    const hardLinkPath = tmp.file("hardlink.json");
    const originalPayload = Buffer.from("preserved-hardlink-content\n", "utf8");
    await writeFile(firstPath, originalPayload);
    await link(firstPath, hardLinkPath);

    await assert.rejects(
      () => validateReplayFilePaths({ outputFile: hardLinkPath, progressFile: firstPath }),
      /point to the same file/,
    );

    const server = rejectingServer();
    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--output",
        hardLinkPath,
        "--progress-file",
        firstPath,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });

    assert.equal(exitCode, 2);
    assert.equal(report, null);
    assert.equal(server.callCount, 0);
    assert.equal(Buffer.compare(await readFile(firstPath), originalPayload), 0);
    assert.equal(Buffer.compare(await readFile(hardLinkPath), originalPayload), 0);
  });
});

test("directory target and missing path values reject with exit code 2", async () => {
  await withTempDataDir(async (tmp) => {
    const dirTarget = path.join(tmp.root, "as-dir");
    await mkdir(dirTarget, { recursive: true });
    const server = rejectingServer();

    const dirRun = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--output", dirTarget],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });
    assert.equal(dirRun.exitCode, 2);
    assert.equal(dirRun.report, null);

    const missingOutput = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--output", "--dry-run"],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });
    assert.equal(missingOutput.exitCode, 2);

    const missingProgress = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "4000", "--progress-file"],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });
    assert.equal(missingProgress.exitCode, 2);

    const duplicateOutputFlags = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--output",
        tmp.file("a.json"),
        "--out",
        tmp.file("b.json"),
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });
    assert.equal(duplicateOutputFlags.exitCode, 2);
    assert.equal(server.callCount, 0);
  });
});

test("distinct --output and --progress-file paths write valid independent JSON artifacts", async () => {
  await withTempDataDir(async (tmp) => {
    const outputFile = tmp.file("replay-report.json");
    const progressFile = tmp.file("replay-progress.json");
    const cursor1 = makeCursor(4100, 1);
    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 901, id: cursor1, pagingToken: cursor1 });

    let eventCalls = 0;
    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 4100 };
      },
      async getEvents() {
        eventCalls += 1;
        return { events: eventCalls === 1 ? [ev1] : [], cursor: cursor1, latestLedger: 4100 };
      },
    };

    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4100",
        "--contract",
        "market",
        "--output",
        outputFile,
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });

    assert.equal(exitCode, 0);
    assert.ok(report !== null);

    const savedReport = JSON.parse(await readFile(outputFile, "utf8"));
    const savedProgress = JSON.parse(await readFile(progressFile, "utf8"));

    assert.equal(savedReport.format, "mimir-replay-v1");
    assert.equal(savedReport.totals.events, 1);
    assert.equal(savedProgress.format, "mimir-replay-progress-v1");
    assert.equal(savedProgress.targets.market.completed, true);
  });
});
