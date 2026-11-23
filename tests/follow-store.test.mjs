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

    store.follow('chat:1', 'market:abc');
    store.follow('chat:1', 'squad:m1');
    store.follow('chat:2', 'market:abc');

    assert.deepStrictEqual(store.list('chat:1'), ['market:abc', 'squad:m1']);
    assert.deepStrictEqual(store.list('chat:2'), ['market:abc']);
    assert.deepStrictEqual(store.followersOf('market:abc'), ['chat:1', 'chat:2']);
    assert.deepStrictEqual(store.followersOf('squad:m1'), ['chat:1']);

    store.unfollow('chat:1', 'market:abc');
    assert.deepStrictEqual(store.list('chat:1'), ['squad:m1']);
    assert.deepStrictEqual(store.followersOf('market:abc'), ['chat:2']);
  });
});

test('persistence across instances', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const a = createFollowStore({ filePath });
    a.follow('chat:1', 'market:abc');
    a.follow('chat:1', 'squad:m1');

    const b = createFollowStore({ filePath });
    assert.deepStrictEqual(b.list('chat:1'), ['market:abc', 'squad:m1']);
    assert.deepStrictEqual(b.followersOf('market:abc'), ['chat:1']);

    const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    assert.strictEqual(typeof raw.version, 'number');
  });
});

test('follow is idempotent', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    store.follow('chat:1', 'market:abc');
    store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(store.list('chat:1'), ['market:abc']);
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
    assert.deepStrictEqual(store.list('chat:1'), []);
  });
});

test('enforces per-chat cap', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxFollowsPerChat: 2,
    });
    store.follow('chat:1', 'market:a1');
    store.follow('chat:1', 'market:a2');
    assert.throws(() => store.follow('chat:1', 'market:a3'), /per-chat follow limit reached \(2\)/);
    assert.deepStrictEqual(store.list('chat:1'), ['market:a1', 'market:a2']);
    // Other chats unaffected.
    store.follow('chat:2', 'market:a1');
    assert.deepStrictEqual(store.list('chat:2'), ['market:a1']);
  });
});

test('enforces total cap', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxTotalEntries: 3,
    });
    store.follow('chat:1', 'market:a1');
    store.follow('chat:1', 'market:a2');
    store.follow('chat:2', 'market:a3');
    assert.throws(() => store.follow('chat:2', 'market:a4'), /total follow limit reached \(3\)/);
    // Idempotent re-follow of existing entry is allowed even at cap.
    store.follow('chat:1', 'market:a1');
    assert.deepStrictEqual(store.list('chat:1'), ['market:a1', 'market:a2']);
    assert.deepStrictEqual(store.list('chat:2'), ['market:a3']);
  });
});

test('quarantines corrupt file and starts fresh', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    await fs.promises.writeFile(filePath, '{ not json ::', 'utf8');

    const store = createFollowStore({ filePath });
    assert.deepStrictEqual(store.list('chat:1'), []);
    store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(store.list('chat:1'), ['market:abc']);

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
    assert.deepStrictEqual(store.list('chat:1'), []);
    store.follow('chat:1', 'market:abc');
    assert.deepStrictEqual(store.list('chat:1'), ['market:abc']);
  });
});

test('writes atomically via temp + rename', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    const store = createFollowStore({ filePath });
    store.follow('chat:1', 'market:abc');
    const files = await fs.promises.readdir(dir);
    assert.deepStrictEqual(files, ['follows.json']);
  });
});

test('expires inactive follows after the configured TTL and keeps active ones', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    let clock = 1_000_000;
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      inactivityTtlMs: 100,
      now: () => clock,
    });
    store.follow('chat:1', 'market:old');
    store.follow('chat:1', 'market:active');

    clock += 60;
    assert.strictEqual(store.touch('chat:1', 'market:active'), true);

    // At t+120: market:old (expires t+100) is pruned; market:active (expires t+160) survives.
    clock += 60;
    assert.deepStrictEqual(store.list('chat:1'), ['market:active']);
    assert.deepStrictEqual(store.followersOf('market:old'), []);
    assert.deepStrictEqual(store.followersOf('market:active'), ['chat:1']);
  });
});

test('boundary: follow exactly at expiry is pruned; one ms earlier is kept', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    let clock = 0;
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      inactivityTtlMs: 50,
      now: () => clock,
    });
    store.follow('chat:1', 'market:edge');
    clock = 49;
    assert.deepStrictEqual(store.list('chat:1'), ['market:edge']);
    clock = 50;
    assert.deepStrictEqual(store.list('chat:1'), []);
  });
});

test('touch returns false for unknown or expired follows and does not resurrect them', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    let clock = 0;
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      inactivityTtlMs: 10,
      now: () => clock,
    });
    assert.strictEqual(store.touch('chat:1', 'market:none'), false);
    store.follow('chat:1', 'market:x');
    clock = 20;
    assert.strictEqual(store.touch('chat:1', 'market:x'), false);
    assert.deepStrictEqual(store.list('chat:1'), []);
  });
});

test('pruneExpiredFollows reports and persists removal without touching active follows', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    let clock = 0;
    const filePath = pathJoin(dir, 'follows.json');
    const store = createFollowStore({ filePath, inactivityTtlMs: 10, now: () => clock });
    store.follow('chat:1', 'market:a');
    clock = 5;
    store.follow('chat:2', 'market:b');
    clock = 12;
    assert.strictEqual(store.pruneExpiredFollows(), 1);
    const reopened = createFollowStore({ filePath, inactivityTtlMs: 10, now: () => clock });
    assert.deepStrictEqual(reopened.list('chat:1'), []);
    assert.deepStrictEqual(reopened.list('chat:2'), ['market:b']);
  });
});

test('rejects non-positive inactivity TTL', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    assert.throws(
      () => createFollowStore({ filePath: pathJoin(dir, 'f.json'), inactivityTtlMs: 0 }),
      { name: 'FollowStoreError' },
    );
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

test('deduplicates duplicate references on load without consuming extra quota slots', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const filePath = pathJoin(dir, 'follows.json');
    await fs.promises.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        follows: {
          'chat:1': ['market:a1', 'market:a1', 'squad:s1', 'market:a1'],
          'chat:2': ['market:b1', 'market:b1'],
        },
      }),
      'utf8',
    );

    const store = createFollowStore({
      filePath,
      maxPerChat: 3,
      maxTotal: 4,
    });

    assert.deepStrictEqual(store.list('chat:1'), ['market:a1', 'squad:s1']);
    assert.deepStrictEqual(store.list('chat:2'), ['market:b1']);

    // Only 3 unique entries exist (2 in chat:1, 1 in chat:2), so 1 more fits under both caps.
    assert.strictEqual(store.follow('chat:1', 'market:a2'), true);
    assert.deepStrictEqual(store.list('chat:1'), ['market:a1', 'squad:s1', 'market:a2']);
    assert.throws(() => store.follow('chat:1', 'market:a3'), /per-chat follow limit reached \(3\)/);
    assert.throws(() => store.follow('chat:2', 'market:b2'), /total follow limit reached \(4\)/);
  });
});

test('import deduplicates within payload and against existing follows before enforcing limits', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxPerChat: 2,
      maxTotal: 3,
    });

    store.follow('chat:1', 'market:a1');

    // 3 entries in payload, but market:a1 is already followed and market:a2 is duplicated -> 1 net new.
    const res1 = store.import({
      'chat:1': ['market:a1', 'market:a2', 'market:a2'],
    });
    assert.deepStrictEqual(res1, { added: 1, skipped: 2 });
    assert.deepStrictEqual(store.list('chat:1'), ['market:a1', 'market:a2']);

    // StoreFile payload format also supported and deduplicated before total cap check.
    const res2 = store.import({
      version: 1,
      follows: {
        'chat:2': ['squad:s1', 'squad:s1'],
      },
    });
    assert.deepStrictEqual(res2, { added: 1, skipped: 1 });
    assert.deepStrictEqual(store.list('chat:2'), ['squad:s1']);
  });
});

test('import rejects limit violations and malformed inputs atomically without partial writes', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxPerChat: 2,
      maxTotal: 3,
    });

    store.follow('chat:1', 'market:a1');

    // Per-chat cap exceeded even after deduplication.
    assert.throws(
      () => store.import({ 'chat:1': ['market:a2', 'market:a2', 'market:a3'] }),
      /per-chat follow limit reached \(2\)/,
    );
    assert.deepStrictEqual(store.list('chat:1'), ['market:a1']);

    // Total cap exceeded across multiple chats; chat:2 must not be partially persisted.
    assert.throws(
      () =>
        store.import({
          'chat:2': ['market:b1', 'market:b2'],
          'chat:3': ['market:c1'],
        }),
      /total follow limit reached \(3\)/,
    );
    assert.deepStrictEqual(store.list('chat:2'), []);
    assert.deepStrictEqual(store.list('chat:3'), []);

    // Malformed ref in a later chat aborts the entire import.
    assert.throws(
      () =>
        store.import({
          'chat:2': ['market:b1'],
          'chat:3': ['badref'],
        }),
      { name: 'FollowStoreError' },
    );
    assert.deepStrictEqual(store.list('chat:2'), []);
  });
});
