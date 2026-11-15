import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { backupCursor, DuplicateCursorTargetError, restoreCursor } from "../dist/cursor-cli.js";
import {
  buildCursorFile,
  createPoller,
  parseAndMigrateCursorFile,
  parseCursorFile,
} from "../dist/poller.js";

function makeConfig(stateDir) {
  return {
    botToken: "000000:synthetic-test-token",
    chatId: "-1001234567890",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    marketContractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
    squadContractId: "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY",
    pollIntervalMs: 60_000,
    startLookbackLedgers: 60,
    cursorFile: path.join(stateDir, "cursor.json"),
    deadLetterFile: path.join(stateDir, "dead-letter.json"),
    auditFile: path.join(stateDir, "audit.jsonl"),
    statusFile: path.join(stateDir, "status.json"),
    instanceLockFile: path.join(stateDir, "poller.lock"),
    maxNotificationsPerCycle: 20,
    dedupWindow: 64,
    featureFlags: {},
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-dup-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseCursorFile and parseAndMigrateCursorFile reject exact and escaped duplicate target keys", () => {
  const rawV1Dup =
    '{"version":1,"updatedAt":"2026-10-01T00:00:00.000Z","targets":{' +
    '"market":{"cursor":"00004255261-0000000001","lastEventLedger":4255261},' +
    '"market":{"cursor":"00004255999-0000000002","lastEventLedger":4255999}}}';

  assert.throws(
    () => parseCursorFile(rawV1Dup),
    (err) => {
      assert.ok(err instanceof DuplicateCursorTargetError);
      assert.equal(err.code, "DUPLICATE_CURSOR_TARGET");
      assert.equal(err.reason, "duplicate_key");
      assert.deepEqual(err.duplicateTargets, ["market"]);
      assert.match(err.message, /duplicate target definition.*"market"/i);
      return true;
    },
  );

  assert.throws(
    () => parseAndMigrateCursorFile(rawV1Dup),
    (err) => err instanceof DuplicateCursorTargetError && err.reason === "duplicate_key",
  );

  const rawEscapedDup =
    '{"version":1,"updatedAt":"2026-10-01T00:00:00.000Z","targets":{' +
    '"market":{"cursor":"00004255261-0000000001","lastEventLedger":4255261},' +
    '"m\\u0061rket":{"cursor":"00004255999-0000000002","lastEventLedger":4255999}}}';

  assert.throws(
    () => parseAndMigrateCursorFile(rawEscapedDup),
    (err) => err instanceof DuplicateCursorTargetError && err.duplicateTargets.includes("market"),
  );
});

test("legacy flat maps, case/whitespace aliases, duplicate contracts, and buildCursorFile reject duplicates", () => {
  const rawFlatDup = '{"market":"00004255261-0000000001","market":"00004255999-0000000002"}';
  assert.throws(
    () => parseAndMigrateCursorFile(rawFlatDup),
    (err) => err instanceof DuplicateCursorTargetError && err.reason === "duplicate_key",
  );

  const rawAliasDup = JSON.stringify({
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    targets: {
      market: { cursor: "00004255261-0000000001", lastEventLedger: 4255261 },
      MARKET: { cursor: "00004255999-0000000002", lastEventLedger: 4255999 },
    },
  });
  assert.throws(
    () => parseAndMigrateCursorFile(rawAliasDup),
    (err) => err instanceof DuplicateCursorTargetError && err.reason === "normalized_alias",
  );

  const rawDupContract = JSON.stringify({
    version: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
    targets: {
      market: {
        cursor: "00004255261-0000000001",
        lastEventLedger: 4255261,
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      },
      market_v2: {
        cursor: "00004255999-0000000002",
        lastEventLedger: 4255999,
        contractId: "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
      },
    },
  });
  assert.throws(
    () => parseAndMigrateCursorFile(rawDupContract),
    (err) => err instanceof DuplicateCursorTargetError && err.reason === "duplicate_contract",
  );

  const rawDupRootTargets =
    '{"version":1,"targets":{"market":{"cursor":null,"lastEventLedger":null}},' +
    '"targets":{"squad":{"cursor":null,"lastEventLedger":null}}}';
  assert.throws(
    () => parseAndMigrateCursorFile(rawDupRootTargets),
    (err) => err instanceof DuplicateCursorTargetError && err.reason === "duplicate_targets_field",
  );

  assert.throws(
    () =>
      buildCursorFile(
        [
          { source: "market", cursor: "a", lastEventLedger: 1 },
          { source: "market", cursor: "b", lastEventLedger: 2 },
        ],
        "2026-10-01T00:00:00.000Z",
      ),
    (err) => err instanceof DuplicateCursorTargetError,
  );
});

test("poller detects duplicate targets before mutating in-memory state and preserves original file", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    const originalRaw =
      '{\n' +
      '  "version": 1,\n' +
      '  "updatedAt": "2026-10-01T00:00:00.000Z",\n' +
      '  "targets": {\n' +
      '    "squad": { "cursor": "00004255100-0000000001", "lastEventLedger": 4255100 },\n' +
      '    "market": { "cursor": "00004255261-0000000001", "lastEventLedger": 4255261 },\n' +
      '    "market": { "cursor": "00004255999-0000000002", "lastEventLedger": 4255999 }\n' +
      "  }\n" +
      "}\n";
    await writeFile(config.cursorFile, originalRaw, "utf8");

    const poller = createPoller({
      config,
      server: { getHealth: async () => ({ status: "healthy", latestLedger: 5000, oldestLedger: 4000 }) },
      send: async () => undefined,
      persistAudit: false,
    });

    await assert.rejects(
      () => poller.loadCursors(),
      (err) => err instanceof DuplicateCursorTargetError && err.duplicateTargets.includes("market"),
    );

    // Neither market nor squad in-memory cursor state was mutated.
    const statusAfterLoad = poller.status();
    for (const target of statusAfterLoad.targets) {
      assert.equal(target.cursor, null);
      assert.equal(target.lastEventLedger, null);
    }

    // start() also rejects cleanly, releases lock, and preserves original file without quarantine rename.
    await assert.rejects(
      () => poller.start(),
      (err) => err instanceof DuplicateCursorTargetError,
    );

    assert.equal(await readFile(config.cursorFile, "utf8"), originalRaw);
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["cursor.json"]);
  });
});

test("cursor CLI backup and restore preserve files and surface specific DuplicateCursorTargetError", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const lockFile = path.join(dir, "poller.lock");

    const dupRaw =
      '{"version":1,"updatedAt":"2026-10-01T00:00:00.000Z","targets":{' +
      '"market":{"cursor":"00004255261-0000000001","lastEventLedger":4255261},' +
      '"market":{"cursor":"00004255999-0000000002","lastEventLedger":4255999}}}\n';
    await writeFile(cursorFile, dupRaw, "utf8");

    await assert.rejects(
      () => backupCursor({ cursorFile, backupFile }),
      (err) => {
        assert.ok(err instanceof DuplicateCursorTargetError);
        assert.match(err.message, /duplicate target definition.*"market"/i);
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), dupRaw);
    const afterFailedBackup = await readdir(dir);
    assert.deepEqual(afterFailedBackup, ["cursor.json"]);

    // Now place a clean live cursor file and attempt to restore a duplicate-target backup over it.
    const liveCleanRaw =
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-01T00:00:00.000Z",
          targets: {
            market: { cursor: "00004255261-0000000001", lastEventLedger: 4255261 },
            squad: { cursor: "00004255100-0000000001", lastEventLedger: 4255100 },
          },
        },
        null,
        2,
      ) + "\n";
    await writeFile(cursorFile, liveCleanRaw, "utf8");
    await writeFile(backupFile, dupRaw, "utf8");

    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile, lockFile, force: true }),
      (err) => err instanceof DuplicateCursorTargetError && err.code === "DUPLICATE_CURSOR_TARGET",
    );

    // Both live and backup files remain byte-for-byte unchanged.
    assert.equal(await readFile(cursorFile, "utf8"), liveCleanRaw);
    assert.equal(await readFile(backupFile, "utf8"), dupRaw);
  });
});
