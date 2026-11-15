import test from 'node:test';
import assert from 'node:assert';
import { createBot, helpDetailMessage, registerCommands, statsMessage } from '../dist/bot.js';
import { CommandRateLimiter } from '../dist/commands/rate-limit.js';
import { statsSnapshotFromDeps } from '../dist/commands/stats.js';
import { createMetrics } from '../dist/metrics.js';

// statsMessage (#668) renders one line per group: "Notifications: sent N,
// failed N, skipped N", "RPC: calls N, errors N" and "Uptime: ...". The #668
// test was written against a one-counter-per-line layout the builder never had.

test('statsMessage renders counters and uptime', () => {
  const now = 100000;
  const startedAt = 40000;
  const snapshot = {
    notificationsSent: 12,
    notificationsFailed: 2,
    notificationsSkipped: 3,
    rpcCalls: 45,
    rpcErrors: 1,
    startedAtMs: startedAt,
  };

  const out = statsMessage(snapshot, now);

  assert.strictEqual(typeof out, 'string');
  assert.strictEqual(
    out,
    '*Stats*\n' +
      'Notifications: sent 12, failed 2, skipped 3\n' +
      'RPC: calls 45, errors 1\n' +
      'Uptime: 1m 0s',
  );
});

test('statsMessage renders missing counters as 0', () => {
  const out = statsMessage({}, 5000);

  assert.match(out, /^Notifications: sent 0, failed 0, skipped 0$/m);
  assert.match(out, /^RPC: calls 0, errors 0$/m);
  assert.doesNotMatch(out, /undefined|NaN/);
});

test('statsMessage stays within one Telegram message', () => {
  const out = statsMessage(
    {
      notificationsSent: 99999999,
      notificationsFailed: 99999999,
      notificationsSkipped: 99999999,
      rpcCalls: 99999999,
      rpcErrors: 99999999,
      startedAtMs: 0,
    },
    99999999999,
  );

  assert.ok(out.length < 4096);
});

test('statsMessage renders multi-day uptime without stray characters', () => {
  const day = 86_400_000;
  const out = statsMessage({ startedAtMs: 0 }, 2 * day + 3 * 3_600_000 + 4 * 60_000 + 5_000);
  assert.match(out, /^Uptime: 2d 3h 4m 5s$/m);
});

// ── Registered /stats slash command (credential-free createBot + handleUpdate) ─

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Mimir',
  username: 'mimir_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

function fakeConfig(overrides = {}) {
  return {
    botToken: 'TEST_TOKEN',
    chatId: '-1001234567890',
    chatIds: ['-1001234567890'],
    allowedChatIds: [],
    operatorTelegramUserId: '42',
    marketContractId: 'C' + 'M'.repeat(55),
    squadContractId: 'C' + 'S'.repeat(55),
    rpcUrl: 'https://example.invalid/rpc',
    horizonUrl: 'https://example.invalid/horizon',
    networkPassphrase: 'Test SDF Network ; September 2015',
    explorerBaseUrl: 'https://example.invalid/explorer',
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: '/tmp/unused-cursor.json',
    maxNotificationsPerCycle: 20,
    healthHost: '127.0.0.1',
    healthPort: 0,
    healthStaleMs: 90_000,
    channelPreviewMode: false,
    ...overrides,
  };
}

function fakeStatus(overrides = {}) {
  return {
    running: true,
    paused: false,
    stopping: false,
    chainClockAt: null,
    startedAt: 40_000,
    cycles: 5,
    lastCorrelationId: null,
    lastPollAt: 95_000,
    lastSuccessAt: 95_000,
    latestLedger: 1200,
    oldestLedger: 1000,
    notificationsSent: 0,
    notificationsFailed: 0,
    eventsSkipped: 0,
    emptyPages: 0,
    pagesScanned: 5,
    lastCycleEmptyPages: 0,
    lastCyclePages: 1,
    consecutiveFailures: 0,
    lastError: null,
    targets: [],
    ...overrides,
  };
}

function commandUpdate(text, { updateId = 1, chatId = -1001234567890, userId = 99 } = {}) {
  const spaceIndex = text.indexOf(' ');
  const commandLength = spaceIndex === -1 ? text.length : spaceIndex;
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'supergroup' },
      from: { id: userId, is_bot: false, first_name: 'Reader' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: commandLength }],
    },
  };
}

function harness({
  config = fakeConfig(),
  status = () => fakeStatus(),
  metrics = createMetrics(),
  now = () => 100_000,
  rateLimiter,
} = {}) {
  const bot = createBot({
    config,
    status,
    pause: () => 'paused',
    resume: () => 'resumed',
    metrics,
    botInfo: BOT_INFO,
    now,
    ...(rateLimiter ? { rateLimiter } : {}),
  });

  const sent = [];
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      sent.push(payload);
      return Promise.resolve({ ok: true, result: { message_id: sent.length } });
    }
    return prev(method, payload, signal);
  });

  return { bot, sent, metrics, config };
}

test('/stats replies with live createMetrics() counters and uptime over handleUpdate', async () => {
  const metrics = createMetrics();
  metrics.notificationsSent.inc(12);
  metrics.notificationsFailed.inc(2);
  metrics.eventsSkipped.inc(3);
  metrics.rpcRequests.inc(45);
  metrics.rpcErrors.inc(1);

  const { bot, sent } = harness({
    metrics,
    status: () => fakeStatus({ startedAt: 40_000 }),
    now: () => 100_000,
  });

  await bot.handleUpdate(commandUpdate('/stats', { updateId: 1 }));

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].chat_id, -1001234567890);
  assert.strictEqual(sent[0].parse_mode, 'MarkdownV2');
  assert.deepStrictEqual(sent[0].link_preview_options, { is_disabled: true });
  assert.strictEqual(
    sent[0].text,
    '*Stats*\n' +
      'Notifications: sent 12, failed 2, skipped 3\n' +
      'RPC: calls 45, errors 1\n' +
      'Uptime: 1m 0s',
  );

  // Subsequent live counter increments are reflected immediately on the next /stats call.
  metrics.notificationsSent.inc(4);
  metrics.rpcRequests.inc(5);
  metrics.rpcErrors.inc(2);

  await bot.handleUpdate(commandUpdate('/stats', { updateId: 2 }));
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(
    sent[1].text,
    '*Stats*\n' +
      'Notifications: sent 16, failed 2, skipped 3\n' +
      'RPC: calls 50, errors 3\n' +
      'Uptime: 1m 0s',
  );
});

test('/stats renders 0s uptime before poller start and falls back safely when metrics is omitted', async () => {
  const bot = createBot({
    config: fakeConfig(),
    status: () =>
      fakeStatus({
        startedAt: 0,
        notificationsSent: 7,
        notificationsFailed: 1,
        eventsSkipped: 2,
      }),
    pause: () => 'paused',
    resume: () => 'resumed',
    botInfo: BOT_INFO,
    now: () => 1_700_000_000_000,
  });

  const sent = [];
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      sent.push(payload);
      return Promise.resolve({ ok: true, result: { message_id: 1 } });
    }
    return prev(method, payload, signal);
  });

  await bot.handleUpdate(commandUpdate('/stats', { updateId: 10 }));

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(
    sent[0].text,
    '*Stats*\n' +
      'Notifications: sent 7, failed 1, skipped 2\n' +
      'RPC: calls 0, errors 0\n' +
      'Uptime: 0s',
  );
});

test('statsSnapshotFromDeps prefers sinceStart poller counters when metrics is absent', () => {
  const snap = statsSnapshotFromDeps(
    {
      config: fakeConfig(),
      status: () =>
        fakeStatus({
          startedAt: 10_000,
          notificationsSent: 99,
          notificationsFailed: 9,
          eventsSkipped: 8,
          sinceStart: {
            cycles: 2,
            notificationsSent: 4,
            notificationsFailed: 1,
            eventsSkipped: 2,
          },
        }),
      pause: () => 'paused',
      resume: () => 'resumed',
    },
    25_000,
  );

  assert.deepStrictEqual(snap, {
    notificationsSent: 4,
    notificationsFailed: 1,
    notificationsSkipped: 2,
    rpcCalls: 0,
    rpcErrors: 0,
    startedAtMs: 10_000,
  });
});

test('/stats enforces ALLOWED_CHAT_IDS silently before reading status or metrics', async () => {
  let statusCalls = 0;
  const { bot, sent } = harness({
    config: fakeConfig({ allowedChatIds: ['-100777'] }),
    status: () => {
      statusCalls += 1;
      return fakeStatus();
    },
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 20, chatId: -1001234567890 }));
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(sent.length, 0);
  assert.strictEqual(statusCalls, 0);

  await bot.handleUpdate(commandUpdate('/stats', { updateId: 21, chatId: -100777 }));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(statusCalls, 1);
});

test('/stats shares the per-chat command rate limiter while letting the operator bypass', async () => {
  const rateLimiter = new CommandRateLimiter({ capacity: 1, refillPerSecond: 0, now: () => 1000 });
  const { bot, sent } = harness({ rateLimiter });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 30, userId: 99 }));
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 31, userId: 99 }));
    // Operator (userId 42) bypasses the exhausted bucket.
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 32, userId: 42 }));
  } finally {
    console.warn = originalWarn;
  }

  assert.strictEqual(sent.length, 2);
});

test('/stats handles bot mentions accurately and registers menu + /help stats metadata', async () => {
  const { bot, sent, config } = harness();
  const menus = [];
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'setMyCommands') {
      menus.push(payload);
      return Promise.resolve({ ok: true, result: true });
    }
    return prev(method, payload, signal);
  });

  await bot.handleUpdate(commandUpdate('/stats@other_bot', { updateId: 40 }));
  assert.strictEqual(sent.length, 0);

  await bot.handleUpdate(commandUpdate(`/stats@${BOT_INFO.username}`, { updateId: 41 }));
  assert.strictEqual(sent.length, 1);

  await bot.handleUpdate(commandUpdate('/help stats', { updateId: 42 }));
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[1].text, helpDetailMessage('stats', config));
  assert.match(sent[1].text, /\*Command:\* \/stats/);
  assert.match(sent[1].text, /\*Who can run it:\* Anyone in allowed chats/);

  await registerCommands(bot, config);
  assert.strictEqual(menus.length, 1);
  const statsEntry = menus[0].commands.find((c) => c.command === 'stats');
  assert.deepStrictEqual(statsEntry, {
    command: 'stats',
    description: 'Notification and RPC counters with process uptime',
  });
});
