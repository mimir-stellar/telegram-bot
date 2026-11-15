import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  computeCertificateDigest,
  runReplayCli,
  verifyReplayCompletenessCertificate,
} from "../dist/stellar/replay.js";
import {
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimCreatedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeConfig(overrides = {}) {
  return {
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://fake-rpc-a.invalid",
    horizonUrl: "http://fake-horizon.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    ...overrides,
  };
}

test("complete range produces byte-for-byte deterministic certificate across different wall-clock times and RPC URLs", async () => {
  await withTempDataDir(async (tmp) => {
    const certPath1 = tmp.file("cert-1.json");
    const certPath2 = tmp.file("cert-2.json");

    const ev = claimCreatedEvent({
      ledger: 4100,
      claimId: 1,
      id: makeCursor(4100, 1),
      pagingToken: makeCursor(4100, 1),
    });

    const makeHealthyServer = () => ({
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents(req) {
        const cid = req?.filters?.[0]?.contractIds?.[0];
        if (cid === MARKET_CONTRACT) {
          return { events: [ev], cursor: makeCursor(4600, 1), latestLedger: 5000 };
        }
        return { events: [], cursor: makeCursor(4600, 1), latestLedger: 5000 };
      },
    });

    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4500",
        "--certificate",
        certPath1,
        "--require-complete",
      ],
      deps: {
        config: fakeConfig({ rpcUrl: "http://rpc-node-1.invalid" }),
        server: makeHealthyServer(),
        now: () => 1_700_000_000_000,
        progress: () => {},
      },
    });

    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4500",
        "--certificate",
        certPath2,
        "--require-complete",
      ],
      deps: {
        config: fakeConfig({ rpcUrl: "http://rpc-node-2.invalid" }),
        server: makeHealthyServer(),
        now: () => 1_950_000_000_000,
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, 0);
    assert.equal(run2.exitCode, 0);

    const raw1 = await readFile(certPath1, "utf8");
    const raw2 = await readFile(certPath2, "utf8");
    assert.equal(
      raw1,
      raw2,
      "completeness certificate must be byte-for-byte identical across timestamps and RPC endpoints",
    );

    const cert = JSON.parse(raw1);
    assert.equal(cert.format, "mimir-replay-completeness-v1");
    assert.equal(cert.version, 1);
    assert.equal(cert.complete, true);
    assert.deepEqual(cert.unresolvedGaps, []);
    assert.match(cert.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(verifyReplayCompletenessCertificate(cert), true);

    assert.equal(cert.targets.length, 2);
    for (const target of cert.targets) {
      assert.equal(target.complete, true);
      assert.deepEqual(target.observedRange, { from: 4000, to: 4500, count: 501 });
      assert.deepEqual(target.unresolvedGaps, []);
    }
  });
});

test("pruned ranges (partial, wholly pruned, or resumed) are never marked complete", async () => {
  await withTempDataDir(async (tmp) => {
    // 1. Partially pruned: requested 2000..5000, retention floor at 4000
    const serverPartialPrune = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 4000, latestLedger: 5000 };
      },
      async getEvents() {
        return { events: [], cursor: makeCursor(5000, 1), latestLedger: 5000 };
      },
    };

    const resPartial = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "2000", "--to", "5000", "--contract", "market"],
      deps: { config: fakeConfig(), server: serverPartialPrune, progress: () => {} },
    });

    assert.equal(resPartial.exitCode, 0);
    const certPartial = resPartial.report.completeness;
    assert.equal(certPartial.complete, false, "pruned range must never be marked complete");
    assert.equal(verifyReplayCompletenessCertificate(certPartial), true);
    assert.deepEqual(certPartial.targets[0].observedRange, { from: 4000, to: 5000, count: 1001 });
    assert.deepEqual(certPartial.unresolvedGaps, [
      {
        source: "market",
        from: 2000,
        to: 3999,
        count: 2000,
        reason: "pruned-before-retention-floor",
      },
    ]);

    // Tampering complete=true on a pruned certificate must fail verification
    const tampered = { ...certPartial, complete: true };
    tampered.digest = computeCertificateDigest({
      format: tampered.format,
      version: tampered.version,
      network: tampered.network,
      contracts: tampered.contracts,
      complete: true,
      requestedRange: tampered.requestedRange,
      targets: tampered.targets,
      unresolvedGaps: tampered.unresolvedGaps,
    });
    assert.equal(verifyReplayCompletenessCertificate(tampered), false);

    // 2. Wholly pruned: requested 2000..3500 when retention floor is 4000
    const resWhollyPruned = await runReplayCli({
      argv: ["node", "replay-cli.ts", "--from", "2000", "--to", "3500", "--contract", "market"],
      deps: { config: fakeConfig(), server: serverPartialPrune, progress: () => {} },
    });
    const certWholly = resWhollyPruned.report.completeness;
    assert.equal(certWholly.complete, false);
    assert.equal(certWholly.targets[0].observedRange, null);
    assert.deepEqual(certWholly.unresolvedGaps, [
      {
        source: "market",
        from: 2000,
        to: 3500,
        count: 1501,
        reason: "pruned-before-retention-floor",
      },
    ]);

    // 3. Multi-run resumed pruned range still remembers pruned gap on completion
    const progressFile = tmp.file("pruned-progress.json");
    let calls = 0;
    const twoPagePrunedServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 4000, latestLedger: 5000 };
      },
      async getEvents() {
        calls += 1;
        if (calls === 1) {
          return { events: [], cursor: makeCursor(4400, 1), latestLedger: 5000 };
        }
        return { events: [], cursor: makeCursor(5000, 1), latestLedger: 5000 };
      },
    };

    const part1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "2000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--pages",
        "1",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeConfig(), server: twoPagePrunedServer, progress: () => {} },
    });
    assert.equal(part1.report.completeness.complete, false);

    const part2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "2000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeConfig(), server: twoPagePrunedServer, progress: () => {} },
    });
    assert.equal(
      part2.report.completeness.complete,
      false,
      "resumed replay of a pruned range must remain incomplete",
    );
    assert.deepEqual(part2.report.completeness.unresolvedGaps, [
      {
        source: "market",
        from: 2000,
        to: 3999,
        count: 2000,
        reason: "pruned-before-retention-floor",
      },
    ]);
  });
});

test("truncated page-budget runs record exact tail gaps and become complete only after resuming to exhaustion", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("resume-complete.json");
    let pageCalls = 0;
    const server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        pageCalls += 1;
        if (pageCalls <= 2) {
          return {
            events: [],
            cursor: makeCursor(3000 + pageCalls * 100, 1),
            latestLedger: 5000,
          };
        }
        return {
          events: [],
          cursor: makeCursor(5000, 1),
          latestLedger: 5000,
        };
      },
    };

    // Run 1: --pages 2 stops at empty cursor ledger 3200
    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "3000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--pages",
        "2",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });
    assert.equal(run1.exitCode, 0);
    assert.equal(run1.report.completeness.complete, false);
    assert.deepEqual(run1.report.completeness.targets[0].observedRange, {
      from: 3000,
      to: 3200,
      count: 201,
    });
    assert.deepEqual(run1.report.completeness.unresolvedGaps, [
      {
        source: "market",
        from: 3201,
        to: 5000,
        count: 1800,
        reason: "truncated-page-budget",
      },
    ]);

    // Run 2: resume without page cap -> finishes 3201..5000 and marks complete=true
    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "3000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
      ],
      deps: { config: fakeConfig(), server, progress: () => {} },
    });
    assert.equal(run2.exitCode, 0);
    assert.equal(run2.report.completeness.complete, true);
    assert.deepEqual(run2.report.completeness.targets[0].observedRange, {
      from: 3000,
      to: 5000,
      count: 2001,
    });
    assert.deepEqual(run2.report.completeness.unresolvedGaps, []);

    // Single-ledger non-empty truncated page (4000..4000 with --pages 1) is incomplete
    const singleLedgerTruncatedServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        return {
          events: [
            claimCreatedEvent({
              ledger: 4000,
              claimId: 1,
              id: makeCursor(4000, 1),
              pagingToken: makeCursor(4000, 1),
            }),
          ],
          cursor: makeCursor(4000, 1),
          latestLedger: 5000,
        };
      },
    };
    const singleTrunc = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4000",
        "--contract",
        "market",
        "--pages",
        "1",
      ],
      deps: { config: fakeConfig(), server: singleLedgerTruncatedServer, progress: () => {} },
    });
    assert.equal(singleTrunc.report.completeness.complete, false);
    assert.equal(singleTrunc.report.completeness.targets[0].observedRange, null);
    assert.deepEqual(singleTrunc.report.completeness.unresolvedGaps, [
      {
        source: "market",
        from: 4000,
        to: 4000,
        count: 1,
        reason: "truncated-page-budget",
      },
    ]);
  });
});

test("records beyond-chain-tip, cursor-start, and mid-walk RPC failure gaps accurately and enforces --require-complete", async () => {
  await withTempDataDir(async (tmp) => {
    const certPath = tmp.file("incomplete-cert.json");
    const tipServer = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        return { events: [], cursor: makeCursor(5000, 1), latestLedger: 5000 };
      },
    };

    // 1. --to 6000 beyond chain tip 5000 with --require-complete exits 1 and writes cert
    const beyondTip = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "6000",
        "--contract",
        "market",
        "--certificate",
        certPath,
        "--require-complete",
      ],
      deps: { config: fakeConfig(), server: tipServer, progress: () => {} },
    });
    assert.equal(beyondTip.exitCode, 1);
    const writtenBeyond = JSON.parse(await readFile(certPath, "utf8"));
    assert.equal(writtenBeyond.complete, false);
    assert.deepEqual(writtenBeyond.targets[0].observedRange, {
      from: 4000,
      to: 5000,
      count: 1001,
    });
    assert.deepEqual(writtenBeyond.unresolvedGaps, [
      {
        source: "market",
        from: 5001,
        to: 6000,
        count: 1000,
        reason: "beyond-chain-tip",
      },
    ]);

    // 2. Mid-ledger TOID cursor start
    const midCursorRun = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        makeCursor(4000, 2, 0),
        "--to",
        "5000",
        "--contract",
        "market",
      ],
      deps: { config: fakeConfig(), server: tipServer, progress: () => {} },
    });
    assert.equal(midCursorRun.report.completeness.complete, false);
    assert.deepEqual(midCursorRun.report.completeness.targets[0].observedRange, {
      from: 4001,
      to: 5000,
      count: 1000,
    });
    assert.deepEqual(midCursorRun.report.completeness.unresolvedGaps, [
      {
        source: "market",
        from: 4000,
        to: 4000,
        count: 1,
        reason: "partial-cursor-start",
      },
    ]);

    // 3. Opaque non-TOID cursor start
    const opaqueRun = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "opaque-cursor-token",
        "--to",
        "5000",
        "--contract",
        "market",
      ],
      deps: { config: fakeConfig(), server: tipServer, progress: () => {} },
    });
    assert.equal(opaqueRun.report.completeness.complete, false);
    assert.equal(opaqueRun.report.completeness.unresolvedGaps[0].reason, "opaque-cursor-start");

    // 4. Mid-walk RPC failure after page 1 committed via --progress-file
    const failProgressPath = tmp.file("fail-progress.json");
    let failCalls = 0;
    const failingPage2Server = {
      async getHealth() {
        return { status: "healthy", oldestLedger: 3000, latestLedger: 5000 };
      },
      async getEvents() {
        failCalls += 1;
        if (failCalls === 1) {
          return { events: [], cursor: makeCursor(4200, 1), latestLedger: 5000 };
        }
        throw new Error("upstream RPC socket reset");
      },
    };

    const failedRun = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--progress-file",
        failProgressPath,
      ],
      deps: { config: fakeConfig(), server: failingPage2Server, progress: () => {} },
    });
    assert.equal(failedRun.exitCode, 1);
    assert.equal(failedRun.report.completeness.complete, false);
    assert.deepEqual(failedRun.report.completeness.targets[0].observedRange, {
      from: 4000,
      to: 4200,
      count: 201,
    });
    assert.deepEqual(failedRun.report.completeness.unresolvedGaps, [
      {
        source: "market",
        from: 4201,
        to: 5000,
        count: 800,
        reason: "scan-failed",
      },
    ]);
  });
});
