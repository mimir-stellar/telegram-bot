import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  FollowStoreError,
  STORE_VERSION,
  createFollowStore,
  deduplicateFollowRefs,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimir-follow-dedup-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("normalizes duplicate references on load so duplicates never consume extra quota slots", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    // Hand-authored or legacy file with repeated entries for chat:1 and chat:2.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: STORE_VERSION,
        follows: {
          "chat:1": ["market:1", "market:1", "market:1"],
          "chat:2": ["squad:9", "squad:9"],
          "chat:empty": [],
        },
      }),
      "utf8",
    );

    const store = createFollowStore({
      filePath,
      maxPerChat: 2,
      maxTotal: 3,
    });

    assert.deepEqual(store.list("chat:1"), ["market:1"]);
    assert.deepEqual(store.list("chat:2"), ["squad:9"]);
    assert.deepEqual(store.followersOf("market:1"), ["chat:1"]);

    // Because chat:1 only occupies 1 unique slot and total unique entries is 2,
    // adding a second distinct ref for chat:1 succeeds within maxPerChat=2 and maxTotal=3.
    assert.equal(store.follow("chat:1", "market:2"), true);
    assert.deepEqual(store.list("chat:1"), ["market:1", "market:2"]);

    // Persisted file now holds deduplicated canonical arrays.
    const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.deepEqual(saved.follows, {
      "chat:1": ["market:1", "market:2"],
      "chat:2": ["squad:9"],
    });
  });
});

test("importFollows deduplicates incoming and existing refs before enforcing per-chat and global limits", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({
      filePath,
      maxPerChat: 2,
      maxTotal: 3,
    });

    store.follow("chat:1", "market:10");

    // 5 raw entries collapse to 2 unique refs ("market:10" already followed + "squad:20"),
    // fitting inside maxPerChat=2 instead of failing as 1 + 5 = 6 entries.
    const res = store.importFollows("chat:1", [
      "market:10",
      "squad:20",
      "market:10",
      "squad:20",
      "squad:20",
    ]);
    assert.deepEqual(res, {
      added: 1,
      duplicatesSkipped: 4,
      totalForChat: 2,
    });
    assert.deepEqual(store.list("chat:1"), ["market:10", "squad:20"]);

    // Boundary case: 3 distinct refs exceed maxPerChat=2 even after deduplication,
    // throwing FollowStoreError and leaving persisted state untouched.
    const beforeBytes = await fs.readFile(filePath, "utf8");
    assert.throws(
      () => store.importFollows("chat:2", ["market:1", "market:1", "market:2", "market:3"]),
      /per-chat follow limit reached \(2\)/,
    );
    assert.equal(await fs.readFile(filePath, "utf8"), beforeBytes);

    // Global cap boundary: chat:1 holds 2 unique entries and maxTotal=3, so importing
    // 2 distinct entries into chat:2 fails on maxTotal=3, whereas importing duplicates
    // of a single distinct entry succeeds.
    assert.throws(
      () => store.importFollows("chat:2", ["market:30", "market:30", "market:40"]),
      /total follow limit reached \(3\)/,
    );
    const okRes = store.importFollows("chat:2", ["market:30", "market:30", "market:30"]);
    assert.deepEqual(okRes, {
      added: 1,
      duplicatesSkipped: 2,
      totalForChat: 1,
    });
    assert.deepEqual(store.list("chat:2"), ["market:30"]);
  });
});

test("importStore deduplicates multi-chat imports atomically and rejects malformed refs without partial writes", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({
      filePath,
      maxPerChat: 2,
      maxTotal: 3,
    });

    assert.deepEqual(deduplicateFollowRefs(["market:5", "squad:1", "market:5"]), [
      "market:5",
      "squad:1",
    ]);

    const res = store.importStore({
      "chat:a": ["market:1", "market:1", "squad:2"],
      "chat:b": ["market:1", "market:1"],
    });
    assert.deepEqual(res, {
      added: 3,
      duplicatesSkipped: 2,
      totalEntries: 3,
    });

    const snapshot = await fs.readFile(filePath, "utf8");
    assert.throws(
      () =>
        store.importStore({
          "chat:a": ["market:1"],
          "chat:b": ["INVALID_REF"],
        }),
      FollowStoreError,
    );
    assert.equal(await fs.readFile(filePath, "utf8"), snapshot);
  });
});
