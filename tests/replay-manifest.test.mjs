/**
 * Tests for Issue #787: add a signed-off replay manifest before sending historical notifications.
 *
 * Covered:
 *   - Deterministic SHA-256 plan digest over range, contracts, and Telegram destinations
 *   - Preview (--manifest-out) -> signed-off delivery (--send --manifest / --approve-plan)
 *   - Unapproved --send refused before RPC or Telegram notifier initialization
 *   - Range, destination, contract, and cap changes rejected when switching from preview to delivery
 *   - Manifest tampering, missing destinations, and --manifest-out + --send bypass rejected
 *   - Bot token never written to manifest files
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  computeReplayPlanDigest,
  loadAndValidateManifestFile,
  runReplayCli,
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

function fakeBotConfig(overrides = {}) {
  return {
    botToken: "fake-bot",
    chatId: "-1001234567890",
    chatIds: ["-1001234567890"],
    marketChatId: "-1001111111111",
    squadChatId: "-1002222222222",
    marketContractId: MARKET_CONTRACT,
    squadContractId: SQUAD_CONTRACT,
    rpcUrl: "http://fake-rpc.invalid",
    horizonUrl: "http://fake-horizon.invalid",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://stellar.expert/explorer",
    maxNotificationsPerCycle: 20,
    dedupWindow: 256,
    ...overrides,
  };
}

function makeServer(health, pagesByContract = {}, tracker = { calls: 0 }) {
  const indices = {};
  return {
    async getHealth() {
      tracker.calls += 1;
      return {
        status: "healthy",
        oldestLedger: health.oldestLedger ?? 1,
        latestLedger: health.latestLedger ?? 5000,
      };
    },
    async getEvents(req) {
      tracker.calls += 1;
      const contractId = req?.filters?.[0]?.contractIds?.[0] ?? "";
      const pages = pagesByContract[contractId] ?? [];
      const idx = indices[contractId] ?? 0;
      const page = pages[idx] ?? { events: [], cursor: "", latestLedger: health.latestLedger ?? 5000 };
      indices[contractId] = idx + 1;
      return {
        events: Array.isArray(page.events) ? page.events : [],
        cursor: page.cursor ?? "",
        latestLedger: page.latestLedger ?? health.latestLedger ?? 5000,
      };
    },
  };
}

async function captureStderr(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, stderr: errors.join("\n") };
  } finally {
    console.error = orig;
  }
}

test("computeReplayPlanDigest produces a deterministic digest sensitive to range and destinations", () => {
  const baseA = {
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    range: { from: " 4226500 ", to: 4226800 },
    cap: 20,
    targets: [
      { source: "squad", contractId: SQUAD_CONTRACT, destinationChatId: " -1002222222222 " },
      { source: "market", contractId: MARKET_CONTRACT, destinationChatId: "-1001111111111" },
    ],
  };
  const baseB = {
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    range: { from: "4226500", to: 4226800 },
    cap: 20,
    targets: [
      { source: "market", contractId: MARKET_CONTRACT, destinationChatId: "-1001111111111" },
      { source: "squad", contractId: SQUAD_CONTRACT, destinationChatId: "-1002222222222" },
    ],
  };

  const digestA = computeReplayPlanDigest(baseA);
  const digestB = computeReplayPlanDigest(baseB);
  assert.equal(digestA, digestB);
  assert.match(digestA, /^sha256:[0-9a-f]{64}$/);

  const changedRange = computeReplayPlanDigest({
    ...baseB,
    range: { from: "4226500", to: 4226801 },
  });
  assert.notEqual(digestA, changedRange);

  const changedDestination = computeReplayPlanDigest({
    ...baseB,
    targets: [
      { source: "market", contractId: MARKET_CONTRACT, destinationChatId: "-1009999999999" },
      { source: "squad", contractId: SQUAD_CONTRACT, destinationChatId: "-1002222222222" },
    ],
  });
  assert.notEqual(digestA, changedDestination);
});

test("preview --manifest-out writes deterministic manifest and allows matching --send delivery", async () => {
  await withTempDataDir(async (tmp) => {
    const manifestPath = tmp.file("replay-manifest.json");
    const c1 = makeCursor(4100, 1);
    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 501, id: c1 });
    const health = { oldestLedger: 4000, latestLedger: 5000 };
    const cfg = fakeBotConfig();

    // 1. Dry-run preview writes manifest
    const preview = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4500",
        "--contract",
        "market",
        "--manifest-out",
        manifestPath,
      ],
      deps: {
        config: cfg,
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1], cursor: "", latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });

    assert.equal(preview.exitCode, 0);
    assert.ok(existsSync(manifestPath));

    const manifestRaw = await readFile(manifestPath, "utf8");
    assert.doesNotMatch(manifestRaw, /fake-bot/, "manifest must never persist botToken");
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.format, "mimir-replay-manifest-v1");
    assert.equal(manifest.planDigest, preview.report.planDigest);
    assert.equal(manifest.preview.wouldSend, 1);
    assert.deepEqual(manifest.plan.targets, [
      {
        source: "market",
        contractId: MARKET_CONTRACT,
        destinationChatId: "-1001111111111",
      },
    ]);

    // 2. Delivery with matching --manifest dispatches notification
    const delivered = [];
    const sendWithManifest = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4500",
        "--contract",
        "market",
        "--send",
        "--manifest",
        manifestPath,
      ],
      deps: {
        config: cfg,
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1], cursor: "", latestLedger: 5000 }],
        }),
        send: async (text, source) => {
          delivered.push({ text, source });
        },
        requireManifest: true,
        progress: () => {},
      },
    });

    assert.equal(sendWithManifest.exitCode, 0);
    assert.equal(sendWithManifest.report.planDigest, manifest.planDigest);
    assert.equal(delivered.length, 1);

    // 3. Delivery with matching --approve-plan digest also succeeds
    const sendWithDigest = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4500",
        "--contract",
        "market",
        "--send",
        "--approve-plan",
        manifest.planDigest,
      ],
      deps: {
        config: cfg,
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1], cursor: "", latestLedger: 5000 }],
        }),
        send: async (text, source) => {
          delivered.push({ text, source });
        },
        requireManifest: true,
        progress: () => {},
      },
    });

    assert.equal(sendWithDigest.exitCode, 0);
    assert.equal(delivered.length, 2);
  });
});

test("refuses unapproved --send and rejects range or destination drift when switching from preview to delivery", async () => {
  await withTempDataDir(async (tmp) => {
    const manifestPath = tmp.file("manifest.json");
    const health = { oldestLedger: 4000, latestLedger: 5000 };
    const cfg = fakeBotConfig();

    // Generate valid preview manifest for 4000..4500 -> marketChatId -1001111111111
    const preview = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "4500",
        "--contract",
        "market",
        "--manifest-out",
        manifestPath,
      ],
      deps: {
        config: cfg,
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [], cursor: "", latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });
    assert.equal(preview.exitCode, 0);

    // 1. Unapproved CLI --send (no deps.send injected!) refuses before touching RPC or grammy
    const rpcTracker = { calls: 0 };
    const unapproved = await captureStderr(() =>
      runReplayCli({
        argv: ["node", "replay-cli.ts", "--from", "4000", "--to", "4500", "--contract", "market", "--send"],
        deps: {
          config: cfg,
          server: makeServer(health, {}, rpcTracker),
          progress: () => {},
        },
      }),
    );
    assert.equal(unapproved.result.exitCode, 2);
    assert.equal(unapproved.result.report, null);
    assert.equal(rpcTracker.calls, 0, "unapproved --send must not query RPC");
    assert.match(unapproved.stderr, /requires a signed-off replay manifest/i);
    assert.match(unapproved.stderr, new RegExp(preview.report.planDigest));

    // 2. Changed ledger range (--to 4600 instead of 4500) rejected
    let sendCalls = 0;
    const rangeMismatch = await captureStderr(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "4600",
          "--contract",
          "market",
          "--send",
          "--manifest",
          manifestPath,
        ],
        deps: {
          config: cfg,
          server: makeServer(health, {}, rpcTracker),
          send: async () => {
            sendCalls += 1;
          },
          progress: () => {},
        },
      }),
    );
    assert.equal(rangeMismatch.result.exitCode, 2);
    assert.equal(sendCalls, 0);
    assert.equal(rpcTracker.calls, 0);
    assert.match(rangeMismatch.stderr, /range \(4000\.\.4500 vs 4000\.\.4600\)/);

    // 3. Changed destination chat ID (-1009999999999 instead of -1001111111111) rejected
    const destMismatch = await captureStderr(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "4500",
          "--contract",
          "market",
          "--send",
          "--manifest",
          manifestPath,
        ],
        deps: {
          config: fakeBotConfig({ marketChatId: "-1009999999999" }),
          server: makeServer(health, {}, rpcTracker),
          send: async () => {
            sendCalls += 1;
          },
          progress: () => {},
        },
      }),
    );
    assert.equal(destMismatch.result.exitCode, 2);
    assert.equal(sendCalls, 0);
    assert.match(destMismatch.stderr, /destinations\/targets/);

    // 4. Combining --manifest-out and --send in one run is rejected (no self-sign-off bypass)
    const selfSignBypass = await captureStderr(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "4500",
          "--manifest-out",
          tmp.file("bypass.json"),
          "--send",
        ],
        deps: { config: cfg, progress: () => {} },
      }),
    );
    assert.equal(selfSignBypass.result.exitCode, 2);
    assert.match(selfSignBypass.stderr, /--manifest-out can only be used in preview/i);

    // 5. --manifest-out without configured destinations rejects upfront
    const missingDestPreview = await captureStderr(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "4500",
          "--manifest-out",
          tmp.file("no-dest.json"),
        ],
        deps: {
          config: fakeBotConfig({
            chatId: "",
            chatIds: [],
            marketChatId: "",
            squadChatId: "",
          }),
          server: makeServer(health, {}, rpcTracker),
          progress: () => {},
        },
      }),
    );
    assert.equal(missingDestPreview.result.exitCode, 2);
    assert.equal(rpcTracker.calls, 0);
    assert.match(missingDestPreview.stderr, /requires configured Telegram destination chat IDs/i);

    // 6. Tampered manifest file fails integrity verification
    const tamperedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    tamperedManifest.plan.range.to = 4999;
    const tamperedPath = tmp.file("tampered-manifest.json");
    await writeFile(tamperedPath, JSON.stringify(tamperedManifest, null, 2), "utf8");

    await assert.rejects(
      () => loadAndValidateManifestFile(tamperedPath),
      /failed integrity check/,
    );
  });
});
