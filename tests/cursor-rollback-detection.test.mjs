import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPoller,
  detectCursorRollback,
  readBackupMetadata,
  writeBackupMetadata,
  CursorRollbackError,
} from "../dist/poller.js";
import { backupCursor, restoreCursor } from "../dist/cursor-cli.js";

async function withTempDir(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-rollback-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function baseConfig(cursorFile, overrides = {}) {
  return {
    marketContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    squadContractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KN",
    rpcUrl: "https://example.invalid/rpc",
    horizonUrl: "https://example.invalid/horizon",
    networkPassphrase: "Test SDF Network ; September 2015",
    botToken: "fake-token",
    chatId: "-1001234567890",
    pollIntervalMs: 999_999,
    startLookbackLedgers: 60,
    maxNotificationsPerCycle: 5,
    cursorFile,
    ...overrides,
  };
}

function mockServer() {
  return {
    getHealth: async () => ({ status: "healthy", latestLedger: 5000, oldestLedger: 1000 }),
    getEvents: async () => ({ events: [], cursor: null, latestLedger: 5000 }),
  };
}

// ── Unit Tests: detectCursorRollback ──────────────────────────────────────────

test("detectCursorRollback: returns rollback=false when backup metadata is missing", () => {
  const cursor = {
    version: 1,
    updatedAt: "2026-11-23T10:00:00.000Z",
    recoveryGeneration: 1,
    targets: { market: { cursor: "1000-0", lastEventLedger: 100 } },
  };
  const result = detectCursorRollback(cursor, null);
  assert.equal(result.rollback, false);
});

test("detectCursorRollback: detects rollback when recovery generation is lower than backup metadata", () => {
  const cursor = {
    version: 1,
    updatedAt: "2026-11-20T10:00:00.000Z",
    recoveryGeneration: 1,
    targets: { market: { cursor: "1000-0", lastEventLedger: 100 } },
  };
  const backupMeta = {
    version: 1,
    recoveryGeneration: 2,
    updatedAt: "2026-11-22T10:00:00.000Z",
    targets: { market: { cursor: "2000-0", lastEventLedger: 200 } },
  };

  const result = detectCursorRollback(cursor, backupMeta);
  assert.equal(result.rollback, true);
  assert.match(result.reason, /generation \(1\) is older than backup metadata \(2\)/);
  assert.equal(result.cursorGeneration, 1);
  assert.equal(result.backupGeneration, 2);
});

test("detectCursorRollback: detects rollback when cursor has no generation (legacy 0) and backup has generation 1", () => {
  const cursor = {
    version: 1,
    updatedAt: "2026-11-20T10:00:00.000Z",
    targets: { market: { cursor: "1000-0", lastEventLedger: 100 } },
  };
  const backupMeta = {
    version: 1,
    recoveryGeneration: 1,
    updatedAt: "2026-11-22T10:00:00.000Z",
    targets: { market: { cursor: "1000-0", lastEventLedger: 100 } },
  };

  const result = detectCursorRollback(cursor, backupMeta);
  assert.equal(result.rollback, true);
  assert.equal(result.cursorGeneration, 0);
  assert.equal(result.backupGeneration, 1);
});

test("detectCursorRollback: detects rollback within same generation when target ledgers regressed", () => {
  const cursor = {
    version: 1,
    updatedAt: "2026-11-20T10:00:00.000Z",
    recoveryGeneration: 2,
    targets: {
      market: { cursor: "1000-0", lastEventLedger: 100 },
      squad: { cursor: "2000-0", lastEventLedger: 200 },
    },
  };
  const backupMeta = {
    version: 1,
    recoveryGeneration: 2,
    updatedAt: "2026-11-22T10:00:00.000Z",
    targets: {
      market: { cursor: "1500-0", lastEventLedger: 150 },
      squad: { cursor: "2000-0", lastEventLedger: 200 },
    },
  };

  const result = detectCursorRollback(cursor, backupMeta);
  assert.equal(result.rollback, true);
  assert.match(result.reason, /target positions regressed/);
  assert.equal(result.regressedTargets.length, 1);
  assert.equal(result.regressedTargets[0].source, "market");
  assert.equal(result.regressedTargets[0].cursorLedger, 100);
  assert.equal(result.regressedTargets[0].backupLedger, 150);
});

test("detectCursorRollback: returns rollback=false when cursor is ahead of or equal to backup metadata", () => {
  const cursor = {
    version: 1,
    updatedAt: "2026-11-23T10:00:00.000Z",
    recoveryGeneration: 2,
    targets: { market: { cursor: "2500-0", lastEventLedger: 250 } },
  };
  const backupMeta = {
    version: 1,
    recoveryGeneration: 2,
    updatedAt: "2026-11-22T10:00:00.000Z",
    targets: { market: { cursor: "2000-0", lastEventLedger: 200 } },
  };

  const result = detectCursorRollback(cursor, backupMeta);
  assert.equal(result.rollback, false);
});

test("detectCursorRollback: returns rollback=false when cursor has higher recovery generation (forward progress)", () => {
  const cursor = {
    version: 1,
    updatedAt: "2026-11-23T10:00:00.000Z",
    recoveryGeneration: 3,
    targets: { market: { cursor: "1000-0", lastEventLedger: 100 } },
  };
  const backupMeta = {
    version: 1,
    recoveryGeneration: 2,
    updatedAt: "2026-11-22T10:00:00.000Z",
    targets: { market: { cursor: "2000-0", lastEventLedger: 200 } },
  };

  const result = detectCursorRollback(cursor, backupMeta);
  assert.equal(result.rollback, false);
});

// ── Startup Rollback Detection & Acknowledgment Tests ────────────────────────

test("poller startup rejects unacknowledged rollback to older recovery generation", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    // Active cursor is at generation 1 (e.g. older backup restored)
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 1,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    // Companion backup metadata records generation 2 (previous active state)
    await writeBackupMetadata(cursorFile, {
      version: 1,
      recoveryGeneration: 2,
      updatedAt: "2026-11-22T00:00:00.000Z",
      targets: { market: { cursor: "200-0", lastEventLedger: 200 } },
    });

    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });

    await assert.rejects(
      async () => poller.loadCursors(),
      (err) => {
        assert(err instanceof CursorRollbackError);
        assert.equal(err.cursorGeneration, 1);
        assert.equal(err.backupGeneration, 2);
        assert.match(err.message, /cursor rollback detected/);
        return true;
      },
    );

    // Check audit trail recorded rollback rejection
    const entries = poller.audit.flush();
    const rejected = entries.find((e) => e.kind === "cursor_rollback_rejected");
    assert(rejected, "expected cursor_rollback_rejected audit entry");
  });
});

test("poller startup rejects unacknowledged rollback to regressed target positions within same generation", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 2,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    await writeBackupMetadata(cursorFile, {
      version: 1,
      recoveryGeneration: 2,
      updatedAt: "2026-11-22T00:00:00.000Z",
      targets: { market: { cursor: "300-0", lastEventLedger: 300 } },
    });

    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });

    await assert.rejects(
      async () => poller.loadCursors(),
      (err) => {
        assert(err instanceof CursorRollbackError);
        assert.match(err.message, /target positions regressed/);
        return true;
      },
    );
  });
});

test("poller startup proceeds when ACKNOWLEDGE_CURSOR_REPLAY=true and advances recovery generation", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 1,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    await writeBackupMetadata(cursorFile, {
      version: 1,
      recoveryGeneration: 2,
      updatedAt: "2026-11-22T00:00:00.000Z",
      targets: { market: { cursor: "200-0", lastEventLedger: 200 } },
    });

    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: true }),
      server: mockServer(),
      send: async () => undefined,
    });

    await poller.loadCursors();
    // Generation advanced past backup generation 2 -> 3
    assert.equal(poller.status().recoveryGeneration, 3);
    assert.equal(poller.status().targets.find((t) => t.source === "market").cursor, "100-0");

    const entries = poller.audit.flush();
    const acked = entries.find((e) => e.kind === "cursor_rollback_acknowledged");
    assert(acked, "expected cursor_rollback_acknowledged audit entry");
  });
});

test("poller startup proceeds when file has replayAcknowledged=true", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    // File restored with --ack-replay carries replayAcknowledged: true
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 1,
        replayAcknowledged: true,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    await writeBackupMetadata(cursorFile, {
      version: 1,
      recoveryGeneration: 2,
      updatedAt: "2026-11-22T00:00:00.000Z",
      targets: { market: { cursor: "200-0", lastEventLedger: 200 } },
    });

    // acknowledgeCursorReplay is false in config, but file carries explicit acknowledgement
    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });

    await poller.loadCursors();
    assert.equal(poller.status().recoveryGeneration, 3);
  });
});

test("poller startup detects rollback via .bak fallback when .backup-meta.json is missing", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = `${cursorFile}.bak`;

    // Live cursor regressed
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 1,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    // .bak copy is from generation 2
    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-22T00:00:00.000Z",
        recoveryGeneration: 2,
        targets: { market: { cursor: "200-0", lastEventLedger: 200 } },
      }),
      "utf8",
    );

    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });

    await assert.rejects(
      async () => poller.loadCursors(),
      /cursor rollback detected/,
    );
  });
});

test("poller startup handles corrupt backup metadata gracefully without crashing", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const metaFile = `${cursorFile}.backup-meta.json`;

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-23T00:00:00.000Z",
        recoveryGeneration: 1,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    // Corrupt metadata file
    await writeFile(metaFile, "{not-valid-json", "utf8");

    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });

    // Startup should succeed and treat corrupt metadata as missing
    await poller.loadCursors();
    assert.equal(poller.status().targets.find((t) => t.source === "market").cursor, "100-0");
  });
});

// ── CLI Backup & Restore Tests ───────────────────────────────────────────────

test("cursor backup creates companion metadata file", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const metaFile = `${backupFile}.meta.json`;

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-23T00:00:00.000Z",
        recoveryGeneration: 2,
        targets: { market: { cursor: "400-0", lastEventLedger: 400 } },
      }),
      "utf8",
    );

    await backupCursor({ cursorFile, backupFile });
    const metaRaw = await readFile(metaFile, "utf8");
    const meta = JSON.parse(metaRaw);
    assert.equal(meta.version, 1);
    assert.equal(meta.recoveryGeneration, 2);
    assert.equal(meta.targets.market.lastEventLedger, 400);
  });
});

test("cursor restore without --ack-replay preserves backup generation and does not acknowledge replay", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const lockFile = path.join(dir, "poller.lock");

    // Live state is generation 3
    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-23T00:00:00.000Z",
        recoveryGeneration: 3,
        targets: { market: { cursor: "500-0", lastEventLedger: 500 } },
      }),
      "utf8",
    );

    // Older backup is generation 1
    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 1,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    await restoreCursor({ cursorFile, backupFile, lockFile, force: true });

    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.recoveryGeneration, 1);
    assert.equal(restored.replayAcknowledged, undefined);

    // Live metadata was recorded before overwrite
    const meta = await readBackupMetadata(cursorFile);
    assert.equal(meta.recoveryGeneration, 3);

    // Startup should now detect rollback
    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });
    await assert.rejects(async () => poller.loadCursors(), CursorRollbackError);
  });
});

test("cursor restore with --ack-replay marks replayAcknowledged and bumps generation", async () => {
  await withTempDir(async (dir) => {
    const cursorFile = path.join(dir, "cursor.json");
    const backupFile = path.join(dir, "backup.json");
    const lockFile = path.join(dir, "poller.lock");

    await writeFile(
      cursorFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-23T00:00:00.000Z",
        recoveryGeneration: 3,
        targets: { market: { cursor: "500-0", lastEventLedger: 500 } },
      }),
      "utf8",
    );

    await writeFile(
      backupFile,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-11-20T00:00:00.000Z",
        recoveryGeneration: 1,
        targets: { market: { cursor: "100-0", lastEventLedger: 100 } },
      }),
      "utf8",
    );

    await restoreCursor({ cursorFile, backupFile, lockFile, force: true, ackReplay: true });

    const restored = JSON.parse(await readFile(cursorFile, "utf8"));
    assert.equal(restored.replayAcknowledged, true);
    // Generation bumped to max(3, 1) + 1 = 4
    assert.equal(restored.recoveryGeneration, 4);

    // Startup succeeds because replay was explicitly acknowledged during restore
    const poller = createPoller({
      config: baseConfig(cursorFile, { acknowledgeCursorReplay: false }),
      server: mockServer(),
      send: async () => undefined,
    });
    await poller.loadCursors();
    assert.equal(poller.status().recoveryGeneration, 4);
  });
});
