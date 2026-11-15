import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backupCursor,
  CursorOwnershipMismatchError,
  restoreCursor,
} from "../dist/cursor-cli.js";
import { createPoller } from "../dist/poller.js";

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

const MARKET_A = "CDV6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";
const SQUAD_A = "CBPGVXHXLULUBVZ24D6XNSUX7NH45HYXGWHAJFWTBHXYNO72KDRKCDFY";
const MARKET_OTHER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-owner-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("poller stamps cursor ownership and restoreCursor accepts matching backup while rejecting contract or network mismatches", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const matchingBackup = path.join(dir, "matching-backup.json");
    const wrongContractBackup = path.join(dir, "wrong-contract.json");
    const wrongNetworkBackup = path.join(dir, "wrong-network.json");
    const lockFile = path.join(dir, "poller.lock");

    const poller = createPoller({
      config: {
        marketContractId: MARKET_A,
        squadContractId: SQUAD_A,
        rpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        botToken: "000000:synthetic-token",
        chatId: "-1001234567890",
        pollIntervalMs: 999_999,
        startLookbackLedgers: 60,
        maxNotificationsPerCycle: 5,
        cursorFile,
        deadLetterFile: path.join(dir, "dead-letter.json"),
        auditFile: path.join(dir, "audit.jsonl"),
        statusFile: path.join(dir, "status.json"),
        instanceLockFile: lockFile,
      },
      server: {
        async getHealth() {
          return { status: "healthy", latestLedger: 7000, oldestLedger: 6000 };
        },
        async getEvents() {
          return { events: [], cursor: cursorAt(7000), latestLedger: 7000 };
        },
      },
      send: async () => undefined,
      persistAudit: false,
    });

    await poller.runCycle();
    const liveSavedRaw = await readFile(cursorFile, "utf8");
    const liveSaved = JSON.parse(liveSavedRaw);
    assert.deepEqual(liveSaved.ownership, {
      contracts: { market: MARKET_A, squad: SQUAD_A },
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    await backupCursor({ cursorFile, backupFile: matchingBackup });

    // 1. Wrong contract ID backup is rejected without modifying live cursorFile.
    await writeFile(
      wrongContractBackup,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-10T01:00:00.000Z",
        ownership: {
          contracts: { market: MARKET_OTHER, squad: SQUAD_A },
          networkPassphrase: "Test SDF Network ; September 2015",
        },
        targets: {
          market: { cursor: cursorAt(6500), lastEventLedger: 6500 },
          squad: { cursor: cursorAt(6500), lastEventLedger: 6500 },
        },
      }),
      "utf8",
    );

    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile: wrongContractBackup, lockFile, force: true }),
      (err) => {
        assert.ok(err instanceof CursorOwnershipMismatchError);
        assert.equal(err.reason, "contract_mismatch");
        return true;
      },
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveSavedRaw);

    // 2. Wrong network passphrase backup is rejected without modifying live cursorFile.
    await writeFile(
      wrongNetworkBackup,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-10T01:00:00.000Z",
        ownership: {
          contracts: { market: MARKET_A, squad: SQUAD_A },
          networkPassphrase: "Public Global Stellar Network ; September 2015",
        },
        targets: {
          market: { cursor: cursorAt(6500), lastEventLedger: 6500 },
          squad: { cursor: cursorAt(6500), lastEventLedger: 6500 },
        },
      }),
      "utf8",
    );

    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile: wrongNetworkBackup, lockFile, force: true }),
      (err) => err instanceof CursorOwnershipMismatchError && err.reason === "network_mismatch",
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveSavedRaw);

    // 3. Matching backup restores cleanly.
    await restoreCursor({ cursorFile, backupFile: matchingBackup, lockFile, force: true });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.deepEqual(restored.ownership, liveSaved.ownership);
  });
});

test("restoreCursor rejects unrelated schemas, empty targets, foreign target names, and disjoint target sets", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const lockFile = path.join(dir, "poller.lock");
    const liveRaw =
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-10T02:00:00.000Z",
          ownership: { contracts: { market: MARKET_A } },
          targets: {
            market: { cursor: cursorAt(7100), lastEventLedger: 7100 },
          },
        },
        null,
        2,
      ) + "\n";
    await writeFile(cursorFile, liveRaw, "utf8");

    // Non-cursor counters JSON file (version 1, but no targets map)
    const countersBackup = path.join(dir, "counters.json");
    await writeFile(
      countersBackup,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-10T02:00:00.000Z",
        contracts: { marketContractId: MARKET_A, squadContractId: SQUAD_A },
        counters: { cycles: 5, notificationsSent: 1, notificationsFailed: 0, eventsSkipped: 0 },
      }),
      "utf8",
    );
    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile: countersBackup, lockFile, force: true }),
      /malformed|unsupported/,
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);

    // Empty targets `{}`
    const emptyTargetsBackup = path.join(dir, "empty-targets.json");
    await writeFile(
      emptyTargetsBackup,
      JSON.stringify({ version: 1, updatedAt: "2026-10-10T02:00:00.000Z", targets: {} }),
      "utf8",
    );
    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile: emptyTargetsBackup, lockFile, force: true }),
      (err) => err instanceof CursorOwnershipMismatchError && err.reason === "empty_targets",
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);

    // Foreign unrecognized target identity (`indexer`)
    const foreignTargetBackup = path.join(dir, "foreign.json");
    await writeFile(
      foreignTargetBackup,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-10T02:00:00.000Z",
        targets: { indexer: { cursor: cursorAt(7050), lastEventLedger: 7050 } },
      }),
      "utf8",
    );
    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile: foreignTargetBackup, lockFile, force: true }),
      (err) => err instanceof CursorOwnershipMismatchError && err.reason === "unrecognized_target",
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);

    // Disjoint target set (`squad` only when live cursor tracks `market` only)
    const disjointBackup = path.join(dir, "disjoint.json");
    await writeFile(
      disjointBackup,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-10T02:00:00.000Z",
        targets: { squad: { cursor: cursorAt(7050), lastEventLedger: 7050 } },
      }),
      "utf8",
    );
    await assert.rejects(
      () => restoreCursor({ cursorFile, backupFile: disjointBackup, lockFile, force: true }),
      (err) => err instanceof CursorOwnershipMismatchError && err.reason === "disjoint_targets",
    );
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);
  });
});

test("legacy un-annotated backup with matching target identity inherits live ownership cleanly", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const legacyBackup = path.join(dir, "legacy.json");
    const lockFile = path.join(dir, "poller.lock");

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-10T03:00:00.000Z",
        ownership: {
          contracts: { market: MARKET_A, squad: SQUAD_A },
          networkPassphrase: "Test SDF Network ; September 2015",
        },
        targets: {
          market: { cursor: cursorAt(7200), lastEventLedger: 7200 },
          squad: { cursor: cursorAt(7200), lastEventLedger: 7200 },
        },
      }),
      "utf8",
    );
    await writeFile(legacyBackup, JSON.stringify({ market: cursorAt(7150) }), "utf8");

    await restoreCursor({ cursorFile, backupFile: legacyBackup, lockFile, force: true });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.targets.market.cursor, cursorAt(7150));
    assert.deepEqual(restored.ownership, {
      contracts: { market: MARKET_A, squad: SQUAD_A },
      networkPassphrase: "Test SDF Network ; September 2015",
    });
  });
});
