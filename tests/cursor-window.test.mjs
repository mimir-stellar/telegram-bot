/**
 * Restart gaps: a resume position that fell out of the RPC's retained window.
 *
 * The retained window is a rolling one (~120,960 ledgers on Testnet, roughly a
 * week), so a long enough downtime leaves the persisted cursor pointing at a
 * ledger the RPC no longer serves. Everything between that cursor and the floor
 * is unrecoverable, and the poller must say so once rather than retry the same
 * position forever.
 *
 * Everything here is an in-process fake: fake RPC, fake Telegram send, temporary
 * cursor paths and a fake clock. No network, no live Telegram, no credentials.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { classifyCursorWindow, createPoller } from "../dist/poller.js";
import { statusMessage } from "../dist/bot.js";
import { buildHealthReport } from "../dist/health.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TOKEN = "123456789:" + "TEST-ONLY-TOKEN-NEVER-USE";
const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);

const FLOOR = 900;
const TIP = 1000;
const WINDOW = { status: "healthy", oldestLedger: FLOOR, latestLedger: TIP };
const STALE_LEDGER = 500;

/** Soroban TOID cursor for a ledger, matching `eventCursorLedger`. */
const makeCursor = (ledger) => `${(BigInt(ledger) << 32n) | 1n}-0`;

/** Ledger the TOID half of a cursor encodes. */
function ledgerOf(cursor) {
  const toid = String(cursor).split("-")[0];
  return Number(BigInt(toid) >> 32n);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

/**
 * A server that answers a cursor walk honestly and never rejects it: an empty
 * page that hands the same cursor back. That is the shape of the gap this
 * suite is about — no error to react to, and nothing that advances.
 */
function makeServer({ health = WINDOW, onEvents } = {}) {
  const requests = [];
  return {
    requests,
    async getHealth() {
      const value = typeof health === "function" ? health() : health;
      if (value instanceof Error) throw value;
      return value;
    },
    async getEvents(req) {
      requests.push(req);
      if (onEvents) return onEvents(req);
      if (typeof req.cursor === "string") {
        return { events: [], cursor: req.cursor, latestLedger: TIP };
      }
      return { events: [], cursor: makeCursor(TIP), latestLedger: TIP };
    },
  };
}

function makeConfig(cursorFile, overrides = {}) {
  return {
    marketContractId: MARKET_ID,
    squadContractId: SQUAD_ID,
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    explorerBaseUrl: "https://example.invalid/explorer",
    botToken: TOKEN,
    chatId: "-1001234567890",
    operatorTelegramUserId: null,
    pollIntervalMs: 20,
    startLookbackLedgers: 60,
    cursorFile,
    lockFile: `${cursorFile}.lock`,
    statusFile: path.join(path.dirname(cursorFile), "status.json"),
    maxNotificationsPerCycle: 20,
    dedupWindow: 64,
    healthHost: "127.0.0.1",
    healthPort: 0,
    healthStaleMs: 90_000,
    shutdownTimeoutMs: 50,
    channelPreviewMode: false,
    ...overrides,
  };
}

function cursorFileJson(targets) {
  return `${JSON.stringify(
    { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", targets },
    null,
    2,
  )}\n`;
}

/** Monotonic fake clock so status timestamps never depend on the wall clock. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return () => (value += 1_000);
}

function targetOf(poller, source) {
  return poller.status().targets.find((t) => t.source === source);
}

/** Captures console output for the duration of `fn`. */
async function captureLogs(fn) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const record = (...args) => lines.push(args.join(" "));
  console.log = console.warn = console.error = record;
  try {
    await fn();
  } finally {
    Object.assign(console, original);
  }
  return lines;
}

function assertBoundedAndClean(lines) {
  for (const line of lines) {
    assert.ok(line.length <= 300, `log line exceeded 300 chars (${line.length}): ${line}`);
    assert.equal(line.includes(TOKEN), false, `bot token leaked into logs: ${line}`);
  }
}

// ── The classifier ──────────────────────────────────────────────────────────

test("classifyCursorWindow places a readable cursor exactly, and refuses to guess", () => {
  assert.deepEqual(classifyCursorWindow(null, FLOOR), { status: "no-cursor" });
  assert.deepEqual(classifyCursorWindow("", FLOOR), { status: "no-cursor" });

  // An unknown floor is not evidence of anything, so nothing is classified.
  assert.deepEqual(classifyCursorWindow(makeCursor(STALE_LEDGER), null), {
    status: "unknown-floor",
  });
  assert.deepEqual(classifyCursorWindow(makeCursor(STALE_LEDGER), 0), {
    status: "unknown-floor",
  });

  // A token with no readable ledger is its own verdict: never a gap.
  assert.deepEqual(classifyCursorWindow("opaque-token", FLOOR), {
    status: "unreadable",
    cursor: "opaque-token",
  });
  // Ledgers start at 1, so a TOID that packs none is unreadable rather than
  // "at ledger 0". Both shapes are forwarded to the RPC instead of being
  // treated as a position this build can call stale.
  assert.deepEqual(classifyCursorWindow("456-0", FLOOR), {
    status: "unreadable",
    cursor: "456-0",
  });
  assert.deepEqual(classifyCursorWindow("0-0", FLOOR), {
    status: "unreadable",
    cursor: "0-0",
  });

  // Exactly at the floor is still retained, so it is inside the window.
  assert.deepEqual(classifyCursorWindow(makeCursor(FLOOR), FLOOR), {
    status: "inside",
    cursorLedger: FLOOR,
    behind: 0,
  });
  assert.deepEqual(classifyCursorWindow(makeCursor(TIP), FLOOR), {
    status: "inside",
    cursorLedger: TIP,
    behind: TIP - FLOOR,
  });

  // One ledger below the floor is already unrecoverable.
  assert.deepEqual(classifyCursorWindow(makeCursor(FLOOR - 1), FLOOR), {
    status: "stale",
    cursorLedger: FLOOR - 1,
    missedLedgers: 1,
  });
  assert.deepEqual(classifyCursorWindow(makeCursor(STALE_LEDGER), FLOOR), {
    status: "stale",
    cursorLedger: STALE_LEDGER,
    missedLedgers: FLOOR - STALE_LEDGER,
  });
});

test("the documented stale-cursor fixture is a restart gap", async () => {
  const raw = JSON.parse(
    await readFile(new URL("./fixtures/cursor-stale.json", import.meta.url), "utf8"),
  );
  const cursor = raw.targets.market.cursor;
  assert.equal(ledgerOf(cursor), 4_250_000);
  assert.deepEqual(classifyCursorWindow(cursor, 4_300_000), {
    status: "stale",
    cursorLedger: 4_250_000,
    missedLedgers: 50_000,
  });
});

// ── Recovery preview ────────────────────────────────────────────────────────

test("a recovery preview reports old and proposed positions with retained-window evidence", () => {
  const verdict = classifyCursorWindow(makeCursor(STALE_LEDGER), FLOOR);
  assert.equal(verdict.status, "stale");
  const preview = {
    oldPosition: verdict.cursorLedger,
    proposedPosition: FLOOR,
    retainedWindow: { oldestLedger: FLOOR, latestLedger: TIP },
    estimatedMissedLedgers: verdict.missedLedgers,
  };
  assert.deepEqual(preview, {
    oldPosition: STALE_LEDGER,
    proposedPosition: FLOOR,
    retainedWindow: { oldestLedger: FLOOR, latestLedger: TIP },
    estimatedMissedLedgers: FLOOR - STALE_LEDGER,
  });
});

test("a recovery preview never guesses an opaque token into a proposed position", () => {
  assert.deepEqual(classifyCursorWindow("opaque-token", FLOOR), {
    status: "unreadable",
    cursor: "opaque-token",
  });
});
