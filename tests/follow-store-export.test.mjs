/**
 * follow-store-export.test.mjs
 *
 * Covers `exportChat` and `importChat` on `FollowStore` for issue #740.
 *
 * Before/after:
 *   Before: no portable export/import API existed. Copying one chat's follows
 *   to another instance required reading the raw JSON file, which carries all
 *   chats and offers no cross-boundary protection.
 *   After: `exportChat(chatId)` returns a versioned, chat-scoped snapshot;
 *   `importChat(chatId, snapshot)` validates the boundary, all refs, and both
 *   quota limits before atomically replacing the target chat's follows.
 *
 * Tests verify:
 *   - export returns a versioned object with the right chatId and refs
 *   - export of an unknown chat returns an empty refs array (not an error)
 *   - import restores the follows exactly
 *   - import with a mismatched chatId throws (chat-boundary enforcement)
 *   - import with an invalid export version throws
 *   - import with an invalid ref throws
 *   - import enforces maxPerChat quota before any write
 *   - import enforces maxTotal quota before any write (other chats count)
 *   - import replaces rather than merges (existing follows are overwritten)
 *   - import with empty refs clears the chat without touching others
 *   - import silently deduplicates repeated refs in the export
 *   - other chats are never touched by an import
 *   - the round-trip is lossless: export then import produces the same list
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFollowStore,
  EXPORT_VERSION,
} from "../dist/subscriptions/store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "follow-export-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function storeAt(dir, name = "follows.json", opts = {}) {
  return createFollowStore({ filePath: path.join(dir, name), ...opts });
}

// ── EXPORT_VERSION ────────────────────────────────────────────────────────────

test("EXPORT_VERSION is 1", () => {
  assert.equal(EXPORT_VERSION, 1);
});

// ── exportChat ────────────────────────────────────────────────────────────────

test("exportChat returns a versioned object with the correct chatId and refs", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    store.follow("chat:1", "market:abc");
    store.follow("chat:1", "squad:q1");

    const exp = store.exportChat("chat:1");

    assert.equal(exp.version, EXPORT_VERSION);
    assert.equal(exp.chatId, "chat:1");
    assert.deepEqual(exp.refs, ["market:abc", "squad:q1"]);
  });
});

test("exportChat of an unknown chat returns an empty refs array", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    const exp = store.exportChat("chat:nobody");
    assert.equal(exp.version, EXPORT_VERSION);
    assert.equal(exp.chatId, "chat:nobody");
    assert.deepEqual(exp.refs, []);
  });
});

test("exportChat only contains the target chat's refs", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    store.follow("chat:1", "market:a");
    store.follow("chat:2", "market:b");
    store.follow("chat:2", "squad:c");

    const exp = store.exportChat("chat:1");
    assert.deepEqual(exp.refs, ["market:a"]);
    assert.ok(!JSON.stringify(exp).includes("market:b"), "must not include chat:2 data");
  });
});

test("exportChat throws on empty chatId", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    assert.throws(() => store.exportChat(""), { name: "FollowStoreError" });
  });
});

// ── importChat ────────────────────────────────────────────────────────────────

test("importChat restores the follows and returns the ref count", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    store.follow("chat:1", "market:old");

    const count = store.importChat("chat:1", {
      version: 1,
      chatId: "chat:1",
      refs: ["market:new1", "squad:new2"],
    });

    assert.equal(count, 2);
    assert.deepEqual(store.list("chat:1"), ["market:new1", "squad:new2"]);
  });
});

test("round-trip: exportChat then importChat reproduces the same list", async () => {
  await withTempDir(async (dir) => {
    const src = storeAt(dir, "a.json");
    src.follow("chat:1", "market:abc");
    src.follow("chat:1", "squad:q1");
    src.follow("chat:1", "market:xyz");

    const exp = src.exportChat("chat:1");

    const dst = storeAt(dir, "b.json");
    dst.importChat("chat:1", exp);

    assert.deepEqual(dst.list("chat:1"), ["market:abc", "squad:q1", "market:xyz"]);
  });
});

// ── Chat-boundary enforcement ─────────────────────────────────────────────────

test("importChat refuses an export whose chatId differs from the target chatId", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);

    assert.throws(
      () =>
        store.importChat("chat:target", {
          version: 1,
          chatId: "chat:other",
          refs: ["market:abc"],
        }),
      (err) =>
        err.name === "FollowStoreError" &&
        /chat boundaries/.test(err.message),
      "must refuse cross-chat import",
    );

    // Target chat must be untouched.
    assert.deepEqual(store.list("chat:target"), []);
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

test("importChat throws on unknown export version", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    assert.throws(
      () => store.importChat("chat:1", { version: 99, chatId: "chat:1", refs: [] }),
      (err) =>
        err.name === "FollowStoreError" && /unsupported export version/.test(err.message),
    );
  });
});

test("importChat throws when refs contains an invalid ref", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    assert.throws(
      () =>
        store.importChat("chat:1", {
          version: 1,
          chatId: "chat:1",
          refs: ["market:abc", "not-valid"],
        }),
      (err) => err.name === "FollowStoreError" && /invalid ref/.test(err.message),
    );
    // Store must be untouched.
    assert.deepEqual(store.list("chat:1"), []);
  });
});

test("importChat throws when exported data is not a plain object", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    for (const bad of [null, 42, "string", [1, 2, 3]]) {
      assert.throws(
        () => store.importChat("chat:1", bad),
        { name: "FollowStoreError" },
        `must reject ${JSON.stringify(bad)}`,
      );
    }
  });
});

test("importChat throws on empty chatId", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    assert.throws(
      () => store.importChat("", { version: 1, chatId: "", refs: [] }),
      { name: "FollowStoreError" },
    );
  });
});

// ── Quota enforcement ─────────────────────────────────────────────────────────

test("importChat throws when ref count exceeds maxPerChat and leaves the store untouched", async () => {
  await withTempDir(async (dir) => {
    const store = createFollowStore({
      filePath: path.join(dir, "follows.json"),
      maxFollowsPerChat: 2,
    });
    store.follow("chat:1", "market:existing");

    assert.throws(
      () =>
        store.importChat("chat:1", {
          version: 1,
          chatId: "chat:1",
          refs: ["market:a", "market:b", "market:c"], // 3 > 2
        }),
      (err) =>
        err.name === "FollowStoreError" && /per-chat follow limit/.test(err.message),
    );
    // Original follow must be untouched.
    assert.deepEqual(store.list("chat:1"), ["market:existing"]);
  });
});

test("importChat throws when total exceeds maxTotal (other chats count)", async () => {
  await withTempDir(async (dir) => {
    const store = createFollowStore({
      filePath: path.join(dir, "follows.json"),
      maxTotalEntries: 3,
    });
    store.follow("chat:2", "market:a");
    store.follow("chat:2", "market:b"); // 2 total already

    // chat:1 currently has 0 follows; importing 2 would bring total to 4 > 3.
    assert.throws(
      () =>
        store.importChat("chat:1", {
          version: 1,
          chatId: "chat:1",
          refs: ["market:c", "squad:d"], // +2, total would be 4
        }),
      (err) =>
        err.name === "FollowStoreError" && /total follow limit/.test(err.message),
    );
    // chat:2 must be untouched.
    assert.deepEqual(store.list("chat:2"), ["market:a", "market:b"]);
    assert.deepEqual(store.list("chat:1"), []);
  });
});

// ── Replace semantics ─────────────────────────────────────────────────────────

test("importChat replaces existing follows rather than merging", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    store.follow("chat:1", "market:old1");
    store.follow("chat:1", "market:old2");

    store.importChat("chat:1", {
      version: 1,
      chatId: "chat:1",
      refs: ["squad:new"],
    });

    assert.deepEqual(store.list("chat:1"), ["squad:new"], "old follows must be gone");
  });
});

test("importChat with empty refs clears the target chat", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    store.follow("chat:1", "market:a");
    store.follow("chat:1", "market:b");

    const count = store.importChat("chat:1", { version: 1, chatId: "chat:1", refs: [] });

    assert.equal(count, 0);
    assert.deepEqual(store.list("chat:1"), []);
  });
});

test("importChat silently deduplicates repeated refs in the export", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);

    const count = store.importChat("chat:1", {
      version: 1,
      chatId: "chat:1",
      refs: ["market:a", "market:a", "squad:b", "market:a"],
    });

    assert.equal(count, 2, "duplicates must be collapsed");
    assert.deepEqual(store.list("chat:1"), ["market:a", "squad:b"]);
  });
});

// ── Chat isolation ────────────────────────────────────────────────────────────

test("importChat does not modify other chats", async () => {
  await withTempDir(async (dir) => {
    const store = storeAt(dir);
    store.follow("chat:1", "market:c1");
    store.follow("chat:2", "market:c2");
    store.follow("chat:3", "squad:c3");

    store.importChat("chat:1", {
      version: 1,
      chatId: "chat:1",
      refs: ["squad:new"],
    });

    // Other chats must be exactly as before.
    assert.deepEqual(store.list("chat:2"), ["market:c2"]);
    assert.deepEqual(store.list("chat:3"), ["squad:c3"]);
  });
});
