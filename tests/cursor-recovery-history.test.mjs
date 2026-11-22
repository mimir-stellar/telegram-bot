import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendCursorRecoveryHistory,
  buildCursorFile,
  MAX_CURSOR_RECOVERY_HISTORY,
  parseAndMigrateCursorFile,
  parseCursorFile,
  parseRecoveryHistory,
} from "../dist/poller.js";
import { readCursorRecoveryHistory, restoreCursor } from "../dist/cursor-cli.js";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-recovery-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("restoreCursor records before and after positions with reason and timestamp", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: {
            cursor: "live-cursor-100",
            lastEventLedger: 100,
            recentEventIds: ["evt-secret-payload-should-not-copy"],
          },
        },
      }),
    );
    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-28T00:00:00.000Z",
        targets: {
          market: {
            cursor: "backup-cursor-50",
            lastEventLedger: 50,
            recentEventIds: ["evt-backup-should-not-copy"],
          },
        },
      }),
    );

    const fixedTime = new Date("2026-09-30T12:34:56.000Z");
    await restoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      now: () => fixedTime,
    });

    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.recoveryHistory.length, 1);
    const [entry] = restored.recoveryHistory;
    assert.equal(entry.at, "2026-09-30T12:34:56.000Z");
    assert.equal(entry.reason, "restore");
    assert.deepEqual(entry.before, {
      market: { cursor: "live-cursor-100", lastEventLedger: 100 },
    });
    assert.deepEqual(entry.after, {
      market: { cursor: "backup-cursor-50", lastEventLedger: 50 },
    });

    // Verify no event IDs or payloads leaked into recoveryHistory
    const serialized = JSON.stringify(restored.recoveryHistory);
    assert.equal(serialized.includes("recentEventIds"), false);
    assert.equal(serialized.includes("evt-secret-payload"), false);
    assert.equal(serialized.includes("evt-backup"), false);

    // readCursorRecoveryHistory reads the same bounded history
    const history = await readCursorRecoveryHistory(cursorFile);
    assert.deepEqual(history, restored.recoveryHistory);
  });
});

test("restoreCursor over corrupt live cursor records empty before without leaking raw bytes", async () => {
  await withTempDir(async (directory) => {
    const cursorFile = path.join(directory, "cursor.json");
    const backupFile = path.join(directory, "backup.json");
    const lockFile = path.join(directory, "poller.lock");

    await writeFile(cursorFile, "CORRUPT_RAW_BOT_TOKEN_0000000000:PLACEHOLDER_DO_NOT_LEAK");
    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-28T00:00:00.000Z",
        targets: { market: { cursor: "backup-cursor-50", lastEventLedger: 50 } },
      }),
    );

    await restoreCursor({
      cursorFile,
      backupFile,
      lockFile,
      force: true,
      now: () => new Date("2026-09-30T01:00:00.000Z"),
    });

    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.recoveryHistory.length, 1);
    assert.deepEqual(restored.recoveryHistory[0].before, {});
    assert.deepEqual(restored.recoveryHistory[0].after, {
      market: { cursor: "backup-cursor-50", lastEventLedger: 50 },
    });
    assert.equal(JSON.stringify(restored.recoveryHistory).includes("PLACEHOLDER_DO_NOT_LEAK"), false);
  });
});

test("recoveryHistory is bounded to MAX_CURSOR_RECOVERY_HISTORY most-recent entries", () => {
  let history = [];
  const total = MAX_CURSOR_RECOVERY_HISTORY + 7;
  for (let i = 1; i <= total; i += 1) {
    history = appendCursorRecoveryHistory(history, {
      at: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
      reason: "floor_rewind",
      source: "market",
      before: { market: { cursor: `cursor-${i}`, lastEventLedger: i } },
      after: { market: { cursor: null, lastEventLedger: null, rewindFromLedger: i + 100 } },
    });
  }

  assert.equal(history.length, MAX_CURSOR_RECOVERY_HISTORY);
  assert.equal(history[0].before.market.lastEventLedger, 8);
  assert.equal(history[history.length - 1].before.market.lastEventLedger, total);
});

test("parseCursorFile and parseAndMigrateCursorFile strip extra fields and drop malformed recovery entries", () => {
  const raw = JSON.stringify({
    version: 1,
    updatedAt: "2026-09-29T00:00:00.000Z",
    targets: { market: { cursor: "cursor-10", lastEventLedger: 10 } },
    recoveryHistory: [
      {
        at: "2026-09-29T00:00:00.000Z",
        reason: "floor_rewind",
        source: "market",
        unexpectedField: "must-be-stripped",
        eventPayload: { topic: "claim_created", amount: 999 },
        before: {
          market: {
            cursor: "cursor-5",
            lastEventLedger: 5,
            recentEventIds: ["evt-1"],
            payload: "raw-xdr",
          },
        },
        after: {
          market: {
            cursor: null,
            lastEventLedger: null,
            rewindFromLedger: 10,
            extraSecret: "nope",
          },
        },
      },
      { at: "not-a-date", reason: "restore", before: {}, after: {} },
      { at: "2026-09-29T00:00:01.000Z", reason: "unknown_reason", before: {}, after: {} },
      null,
      "malformed",
    ],
  });

  const parsedStrict = parseCursorFile(raw);
  const parsedMigrated = parseAndMigrateCursorFile(raw).file;

  for (const doc of [parsedStrict, parsedMigrated]) {
    assert.equal(doc.recoveryHistory?.length, 1);
    const [record] = doc.recoveryHistory;
    assert.deepEqual(record, {
      at: "2026-09-29T00:00:00.000Z",
      reason: "floor_rewind",
      source: "market",
      before: { market: { cursor: "cursor-5", lastEventLedger: 5 } },
      after: { market: { cursor: null, lastEventLedger: null, rewindFromLedger: 10 } },
    });
    const serialized = JSON.stringify(doc.recoveryHistory);
    assert.equal(serialized.includes("must-be-stripped"), false);
    assert.equal(serialized.includes("raw-xdr"), false);
    assert.equal(serialized.includes("nope"), false);
  }
});

test("buildCursorFile omits recoveryHistory when empty and bounds it when provided", () => {
  const withoutHistory = buildCursorFile(
    [{ source: "market", cursor: "c1", lastEventLedger: 1 }],
    "2026-09-29T00:00:00.000Z",
  );
  assert.equal("recoveryHistory" in withoutHistory, false);

  const many = Array.from({ length: MAX_CURSOR_RECOVERY_HISTORY + 5 }, (_, idx) => ({
    at: new Date(Date.UTC(2026, 8, 1, 0, idx, 0)).toISOString(),
    reason: "quarantine",
    before: {},
    after: { market: { cursor: null, lastEventLedger: null } },
  }));
  const withHistory = buildCursorFile(
    [{ source: "market", cursor: "c1", lastEventLedger: 1 }],
    "2026-09-29T00:00:00.000Z",
    null,
    many,
  );
  assert.equal(withHistory.recoveryHistory?.length, MAX_CURSOR_RECOVERY_HISTORY);
  assert.deepEqual(parseRecoveryHistory("not-an-array"), []);
});
