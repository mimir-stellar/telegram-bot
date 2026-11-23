/**
 * follow-store-network.test.mjs
 *
 * Covers the network-identity features added to FollowStore for issue #746:
 *   - New stores created with a `network` option write version-2 files that
 *     record the passphrase.
 *   - Opening a version-2 file with the same network works normally.
 *   - Opening a version-2 file with a different network throws FollowStoreError.
 *   - Opening a version-1 file (no network field) with a network set throws
 *     FollowStoreError, prompting an explicit migration.
 *   - `migrateToNetwork()` upgrades a version-1 file to version 2 and
 *     preserves all existing follows.
 *   - After migration, the store accepts the network.
 *   - Stores created without a `network` option continue to work exactly as
 *     before (backwards compatibility).
 *
 * Before (version 1): no network field; a file created on mainnet could be
 * silently reused on testnet.
 * After (version 2): the network passphrase is stored; any mismatch is
 * detected and refused.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createFollowStore, STORE_VERSION } from "../dist/subscriptions/store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "follow-net-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function storeAt(dir, name, network) {
  return createFollowStore({
    filePath: path.join(dir, name ?? "follows.json"),
    ...(network !== undefined ? { network } : {}),
  });
}

// ── STORE_VERSION ─────────────────────────────────────────────────────────────

test("STORE_VERSION is 2 after the network-identity change", () => {
  assert.equal(STORE_VERSION, 2);
});

// ── New files write version 2 when network is provided ───────────────────────

test("a new store with network writes a version-2 file recording the passphrase", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath, network: TESTNET });

    store.follow("chat:1", "market:abc");

    const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.equal(raw.version, 2, "file must be version 2");
    assert.equal(raw.network, TESTNET, "file must record the network passphrase");
    assert.ok(Array.isArray(raw.follows["chat:1"]), "follows must be preserved");
  });
});

test("a new store without network writes a version-1 file (backwards compat)", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath });

    store.follow("chat:1", "market:xyz");

    const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.equal(raw.version, 1, "file without network option must stay version 1");
    assert.equal(raw.network, undefined, "file must not have a network field");
  });
});

// ── Same network: normal operation ───────────────────────────────────────────

test("opening a version-2 file with the matching network works normally", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");

    const a = createFollowStore({ filePath, network: TESTNET });
    a.follow("chat:1", "market:abc");

    const b = createFollowStore({ filePath, network: TESTNET });
    assert.deepEqual(b.list("chat:1"), ["market:abc"]);
    b.follow("chat:1", "market:def");
    assert.deepEqual(b.list("chat:1"), ["market:abc", "market:def"]);
  });
});

// ── Different network: refuse ─────────────────────────────────────────────────

test("opening a version-2 file with a different network throws FollowStoreError", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");

    const a = createFollowStore({ filePath, network: TESTNET });
    a.follow("chat:1", "market:abc");

    const b = createFollowStore({ filePath, network: MAINNET });
    assert.throws(
      () => b.list("chat:1"),
      (err) =>
        err.name === "FollowStoreError" &&
        /different network/.test(err.message),
      "must refuse cross-network reuse",
    );
  });
});

test("follow() on a mismatched network also throws", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");

    const a = createFollowStore({ filePath, network: MAINNET });
    a.follow("chat:1", "market:a");

    const b = createFollowStore({ filePath, network: TESTNET });
    assert.throws(
      () => b.follow("chat:1", "market:b"),
      (err) => err.name === "FollowStoreError" && /different network/.test(err.message),
    );
    // Original chat data must be untouched.
    const c = createFollowStore({ filePath, network: MAINNET });
    assert.deepEqual(c.list("chat:1"), ["market:a"]);
  });
});

// ── Version-1 file with network set: refuse until migrated ───────────────────

test("opening a version-1 file with a network set throws FollowStoreError", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    // Write a plain version-1 file by hand.
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ version: 1, follows: { "chat:1": ["market:abc"] } }),
      "utf8",
    );

    const store = createFollowStore({ filePath, network: TESTNET });
    assert.throws(
      () => store.list("chat:1"),
      (err) =>
        err.name === "FollowStoreError" &&
        /no network identity/.test(err.message) &&
        /migrateToNetwork/.test(err.message),
      "must prompt migration for version-1 files",
    );
  });
});

// ── migrateToNetwork ──────────────────────────────────────────────────────────

test("migrateToNetwork upgrades a version-1 file and preserves follows", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ version: 1, follows: { "chat:1": ["market:abc", "squad:q1"] } }),
      "utf8",
    );

    const store = createFollowStore({ filePath, network: TESTNET });
    store.migrateToNetwork(TESTNET);

    const raw = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    assert.equal(raw.version, 2, "must upgrade to version 2");
    assert.equal(raw.network, TESTNET, "must record the network");
    assert.deepEqual(raw.follows["chat:1"], ["market:abc", "squad:q1"], "follows must be preserved");
  });
});

test("after migrateToNetwork the store reads and writes normally", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ version: 1, follows: { "chat:1": ["market:abc"] } }),
      "utf8",
    );

    const store = createFollowStore({ filePath, network: TESTNET });
    store.migrateToNetwork(TESTNET);

    // Now reads and writes must work without errors.
    assert.deepEqual(store.list("chat:1"), ["market:abc"]);
    store.follow("chat:1", "squad:s1");
    assert.deepEqual(store.list("chat:1"), ["market:abc", "squad:s1"]);
  });
});

test("migrateToNetwork throws when the file does not exist", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "no-such-file.json");
    const store = createFollowStore({ filePath, network: TESTNET });
    assert.throws(
      () => store.migrateToNetwork(TESTNET),
      (err) =>
        err.name === "FollowStoreError" && /does not exist/.test(err.message),
    );
  });
});

test("migrateToNetwork throws when the file is already version 2", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const store = createFollowStore({ filePath, network: TESTNET });
    store.follow("chat:1", "market:abc"); // creates v2 file

    assert.throws(
      () => store.migrateToNetwork(TESTNET),
      (err) =>
        err.name === "FollowStoreError" && /already at version/.test(err.message),
    );
  });
});

test("migrateToNetwork throws on empty network string", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({ version: 1, follows: {} }),
      "utf8",
    );
    const store = createFollowStore({ filePath });
    assert.throws(
      () => store.migrateToNetwork(""),
      (err) => err.name === "FollowStoreError",
    );
  });
});

// ── Backwards compatibility: no network option ────────────────────────────────

test("stores without network option are unaffected by version-2 files from other stores", async () => {
  await withTempDir(async (dir) => {
    const filePath = path.join(dir, "follows.json");
    const withNet = createFollowStore({ filePath, network: TESTNET });
    withNet.follow("chat:1", "market:abc");

    // A legacy store (no network option) can still read and write.
    const legacy = createFollowStore({ filePath });
    assert.deepEqual(legacy.list("chat:1"), ["market:abc"]);
    legacy.follow("chat:1", "market:def");
    assert.deepEqual(legacy.list("chat:1"), ["market:abc", "market:def"]);
  });
});
