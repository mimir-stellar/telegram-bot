import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { FollowStoreError, createFollowStore } from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimir-follow-serial-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("serializes overlapping followAsync and unfollowAsync mutations across instances without lost updates", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    let activeCommits = 0;
    let maxConcurrentCommits = 0;

    const makeHookedStore = () =>
      createFollowStore({
        filePath,
        onBeforeCommit: async () => {
          activeCommits += 1;
          if (activeCommits > maxConcurrentCommits) {
            maxConcurrentCommits = activeCommits;
          }
          // Yield across the microtask/timer queue so unserialized read-modify-write
          // callers would overlap and clobber each other's snapshots.
          await new Promise((resolve) => setImmediate(resolve));
          activeCommits -= 1;
        },
      });

    const storeA = makeHookedStore();
    const storeB = makeHookedStore();

    // Seed initial state for unfollow contention.
    await storeA.followAsync("chat:1", "market:drop-1");
    await storeB.followAsync("chat:1", "market:keep-1");
    await storeA.followAsync("chat:2", "squad:drop-2");

    // Launch overlapping follow and unfollow mutations concurrently across two
    // independent FollowStore instances pointing at the same filePath.
    const ops = [
      storeA.followAsync("chat:1", "market:add-1"),
      storeB.unfollowAsync("chat:1", "market:drop-1"),
      storeA.followAsync("chat:1", "squad:add-2"),
      storeB.followAsync("chat:2", "market:add-3"),
      storeA.unfollowAsync("chat:2", "squad:drop-2"),
      storeB.followAsync("chat:3", "market:add-4"),
      storeA.followAsync("chat:3", "squad:add-5"),
      storeB.followAsync("chat:1", "market:add-1"), // duplicate queued after add-1
    ];

    const results = await Promise.all(ops);
    assert.deepEqual(results, [true, true, true, true, true, true, true, false]);
    assert.equal(maxConcurrentCommits, 1, "at most one commit may be in flight per store file");
    assert.equal(storeA.pendingMutations(), 0);

    const fresh = createFollowStore({ filePath });
    assert.deepEqual(fresh.list("chat:1"), [
      "market:keep-1",
      "market:add-1",
      "squad:add-2",
    ]);
    assert.deepEqual(fresh.list("chat:2"), ["market:add-3"]);
    assert.deepEqual(fresh.list("chat:3"), ["market:add-4", "squad:add-5"]);

    // Verify zero leftover .tmp files on disk.
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ["follows.json"]);
  });
});

test("failed or quota-rejected queued mutation does not poison subsequent serialized mutations", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({
      filePath,
      maxPerChat: 2,
      onBeforeCommit: () => new Promise((resolve) => setImmediate(resolve)),
    });

    const [r1, , r2, , rOther] = await Promise.all([
      store.followAsync("chat:1", "market:1"),
      assert.rejects(store.followAsync("chat:1", "INVALID_REF"), FollowStoreError),
      store.followAsync("chat:1", "market:2"),
      assert.rejects(
        store.followAsync("chat:1", "market:3"),
        /per-chat follow limit reached \(2\)/,
      ),
      store.followAsync("chat:2", "squad:7"),
    ]);

    assert.equal(r1, true);
    assert.equal(r2, true);
    assert.equal(rOther, true);

    assert.deepEqual(store.list("chat:1"), ["market:1", "market:2"]);
    assert.deepEqual(store.list("chat:2"), ["squad:7"]);
  });
});

test("interleaved synchronous mutation during async onBeforeCommit does not get overwritten", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    let injectedSync = false;
    const syncWriter = createFollowStore({ filePath });
    const asyncWriter = createFollowStore({
      filePath,
      onBeforeCommit: async () => {
        if (!injectedSync) {
          injectedSync = true;
          // Mutate synchronously after asyncWriter already read its initial snapshot!
          syncWriter.follow("chat:sync", "market:999");
        }
      },
    });

    await asyncWriter.followAsync("chat:async", "squad:111");

    const verify = createFollowStore({ filePath });
    assert.deepEqual(verify.list("chat:sync"), ["market:999"]);
    assert.deepEqual(verify.list("chat:async"), ["squad:111"]);
  });
});
