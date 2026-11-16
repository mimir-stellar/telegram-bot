import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  FollowStoreError,
  STORE_VERSION,
  createFollowStore,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimir-follow-expiry-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("persists lastActiveAt and expiresAt per follow, extends active follows on activity, and prunes expired entries without deleting active ones", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    let nowMs = 1_700_000_000_000;
    const ttlMs = 60_000;

    const store = createFollowStore({
      filePath,
      inactivityTtlMs: ttlMs,
      now: () => nowMs,
    });

    store.follow("chat:1", "market:10");
    store.follow("chat:1", "market:20");
    store.follow("chat:2", "market:10");
    store.follow("chat:2", "squad:99");

    assert.deepEqual(store.getFollowMetadata("chat:1", "market:10"), {
      lastActiveAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    });

    // Verify metadata is persisted on disk across instances.
    const diskInitial = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(diskInitial.version, STORE_VERSION);
    assert.deepEqual(diskInitial.meta["chat:1"]["market:10"], {
      lastActiveAt: 1_700_000_000_000,
      expiresAt: 1_700_000_060_000,
    });

    // At +30s, market:10 sees activity; market:20 and squad:99 do not.
    nowMs += 30_000;
    const refreshed = store.recordActivity("market:10");
    assert.equal(refreshed, 2, "both chat:1 and chat:2 refreshed for market:10");
    assert.deepEqual(store.getFollowMetadata("chat:1", "market:10"), {
      lastActiveAt: 1_700_000_030_000,
      expiresAt: 1_700_000_090_000,
    });

    // Boundary check at t0 + 59_999ms (1ms before initial expiry): all 4 still active.
    nowMs = 1_700_000_059_999;
    assert.deepEqual(store.list("chat:1"), ["market:10", "market:20"]);
    assert.deepEqual(store.list("chat:2"), ["market:10", "squad:99"]);
    assert.equal(store.pruneExpired(), 0);

    // Boundary check at exact expiry t0 + 60_000ms: market:20 and squad:99 expire,
    // while market:10 (extended to +90_000ms) stays active in both chats!
    nowMs = 1_700_000_060_000;
    assert.deepEqual(store.list("chat:1"), ["market:10"]);
    assert.deepEqual(store.list("chat:2"), ["market:10"]);
    assert.deepEqual(store.followersOf("market:20"), []);
    assert.deepEqual(store.followersOf("market:10"), ["chat:1", "chat:2"]);

    const removed = store.pruneExpired();
    assert.equal(removed, 2, "pruned exactly the 2 inactive entries");

    // Reopen from disk to confirm pruned entries were removed and active subscriptions survived.
    const reloaded = createFollowStore({
      filePath,
      inactivityTtlMs: ttlMs,
      now: () => nowMs,
    });
    assert.deepEqual(reloaded.list("chat:1"), ["market:10"]);
    assert.deepEqual(reloaded.list("chat:2"), ["market:10"]);
    assert.equal(reloaded.getFollowMetadata("chat:1", "market:20"), null);
    assert.deepEqual(reloaded.getFollowMetadata("chat:2", "market:10"), {
      lastActiveAt: 1_700_000_030_000,
      expiresAt: 1_700_000_090_000,
    });
  });
});

test("expired follows free quota slots for new follows and invalid TTL values are rejected", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    assert.throws(
      () => createFollowStore({ filePath, inactivityTtlMs: 0 }),
      FollowStoreError,
    );
    assert.throws(
      () => createFollowStore({ filePath, inactivityTtlMs: -500 }),
      FollowStoreError,
    );

    let nowMs = 1_000_000;
    const store = createFollowStore({
      filePath,
      inactivityTtlMs: 10_000,
      maxPerChat: 2,
      maxTotal: 2,
      now: () => nowMs,
    });

    store.follow("chat:1", "market:1");
    store.follow("chat:1", "market:2");
    assert.throws(() => store.follow("chat:1", "market:3"), /per-chat follow limit reached \(2\)/);

    // Advance past expiry for market:1 while keeping market:2 alive via recordActivity.
    nowMs += 5_000;
    store.recordActivity("market:2");
    nowMs += 6_000; // t0 + 11_000: market:1 expired (at +10_000), market:2 expires at +15_000.

    assert.equal(store.follow("chat:1", "market:3"), true);
    assert.deepEqual(store.list("chat:1"), ["market:2", "market:3"]);
  });
});
