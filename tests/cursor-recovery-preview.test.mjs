import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatCursorRecoveryPreview, previewCursorRecovery } from "../dist/cursor-cli.js";
import { createPoller } from "../dist/poller.js";

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-0`;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-preview-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("previewCursorRecovery computes missed below-floor and replay ledger ranges from status-file evidence without mutating disk", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const statusFile = path.join(dir, "status.json");

    const liveRaw =
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-09T12:00:00.000Z",
          targets: {
            market: { cursor: cursorAt(5500), lastEventLedger: 5499 },
            squad: { cursor: cursorAt(5400), lastEventLedger: 5395 },
          },
        },
        null,
        2,
      ) + "\n";

    const backupRaw =
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-10-09T10:00:00.000Z",
          targets: {
            market: { cursor: cursorAt(4800), lastEventLedger: 4799 },
            squad: { cursor: cursorAt(5200), lastEventLedger: 5190 },
          },
        },
        null,
        2,
      ) + "\n";

    const statusRaw = JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-10-09T12:01:00.000Z",
      oldestLedger: 5000,
      latestLedger: 5600,
    });

    await writeFile(cursorFile, liveRaw, "utf8");
    await writeFile(backupFile, backupRaw, "utf8");
    await writeFile(statusFile, statusRaw, "utf8");

    const preview = await previewCursorRecovery({
      cursorFile,
      backupFile,
      statusFile,
    });

    assert.deepEqual(preview.windowEvidence, {
      available: true,
      source: "status_file",
      oldestLedger: 5000,
      latestLedger: 5600,
      capturedAt: "2026-10-09T12:01:00.000Z",
    });

    // market: proposed 4800 < floor 5000 -> 200 missed ledgers (4800..4999) + replay 5000..5500
    const market = preview.targets.market;
    assert.deepEqual(market.oldPosition, {
      kind: "ledger",
      ledger: 5500,
      lastEventLedger: 5499,
    });
    assert.deepEqual(market.proposedPosition, {
      kind: "ledger",
      ledger: 4800,
      lastEventLedger: 4799,
    });
    assert.equal(market.windowPlacement, "below_floor");
    assert.equal(market.missedLedgers, 200);
    assert.deepEqual(market.estimatedMissedRange, {
      startLedger: 4800,
      endLedger: 4999,
      ledgerCount: 200,
    });
    assert.deepEqual(market.estimatedReplayRange, {
      startLedger: 5000,
      endLedger: 5500,
      ledgerCount: 501,
    });

    // squad: proposed 5200 >= floor 5000 -> 0 missed ledgers, replay 5200..5400
    const squad = preview.targets.squad;
    assert.equal(squad.windowPlacement, "within_window");
    assert.equal(squad.missedLedgers, 0);
    assert.equal(squad.estimatedMissedRange, null);
    assert.deepEqual(squad.estimatedReplayRange, {
      startLedger: 5200,
      endLedger: 5400,
      ledgerCount: 201,
    });

    const rendered = formatCursorRecoveryPreview(preview);
    assert.match(rendered, /retainedWindow: oldest=5000 latest=5600 source=status_file/);
    assert.match(rendered, /target=market old=ledger:5500 proposed=ledger:4800 placement=below_floor missed=4800\.\.4999 \(200 ledgers\)/);

    // Zero disk mutations or lock files created.
    assert.equal(await readFile(cursorFile, "utf8"), liveRaw);
    assert.equal(await readFile(backupFile, "utf8"), backupRaw);
    assert.deepEqual((await readdir(dir)).sort(), ["backup.json", "cursor.json", "status.json"]);
  });
});

test("previewCursorRecovery refuses to guess ledgers for opaque cursor tokens or missing window evidence", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-09T12:00:00.000Z",
        targets: {
          market: { cursor: "opaque-live-token", lastEventLedger: 5500 },
          squad: { cursor: cursorAt(5400), lastEventLedger: 5400 },
        },
      }),
      "utf8",
    );

    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-09T11:00:00.000Z",
        targets: {
          // Even though lastEventLedger is 4100, cursor is opaque so ledger MUST NOT be guessed!
          market: { cursor: "opaque-backup-token", lastEventLedger: 4100 },
          squad: { cursor: cursorAt(5100), lastEventLedger: 5100 },
        },
      }),
      "utf8",
    );

    const withWindow = await previewCursorRecovery({
      cursorFile,
      backupFile,
      retainedWindow: { oldestLedger: 5000, latestLedger: 5600 },
    });

    assert.equal(withWindow.targets.market.proposedPosition.kind, "opaque");
    assert.equal(withWindow.targets.market.proposedPosition.ledger, null);
    assert.equal(withWindow.targets.market.windowPlacement, "opaque_cursor");
    assert.equal(withWindow.targets.market.missedLedgers, null);
    assert.equal(withWindow.targets.market.estimatedMissedRange, null);
    assert.equal(withWindow.targets.market.estimatedReplayRange, null);
    assert.equal(JSON.stringify(withWindow).includes("opaque-backup-token"), false);

    // Without retainedWindow or statusFile, squad placement is unknown_window rather than guessed.
    const withoutWindow = await previewCursorRecovery({ cursorFile, backupFile });
    assert.equal(withoutWindow.windowEvidence.available, false);
    assert.equal(withoutWindow.targets.squad.windowPlacement, "unknown_window");
    assert.equal(withoutWindow.targets.squad.missedLedgers, null);
    assert.equal(withoutWindow.targets.squad.estimatedMissedRange, null);
  });
});

test("poller.previewCursorRecovery uses observed retained window without issuing RPC or chain calls", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    let rpcCalls = 0;

    const poller = createPoller({
      config: {
        marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN",
        rpcUrl: "https://soroban-testnet.stellar.org",
        horizonUrl: "https://horizon-testnet.stellar.org",
        networkPassphrase: "Test SDF Network ; September 2015",
        botToken: "000000:synthetic-token",
        chatId: "-1001234567890",
        pollIntervalMs: 999_999,
        startLookbackLedgers: 60,
        maxNotificationsPerCycle: 5,
        cursorFile,
        deadLetterFile: path.join(dir, "dead-letter.json"),
        auditFile: path.join(dir, "audit.jsonl"),
        statusFile: path.join(dir, "status.json"),
        instanceLockFile: path.join(dir, "poller.lock"),
      },
      server: {
        async getHealth() {
          rpcCalls += 1;
          return { status: "healthy", latestLedger: 9000, oldestLedger: 8500 };
        },
        async getEvents() {
          rpcCalls += 1;
          return { events: [], cursor: cursorAt(9000), latestLedger: 9000 };
        },
      },
      send: async () => undefined,
      persistAudit: false,
    });

    await poller.runCycle();
    const callsAfterCycle = rpcCalls;

    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-09T11:00:00.000Z",
        targets: {
          market: { cursor: cursorAt(8200), lastEventLedger: 8200 },
          squad: { cursor: cursorAt(8800), lastEventLedger: 8800 },
        },
      }),
      "utf8",
    );

    const preview = await poller.previewCursorRecovery(backupFile);
    assert.equal(rpcCalls, callsAfterCycle, "preview must not issue any RPC or chain calls");
    assert.equal(preview.windowEvidence.source, "poller_status");
    assert.equal(preview.targets.market.windowPlacement, "below_floor");
    assert.equal(preview.targets.market.missedLedgers, 300);
    assert.equal(preview.targets.squad.windowPlacement, "within_window");
    assert.equal(preview.targets.squad.missedLedgers, 0);
  });
});
