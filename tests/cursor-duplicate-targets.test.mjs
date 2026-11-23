import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { backupCursor, restoreCursor } from "../dist/cursor-cli.js";
import {
  createPoller,
  DuplicateCursorTargetError,
  parseAndMigrateCursorFile,
  parseCursorFile,
} from "../dist/poller.js";

const MARKET_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const SQUAD_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-dup-"));
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

function makeConfig(cursorFile) {
  return {
    botToken: "0000000000:TEST-TOKEN-NOT-REAL",
    chatId: "-1000000000000",
    chatIds: ["-1000000000000"],
    allowedChatIds: [],
    operatorChatId: null,
    rpcUrl: "https://rpc.example.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    marketContractVersion: "1",
    squadContractVersion: "1",
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    maxEventsPerCycle: 50,
    maxPagesPerCycle: 5,
    dedupWindow: 200,
    cursorFile,
    deadLetterFile: path.join(path.dirname(cursorFile), "dead-letter.json"),
    auditFile: path.join(path.dirname(cursorFile), "audit.jsonl"),
    statusFile: path.join(path.dirname(cursorFile), "status.json"),
    lockFile: path.join(path.dirname(cursorFile), "poller.lock"),
    countersFile: path.join(path.dirname(cursorFile), "counters.json"),
    shutdownTimeoutMs: 5_000,
    healthPort: 0,
    healthHost: "127.0.0.1",
    healthAuthToken: null,
    logLevel: "error",
    logFormat: "json",
    locale: "en",
    explorerBaseUrl: "https://stellar.expert/explorer/testnet",
    disabledEventTypes: [],
    minUsdcThreshold: 0,
    rpcTimeoutMs: 15_000,
    rpcMaxRetries: 1,
    supervisorFailureThreshold: 0,
    marketChatId: null,
    squadChatId: null,
    archiveDir: null,
  };
}

test("parseCursorFile and parseAndMigrateCursorFile reject duplicate target keys in v1 files", () => {
  const raw = `{
    "version": 1,
    "updatedAt": "2026-09-29T00:00:00.000Z",
    "targets": {
      "market": { "cursor": "0000000000000000100-0000000000", "lastEventLedger": 100 },
      "market": { "cursor": "0000000000000000200-0000000000", "lastEventLedger": 200 }
    }
  }`;

  assert.throws(
    () => parseCursorFile(raw),
    (err) =>
      err instanceof DuplicateCursorTargetError &&
      err.target === "market" &&
      /duplicate target definition.*"market"/i.test(err.message),
  );
  assert.throws(
    () => parseAndMigrateCursorFile(raw),
    (err) =>
      err instanceof DuplicateCursorTargetError &&
      err.target === "market" &&
      /duplicate target definition.*"market"/i.test(err.message),
  );
});

test("parseAndMigrateCursorFile rejects unicode-escaped duplicate target keys", () => {
  const raw = `{
    "version": 1,
    "updatedAt": "2026-09-29T00:00:00.000Z",
    "targets": {
      "market": { "cursor": "cursor-1", "lastEventLedger": 10 },
      "mark\\u0065t": { "cursor": "cursor-2", "lastEventLedger": 20 }
    }
  }`;

  assert.throws(
    () => parseAndMigrateCursorFile(raw),
    (err) => err instanceof DuplicateCursorTargetError && err.target === "market",
  );
});

test("parseAndMigrateCursorFile rejects duplicate targets block and duplicate legacy targets", () => {
  const duplicateTargetsBlock = `{
    "version": 1,
    "updatedAt": "2026-09-29T00:00:00.000Z",
    "targets": { "market": { "cursor": "c1", "lastEventLedger": 1 } },
    "targets": { "squad": { "cursor": "c2", "lastEventLedger": 2 } }
  }`;
  assert.throws(
    () => parseAndMigrateCursorFile(duplicateTargetsBlock),
    (err) => err instanceof DuplicateCursorTargetError && err.target === "targets",
  );

  const duplicateLegacyUnversioned = `{
    "targets": {
      "squad": { "cursor": "c1", "lastEventLedger": 1 },
      "squad": { "cursor": "c2", "lastEventLedger": 2 }
    }
  }`;
  assert.throws(
    () => parseAndMigrateCursorFile(duplicateLegacyUnversioned),
    (err) => err instanceof DuplicateCursorTargetError && err.target === "squad",
  );

  const duplicateLegacyFlat = `{
    "market": { "cursor": "c1", "lastEventLedger": 1 },
    "market": { "cursor": "c2", "lastEventLedger": 2 }
  }`;
  assert.throws(
    () => parseAndMigrateCursorFile(duplicateLegacyFlat),
    (err) => err instanceof DuplicateCursorTargetError && err.target === "market",
  );

  const duplicateLegacyStringMap = `{
    "market": "c1",
    "market": "c2"
  }`;
  assert.throws(
    () => parseAndMigrateCursorFile(duplicateLegacyStringMap),
    (err) => err instanceof DuplicateCursorTargetError && err.target === "market",
  );
});

test("boundary: distinct targets with brace-like cursor strings are accepted", () => {
  const raw = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-29T00:00:00.000Z",
    targets: {
      market: {
        cursor: '{"market":1,"market":2}',
        lastEventLedger: 100,
        recentEventIds: ['evt-{"market":1}'],
      },
      squad: {
        cursor: "cursor-squad",
        lastEventLedger: 200,
      },
    },
  });

  const parsed = parseAndMigrateCursorFile(raw);
  assert.equal(parsed.file.targets.market.cursor, '{"market":1,"market":2}');
  assert.equal(parsed.file.targets.squad.cursor, "cursor-squad");
});

test("poller.loadCursors detects duplicate targets before mutating in-memory state and preserves file", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const raw = `{
  "version": 1,
  "updatedAt": "2026-09-29T00:00:00.000Z",
  "chainClockAt": 1759104000000,
  "targets": {
    "squad": { "cursor": "squad-cursor-1", "lastEventLedger": 55 },
    "market": { "cursor": "market-cursor-1", "lastEventLedger": 100 },
    "market": { "cursor": "market-cursor-2", "lastEventLedger": 200 }
  }
}\n`;
    await writeFile(cursorFile, raw, "utf8");

    const poller = createPoller({
      config: makeConfig(cursorFile),
      server: {},
      send: async () => undefined,
      persistAudit: false,
      sleep: async () => undefined,
    });

    await poller.loadCursors();

    const status = poller.getStatus();
    for (const target of status.targets) {
      assert.equal(target.cursor, null, `${target.source} cursor must remain null`);
      assert.equal(target.lastEventLedger, null, `${target.source} lastEventLedger must remain null`);
    }
    assert.equal(status.chainClockAt, null);
    assert.equal(status.pendingFlush, false);

    // Original file was quarantined intact rather than overwritten or deleted.
    assert.equal(await exists(cursorFile), false);
    const entries = await readdir(directory);
    const quarantined = entries.filter((name) => name.startsWith("cursor.json.corrupt."));
    assert.equal(quarantined.length, 1);
    assert.equal(await readFile(path.join(directory, quarantined[0]), "utf8"), raw);
  });
});

test("cursor-cli backupCursor and restoreCursor reject duplicate targets with specific error and preserve files", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");
    const duplicateRaw = `{
  "version": 1,
  "updatedAt": "2026-09-29T00:00:00.000Z",
  "targets": {
    "market": { "cursor": "cursor-1", "lastEventLedger": 10 },
    "market": { "cursor": "cursor-2", "lastEventLedger": 20 }
  }
}\n`;

    // backupCursor: rejects, preserves original cursorFile, does not create backupFile.
    await writeFile(cursorFile, duplicateRaw, "utf8");
    await assert.rejects(
      backupCursor({ cursorFile, backupFile }),
      (err) =>
        err instanceof DuplicateCursorTargetError &&
        err.target === "market" &&
        /duplicate target definition.*"market"/i.test(err.message),
    );
    assert.equal(await readFile(cursorFile, "utf8"), duplicateRaw);
    assert.equal(await exists(backupFile), false);

    // restoreCursor (even with --force): rejects, preserves existing cursorFile & backupFile, releases lock.
    const existingLive = `${JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: { market: { cursor: "live-cursor", lastEventLedger: 99 } },
    })}\n`;
    await writeFile(cursorFile, existingLive, "utf8");
    await writeFile(backupFile, duplicateRaw, "utf8");

    await assert.rejects(
      restoreCursor({ cursorFile, backupFile, lockFile, force: true }),
      (err) =>
        err instanceof DuplicateCursorTargetError &&
        err.target === "market" &&
        /duplicate target definition.*"market"/i.test(err.message),
    );
    assert.equal(await readFile(cursorFile, "utf8"), existingLive);
    assert.equal(await readFile(backupFile, "utf8"), duplicateRaw);
    assert.equal(await exists(lockFile), false);
  });
});
