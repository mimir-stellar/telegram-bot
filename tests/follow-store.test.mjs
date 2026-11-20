import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';

// The follow store (#676) is synchronous: follow() and friends return or throw
// directly, so failures are asserted with assert.throws, not assert.rejects.
const modulePath = new URL('../dist/subscriptions/store.js', import.meta.url);

async function importStore() {
  return import(modulePath.href);
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(os.tmpdir() + '/follow-store-test-');
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function pathJoin(...parts) {
  return parts.join(os.platform === 'win32' ? '\\' : '/');
}

test('follow / unfollow / list / followersOf basic flow', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });

    await store.follow('chat:1', 'market:abc');
    await store.follow('chat:1', 'squad:m1');
    await store.follow('chat:2', 'market:abc');

    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc', 'squad:m1']);
    assert.deepStrictEqual(await store.list('chat:2'), ['market:abc']);
    assert.deepStrictEqual(await store.followersOf('market:abc'), ['chat:1', 'chat:2']);
    assert.deepStrictEqual(await store.followersOf('squad:m1'), ['chat:1']);

    await store.unfollow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['squad:m1']);
    assert.deepStrictEqual(await store.followersOf('market:abc'), ['chat:2']);
  });
});

test('persistence across instances', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const a = createFollowStore({ filePath });
    await a.follow('chat:1', 'market:abc');
    await a.follow('chat:1', 'squad:m1');

    const b = createFollowStore({ filePath });
    assert.deepStrictEqual(await b.list('chat:1'), ['market:abc', 'squad:m1']);
    assert.deepStrictEqual(await b.followersOf('market:abc'), ['chat:1']);

    const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    assert.strictEqual(typeof raw.version, 'number');
  });
});

test('follow is idempotent', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    await store.follow('chat:1', 'market:abc');
    await store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc']);
  });
});

test('rejects malformed refs', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const bad = ['', 'market:', 'market: ', 'foo', 'foo:bar', 'market:a:b', 'squad:', 'MARKET:abc', 'market:abc '];
    for (const ref of bad) {
      assert.throws(() => store.follow('chat:1', ref), { name: 'FollowStoreError' }, `ref ${JSON.stringify(ref)} should be rejected`);
    }
    assert.deepStrictEqual(await store.list('chat:1'), []);
  });
});

test('enforces per-chat cap', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxFollowsPerChat: 2,
    });
    await store.follow('chat:1', 'market:a1');
    await store.follow('chat:1', 'market:a2');
    await assert.rejects(() => store.follow('chat:1', 'market:a3'), /per-chat follow limit reached \(2\)/);
    assert.deepStrictEqual(await store.list('chat:1'), ['market:a1', 'market:a2']);
    // Other chats unaffected.
    await store.follow('chat:2', 'market:a1');
    assert.deepStrictEqual(await store.list('chat:2'), ['market:a1']);
  });
});

test('enforces total cap', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxTotalEntries: 3,
    });
    await store.follow('chat:1', 'market:a1');
    await store.follow('chat:1', 'market:a2');
    await store.follow('chat:2', 'market:a3');
    await assert.rejects(() => store.follow('chat:2', 'market:a4'), /total follow limit reached \(3\)/);
    // Idempotent re-follow of existing entry is allowed even at cap.
    await store.follow('chat:1', 'market:a1');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:a1', 'market:a2']);
    assert.deepStrictEqual(await store.list('chat:2'), ['market:a3']);
  });
});

test('quarantines corrupt file and starts fresh', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    await fs.promises.writeFile(filePath, '{ not json ::', 'utf8');

    const store = createFollowStore({ filePath });
    assert.deepStrictEqual(await store.list('chat:1'), []);
    await store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc']);

    const files = await fs.promises.readdir(dir);
    const quarantined = files.filter((f) => f !== 'follows.json' && f.includes('follows.json'));
    assert.ok(quarantined.length >= 1, 'corrupt file should be quarantined');
  });
});

test('quarantines wrong shape file', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    await fs.promises.writeFile(filePath, JSON.stringify({ version: 1, follows: 'not-an-array' }), 'utf8');

    const store = createFollowStore({ filePath });
    assert.deepStrictEqual(await store.list('chat:1'), []);
    await store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:abc']);
  });
});

test('writes atomically via temp + rename', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const store = createFollowStore({ filePath });
    await store.follow('chat:1', 'market:abc');
    const files = await fs.promises.readdir(dir);
    assert.deepStrictEqual(files, ['follows.json']);
  });
});

test('retains corrupt follow file bytes and throws redacted actionable error when quarantine rename fails', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const raw = '{"version":1,"follows":{"chat:1":["market:precious"';
    await fs.promises.writeFile(filePath, raw, 'utf8');
    const ts = 1_700_000_000_000;
    await fs.promises.mkdir(pathJoin(dir, `follows.json.corrupt.${ts}`), { recursive: true });
    await fs.promises.writeFile(pathJoin(dir, `follows.json.corrupt.${ts}`, 'k'), 'x', 'utf8');
    const realNow = Date.now;
    Date.now = () => ts;
    try {
      const s = createFollowStore({ filePath, now: () => ts });
      for (const op of [() => s.list('c'), () => s.followersOf('market:a')]) {
        assert.throws(op, (e) => e.name === 'FollowStoreError' && /quarantine.*retained in place/i.test(e.message));
      }
      for (const op of [() => s.follow('c', 'market:a'), () => s.unfollow('c', 'market:a')]) {
        await assert.rejects(op, (e) => e.name === 'FollowStoreError' && /quarantine.*retained in place/i.test(e.message));
      }
    } finally {
      Date.now = realNow;
    }
    assert.strictEqual(await fs.promises.readFile(filePath, 'utf8'), raw);
  });
});

test('preserves unreadable follow file and redacts credentials when read and quarantine both fail', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
    await fs.promises.writeFile(filePath, raw);
    const url = 'https://' + 'op' + ':' + 'hunter2secret' + '@rpc.example.invalid';
    let unlinked = false;
    const s = createFollowStore({
      filePath,
      now: () => 1_700_000_000_123,
      fs: {
        readFileSync: () => { throw new Error(`EACCES: ${url}`); },
        renameSync: () => { throw new Error(`EROFS: ${url}`); },
        unlinkSync: () => { unlinked = true; },
      },
    });
    await assert.rejects(() => s.follow('c', 'market:a'), (e) => e.name === 'FollowStoreError' && !e.message.includes('hunter2secret') && e.message.includes('[REDACTED]') && /EROFS/.test(e.message));
    assert.strictEqual(unlinked, false);
    assert.strictEqual(Buffer.compare(await fs.promises.readFile(filePath), raw), 0);
  });
});

// ── #742 – serialized follow-store mutations ──────────────────────────────────

test('concurrent follow calls on the same ref are idempotent and preserve the set', async () => {
  // Fire 10 concurrent follow() calls for the same ref. Because each is
  // serialized through the mutex, the final set must contain exactly one
  // entry, and the results must be: first true, then all false.
  const { createFollowStore } = await importStore();
  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: dir + '/follows.json' });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.follow('chat:1', 'market:42')),
    );
    assert.strictEqual(results.filter(Boolean).length, 1, 'exactly one follow should succeed');
    assert.strictEqual(results.filter((r) => !r).length, 9, 'remaining nine should be no-ops');
    assert.deepStrictEqual(await store.list('chat:1'), ['market:42']);
  });
});

test('concurrent follow and unfollow operations preserve the expected final set', async () => {
  // Add two refs sequentially, then concurrently follow a third ref and
  // unfollow the first. The final set must be exactly ['market:b', 'market:c'].
  const { createFollowStore } = await importStore();
  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: dir + '/follows.json' });
    await store.follow('chat:1', 'market:a');
    await store.follow('chat:1', 'market:b');

    // Race: unfollow 'a' while following 'c'.
    await Promise.all([
      store.unfollow('chat:1', 'market:a'),
      store.follow('chat:1', 'market:c'),
    ]);

    assert.deepStrictEqual(await store.list('chat:1'), ['market:b', 'market:c']);
  });
});

test('concurrent follow calls for distinct refs all land in the final set', async () => {
  // 20 goroutine-style concurrent follows for 20 different refs.
  // Every ref must appear exactly once in the final list.
  const { createFollowStore } = await importStore();
  await withTempDir(async (dir) => {
    const store = createFollowStore({ filePath: dir + '/follows.json' });
    const refs = Array.from({ length: 20 }, (_, i) => `market:${i + 1}`);
    const results = await Promise.all(refs.map((ref) => store.follow('chat:1', ref)));
    // All 20 must have returned true (new follow).
    assert.ok(results.every(Boolean), 'all concurrent follows for distinct refs should succeed');
    const finalList = await store.list('chat:1');
    assert.strictEqual(finalList.length, 20, 'final list must contain all 20 refs');
    for (const ref of refs) {
      assert.ok(finalList.includes(ref), `${ref} must be in the final list`);
    }
  });
});

test('a rejected mutation does not block subsequent operations', async () => {
  // If one operation rejects (e.g. cap exceeded), the mutex chain must
  // recover and let the next operation proceed normally.
  const { createFollowStore } = await importStore();
  await withTempDir(async (dir) => {
    const store = createFollowStore({
      filePath: dir + '/follows.json',
      maxFollowsPerChat: 1,
    });
    await store.follow('chat:1', 'market:a');
    // This one rejects because the cap is reached.
    await assert.rejects(() => store.follow('chat:1', 'market:b'), /per-chat follow limit reached/);
    // The store must still be usable.
    assert.deepStrictEqual(await store.list('chat:1'), ['market:a']);
    await store.unfollow('chat:1', 'market:a');
    assert.deepStrictEqual(await store.list('chat:1'), []);
  });
});
