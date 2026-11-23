/**
 * Tests for /follow, /unfollow, and /follows command handlers.
 *
 * Covers:
 *   - /follow: success, idempotent re-follow, invalid ref, missing arg, no store
 *   - /follow: per-chat quota exhaustion → actionable chat feedback, store unchanged
 *   - /follow: global quota exhaustion → actionable chat feedback, store unchanged
 *   - /unfollow: success, not-following case, invalid ref, missing arg, no store
 *   - /follows: empty list, non-empty list, no store
 *
 * Follow operations in FollowStore are synchronous; quota errors are synchronous
 * throws caught by the command handlers and turned into user-facing replies.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const storePath = new URL('../dist/subscriptions/store.js', import.meta.url);
const followPath = new URL('../dist/commands/follow.js', import.meta.url);
const unfollowPath = new URL('../dist/commands/unfollow.js', import.meta.url);
const followsPath = new URL('../dist/commands/follows.js', import.meta.url);

async function importStore() {
  return import(storePath.href);
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(os.tmpdir() + '/follow-cmd-test-');
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function pathJoin(...parts) {
  return parts.join('/');
}

/** Build a minimal grammy-like ctx with a reply capture. */
function makeCtx({ chatId = -1001234567890, userId = 42, match = '' } = {}) {
  const replies = [];
  return {
    replies,
    ctx: {
      chat: { id: chatId, type: 'group' },
      from: { id: userId },
      match,
      message: { text: match ? `/follow ${match}` : '/follow', entities: [] },
      update: { update_id: 1 },
      reply: async (text, opts) => replies.push({ text, opts }),
    },
  };
}

/** Build deps with an optional follow store. */
function makeDeps(followStore) {
  return {
    config: {
      allowedChatIds: [],
      operatorTelegramUserId: null,
      botToken: '123456789:TEST-ONLY-TOKEN-NEVER-USE',
    },
    status: () => ({}),
    pause: () => 'paused',
    resume: () => 'resumed',
    followStore,
  };
}

// ── /follow ──────────────────────────────────────────────────────────────────

test('/follow adds a ref and replies with confirmation', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { followCommand } = await import(followPath.href);

    const { ctx, replies } = makeCtx({ match: 'market:abc' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.includes('Following'), `reply should confirm follow: ${replies[0].text}`);
    assert.ok(replies[0].text.includes('market:abc'), `reply should name the ref`);
    assert.deepEqual(await store.list(String(ctx.chat.id)), ['market:abc']);
  });
});

test('/follow is idempotent and reports already-following', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { followCommand } = await import(followPath.href);

    const chatId = -1001234567890;
    await store.follow(String(chatId), 'market:abc');

    const { ctx, replies } = makeCtx({ chatId, match: 'market:abc' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.toLowerCase().includes('already'), `should say already following`);
    // Store should still contain exactly one entry.
    assert.deepEqual(await store.list(String(chatId)), ['market:abc']);
  });
});

test('/follow with no argument replies with usage hint', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { followCommand } = await import(followPath.href);

    const { ctx, replies } = makeCtx({ match: '' });
    // Simulate no argument by clearing match and message text.
    ctx.match = '';
    ctx.message = { text: '/follow', entities: [] };
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.includes('Usage'), `should show usage hint`);
    assert.deepEqual(await store.list(String(ctx.chat.id)), []);
  });
});

test('/follow rejects an invalid ref and leaves store unchanged', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { followCommand } = await import(followPath.href);

    const chatId = -1001234567890;
    const { ctx, replies } = makeCtx({ chatId, match: 'notaref' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.toLowerCase().includes('invalid'), `should report invalid ref`);
    assert.deepEqual(await store.list(String(chatId)), []);
  });
});

test('/follow with no store replies with not-available message', async () => {
  const { followCommand } = await import(followPath.href);
  const { ctx, replies } = makeCtx({ match: 'market:abc' });
  await followCommand.handler(ctx, makeDeps(undefined));

  assert.equal(replies.length, 1);
  assert.ok(
    replies[0].text.toLowerCase().includes('not available') ||
    replies[0].text.toLowerCase().includes('not configured'),
    `should report store not configured: ${replies[0].text}`,
  );
});

// ── Per-chat quota exhaustion ─────────────────────────────────────────────────

test('/follow per-chat quota exhaustion: actionable reply, store unchanged', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxFollowsPerChat: 2,
    });
    const { followCommand } = await import(followPath.href);

    const chatId = -1001234567890;
    await store.follow(String(chatId), 'market:a1');
    await store.follow(String(chatId), 'market:a2');
    // Chat is now at its per-chat cap.

    const { ctx, replies } = makeCtx({ chatId, match: 'market:a3' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1, 'exactly one reply on quota error');
    const text = replies[0].text;
    // Must mention the per-chat limit (not the global one).
    assert.ok(
      text.toLowerCase().includes('limit') || text.toLowerCase().includes('quota'),
      `reply should mention a limit: ${text}`,
    );
    // Should provide an actionable hint to unfollow.
    assert.ok(
      text.toLowerCase().includes('unfollow'),
      `reply should tell the user to /unfollow something: ${text}`,
    );
    // Store must be unchanged: a3 must NOT have been added.
    assert.deepEqual(
      await store.list(String(chatId)),
      ['market:a1', 'market:a2'],
      'store must not be mutated on a rejected follow',
    );
  });
});

test('/follow per-chat quota reply includes the numeric limit', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxFollowsPerChat: 3,
    });
    const { followCommand } = await import(followPath.href);

    const chatId = -1001234567890;
    for (const id of ['market:a1', 'market:a2', 'market:a3']) {
      await store.follow(String(chatId), id);
    }

    const { ctx, replies } = makeCtx({ chatId, match: 'market:a4' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    // The limit (3) should appear in the reply.
    assert.ok(replies[0].text.includes('3'), `reply should include the numeric limit: ${replies[0].text}`);
  });
});

// ── Global quota exhaustion ───────────────────────────────────────────────────

test('/follow global quota exhaustion: actionable reply, store unchanged', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxTotalEntries: 2,
    });
    const { followCommand } = await import(followPath.href);

    // Fill the global cap from two different chats.
    await store.follow('-100aaa', 'market:a1');
    await store.follow('-100bbb', 'market:a2');

    const chatId = -1001234567890;
    const { ctx, replies } = makeCtx({ chatId, match: 'market:a3' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1, 'exactly one reply on global quota error');
    const text = replies[0].text;
    // Must mention the global/installation-level limit.
    assert.ok(
      text.toLowerCase().includes('global') || text.toLowerCase().includes('installation'),
      `reply should mention global/installation limit: ${text}`,
    );
    // Should point to the operator as the next step.
    assert.ok(
      text.toLowerCase().includes('operator'),
      `reply should tell the user to contact the operator: ${text}`,
    );
    // Store must be unchanged: a3 must NOT have been added.
    assert.deepEqual(
      await store.list(String(chatId)),
      [],
      'store must not be mutated on a rejected global-quota follow',
    );
  });
});

test('/follow global quota reply includes the numeric limit', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({
      filePath: pathJoin(dir, 'follows.json'),
      maxTotalEntries: 2,
    });
    const { followCommand } = await import(followPath.href);

    await store.follow('-100aaa', 'market:a1');
    await store.follow('-100bbb', 'market:a2');

    const chatId = -1001234567890;
    const { ctx, replies } = makeCtx({ chatId, match: 'market:a3' });
    await followCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.includes('2'), `reply should include the numeric limit: ${replies[0].text}`);
  });
});

// ── Per-chat vs global distinction ───────────────────────────────────────────

test('followQuotaMessage distinguishes per-chat and global errors', async () => {
  const { followQuotaMessage } = await import(followPath.href);
  const { FollowStoreError } = await importStore();

  const perChatErr = new FollowStoreError('per-chat follow limit reached (5)');
  const globalErr = new FollowStoreError('total follow limit reached (100)');
  const unknownErr = new FollowStoreError('some other store problem');

  const perChatMsg = followQuotaMessage(perChatErr, '-100test');
  const globalMsg = followQuotaMessage(globalErr, '-100test');
  const unknownMsg = followQuotaMessage(unknownErr, '-100test');

  // Per-chat message mentions unfollow.
  assert.ok(perChatMsg.toLowerCase().includes('unfollow'), `per-chat message should mention /unfollow: ${perChatMsg}`);
  // Per-chat message should NOT mention operator.
  assert.ok(!perChatMsg.toLowerCase().includes('operator'), `per-chat message should not mention operator: ${perChatMsg}`);

  // Global message mentions operator.
  assert.ok(globalMsg.toLowerCase().includes('operator'), `global message should mention operator: ${globalMsg}`);
  // Global message should NOT mention unfollow (no point, it's a system-wide cap).
  assert.ok(!globalMsg.toLowerCase().includes('unfollow'), `global message should not mention /unfollow: ${globalMsg}`);

  // Unknown error is a safe fallback.
  assert.ok(unknownMsg.length > 0);
  // The unknown error should not leak internal store message details.
  assert.ok(!unknownMsg.includes('some other store problem'), `unknown error should not leak internal message: ${unknownMsg}`);
});

// ── /unfollow ─────────────────────────────────────────────────────────────────

test('/unfollow removes a ref and confirms removal', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { unfollowCommand } = await import(unfollowPath.href);

    const chatId = -1001234567890;
    await store.follow(String(chatId), 'market:abc');

    const { ctx, replies } = makeCtx({ chatId, match: 'market:abc' });
    ctx.message = { text: '/unfollow market:abc', entities: [] };
    await unfollowCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.toLowerCase().includes('unfollowed'), `should confirm unfollowed`);
    assert.deepEqual(await store.list(String(chatId)), []);
  });
});

test('/unfollow reports when ref was not followed', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { unfollowCommand } = await import(unfollowPath.href);

    const { ctx, replies } = makeCtx({ match: 'market:abc' });
    ctx.message = { text: '/unfollow market:abc', entities: [] };
    await unfollowCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(
      replies[0].text.toLowerCase().includes('not following') ||
      replies[0].text.toLowerCase().includes('was not'),
      `should report not following: ${replies[0].text}`,
    );
  });
});

test('/unfollow with no argument replies with usage hint', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { unfollowCommand } = await import(unfollowPath.href);

    const { ctx, replies } = makeCtx({ match: '' });
    ctx.match = '';
    ctx.message = { text: '/unfollow', entities: [] };
    await unfollowCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(replies[0].text.includes('Usage'), `should show usage hint`);
  });
});

test('/unfollow with no store replies with not-available message', async () => {
  const { unfollowCommand } = await import(unfollowPath.href);
  const { ctx, replies } = makeCtx({ match: 'market:abc' });
  ctx.message = { text: '/unfollow market:abc', entities: [] };
  await unfollowCommand.handler(ctx, makeDeps(undefined));

  assert.equal(replies.length, 1);
  assert.ok(
    replies[0].text.toLowerCase().includes('not available') ||
    replies[0].text.toLowerCase().includes('not configured'),
    `should report store not configured: ${replies[0].text}`,
  );
});

// ── /follows ─────────────────────────────────────────────────────────────────

test('/follows returns empty message when no subscriptions', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { followsCommand } = await import(followsPath.href);

    const { ctx, replies } = makeCtx();
    ctx.match = '';
    ctx.message = { text: '/follows', entities: [] };
    await followsCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    assert.ok(
      replies[0].text.toLowerCase().includes('no active follows') ||
      replies[0].text.toLowerCase().includes('no active'),
      `should report no follows: ${replies[0].text}`,
    );
  });
});

test('/follows lists active subscriptions', async () => {
  await withTempDir(async (dir) => {
    const { createFollowStore } = await importStore();
    const store = createFollowStore({ filePath: pathJoin(dir, 'follows.json') });
    const { followsCommand } = await import(followsPath.href);

    const chatId = -1001234567890;
    await store.follow(String(chatId), 'market:abc');
    await store.follow(String(chatId), 'squad:xyz');

    const { ctx, replies } = makeCtx({ chatId });
    ctx.match = '';
    ctx.message = { text: '/follows', entities: [] };
    await followsCommand.handler(ctx, makeDeps(store));

    assert.equal(replies.length, 1);
    const text = replies[0].text;
    assert.ok(text.includes('market:abc'), `reply should list market:abc: ${text}`);
    assert.ok(text.includes('squad:xyz'), `reply should list squad:xyz: ${text}`);
  });
});

test('/follows with no store replies with not-available message', async () => {
  const { followsCommand } = await import(followsPath.href);
  const { ctx, replies } = makeCtx();
  ctx.match = '';
  ctx.message = { text: '/follows', entities: [] };
  await followsCommand.handler(ctx, makeDeps(undefined));

  assert.equal(replies.length, 1);
  assert.ok(
    replies[0].text.toLowerCase().includes('not available') ||
    replies[0].text.toLowerCase().includes('not configured'),
    `should report store not configured: ${replies[0].text}`,
  );
});
