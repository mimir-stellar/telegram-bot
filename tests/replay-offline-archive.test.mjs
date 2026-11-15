import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { decodeEvent } from "../dist/stellar/decode.js";
import {
  buildScanJsonReport,
  buildScanJsonTarget,
  formatScanJson,
} from "../dist/stellar/events.js";
import {
  createScannerArchive,
  ReplayArchiveValidationError,
  replayFromArchive,
  runReplayCli,
  validateScannerArchive,
} from "../dist/stellar/replay.js";
import {
  claimChallengedEvent,
  claimCreatedEvent,
  MARKET_CONTRACT,
  oracleChangedEvent,
  SQUAD_CONTRACT,
  squadDepositedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeBotConfig(overrides = {}) {
  const tokenParts = ["123456", "SYNTHETIC_BOT_CREDENTIAL_FOR_TEST"];
  return {
    botToken: tokenParts.join(":"),
    telegramChatId: "-1001234567890",
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://unreachable-rpc.invalid",
    horizonUrl: "http://unreachable-horizon.invalid",
    networkPassphrase: TESTNET_PASSPHRASE,
    explorerBaseUrl: "https://stellar.expert/explorer",
    maxNotificationsPerCycle: 20,
    dedupWindow: 256,
    ...overrides,
  };
}

function toRawArchiveEvent(ev) {
  return {
    id: ev.id,
    ledger: ev.ledger,
    contractId: ev.contractId,
    txHash: ev.txHash,
    ledgerClosedAt: ev.ledgerClosedAt,
    transactionIndex: ev.transactionIndex ?? 0,
    operationIndex: ev.operationIndex ?? 0,
    inSuccessfulContractCall: ev.inSuccessfulContractCall ?? true,
    pagingToken: ev.pagingToken ?? ev.id,
    topic: ev.topic.map((t) => t.toXDR("base64")),
    value: ev.value ? ev.value.toXDR("base64") : undefined,
  };
}

function makeTrapRpcServer() {
  return {
    async getHealth() {
      throw new Error("RPC getHealth must never be called during offline archive replay");
    },
    async getNetwork() {
      throw new Error("RPC getNetwork must never be called during offline archive replay");
    },
    async getEvents() {
      throw new Error("RPC getEvents must never be called during offline archive replay");
    },
  };
}

test("offline replay decodes raw XDR scanner archive and filters range without touching RPC", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveFile = tmp.file("raw-archive.json");

    const idEarly = makeCursor(4050, 1);
    const idCreated = makeCursor(4100, 1);
    const idChallenged = makeCursor(4200, 1);
    const idAdmin = makeCursor(4250, 1);
    const idLate = makeCursor(4450, 1);
    const idSquad = makeCursor(4150, 2);

    const evEarly = claimCreatedEvent({ ledger: 4050, claimId: 1, id: idEarly, pagingToken: idEarly });
    const evCreated = claimCreatedEvent({ ledger: 4100, claimId: 2, id: idCreated, pagingToken: idCreated });
    const evChallenged = claimChallengedEvent({
      ledger: 4200,
      claimId: 2,
      stake: 25_000_000n,
      id: idChallenged,
      pagingToken: idChallenged,
    });
    const evAdmin = oracleChangedEvent({ ledger: 4250, id: idAdmin, pagingToken: idAdmin });
    const evLate = claimCreatedEvent({ ledger: 4450, claimId: 3, id: idLate, pagingToken: idLate });
    const evSquad = squadDepositedEvent({
      ledger: 4150,
      marketId: 7,
      amount: 50_000_000n,
      shares: 50_000_000n,
      id: idSquad,
      pagingToken: idSquad,
    });

    const archive = createScannerArchive({
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      oldestLedger: 4000,
      latestLedger: 4500,
      targets: [
        {
          source: "market",
          contractId: MARKET_CONTRACT,
          rawEvents: [
            toRawArchiveEvent(evEarly),
            toRawArchiveEvent(evCreated),
            toRawArchiveEvent(evCreated), // duplicate boundary event
            toRawArchiveEvent(evChallenged),
            toRawArchiveEvent(evAdmin),
            toRawArchiveEvent(evLate),
          ],
        },
        {
          source: "squad",
          contractId: SQUAD_CONTRACT,
          rawEvents: [toRawArchiveEvent(evSquad)],
        },
      ],
    });

    await writeFile(archiveFile, JSON.stringify(archive, null, 2), "utf8");

    const sentMessages = [];
    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--archive",
        archiveFile,
        "--from",
        "4100",
        "--to",
        "4300",
        "--send",
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeTrapRpcServer(),
        send: async (text, source) => {
          sentMessages.push({ text, source });
        },
        progress: () => {},
      },
    });

    assert.equal(exitCode, 0);
    assert.ok(report);
    assert.equal(report.archive, archiveFile);
    assert.equal(report.fromLedger, 4100);
    assert.equal(report.toLedger, 4300);

    // Market had evCreated (4100), evChallenged (4200), evAdmin (4250) in [4100, 4300];
    // evEarly (4050) and evLate (4450) were filtered out; duplicate evCreated suppressed.
    const marketTarget = report.targets.find((t) => t.source === "market");
    assert.equal(marketTarget.events, 3);
    assert.equal(marketTarget.sent, 2);
    assert.equal(marketTarget.adminLogged, 1);
    assert.equal(marketTarget.duplicates, 1);

    const squadTarget = report.targets.find((t) => t.source === "squad");
    assert.equal(squadTarget.events, 1);
    assert.equal(squadTarget.sent, 1);

    assert.equal(sentMessages.length, 3);
    // Formatted challenge message proves 25_000_000n bigint was decoded to 2.5 USDC (MarkdownV2 escapes '.' as '\.')
    assert.ok(sentMessages.some((m) => m.source === "market" && /2\\?\.5/.test(m.text)));
  });
});

test("offline replay supports mimir-scan-v1 scanner reports with bigint revival and default archive bounds", async () => {
  await withTempDataDir(async (tmp) => {
    const scanFile = tmp.file("scan-report.json");
    const id1 = makeCursor(5100, 1);
    const decoded = decodeEvent(
      "market",
      claimChallengedEvent({ ledger: 5100, claimId: 9, stake: 30_000_000n, id: id1 }),
    );
    const scanTarget = buildScanJsonTarget(
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        version: "v1",
        events: [decoded],
        cursor: id1,
        latestLedger: 5200,
        oldestLedger: 5000,
        truncated: false,
        pages: 1,
        emptyPages: 0,
        duplicates: 0,
        seenEventIds: [id1],
        startLedger: 5000,
        startClamped: false,
        timing: { health: { count: 1, totalMs: 5 }, events: { count: 1, totalMs: 10 } },
        lastEventLedger: 5100,
      },
      10,
    );
    const scanReport = buildScanJsonReport({
      network: "testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      oldestLedger: 5000,
      latestLedger: 5200,
      targets: [scanTarget],
    });
    await writeFile(scanFile, formatScanJson(scanReport), "utf8");

    const sent = [];
    const { report, exitCode } = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--archive",
        scanFile,
        "--contract",
        "market",
        "--send",
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeTrapRpcServer(),
        send: async (text) => sent.push(text),
        progress: () => {},
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(report.fromLedger, 5000);
    assert.equal(report.toLedger, 5200);
    assert.equal(report.totals.sent, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /3(?:\.0+|\b)/);
  });
});

test("enforces network, passphrase, and contract identity BEFORE processing any archive events", async () => {
  const id1 = makeCursor(4100, 1);
  const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 10, id: id1 });

  const baseArchive = createScannerArchive({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    oldestLedger: 4000,
    latestLedger: 4500,
    targets: [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        rawEvents: [toRawArchiveEvent(ev1)],
      },
      {
        source: "squad",
        contractId: SQUAD_CONTRACT,
        rawEvents: [],
      },
    ],
  });

  // 1. Network name mismatch
  let sendCalls = 0;
  await assert.rejects(
    () =>
      replayFromArchive(
        { ...baseArchive, network: "mainnet" },
        { dryRun: false },
        {
          config: fakeBotConfig(),
          send: async () => {
            sendCalls += 1;
          },
        },
      ),
    (err) => err instanceof ReplayArchiveValidationError && err.problem === "network-mismatch",
  );
  assert.equal(sendCalls, 0);

  // 2. Network passphrase mismatch (even when network label claims "testnet")
  await assert.rejects(
    () =>
      replayFromArchive(
        { ...baseArchive, networkPassphrase: MAINNET_PASSPHRASE },
        { dryRun: false },
        {
          config: fakeBotConfig(),
          send: async () => {
            sendCalls += 1;
          },
        },
      ),
    (err) => {
      assert(err instanceof ReplayArchiveValidationError);
      assert.equal(err.problem, "passphrase-mismatch");
      assert(!err.message.includes(TESTNET_PASSPHRASE));
      assert(!err.message.includes(MAINNET_PASSPHRASE));
      return true;
    },
  );
  assert.equal(sendCalls, 0);

  // 3. Contract mismatch on second target aborts BEFORE first target sends anything
  const wrongSquadArchive = createScannerArchive({
    network: "testnet",
    networkPassphrase: TESTNET_PASSPHRASE,
    oldestLedger: 4000,
    latestLedger: 4500,
    targets: [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        rawEvents: [toRawArchiveEvent(ev1)],
      },
      {
        source: "squad",
        contractId: MARKET_CONTRACT, // Wrong contract ID for squad!
        rawEvents: [],
      },
    ],
  });
  await assert.rejects(
    () =>
      replayFromArchive(
        wrongSquadArchive,
        { dryRun: false },
        {
          config: fakeBotConfig(),
          send: async () => {
            sendCalls += 1;
          },
        },
      ),
    (err) => err instanceof ReplayArchiveValidationError && err.problem === "contract-mismatch",
  );
  assert.equal(sendCalls, 0, "target 1 must not send when target 2 fails upfront validation");
});

test("enforces archive schema identity and rejects invalid versions, bounds, or corrupt XDR", async () => {
  const cfg = fakeBotConfig();

  const invalidCases = [
    null,
    [],
    { format: "mimir-replay-v1", version: 1 },
    { format: "mimir-scan-archive-v1", version: 2, network: "testnet", ledgers: { oldest: 1, latest: 10 }, targets: [] },
    { format: "mimir-scan-archive-v1", version: 1, network: "testnet", ledgers: { oldest: 20, latest: 10 }, targets: [] },
    {
      format: "mimir-scan-archive-v1",
      version: 1,
      network: "testnet",
      ledgers: { oldest: 100, latest: 200 },
      targets: [
        {
          source: "market",
          contractId: MARKET_CONTRACT,
          rawEvents: [{ id: "99-0", ledger: 99, topic: ["AAAA"] }], // outside [100, 200]
        },
      ],
    },
    {
      format: "mimir-scan-archive-v1",
      version: 1,
      network: "testnet",
      ledgers: { oldest: 100, latest: 200 },
      targets: [
        {
          source: "market",
          contractId: MARKET_CONTRACT,
          rawEvents: [{ id: "150-0", ledger: 150, topic: ["not-valid-xdr!!!"] }],
        },
      ],
    },
  ];

  for (const bad of invalidCases) {
    assert.throws(
      () => validateScannerArchive(bad, cfg),
      (err) => err instanceof ReplayArchiveValidationError && err.problem === "invalid-schema",
    );
  }

  await withTempDataDir(async (tmp) => {
    const badJsonPath = tmp.file("corrupt.json");
    await writeFile(badJsonPath, "{ broken", "utf8");
    const rCorrupt = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--archive", badJsonPath],
      deps: { config: cfg, server: makeTrapRpcServer(), progress: () => {} },
    });
    assert.equal(rCorrupt.exitCode, 2);
    assert.equal(rCorrupt.report, null);

    const missingArg = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--archive"],
      deps: { config: cfg, server: makeTrapRpcServer(), progress: () => {} },
    });
    assert.equal(missingArg.exitCode, 2);
  });
});

test("offline archive replay clamps --from below floor and rejects --from ahead of archive tip", async () => {
  await withTempDataDir(async (tmp) => {
    const archivePath = tmp.file("bounds-archive.json");
    const archive = createScannerArchive({
      network: "testnet",
      oldestLedger: 4000,
      latestLedger: 4500,
      targets: [
        { source: "market", contractId: MARKET_CONTRACT, rawEvents: [] },
      ],
    });
    await writeFile(archivePath, JSON.stringify(archive), "utf8");

    const clampedRun = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--archive", archivePath, "--from", "3500", "--to", "5000", "--contract", "market"],
      deps: { config: fakeBotConfig(), server: makeTrapRpcServer(), progress: () => {} },
    });
    assert.equal(clampedRun.exitCode, 0);
    assert.equal(clampedRun.report.targets[0].startClamped, true);
    assert.equal(clampedRun.report.targets[0].startLedger, 4000);
    assert.equal(clampedRun.report.targets[0].toLedger, 4500);

    const aheadRun = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--archive", archivePath, "--from", "4600", "--contract", "market"],
      deps: { config: fakeBotConfig(), server: makeTrapRpcServer(), progress: () => {} },
    });
    assert.equal(aheadRun.exitCode, 1);
  });
});
