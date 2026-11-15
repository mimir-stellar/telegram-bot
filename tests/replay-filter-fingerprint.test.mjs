/**
 * Tests for Issue #789: reject replay progress files created for a different filter set.
 *
 * Covered:
 *   - Normalized filter fingerprint determinism across order, case, duplicates, and whitespace
 *   - Seamless resume when equivalent filters are passed in different order/casing
 *   - Actionable rejection (exit 2, progress file untouched) on changed --event, --category,
 *     notificationCategories, featureFlags, or --contract
 *   - Legacy unfiltered v1 progress file compatibility (resumes unfiltered, rejects new filters)
 *   - Tampered / malformed filterFingerprint detection
 *   - Functional event, category, and feature-flag filtering during replay
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  computeReplayFilterFingerprint,
  normalizeReplayFilterSet,
  runReplayCli,
} from "../dist/stellar/replay.js";
import {
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  claimChallengedEvent,
  claimCreatedEvent,
  claimResolvedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeCursor(ledger, txIndex = 1, opIndex = 0) {
  const toid = (BigInt(ledger) << 32n) | BigInt(txIndex);
  return `${toid}-${opIndex}`;
}

function fakeBotConfig(overrides = {}) {
  return {
    botToken: "fake-bot",
    telegramChatId: "-1001234567890",
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

async function captureConsoleError(fn) {
  const errors = [];
  const origError = console.error;
  console.error = (...args) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = origError;
  }
}

test("normalizeReplayFilterSet and computeReplayFilterFingerprint canonicalize order, case, and duplicates", () => {
  const f1 = normalizeReplayFilterSet({
    contracts: ["squad", "market", "squad"],
    eventNames: [" CLAIM_RESOLVED , claim_created ", "CLAIM_CREATED"],
    categories: ["Sports, CRYPTO", "sports"],
    featureFlags: { enabled: true, market: true, squad: false },
  });
  const f2 = normalizeReplayFilterSet({
    contracts: ["market", "squad"],
    eventNames: ["claim_created", "claim_resolved"],
    categories: ["crypto", "sports"],
    featureFlags: { enabled: true, market: true, squad: false },
  });

  assert.deepEqual(f1, f2);
  const fp1 = computeReplayFilterFingerprint(f1);
  const fp2 = computeReplayFilterFingerprint(f2);
  assert.equal(fp1, fp2);
  assert.match(fp1, /^sha256:[0-9a-f]{64}$/);

  const changedCategoryFp = computeReplayFilterFingerprint(
    normalizeReplayFilterSet({
      ...f2,
      categories: ["crypto"],
    }),
  );
  assert.notEqual(fp1, changedCategoryFp);
});

test("equivalent filters in different order and casing resume cleanly with matching filterFingerprint", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");
    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const c3 = makeCursor(4300, 1);

    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 1, category: "crypto", id: c1 });
    const ev2 = claimChallengedEvent({ ledger: 4150, claimId: 1, id: makeCursor(4150, 1) });
    const ev3 = claimResolvedEvent({ ledger: 4250, claimId: 1, id: c3 });

    const health = { oldestLedger: 4000, latestLedger: 5000 };
    const sent = [];

    const run1 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--event",
        "CLAIM_RESOLVED, claim_created",
        "--category",
        "Sports, CRYPTO",
        "--pages",
        "1",
        "--send",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [
            { events: [ev1, ev2], cursor: c2, latestLedger: 5000 },
            { events: [ev3], cursor: c3, latestLedger: 5000 },
          ],
        }),
        send: async (text) => {
          sent.push(text);
        },
        progress: () => {},
      },
    });

    assert.equal(run1.exitCode, 0);
    assert.equal(sent.length, 1); // ev1 sent, ev2 skipped by event-filter
    assert.equal(run1.report.targets[0].skipped, 1);

    const savedAfterRun1 = JSON.parse(await readFile(progressFile, "utf8"));
    assert.match(savedAfterRun1.filterFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(savedAfterRun1.filters.eventNames, ["claim_created", "claim_resolved"]);
    assert.deepEqual(savedAfterRun1.filters.categories, ["crypto", "sports"]);

    // Resume with reordered lowercase flags
    const run2 = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--event",
        "claim_created,claim_resolved",
        "--category",
        "crypto,sports",
        "--send",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev3], cursor: "", latestLedger: 5000 }],
        }),
        send: async (text) => {
          sent.push(text);
        },
        progress: () => {},
      },
    });

    assert.equal(run2.exitCode, 0);
    assert.equal(sent.length, 2);
    assert.equal(run2.report.totals.sent, 2);
    assert.equal(run2.report.totals.skipped, 1);
  });
});

test("incompatible resume attempts are rejected with actionable diagnostics and preserve the progress file", async () => {
  await withTempDataDir(async (tmp) => {
    const progressFile = tmp.file("progress.json");
    const c1 = makeCursor(4100, 1);
    const c2 = makeCursor(4200, 1);
    const ev1 = claimCreatedEvent({ ledger: 4100, claimId: 10, category: "crypto", id: c1 });
    const health = { oldestLedger: 4000, latestLedger: 5000 };

    const init = await runReplayCli({
      argv: [
        "node",
        "replay-cli.ts",
        "--from",
        "4000",
        "--to",
        "5000",
        "--contract",
        "market",
        "--event",
        "claim_created,claim_resolved",
        "--category",
        "crypto",
        "--pages",
        "1",
        "--progress-file",
        progressFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [ev1], cursor: c2, latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });
    assert.equal(init.exitCode, 0);
    const originalBytes = await readFile(progressFile, "utf8");

    // 1. Different --event set
    const diffEvent = await captureConsoleError(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "5000",
          "--contract",
          "market",
          "--event",
          "claim_created",
          "--category",
          "crypto",
          "--progress-file",
          progressFile,
        ],
        deps: {
          config: fakeBotConfig(),
          server: makeServer(health, {}),
          progress: () => {},
        },
      }),
    );
    assert.equal(diffEvent.result.exitCode, 2);
    assert.equal(diffEvent.result.report, null);
    assert.match(diffEvent.errors.join("\n"), /different filter set: events/i);
    assert.match(diffEvent.errors.join("\n"), /--progress-file/);
    assert.equal(await readFile(progressFile, "utf8"), originalBytes);

    // 2. Different --category set
    const diffCategory = await captureConsoleError(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "5000",
          "--contract",
          "market",
          "--event",
          "claim_created,claim_resolved",
          "--category",
          "politics",
          "--progress-file",
          progressFile,
        ],
        deps: {
          config: fakeBotConfig(),
          server: makeServer(health, {}),
          progress: () => {},
        },
      }),
    );
    assert.equal(diffCategory.result.exitCode, 2);
    assert.match(diffCategory.errors.join("\n"), /different filter set: categories/i);
    assert.equal(await readFile(progressFile, "utf8"), originalBytes);

    // 3. Different featureFlags (e.g. NOTIFY_MARKET=false)
    const diffFlags = await captureConsoleError(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "5000",
          "--contract",
          "market",
          "--event",
          "claim_created,claim_resolved",
          "--category",
          "crypto",
          "--progress-file",
          progressFile,
        ],
        deps: {
          config: fakeBotConfig({
            featureFlags: { enabled: true, market: false, squad: true },
          }),
          server: makeServer(health, {}),
          progress: () => {},
        },
      }),
    );
    assert.equal(diffFlags.result.exitCode, 2);
    assert.match(diffFlags.errors.join("\n"), /different filter set: featureFlags/i);
    assert.equal(await readFile(progressFile, "utf8"), originalBytes);

    // 4. Different --contract scope (both contracts instead of market)
    const diffContract = await captureConsoleError(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "5000",
          "--event",
          "claim_created,claim_resolved",
          "--category",
          "crypto",
          "--progress-file",
          progressFile,
        ],
        deps: {
          config: fakeBotConfig(),
          server: makeServer(health, {}),
          progress: () => {},
        },
      }),
    );
    assert.equal(diffContract.result.exitCode, 2);
    assert.match(diffContract.errors.join("\n"), /different filter set: contracts/i);
    assert.equal(await readFile(progressFile, "utf8"), originalBytes);
  });
});

test("legacy unfiltered v1 progress files resume unfiltered runs but reject newly added filters and tampered fingerprints", async () => {
  await withTempDataDir(async (tmp) => {
    const legacyFile = tmp.file("legacy-progress.json");
    const legacyPayload = {
      format: "mimir-replay-progress-v1",
      version: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      network: "testnet",
      rpcUrl: "http://fake-rpc.invalid",
      range: { from: "4000", to: 5000 },
      contracts: ["market"],
      targets: {
        market: {
          contractId: MARKET_CONTRACT,
          cursor: makeCursor(4200, 1),
          lastEventLedger: 4200,
          lastProcessedEventId: makeCursor(4200, 1),
          recentEventIds: [makeCursor(4200, 1)],
          pagesProcessed: 1,
          eventsProcessed: 1,
          eventsSent: 1,
          eventsSkipped: 0,
          eventsCapped: 0,
          adminLogged: 0,
          duplicates: 0,
          completed: false,
        },
      },
    };
    await writeFile(legacyFile, JSON.stringify(legacyPayload, null, 2), "utf8");

    const health = { oldestLedger: 4000, latestLedger: 5000 };

    // Rejects adding --category when legacy progress file was created unfiltered
    const rejected = await captureConsoleError(() =>
      runReplayCli({
        argv: [
          "node",
          "replay-cli.ts",
          "--from",
          "4000",
          "--to",
          "5000",
          "--contract",
          "market",
          "--category",
          "sports",
          "--progress-file",
          legacyFile,
        ],
        deps: {
          config: fakeBotConfig(),
          server: makeServer(health, {}),
          progress: () => {},
        },
      }),
    );
    assert.equal(rejected.result.exitCode, 2);
    assert.match(rejected.errors.join("\n"), /different filter set: categories/i);

    // Resumes cleanly when unfiltered
    const resumed = await runReplayCli({
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
        legacyFile,
      ],
      deps: {
        config: fakeBotConfig(),
        server: makeServer(health, {
          [MARKET_CONTRACT]: [{ events: [], cursor: "", latestLedger: 5000 }],
        }),
        progress: () => {},
      },
    });
    assert.equal(resumed.exitCode, 0);

    // Tamper with filterFingerprint so it disagrees with recorded filters
    const upgraded = JSON.parse(await readFile(legacyFile, "utf8"));
    upgraded.filterFingerprint = `sha256:${"0".repeat(64)}`;
    await writeFile(legacyFile, JSON.stringify(upgraded, null, 2), "utf8");

    const tampered = await captureConsoleError(() =>
      runReplayCli({
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
          legacyFile,
        ],
        deps: {
          config: fakeBotConfig(),
          server: makeServer(health, {}),
          progress: () => {},
        },
      }),
    );
    assert.equal(tampered.result.exitCode, 2);
    assert.match(tampered.errors.join("\n"), /filterFingerprint .* does not match its recorded filters/i);
  });
});

test("category and feature-flag filters skip non-matching events with distinct skipReasons", async () => {
  const c1 = makeCursor(4100, 1);
  const c2 = makeCursor(4101, 1);
  const evCrypto = claimCreatedEvent({ ledger: 4100, claimId: 1, category: "crypto", id: c1 });
  const evSports = claimCreatedEvent({ ledger: 4101, claimId: 2, category: "sports", id: c2 });
  const health = { oldestLedger: 4000, latestLedger: 5000 };

  const categoryRun = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "5000",
      "--contract",
      "market",
      "--category",
      "sports",
      "--show",
      "10",
    ],
    deps: {
      config: fakeBotConfig(),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [{ events: [evCrypto, evSports], cursor: "", latestLedger: 5000 }],
      }),
      progress: () => {},
    },
  });

  assert.equal(categoryRun.exitCode, 0);
  assert.equal(categoryRun.report.totals.sent, 1);
  assert.equal(categoryRun.report.totals.skipped, 1);
  const log = categoryRun.report.targets[0].eventLog;
  assert.equal(log[0].skipReason, "category-filter");
  assert.equal(log[1].sent, true);

  const disabledFlagRun = await runReplayCli({
    argv: [
      "node",
      "replay-cli.ts",
      "--from",
      "4000",
      "--to",
      "5000",
      "--contract",
      "market",
      "--show",
      "10",
    ],
    deps: {
      config: fakeBotConfig({
        featureFlags: { enabled: false, market: true, squad: true },
      }),
      server: makeServer(health, {
        [MARKET_CONTRACT]: [{ events: [evSports], cursor: "", latestLedger: 5000 }],
      }),
      progress: () => {},
    },
  });

  assert.equal(disabledFlagRun.exitCode, 0);
  assert.equal(disabledFlagRun.report.totals.sent, 0);
  assert.equal(disabledFlagRun.report.totals.skipped, 1);
  assert.equal(disabledFlagRun.report.targets[0].eventLog[0].skipReason, "feature-flag");
});
