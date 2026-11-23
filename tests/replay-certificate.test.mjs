/**
 * Tests for Issue #792: deterministic replay completeness certificate.
 *
 * Covered:
 *   - Complete range produces complete=true, empty gaps, matching ranges, and deterministic digest
 *   - Pruned range (--from below oldestLedger) is never marked complete and records pruned-history gap
 *   - Partial/truncated range (--pages limit hit) is never marked complete and records truncated-pages gap
 *   - Beyond-tip range (--to above latestLedger) is never marked complete and records beyond-tip gap
 *   - RPC scan error is never marked complete and records scan-error gap
 *   - Resumed replay preserves pruned status from initial checkpoint (never marks pruned range complete)
 *   - --certificate-file writes deterministic mimir-replay-certificate-v1 JSON atomically
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runReplayCli } from "../dist/stellar/replay.js";
import { MARKET_CONTRACT, SQUAD_CONTRACT } from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

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

function makeServer(health, pagesByContract = {}) {
  const indices = {};
  return {
    async getHealth() {
      return {
        status: "healthy",
        oldestLedger: health.oldestLedger ?? 1,
        latestLedger: health.latestLedger ?? 5000,
      };
    },
    async getEvents(req) {
      const contractId = req?.filters?.[0]?.contractIds?.[0] ?? "";
      const pages = pagesByContract[contractId] ?? [];
      const idx = indices[contractId] ?? 0;
      const page = pages[idx] ?? {
        events: [],
        cursor: "",
        latestLedger: health.latestLedger ?? 5000,
      };
      indices[contractId] = idx + 1;
      return {
        events: Array.isArray(page.events) ? page.events : [],
        cursor: page.cursor ?? "",
        latestLedger: page.latestLedger ?? health.latestLedger ?? 5000,
      };
    },
  };
}

test("complete replay produces deterministic certificate with empty gaps", async () => {
  const health = { oldestLedger: 3000, latestLedger: 5000 };
  const makeArgs = () => ({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "4500", "--contract", "market"],
    deps: {
      config: fakeConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [{ events: [], cursor: makeCursor(4501), latestLedger: 5000 }],
      }),
      progress: () => {},
    },
  });

  const run1 = await runReplayCli(makeArgs());
  const run2 = await runReplayCli(makeArgs());

  assert.equal(run1.exitCode, 0);
  assert.ok(run1.report?.certificate);
  const cert1 = run1.report.certificate;
  const cert2 = run2.report.certificate;

  assert.equal(cert1.format, "mimir-replay-certificate-v1");
  assert.equal(cert1.version, 1);
  assert.equal(cert1.complete, true);
  assert.deepEqual(cert1.requestedRange, { from: "4000", fromLedger: 4000, toLedger: 4500 });
  assert.deepEqual(cert1.observedRange, { fromLedger: 4000, toLedger: 4500 });
  assert.deepEqual(cert1.gaps, []);
  assert.equal(cert1.targets.length, 1);
  assert.equal(cert1.targets[0].pruned, false);
  assert.equal(cert1.targets[0].partial, false);

  // Determinism: identical inputs produce identical JSON and digest
  assert.equal(cert1.digest, cert2.digest);
  assert.equal(JSON.stringify(cert1), JSON.stringify(cert2));
});

test("pruned range (--from below oldestLedger) is never marked complete", async () => {
  const health = { oldestLedger: 4200, latestLedger: 5000 };
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "4500", "--contract", "market"],
    deps: {
      config: fakeConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [{ events: [], cursor: makeCursor(4501), latestLedger: 5000 }],
      }),
      progress: () => {},
    },
  });

  assert.equal(exitCode, 0);
  const cert = report.certificate;
  assert.equal(cert.complete, false);
  assert.deepEqual(cert.requestedRange, { from: "4000", fromLedger: 4000, toLedger: 4500 });
  assert.deepEqual(cert.observedRange, { fromLedger: 4200, toLedger: 4500 });
  assert.equal(cert.targets[0].pruned, true);
  assert.equal(cert.targets[0].complete, false);
  assert.equal(cert.gaps.length, 1);
  assert.equal(cert.gaps[0].kind, "pruned-history");
  assert.equal(cert.gaps[0].fromLedger, 4000);
  assert.equal(cert.gaps[0].toLedger, 4199);
});

test("partial range (--pages limit reached) is never marked complete", async () => {
  const health = { oldestLedger: 3000, latestLedger: 5000 };
  const { report, exitCode } = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "4800",
      "--pages",
      "1",
      "--contract",
      "market",
    ],
    deps: {
      config: fakeConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [
          { events: [], cursor: makeCursor(4200), latestLedger: 5000 },
          { events: [], cursor: makeCursor(4801), latestLedger: 5000 },
        ],
      }),
      progress: () => {},
    },
  });

  assert.equal(exitCode, 0);
  const cert = report.certificate;
  assert.equal(cert.complete, false);
  assert.deepEqual(cert.requestedRange, { from: "4000", fromLedger: 4000, toLedger: 4800 });
  assert.deepEqual(cert.observedRange, { fromLedger: 4000, toLedger: 4200 });
  assert.equal(cert.targets[0].partial, true);
  assert.equal(cert.targets[0].complete, false);
  assert.equal(cert.gaps.length, 1);
  assert.equal(cert.gaps[0].kind, "truncated-pages");
  assert.equal(cert.gaps[0].fromLedger, 4201);
  assert.equal(cert.gaps[0].toLedger, 4800);
});

test("beyond-tip range (--to above latestLedger) is never marked complete", async () => {
  const health = { oldestLedger: 3000, latestLedger: 5000 };
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "6000", "--contract", "market"],
    deps: {
      config: fakeConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [{ events: [], cursor: makeCursor(5000), latestLedger: 5000 }],
      }),
      progress: () => {},
    },
  });

  assert.equal(exitCode, 0);
  const cert = report.certificate;
  assert.equal(cert.complete, false);
  assert.deepEqual(cert.observedRange, { fromLedger: 4000, toLedger: 5000 });
  assert.equal(cert.gaps.length, 1);
  assert.equal(cert.gaps[0].kind, "beyond-tip");
  assert.equal(cert.gaps[0].fromLedger, 5001);
  assert.equal(cert.gaps[0].toLedger, 6000);
});

test("RPC scan failure records scan-error gap and complete=false", async () => {
  const { report, exitCode } = await runReplayCli({
    argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "4500", "--contract", "market"],
    deps: {
      config: fakeConfig(),
      server: {
        async getHealth() {
          throw new Error("RPC connection refused");
        },
        async getEvents() {
          throw new Error("unreachable");
        },
      },
      progress: () => {},
    },
  });

  assert.equal(exitCode, 1);
  const cert = report.certificate;
  assert.equal(cert.complete, false);
  assert.deepEqual(cert.observedRange, { fromLedger: null, toLedger: null });
  assert.equal(cert.gaps.length, 1);
  assert.equal(cert.gaps[0].kind, "scan-error");
});

test("resumed replay preserves pruned status and writes --certificate-file", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");
    const certFile = tmp.file("certificate.json");
    const health = { oldestLedger: 4200, latestLedger: 5000 };

    // Run 1: pruned & truncated after 1 page
    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4800",
        "--pages",
        "1",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [], cursor: makeCursor(4400), latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });
    assert.equal(run1.exitCode, 0);
    assert.equal(run1.report.certificate.complete, false);

    // Run 2: resume to completion of remaining pages, write --certificate-file
    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4800",
        "--contract",
        "market",
        "--progress-file",
        progressFile,
        "--certificate-file",
        certFile,
      ],
      deps: {
        config: fakeConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [], cursor: makeCursor(4801), latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, 0);
    const cert2 = run2.report.certificate;
    assert.equal(cert2.complete, false);
    assert.equal(cert2.targets[0].pruned, true);
    assert.equal(cert2.gaps.length, 1);
    assert.equal(cert2.gaps[0].kind, "pruned-history");

    const diskCert = JSON.parse(await readFile(certFile, "utf8"));
    assert.deepEqual(diskCert, cert2);
  });
});
