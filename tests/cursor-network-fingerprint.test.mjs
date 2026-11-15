import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildCursorBinding,
  computeTargetBindingFingerprint,
  CursorBindingMismatchError,
  migrateCursorBinding,
} from "../dist/cursor-cli.js";
import { createPoller } from "../dist/poller.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cursor-cli.js");

const TOKEN = "123456789:" + "TEST-ONLY-TOKEN-NEVER-USE";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const MARKET_V1 = "C" + "A".repeat(55);
const MARKET_V2 = "C" + "C".repeat(55);
const SQUAD_V1 = "C" + "B".repeat(55);

function cursorAt(ledger, index = 1) {
  return `${(BigInt(ledger) << 32n).toString()}-${index}`;
}

function makeConfig(dir, overrides = {}) {
  return {
    marketContractId: MARKET_V1,
    marketContractVersion: "v1",
    squadContractId: SQUAD_V1,
    squadContractVersion: "v1",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: TESTNET_PASSPHRASE,
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: "42",
    pollIntervalMs: 9_999_999,
    startLookbackLedgers: 60,
    cursorFile: dir.file("cursor.json"),
    lockFile: dir.file("poller.lock"),
    statusFile: dir.file("status.json"),
    auditFile: dir.file("audit.jsonl"),
    countersFile: dir.file("counters.json"),
    maxNotificationsPerCycle: 20,
    dedupWindow: 64,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function fakeServer({ marketCursor = cursorAt(5001, 1), squadCursor = cursorAt(5002, 2) } = {}) {
  return {
    getHealth: async () => ({ status: "healthy", oldestLedger: 4000, latestLedger: 5100 }),
    getEvents: async (req) => {
      const id = req.filters?.[0]?.contractIds?.[0];
      const isMarket = id === MARKET_V1 || id === MARKET_V2;
      return {
        events: [],
        cursor: isMarket ? marketCursor : squadCursor,
        latestLedger: 5100,
      };
    },
  };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("poller stamps deterministic network+contract binding and resumes cleanly with matching config", () =>
  withTempDataDir(async (dir) => {
    const b1 = buildCursorBinding({
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { squad: SQUAD_V1, market: MARKET_V1 },
    });
    const b2 = buildCursorBinding({
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { market: MARKET_V1, squad: SQUAD_V1 },
    });
    assert.deepEqual(b1, b2);
    assert.equal(
      b1.targetFingerprints.market,
      computeTargetBindingFingerprint(TESTNET_PASSPHRASE, "market", MARKET_V1),
    );

    const config = makeConfig(dir);
    const poller1 = createPoller({
      config,
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await poller1.pollOnce();
    await poller1.shutdown({ timeoutMs: 100 });

    const persisted = JSON.parse(await readFile(config.cursorFile, "utf8"));
    assert.deepEqual(persisted.binding, b1);

    const poller2 = createPoller({
      config,
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await poller2.loadCursors();
    const targets = poller2.status().targets;
    assert.equal(targets.find((t) => t.source === "market").cursor, cursorAt(5001, 1));
    assert.equal(targets.find((t) => t.source === "squad").cursor, cursorAt(5002, 2));
  }));

test("legacy unbound cursor file loads compatibly and acquires binding on next save", () =>
  withTempDataDir(async (dir) => {
    const config = makeConfig(dir);
    const legacy = {
      version: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
      targets: {
        market: { cursor: cursorAt(4900, 1), lastEventLedger: 4900 },
        squad: { cursor: cursorAt(4905, 2), lastEventLedger: 4905 },
      },
    };
    await writeFile(config.cursorFile, JSON.stringify(legacy, null, 2), "utf8");

    const poller = createPoller({
      config,
      server: fakeServer({ marketCursor: cursorAt(5010, 1), squadCursor: cursorAt(5012, 2) }),
      send: async () => undefined,
      persistAudit: false,
    });
    await poller.loadCursors();
    assert.equal(
      poller.status().targets.find((t) => t.source === "market").cursor,
      cursorAt(4900, 1),
    );

    await poller.runCycle();
    const saved = JSON.parse(await readFile(config.cursorFile, "utf8"));
    assert.ok(saved.binding);
    assert.equal(saved.binding.networkPassphrase, TESTNET_PASSPHRASE);
    assert.equal(saved.binding.contracts.market, MARKET_V1);
    assert.equal(saved.binding.contracts.squad, SQUAD_V1);
  }));

test("startup rejects changed network, changed contract, or tampered fingerprint while preserving cursor file and releasing lock", () =>
  withTempDataDir(async (dir) => {
    const baseCfg = makeConfig(dir);
    const writer = createPoller({
      config: baseCfg,
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await writer.pollOnce();
    await writer.shutdown({ timeoutMs: 100 });

    const originalRaw = await readFile(baseCfg.cursorFile, "utf8");

    // 1. Changed market contract ID on startup
    const changedContractPoller = createPoller({
      config: makeConfig(dir, { marketContractId: MARKET_V2 }),
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await assert.rejects(
      changedContractPoller.start(),
      (err) => {
        assert.ok(err instanceof CursorBindingMismatchError);
        assert.equal(err.reason, "contract_changed");
        assert.deepEqual(err.changedTargets, ["market"]);
        assert.match(err.message, /npm run cursor -- migrate/);
        return true;
      },
    );
    assert.equal(await readFile(baseCfg.cursorFile, "utf8"), originalRaw);
    assert.equal(await exists(baseCfg.lockFile), false, "poller.lock must be released on mismatch");
    const entriesAfterContractMismatch = await readdir(dir.root);
    assert.equal(
      entriesAfterContractMismatch.some((name) => name.includes(".corrupt.")),
      false,
      "mismatched cursor file must not be quarantined as corrupt",
    );

    // 2. Changed network passphrase on startup
    const changedNetworkPoller = createPoller({
      config: makeConfig(dir, { networkPassphrase: PUBLIC_PASSPHRASE }),
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await assert.rejects(
      changedNetworkPoller.start(),
      (err) => {
        assert.ok(err instanceof CursorBindingMismatchError);
        assert.equal(err.reason, "network_changed");
        assert.deepEqual(err.changedTargets.sort(), ["market", "squad"]);
        return true;
      },
    );
    assert.equal(await readFile(baseCfg.cursorFile, "utf8"), originalRaw);
    assert.equal(await exists(baseCfg.lockFile), false);

    // 3. Tampered binding digest on startup
    const tamperedJson = JSON.parse(originalRaw);
    tamperedJson.binding.fingerprint = "0".repeat(64);
    await writeFile(baseCfg.cursorFile, JSON.stringify(tamperedJson, null, 2), "utf8");

    const tamperedPoller = createPoller({
      config: baseCfg,
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await assert.rejects(
      tamperedPoller.loadCursors(),
      (err) => {
        assert.ok(err instanceof CursorBindingMismatchError);
        assert.equal(err.reason, "fingerprint_tampered");
        return true;
      },
    );
  }));

test("migrateCursorBinding preserves unchanged contracts on same network and resets upgraded contract", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const lockFile = dir.file("poller.lock");
    const preUpgradeBackup = dir.file("cursor.pre-migrate.bak");

    const initialBinding = buildCursorBinding({
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { market: MARKET_V1, squad: SQUAD_V1 },
    });
    const initialDoc = {
      version: 1,
      updatedAt: "2026-10-10T00:00:00.000Z",
      chainClockAt: 1_760_000_000_000,
      binding: initialBinding,
      targets: {
        market: {
          cursor: cursorAt(4800, 1),
          lastEventLedger: 4800,
          recentEventIds: ["evt-market-1"],
        },
        squad: {
          cursor: cursorAt(4850, 2),
          lastEventLedger: 4850,
          recentEventIds: ["evt-squad-1"],
        },
      },
    };
    const initialRaw = `${JSON.stringify(initialDoc, null, 2)}\n`;
    await writeFile(cursorFile, initialRaw, "utf8");

    // Dry run inspects without mutating disk
    const dryResult = await migrateCursorBinding({
      cursorFile,
      lockFile,
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { market: MARKET_V2, squad: SQUAD_V1 },
      dryRun: true,
    });
    assert.equal(dryResult.dryRun, true);
    assert.equal(dryResult.networkChanged, false);
    assert.deepEqual(dryResult.preservedTargets, ["squad"]);
    assert.deepEqual(dryResult.resetTargets, ["market"]);
    assert.equal(await readFile(cursorFile, "utf8"), initialRaw);

    // Real migration writes backup + re-binds cursor file under lock
    const result = await migrateCursorBinding({
      cursorFile,
      lockFile,
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { market: MARKET_V2, squad: SQUAD_V1 },
      backupFile: preUpgradeBackup,
    });
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.preservedTargets, ["squad"]);
    assert.deepEqual(result.resetTargets, ["market"]);
    assert.equal(await readFile(preUpgradeBackup, "utf8"), initialRaw);
    assert.equal(await exists(lockFile), false);

    const migratedDoc = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(migratedDoc.chainClockAt, 1_760_000_000_000);
    assert.equal(migratedDoc.targets.market.cursor, null);
    assert.equal(migratedDoc.targets.market.lastEventLedger, null);
    assert.equal(migratedDoc.targets.market.recentEventIds, undefined);
    assert.equal(migratedDoc.targets.squad.cursor, cursorAt(4850, 2));
    assert.equal(migratedDoc.targets.squad.lastEventLedger, 4850);
    assert.deepEqual(migratedDoc.targets.squad.recentEventIds, ["evt-squad-1"]);

    // Upgraded poller now loads cleanly without mismatch
    const upgradedPoller = createPoller({
      config: makeConfig(dir, { marketContractId: MARKET_V2 }),
      server: fakeServer(),
      send: async () => undefined,
      persistAudit: false,
    });
    await upgradedPoller.loadCursors();
    const targets = upgradedPoller.status().targets;
    assert.equal(targets.find((t) => t.source === "market").cursor, null);
    assert.equal(targets.find((t) => t.source === "squad").cursor, cursorAt(4850, 2));
  }));

test("migrateCursorBinding resets all targets and drops chainClockAt on network change or CLI --json invocation", () =>
  withTempDataDir(async (dir) => {
    const cursorFile = dir.file("cursor.json");
    const lockFile = dir.file("poller.lock");
    const envFile = dir.file("empty.env");
    await writeFile(envFile, "", "utf8");

    const initialBinding = buildCursorBinding({
      networkPassphrase: TESTNET_PASSPHRASE,
      contracts: { market: MARKET_V1, squad: SQUAD_V1 },
    });
    await writeFile(
      cursorFile,
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-10T00:00:00.000Z",
          chainClockAt: 1_760_000_000_000,
          binding: initialBinding,
          targets: {
            market: { cursor: cursorAt(4800, 1), lastEventLedger: 4800 },
            squad: { cursor: cursorAt(4850, 2), lastEventLedger: 4850 },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        CLI_PATH,
        "migrate",
        "--file",
        cursorFile,
        "--network-passphrase",
        PUBLIC_PASSPHRASE,
        "--market-contract",
        MARKET_V1,
        "--squad-contract",
        SQUAD_V1,
        "--json",
      ],
      {
        cwd: dir.root,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: envFile,
          INSTANCE_LOCK_FILE: lockFile,
        },
      },
    );

    const cliResult = JSON.parse(stdout);
    assert.equal(cliResult.networkChanged, true);
    assert.deepEqual(cliResult.preservedTargets, []);
    assert.deepEqual(cliResult.resetTargets.sort(), ["market", "squad"]);

    const migratedDoc = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(migratedDoc.binding.networkPassphrase, PUBLIC_PASSPHRASE);
    assert.equal(migratedDoc.chainClockAt, undefined);
    assert.equal(migratedDoc.targets.market.cursor, null);
    assert.equal(migratedDoc.targets.squad.cursor, null);
  }));
