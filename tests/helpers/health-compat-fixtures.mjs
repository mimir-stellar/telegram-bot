/**
 * Deterministic inputs for versioned `HealthReport` compatibility fixtures.
 *
 * Uses injected `ConfigProvenance`, synthetic `CFIXTURE...` contract IDs, and a
 * fixed UTC timestamp so `buildHealthReport` produces byte-identical output on
 * every machine regardless of `process.env` or local `.env` files.
 */

import { buildHealthReport } from "../../dist/health.js";

export const FIXTURE_NOW_MS = Date.UTC(2026, 9, 17, 12, 0, 0);
export const FIXTURE_MARKET_ID = "CFIXTUREMARKET0000000000000000000000000000000000000000000000";
export const FIXTURE_SQUAD_ID = "CFIXTURESQUAD00000000000000000000000000000000000000000000000";

export const DETERMINISTIC_PROVENANCE = {
  profile: "mock",
  envFile: { present: false, suppliedKeys: 0 },
  entries: [
    { key: "BOT_TOKEN", source: "process-env", secret: true },
    { key: "CHAT_ID", source: "process-env", secret: true, derivedFrom: "TELEGRAM_CHAT_ID" },
    { key: "POLL_INTERVAL_MS", source: "built-in-default", secret: false, emptyDeclaration: true },
    { key: "SOROBAN_RPC_URL", source: "profile-default", secret: false },
  ],
  counts: {
    "process-env": 2,
    "env-file": 0,
    "profile-default": 1,
    "built-in-default": 1,
    derived: 0,
    unset: 0,
  },
  warnings: [],
};

export function fixtureConfig(overrides = {}) {
  return {
    version: "0.1.0",
    marketContractId: FIXTURE_MARKET_ID,
    squadContractId: FIXTURE_SQUAD_ID,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: ["0000000000:FIXTURE", "-PLACEHOLDER"].join(""),
    chatIds: ["-1001234567890"],
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: "/nonexistent/cursor.json",
    maxNotificationsPerCycle: 20,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    ...overrides,
  };
}

function fixtureTarget(source, overrides = {}) {
  return {
    source,
    contractId: source === "market" ? FIXTURE_MARKET_ID : FIXTURE_SQUAD_ID,
    version: "v1",
    lastCycleMs: 0,
    maxCycleMs: 0,
    cursor: null,
    lastEventLedger: null,
    rewindFromLedger: null,
    cursorStale: false,
    gapLedgers: 0,
    cursorResetAt: null,
    cursorUnreadable: false,
    lastError: null,
    cyclesWithoutAdvance: 0,
    cursorStalled: false,
    consecutiveFailures: 0,
    nextEligibleAt: null,
    ...overrides,
  };
}

export function coldStartPollerStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    chainClockAt: null,
    startedAt: FIXTURE_NOW_MS - 2_000,
    cycles: 0,
    lastCorrelationId: null,
    lastPollAt: null,
    lastSuccessAt: null,
    latestLedger: null,
    oldestLedger: null,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    emptyPages: 0,
    pagesScanned: 0,
    lastCycleEmptyPages: 0,
    lastCyclePages: 0,
    notificationsDropped: 0,
    eventsDeduplicated: 0,
    cursorRewinds: 0,
    restartGaps: 0,
    lastRestartGap: null,
    consecutiveFailures: 0,
    lastError: null,
    ledgerCache: { hits: 0, misses: 0 },
    lockFile: null,
    lockPid: null,
    pendingFlush: false,
    lastFlushAt: null,
    suppressedLogs: 0,
    deadLetter: { depth: 0, enqueued: 0, replayed: 0, dropped: 0 },
    persistentVolumeAvailable: true,
    persistentVolumeError: null,
    targets: [fixtureTarget("market"), fixtureTarget("squad")],
    sbomDigest: null,
    circuitBreaker: { open: false, openedAt: null, failureCount: 0, lastFailureAt: null },
    ...overrides,
  };
}

export function healthyPollerStatus() {
  return coldStartPollerStatus({
    startedAt: FIXTURE_NOW_MS - 3_600_000,
    cycles: 120,
    lastCorrelationId: "cycle-120",
    lastPollAt: FIXTURE_NOW_MS - 10_000,
    lastSuccessAt: FIXTURE_NOW_MS - 10_000,
    latestLedger: 5_000,
    oldestLedger: 4_000,
    chainClockAt: FIXTURE_NOW_MS - 12_500,
    notificationsSent: 37,
    eventsSkipped: 2,
    eventsDeduplicated: 3,
    cursorRewinds: 1,
    restartGaps: 1,
    lastRestartGap: {
      at: FIXTURE_NOW_MS - 3_590_000,
      source: "squad",
      cursorLedger: 3_900,
      oldestLedger: 4_000,
      missedLedgers: 100,
    },
    lastFlushAt: FIXTURE_NOW_MS - 10_000,
    deadLetter: { depth: 1, enqueued: 2, replayed: 1, dropped: 0 },
    targets: [
      fixtureTarget("market", {
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_990,
        lastCycleMs: 420,
        maxCycleMs: 1_850,
      }),
      fixtureTarget("squad", {
        version: "v2",
        lastCycleMs: 380,
        maxCycleMs: 2_400,
        cursor: "21474836480-1",
        lastEventLedger: 4_950,
        gapLedgers: 100,
        cursorResetAt: FIXTURE_NOW_MS - 3_590_000,
      }),
    ],
  });
}

export function degradedPollerStatus() {
  return coldStartPollerStatus({
    startedAt: FIXTURE_NOW_MS - 600_000,
    cycles: 40,
    lastCorrelationId: "cycle-40",
    lastPollAt: FIXTURE_NOW_MS - 5_000,
    lastSuccessAt: FIXTURE_NOW_MS - 300_000,
    latestLedger: 5_100,
    oldestLedger: 4_100,
    chainClockAt: FIXTURE_NOW_MS + 4_000,
    notificationsSent: 5,
    notificationsFailed: 4,
    notificationsDropped: 1,
    consecutiveFailures: 10,
    lastError: { at: FIXTURE_NOW_MS - 5_000, message: "getEvents failed: 503 Service Unavailable" },
    suppressedLogs: 6,
    pendingFlush: true,
    lastFlushAt: FIXTURE_NOW_MS - 300_000,
    persistentVolumeAvailable: false,
    persistentVolumeError: "EACCES: data directory is not writable",
    targets: [
      fixtureTarget("market", {
        cursor: "0018276211125911551-4294967295",
        lastEventLedger: 4_990,
        cursorStale: true,
        rewindFromLedger: 4_100,
        lastError: "stale cursor",
        consecutiveFailures: 3,
      }),
      fixtureTarget("squad", {
        cursor: "0017179869184000001-0",
        cursorUnreadable: true,
        cyclesWithoutAdvance: 7,
        cursorStalled: true,
      }),
    ],
  });
}

export function buildDeterministicFixture(status, cfgOverrides = {}) {
  return JSON.parse(
    JSON.stringify(
      buildHealthReport(
        fixtureConfig(cfgOverrides),
        status,
        FIXTURE_NOW_MS,
        DETERMINISTIC_PROVENANCE,
      ),
    ),
  );
}
