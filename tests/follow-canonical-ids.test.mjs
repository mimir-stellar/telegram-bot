import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  FollowStoreError,
  MAX_FOLLOW_ID,
  STORE_VERSION,
  createFollowStore,
  isCanonicalFollowId,
  parseRef,
} from "../dist/bot.js";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimir-follow-canonical-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("accepts canonical unsigned u64 market and squad identifiers including 0 and u64::MAX", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath });

    const validIds = [
      "0",
      "1",
      "42",
      "9007199254740993", // > Number.MAX_SAFE_INTEGER, exact string preserved
      MAX_FOLLOW_ID.toString(), // 18446744073709551615 (u64::MAX)
    ];

    for (const id of validIds) {
      assert.equal(isCanonicalFollowId(id), true, `expected ${id} to be canonical`);
      assert.deepEqual(parseRef(`market:${id}`), { kind: "market", id });
      assert.deepEqual(parseRef(`squad:${id}`), { kind: "squad", id });
      assert.equal(store.follow("chat:1", `market:${id}`), true);
      assert.equal(store.follow("chat:1", `squad:${id}`), true);
    }

    const saved = store.list("chat:1");
    assert.equal(saved.length, validIds.length * 2);
    assert.equal(saved.includes(`market:${MAX_FOLLOW_ID.toString()}`), true);
    assert.equal(saved.includes("squad:9007199254740993"), true);
  });
});

test("rejects leading zeros, exponent notation, signed identifiers, radixes, decimals, and oversized u64 strings", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath });

    const nonCanonicalIds = [
      "",
      "00",
      "01",
      "00042",
      "-0",
      "+0",
      "-1",
      "+1",
      "-42",
      "+42",
      "1e3",
      "1E5",
      "1e+2",
      "1e-2",
      "1.0",
      "1.5",
      "1_000",
      "1,000",
      "0x10",
      "0b10",
      "0o10",
      " 1",
      "1 ",
      "1\n",
      "abc",
      "12abc",
      "18446744073709551616", // u64::MAX + 1
      "99999999999999999999", // 20 digits > u64::MAX
      "100000000000000000000", // 21 digits
    ];

    for (const badId of nonCanonicalIds) {
      assert.equal(isCanonicalFollowId(badId), false, `id ${JSON.stringify(badId)} must fail`);
      for (const kind of ["market", "squad"]) {
        const ref = `${kind}:${badId}`;
        assert.equal(parseRef(ref), null, `parseRef(${JSON.stringify(ref)}) must return null`);
        assert.throws(() => store.follow("chat:1", ref), FollowStoreError);
        assert.throws(() => store.unfollow("chat:1", ref), FollowStoreError);
        assert.throws(() => store.followersOf(ref), FollowStoreError);
      }
    }

    assert.deepEqual(store.list("chat:1"), []);
  });
});

test("quarantines store files containing noncanonical persisted references on load", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: STORE_VERSION,
        follows: {
          "chat:1": ["market:01"],
        },
      }),
      "utf8",
    );

    const store = createFollowStore({ filePath });
    assert.deepEqual(store.list("chat:1"), []);
    const entries = await fs.readdir(dir);
    assert.equal(
      entries.some((name) => name.includes("follows.json.corrupt.")),
      true,
      "noncanonical on-disk ref triggers quarantine",
    );
  });
});
