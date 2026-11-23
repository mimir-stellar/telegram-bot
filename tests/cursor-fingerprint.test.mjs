import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateCursor, restoreCursor } from "../dist/cursor-cli.js";
import {
  CURSOR_SCHEMA_VERSION,
  computeCursorTargetFingerprint,
  createPoller,
  isValidCursorFile,
  parseAndMigrateCursorFile,
} from "../dist/poller.js";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const MARKET_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const MARKET_B = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN";
const SQUAD_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KO";

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

function makeConfig(overrides = {}) {
  return {
    marketContractId: MARKET_A,
    squadContractId: SQUAD_A,
    networkPassphrase: TESTNET,
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    botToken: "fake-token",
    chatId: "-1001234567890",
    pollIntervalMs: 999_999,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 5,
    ...overrides,
  };
}

function makeServer(seenRequests, { latestLedger = 5100, oldestLedger = 1000 } = {}) {
  return {
    async getHealth() {
      return { status: "healthy", latestLedger, oldestLedger };
    },
    async getEvents(req) {
      seenRequests.push(req);
      return {
        events: [],
        cursor: cursorAt(latestLedger),
        latestLedger,
      };
    },
  };
}

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-fp-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("computeCursorTargetFingerprint binds to both network passphrase and contract id", () => {
  const fpTestnetMarketA = computeCursorTargetFingerprint(TESTNET, MARKET_A);
  const fpMainnetMarketA = computeCursorTargetFingerprint(MAINNET, MARKET_A);
  const fpTestnetMarketB = computeCursorTargetFingerprint(TESTNET, MARKET_B);

  assert.equal(fpTestnetMarketA.length, 64);
  assert.notEqual(fpTestnetMarketA, fpMainnetMarketA);
  assert.notEqual(fpTestnetMarketA, fpTestnetMarketB);
  assert.equal(fpTestnetMarketA, computeCursorTargetFingerprint(TESTNET, MARKET_A));
});

test("cursor schema validation preserves valid fingerprints and rejects invalid ones", () => {
  const fp = computeCursorTargetFingerprint(TESTNET, MARKET_A);
  const valid = {
    version: 1,
    updatedAt: "2026-09-29T00:00:00.000Z",
    targets: {
      market: { cursor: cursorAt(100), lastEventLedger: 100, fingerprint: fp },
    },
  };
  assert.equal(isValidCursorFile(valid), true);
  const migrated = parseAndMigrateCursorFile(JSON.stringify(valid));
  assert.equal(migrated.file.targets.market.fingerprint, fp);

  assert.equal(
    isValidCursorFile({
      ...valid,
      targets: { market: { cursor: null, lastEventLedger: null, fingerprint: "" } },
    }),
    false,
  );
  assert.throws(
    () =>
      parseAndMigrateCursorFile(
        JSON.stringify({
          ...valid,
          targets: { market: { cursor: null, lastEventLedger: null, fingerprint: 123 } },
        }),
      ),
    /fingerprint/,
  );
});

test("poller detects changed network or contract fingerprint on startup and cold-starts mismatched targets", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const testnetMarketFp = computeCursorTargetFingerprint(TESTNET, MARKET_A);
    const testnetSquadFp = computeCursorTargetFingerprint(TESTNET, SQUAD_A);
    const oldMarketCursor = cursorAt(4500);
    const oldSquadCursor = cursorAt(4600);

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: CURSOR_SCHEMA_VERSION,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: oldMarketCursor, lastEventLedger: 4500, fingerprint: testnetMarketFp },
          squad: { cursor: oldSquadCursor, lastEventLedger: 4600, fingerprint: testnetSquadFp },
        },
      }),
    );

    const seenRequests = [];
    // Market contract changed from MARKET_A -> MARKET_B; squad remains SQUAD_A on TESTNET.
    const poller = createPoller({
      config: makeConfig({ cursorFile, marketContractId: MARKET_B }),
      server: makeServer(seenRequests),
      send: async () => {},
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 80));
    poller.stop();

    const marketReq = seenRequests.find((r) => r.filters?.[0]?.contractIds?.includes(MARKET_B));
    const squadReq = seenRequests.find((r) => r.filters?.[0]?.contractIds?.includes(SQUAD_A));
    assert.ok(marketReq, "market target should have been scanned");
    assert.ok(squadReq, "squad target should have been scanned");
    assert.equal(marketReq.cursor, undefined, "mismatched market cursor must not be reused");
    assert.equal(squadReq.cursor, oldSquadCursor, "matching squad cursor must be preserved");

    const saved = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(
      saved.targets.market.fingerprint,
      computeCursorTargetFingerprint(TESTNET, MARKET_B),
    );
    assert.equal(saved.targets.squad.fingerprint, testnetSquadFp);
  });
});

test("poller binds legacy unfingerprinted cursor files on startup without dropping cursors", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const legacyCursor = cursorAt(4200);
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: CURSOR_SCHEMA_VERSION,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: legacyCursor, lastEventLedger: 4200 },
        },
      }),
    );

    const seenRequests = [];
    const poller = createPoller({
      config: makeConfig({ cursorFile }),
      server: makeServer(seenRequests),
      send: async () => {},
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 80));
    poller.stop();

    const marketReq = seenRequests.find((r) => r.filters?.[0]?.contractIds?.includes(MARKET_A));
    assert.equal(marketReq.cursor, legacyCursor);

    const saved = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(
      saved.targets.market.fingerprint,
      computeCursorTargetFingerprint(TESTNET, MARKET_A),
    );
  });
});

test("migrateCursor binds legacy targets and requires --force to reset incompatible fingerprints", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const lockFile = path.join(dir, "poller.lock");
    const marketCursor = cursorAt(3000);
    const mainnetSquadFp = computeCursorTargetFingerprint(MAINNET, SQUAD_A);

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: CURSOR_SCHEMA_VERSION,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: marketCursor, lastEventLedger: 3000 },
          squad: { cursor: cursorAt(3100), lastEventLedger: 3100, fingerprint: mainnetSquadFp },
        },
      }),
    );

    await assert.rejects(
      migrateCursor({
        cursorFile,
        lockFile,
        networkPassphrase: TESTNET,
        marketContractId: MARKET_A,
        squadContractId: SQUAD_A,
      }),
      /different network or contract fingerprint/,
    );

    const result = await migrateCursor({
      cursorFile,
      lockFile,
      networkPassphrase: TESTNET,
      marketContractId: MARKET_A,
      squadContractId: SQUAD_A,
      force: true,
    });
    assert.deepEqual(result, { bound: 1, reset: 1 });

    const migrated = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(migrated.targets.market.cursor, marketCursor);
    assert.equal(
      migrated.targets.market.fingerprint,
      computeCursorTargetFingerprint(TESTNET, MARKET_A),
    );
    assert.equal(migrated.targets.squad.cursor, null);
    assert.equal(migrated.targets.squad.lastEventLedger, null);
    assert.equal(
      migrated.targets.squad.fingerprint,
      computeCursorTargetFingerprint(TESTNET, SQUAD_A),
    );
  });
});

test("restoreCursor rejects mismatched target fingerprints without --force and resets with --force", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const lockFile = path.join(dir, "poller.lock");
    const mainnetFp = computeCursorTargetFingerprint(MAINNET, MARKET_A);

    await writeFile(
      backupFile,
      JSON.stringify({
        version: CURSOR_SCHEMA_VERSION,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: cursorAt(1234), lastEventLedger: 1234, fingerprint: mainnetFp },
        },
      }),
    );

    const targets = {
      networkPassphrase: TESTNET,
      marketContractId: MARKET_A,
      squadContractId: SQUAD_A,
    };

    await assert.rejects(
      restoreCursor({ cursorFile, backupFile, lockFile, targets }),
      /different network or contract fingerprint/,
    );

    await restoreCursor({ cursorFile, backupFile, lockFile, force: true, targets });
    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.targets.market.cursor, null);
    assert.equal(
      restored.targets.market.fingerprint,
      computeCursorTargetFingerprint(TESTNET, MARKET_A),
    );
  });
});
