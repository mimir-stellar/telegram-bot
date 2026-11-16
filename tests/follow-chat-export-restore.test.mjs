import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CHAT_FOLLOW_EXPORT_VERSION,
  FollowStoreError,
  createFollowStore,
  serializeChatExport,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimir-follow-export-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("exports one chat's portable versioned follows and restores into a target chat without crossing chat boundaries", async () => {
  await withTempDir(async (dir) => {
    const srcFile = path.join(dir, "source.json");
    const dstFile = path.join(dir, "dest.json");

    const src = createFollowStore({ filePath: srcFile });
    src.follow("-100111", "market:10");
    src.follow("-100111", "squad:20");
    src.follow("-100222", "market:999");

    const portable = src.exportChat("-100111");
    assert.deepEqual(portable, {
      version: CHAT_FOLLOW_EXPORT_VERSION,
      follows: ["market:10", "squad:20"],
    });
    const jsonText = serializeChatExport(portable);
    assert.equal(jsonText.includes("-100111"), false, "portable export omits source chat ID");
    assert.equal(jsonText.includes("-100222"), false, "must never include other chats");
    assert.equal(jsonText.includes("market:999"), false, "must never include other chats' follows");

    // Restore into "-100333" on a destination store that already holds another chat "-100888".
    const dst = createFollowStore({ filePath: dstFile });
    dst.follow("-100888", "market:777");
    dst.follow("-100333", "market:old");

    const res = dst.restoreChat("-100333", jsonText);
    assert.deepEqual(res, {
      restored: 2,
      added: 2,
      removed: 1,
      follows: ["market:10", "squad:20"],
    });
    assert.deepEqual(dst.list("-100333"), ["market:10", "squad:20"]);
    assert.deepEqual(dst.list("-100888"), ["market:777"], "other chat preserved untouched");

    // Merge mode appends without dropping existing entries for that chat.
    const mergeRes = dst.restoreChat(
      "-100333",
      { version: CHAT_FOLLOW_EXPORT_VERSION, follows: ["squad:20", "market:30"] },
      { mode: "merge" },
    );
    assert.deepEqual(mergeRes, {
      restored: 3,
      added: 1,
      removed: 0,
      follows: ["market:10", "squad:20", "market:30"],
    });
    assert.deepEqual(dst.list("-100888"), ["market:777"]);
  });
});

test("rejects wrong version, cross-chat store maps, malformed refs, and quota overflows atomically", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({
      filePath,
      maxPerChat: 2,
      maxTotal: 3,
    });
    store.follow("chat:keep", "market:1");
    store.follow("chat:target", "squad:2");
    const beforeBytes = await fs.readFile(filePath, "utf8");

    // 1. Unsupported version rejected.
    assert.throws(
      () => store.restoreChat("chat:target", { version: 2, follows: ["market:5"] }),
      /unsupported chat export version: 2/,
    );

    // 2. Full store map (cross-chat object) or extra keys rejected.
    assert.throws(
      () =>
        store.restoreChat("chat:target", {
          version: 1,
          follows: { "chat:other": ["market:5"] },
        }),
      FollowStoreError,
    );
    assert.throws(
      () =>
        store.restoreChat("chat:target", {
          version: 1,
          follows: ["market:5"],
          otherChat: "chat:keep",
        }),
      /unexpected field in chat export: otherChat/,
    );

    // 3. Any invalid reference aborts the entire restore before touching disk.
    assert.throws(
      () =>
        store.restoreChat("chat:target", {
          version: 1,
          follows: ["market:5", "BAD_REF"],
        }),
      /invalid ref in chat export: BAD_REF/,
    );

    // 4. Per-chat limit (maxPerChat=2) enforced atomically.
    assert.throws(
      () =>
        store.restoreChat("chat:target", {
          version: 1,
          follows: ["market:10", "market:20", "market:30"],
        }),
      /per-chat follow limit reached \(2\)/,
    );

    // 5. Global limit (maxTotal=3, chat:keep has 1, restoring 2 into chat:new while chat:target has 1 -> 4 > 3).
    assert.throws(
      () =>
        store.restoreChat("chat:new", {
          version: 1,
          follows: ["market:10", "market:20"],
        }),
      /total follow limit reached \(3\)/,
    );

    // Store bytes and both chats remain 100% unchanged after every rejected restore!
    assert.equal(await fs.readFile(filePath, "utf8"), beforeBytes);
    assert.deepEqual(store.list("chat:keep"), ["market:1"]);
    assert.deepEqual(store.list("chat:target"), ["squad:2"]);
    assert.deepEqual(store.list("chat:new"), []);

    // Replacing chat:target (currently 1 entry) with 2 entries keeps total = 1 (chat:keep) + 2 = 3 <= maxTotal(3)!
    const ok = store.restoreChat("chat:target", {
      version: 1,
      follows: ["market:10", "market:20"],
    });
    assert.equal(ok.restored, 2);
    assert.deepEqual(store.list("chat:keep"), ["market:1"]);
    assert.deepEqual(store.list("chat:target"), ["market:10", "market:20"]);
  });
});
