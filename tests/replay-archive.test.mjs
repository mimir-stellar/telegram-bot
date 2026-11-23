/**
 * Tests for offline replay from validated `mimir-scan-v1` scanner archives.
 *
 * All I/O uses temporary directories and in-process fakes; no RPC server is
 * ever contacted.
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  loadAndValidateScannerArchive,
  runReplayCli,
} from "../dist/stellar/replay.js";
import { MARKET_CONTRACT, SQUAD_CONTRACT } from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function fakeConfig(overrides = {}) {
  return {
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://fake-rpc.invalid",
    horizonUrl: "http://fake-horizon.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

function throwingRpcServer() {
  return {
    async getHealth() {
      throw new Error("RPC getHealth must not be called in offline archive mode");
    },
    async getEvents() {
      throw new Error("RPC getEvents must not be called in offline archive mode");
    },
  };
}

function makeSampleArchive(overrides = {}) {
  return {
    format: "mimir-scan-v1",
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
    ledgers: { oldest: 4226000, latest: 4227000 },
    targets: [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        pages: 2,
        eventCount: 4,
        truncated: false,
        lastEventLedger: 4226800,
        cursor: "18153988096000000-0",
        startLedger: 4226500,
        startClamped: false,
        histogram: { claim_challenged: 2, oracle_changed: 1, "unknown:mystery": 1 },
        events: [
          {
            ledger: 4226550,
            txHash: "tx-market-1",
            eventId: "ev-market-1",
            summary: "claim_challenged #7",
            payload: {
              name: "claim_challenged",
              claimId: 7,
              challenger: "GCHALLENGER1",
              stake: "250000000",
            },
          },
          {
            ledger: 4226600,
            txHash: "tx-market-2",
            eventId: "ev-market-2",
            summary: "oracle_changed",
            payload: {
              name: "oracle_changed",
              oldOracle: "GOLD",
              newOracle: "GNEW",
            },
          },
          {
            ledger: 4226650,
            txHash: "tx-market-3",
            eventId: "ev-market-3",
            summary: "unknown:mystery",
            payload: {
              name: "unknown",
              eventName: "mystery",
              reason: "unrecognized event",
            },
          },
          {
            ledger: 4226800,
            txHash: "tx-market-4",
            eventId: "ev-market-4",
            summary: "claim_challenged #8",
            payload: {
              name: "claim_challenged",
              claimId: 8,
              challenger: "GCHALLENGER2",
              stake: "500000000",
            },
          },
        ],
      },
      {
        source: "squad",
        contractId: SQUAD_CONTRACT,
        pages: 1,
        eventCount: 2,
        truncated: false,
        lastEventLedger: 4226700,
        cursor: "18153558599270400-0",
        startLedger: 4226500,
        startClamped: false,
        histogram: { deposited: 2 },
        events: [
          {
            ledger: 4226620,
            txHash: "tx-squad-1",
            eventId: "ev-squad-1",
            summary: "deposited",
            payload: {
              name: "deposited",
              marketId: 3,
              user: "GUSER1",
              side: 1,
              amount: "100000000",
              shares: "100000000",
            },
          },
          {
            // Duplicate eventId to test deduplication
            ledger: 4226620,
            txHash: "tx-squad-1",
            eventId: "ev-squad-1",
            summary: "deposited",
            payload: {
              name: "deposited",
              marketId: 3,
              user: "GUSER1",
              side: 1,
              amount: "100000000",
              shares: "100000000",
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("offline archive replay runs without RPC and handles decode, admin, unknown, dedup, and send", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("scan.json");
    await writeFile(archiveFile, JSON.stringify(makeSampleArchive()), "utf8");

    const sentMessages = [];
    const logs = [];
    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay", "--archive", archiveFile, "--send", "--show", "10"],
      deps: {
        config: fakeConfig(),
        server: throwingRpcServer(),
        send: async (text, source) => {
          sentMessages.push({ text, source });
        },
        progress: (...args) => logs.push(args.join(" ")),
      },
    });

    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.format, "mimir-replay-v1");
    assert.equal(report.network, "testnet");
    assert.equal(report.archivePath, archiveFile);
    assert.equal(report.dryRun, false);

    // Market: 4 events -> 2 sent (claim_challenged), 1 adminLogged, 1 unknown skipped
    const market = report.targets.find((t) => t.source === "market");
    assert.ok(market);
    assert.equal(market.pages, 0);
    assert.equal(market.events, 4);
    assert.equal(market.sent, 2);
    assert.equal(market.adminLogged, 1);
    assert.equal(market.skipped, 1);
    assert.equal(market.duplicates, 0);

    // Squad: 2 raw entries with same eventId -> 1 deduped, 1 sent
    const squad = report.targets.find((t) => t.source === "squad");
    assert.ok(squad);
    assert.equal(squad.pages, 0);
    assert.equal(squad.events, 1);
    assert.equal(squad.sent, 1);
    assert.equal(squad.duplicates, 1);

    assert.equal(sentMessages.length, 3);
    assert.equal(report.totals.events, 5);
    assert.equal(report.totals.sent, 3);
    assert.equal(report.totals.adminLogged, 1);
    assert.equal(report.totals.skipped, 1);
    assert.equal(report.totals.duplicates, 1);
  });
});

test("offline archive replay filters by --from, --to, --contract, and --cap", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("scan.json");
    await writeFile(archiveFile, JSON.stringify(makeSampleArchive()), "utf8");

    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay",
        "--archive",
        archiveFile,
        "--contract",
        "market",
        "--from",
        "4226500",
        "--to",
        "4226700",
        "--cap",
        "1",
      ],
      deps: {
        config: fakeConfig(),
        server: throwingRpcServer(),
        progress: () => {},
      },
    });

    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.targets.length, 1);
    assert.equal(report.targets[0].source, "market");
    // Ledger 4226800 is excluded by --to 4226700
    assert.equal(report.targets[0].events, 3);
    assert.equal(report.targets[0].sent, 1);
    assert.equal(report.targets[0].adminLogged, 1);
    assert.equal(report.targets[0].skipped, 1);
  });
});

test("offline archive replay revives bigint fields via loadAndValidateScannerArchive", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("scan.json");
    await writeFile(archiveFile, JSON.stringify(makeSampleArchive()), "utf8");

    const archive = await loadAndValidateScannerArchive(archiveFile, {
      network: "testnet",
    });

    const marketEvent = archive.targets[0].events[0];
    assert.equal(typeof marketEvent.payload.stake, "bigint");
    assert.equal(marketEvent.payload.stake, 250000000n);

    const squadEvent = archive.targets[1].events[0];
    assert.equal(typeof squadEvent.payload.amount, "bigint");
    assert.equal(squadEvent.payload.amount, 100000000n);
  });
});

test("offline archive replay rejects mismatched network identity before processing", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("mainnet-scan.json");
    await writeFile(
      archiveFile,
      JSON.stringify(makeSampleArchive({ network: "mainnet" })),
      "utf8",
    );

    let sendCalled = false;
    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay", "--archive", archiveFile, "--send"],
      deps: {
        config: fakeConfig(), // testnet
        server: throwingRpcServer(),
        send: async () => {
          sendCalled = true;
        },
        progress: () => {},
      },
    });

    assert.equal(exitCode, 2);
    assert.equal(report, null);
    assert.equal(sendCalled, false);
  });
});

test("offline archive replay rejects invalid schema format before processing", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("bad-schema.json");
    await writeFile(
      archiveFile,
      JSON.stringify(makeSampleArchive({ format: "mimir-scan-v2" })),
      "utf8",
    );

    let sendCalled = false;
    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay", "--archive", archiveFile, "--send"],
      deps: {
        config: fakeConfig(),
        server: throwingRpcServer(),
        send: async () => {
          sendCalled = true;
        },
        progress: () => {},
      },
    });

    assert.equal(exitCode, 2);
    assert.equal(report, null);
    assert.equal(sendCalled, false);
  });
});

test("offline archive replay rejects missing or malformed archive file", async () => {
  await withTempDataDir(async (tmp) => {
    const missing = await runReplayCli({
      argv: ["node", "replay", "--archive", tmp.file("does-not-exist.json")],
      deps: {
        config: fakeConfig(),
        server: throwingRpcServer(),
        progress: () => {},
      },
    });
    assert.equal(missing.exitCode, 2);
    assert.equal(missing.report, null);

    const malformedFile = tmp.file("malformed.json");
    await writeFile(malformedFile, "{not valid json", "utf8");
    const malformed = await runReplayCli({
      argv: ["node", "replay", "--archive", malformedFile],
      deps: {
        config: fakeConfig(),
        server: throwingRpcServer(),
        progress: () => {},
      },
    });
    assert.equal(malformed.exitCode, 2);
    assert.equal(malformed.report, null);
  });
});

test("offline archive replay handles empty archive cleanly", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("empty-scan.json");
    await writeFile(
      archiveFile,
      JSON.stringify(makeSampleArchive({ targets: [] })),
      "utf8",
    );

    const { report, exitCode } = await runReplayCli({
      argv: ["node", "replay", "--archive", archiveFile],
      deps: {
        config: fakeConfig(),
        server: throwingRpcServer(),
        progress: () => {},
      },
    });

    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.totals.events, 0);
    assert.equal(report.totals.sent, 0);
  });
});
