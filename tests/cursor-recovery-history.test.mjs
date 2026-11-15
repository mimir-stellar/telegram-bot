import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCursorRecoveryRecord,
  MAX_CURSOR_RECOVERY_HISTORY,
  readCursorRecoveryHistory,
  restoreCursor,
  sanitizeCursorRecoveryHistory,
} from "../dist/cursor-cli.js";
import { createPoller, parseCursorFile } from "../dist/poller.js";

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

function makeConfig(stateDir) {
  return {
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "111111111:SYNTHETIC-SECRET-DO-NOT-PERSIST",
    chatId: "-1001234567890",
    pollIntervalMs: 999_999,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 5,
    cursorFile: path.join(stateDir, "cursor.json"),
    deadLetterFile: path.join(stateDir, "dead-letter.json"),
    auditFile: path.join(stateDir, "audit.jsonl"),
    statusFile: path.join(stateDir, "status.json"),
    instanceLockFile: path.join(stateDir, "poller.lock"),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-hist-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("restoreCursor records before and after positions with reason and timestamp without leaking opaque tokens", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const lockFile = path.join(dir, "poller.lock");
    const fixedDate = new Date("2026-10-05T14:30:00.000Z");

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-05T14:00:00.000Z",
        targets: {
          market: {
            cursor: cursorAt(4500),
            lastEventLedger: 4498,
            recentEventIds: ["evt-secret-payload-id-1"],
          },
          squad: {
            cursor: "opaque-token-111111111:SYNTHETIC-SECRET",
            lastEventLedger: 4100,
          },
        },
      }),
      "utf8",
    );

    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-05T13:30:00.000Z",
        targets: {
          market: { cursor: cursorAt(4200), lastEventLedger: 4195 },
          squad: { cursor: null, lastEventLedger: null },
        },
      }),
      "utf8",
    );

    await restoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      now: () => fixedDate,
    });

    const history = await readCursorRecoveryHistory(cursorFile);
    assert.equal(history.length, 1);
    assert.deepEqual(history[0], {
      at: "2026-10-05T14:30:00.000Z",
      reason: "operator_restore",
      targets: {
        market: {
          before: { kind: "ledger", ledger: 4500, lastEventLedger: 4498 },
          after: { kind: "ledger", ledger: 4200, lastEventLedger: 4195 },
        },
        squad: {
          before: { kind: "opaque", ledger: null, lastEventLedger: 4100 },
          after: { kind: "none", ledger: null, lastEventLedger: null },
        },
      },
    });

    const serializedHistory = JSON.stringify(history);
    assert.equal(serializedHistory.includes("SYNTHETIC-SECRET"), false);
    assert.equal(serializedHistory.includes("evt-secret-payload-id-1"), false);
    assert.equal(serializedHistory.includes("opaque-token"), false);
  });
});

test("poller records floor_rewind and quarantine_cold_start transitions without payloads or secrets", async () => {
  await withTempDir(async (dir) => {
    const config = makeConfig(dir);
    let clockMs = Date.parse("2026-10-06T09:00:00.000Z");

    // 1. Corrupt cursor file triggers quarantine_cold_start recovery record.
    await writeFile(config.cursorFile, "{corrupt-json-111111111:SYNTHETIC-SECRET", "utf8");

    const poller1 = createPoller({
      config,
      server: {
        async getHealth() {
          return { status: "healthy", latestLedger: 6000, oldestLedger: 5000 };
        },
        async getEvents() {
          return { events: [], cursor: cursorAt(6000), latestLedger: 6000 };
        },
      },
      send: async () => undefined,
      now: () => clockMs,
      persistAudit: false,
    });

    await poller1.loadCursors();
    await poller1.runCycle();
    await poller1.shutdown({ timeoutMs: 500 });

    const afterQuarantine = parseCursorFile(await readFile(config.cursorFile, "utf8"));
    assert.equal(afterQuarantine.recoveryHistory?.length, 1);
    assert.equal(afterQuarantine.recoveryHistory?.[0]?.reason, "quarantine_cold_start");
    assert.deepEqual(afterQuarantine.recoveryHistory?.[0]?.targets.market, {
      before: { kind: "unreadable", ledger: null, lastEventLedger: null },
      after: { kind: "none", ledger: null, lastEventLedger: null },
    });

    // 2. Write a cursor below the retained floor (ledger 3000 < floor 7000) and run two cycles
    //    so cycle 1 establishes status.oldestLedger=7000 or RPC error triggers floor_rewind.
    clockMs = Date.parse("2026-10-06T10:00:00.000Z");
    await writeFile(
      config.cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-06T09:30:00.000Z",
        recoveryHistory: afterQuarantine.recoveryHistory,
        targets: {
          market: { cursor: cursorAt(3000), lastEventLedger: 2999 },
          squad: { cursor: cursorAt(7050), lastEventLedger: 7045 },
        },
      }),
      "utf8",
    );

    let marketCalls = 0;
    const poller2 = createPoller({
      config,
      server: {
        async getHealth() {
          return { status: "healthy", latestLedger: 7500, oldestLedger: 7000 };
        },
        async getEvents(req) {
          if (req.cursor === cursorAt(3000) && marketCalls === 0) {
            marketCalls += 1;
            throw new Error("startLedger is before oldest ledger");
          }
          return { events: [], cursor: cursorAt(7500), latestLedger: 7500 };
        },
      },
      send: async () => undefined,
      now: () => clockMs,
      persistAudit: false,
    });

    await poller2.loadCursors();
    await poller2.runCycle();
    await poller2.shutdown({ timeoutMs: 500 });

    const status = poller2.status();
    assert.equal(status.recoveryHistory?.length, 2);
    const rewindEntry = status.recoveryHistory?.[1];
    assert.deepEqual(rewindEntry, {
      at: "2026-10-06T10:00:00.000Z",
      reason: "floor_rewind",
      targets: {
        market: {
          before: { kind: "ledger", ledger: 3000, lastEventLedger: 2999 },
          after: { kind: "rewind", ledger: 7000, lastEventLedger: null },
        },
      },
    });

    const rawSaved = await readFile(config.cursorFile, "utf8");
    assert.equal(rawSaved.includes(config.botToken), false);
    assert.equal(rawSaved.includes("SYNTHETIC-SECRET"), false);
  });
});

test("recoveryHistory enforces MAX_CURSOR_RECOVERY_HISTORY FIFO cap and strips unexpected payload fields", () => {
  let records = [];
  for (let i = 0; i < MAX_CURSOR_RECOVERY_HISTORY + 6; i += 1) {
    const second = String(i).padStart(2, "0");
    records = appendCursorRecoveryRecord(records, {
      at: `2026-10-07T12:00:${second}.000Z`,
      reason: "operator_restore",
      targets: {
        market: {
          before: { kind: "ledger", ledger: 1000 + i, lastEventLedger: 1000 + i },
          after: { kind: "ledger", ledger: 2000 + i, lastEventLedger: 2000 + i },
        },
      },
    });
  }

  assert.equal(records.length, MAX_CURSOR_RECOVERY_HISTORY);
  assert.equal(records[0].at, "2026-10-07T12:00:06.000Z");
  assert.equal(records.at(-1).at, "2026-10-07T12:00:25.000Z");

  // Tampered entries carrying extra payload or secret fields are stripped down to safe schema.
  const sanitized = sanitizeCursorRecoveryHistory([
    {
      at: "2026-10-07T13:00:00.000Z",
      reason: "operator_restore",
      botToken: "999999:LEAKED-TOKEN",
      eventPayload: { buyer: "GABC", amount: "1000000" },
      targets: {
        market: {
          rawCursor: "secret-cursor-value",
          before: { kind: "opaque", ledger: 9999, lastEventLedger: 50, secret: "nope" },
          after: { kind: "ledger", ledger: 100, lastEventLedger: 99, payload: "nope" },
        },
      },
    },
  ]);

  assert.deepEqual(sanitized, [
    {
      at: "2026-10-07T13:00:00.000Z",
      reason: "operator_restore",
      targets: {
        market: {
          before: { kind: "opaque", ledger: null, lastEventLedger: 50 },
          after: { kind: "ledger", ledger: 100, lastEventLedger: 99 },
        },
      },
    },
  ]);
  assert.equal(JSON.stringify(sanitized).includes("LEAKED-TOKEN"), false);
  assert.equal(JSON.stringify(sanitized).includes("eventPayload"), false);
  assert.equal(JSON.stringify(sanitized).includes("secret-cursor-value"), false);
});
