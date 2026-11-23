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

// ── Registered /stats command (credential-free createBot + fake transport) ────

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'Mimir',
  username: 'mimir_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};
const CHAT_ID = -1001234567890;

function fakeConfig(overrides = {}) {
  return {
    botToken: '123456789:TEST-ONLY-TOKEN-NEVER-USE',
    chatId: String(CHAT_ID),
    chatIds: [String(CHAT_ID)],
    allowedChatIds: [],
    operatorTelegramUserId: '42',
    marketContractId: 'C'.padEnd(56, 'M'),
    squadContractId: 'C'.padEnd(56, 'S'),
    rpcUrl: 'https://example.invalid/rpc',
    horizonUrl: 'https://example.invalid/horizon',
    networkPassphrase: 'Test SDF Network ; September 2015',
    pollIntervalMs: 30_000,
    startLookbackLedgers: 60,
    cursorFile: '/tmp/unused-cursor.json',
    maxNotificationsPerCycle: 20,
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

function commandUpdate(text, { updateId = 1, chatId = CHAT_ID, userId = 99 } = {}) {
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

function harness({ config = fakeConfig(), status = () => fakeStatus(), metrics, now = () => 100_000, rateLimiter } = {}) {
  const bot = createBot({
    config,
    status,
    pause: () => 'paused',
    resume: () => 'resumed',
    botInfo: BOT_INFO,
    now,
    ...(metrics === undefined ? {} : { metrics }),
    ...(rateLimiter === undefined ? {} : { rateLimiter }),
  });

  const sent = [];
  const menus = [];
  bot.api.config.use((prev, method, payload, signal) => {
    if (method === 'sendMessage') {
      sent.push(payload);
      return Promise.resolve({ ok: true, result: { message_id: sent.length } });
    }
    if (method === 'setMyCommands') {
      menus.push(payload);
      return Promise.resolve({ ok: true, result: true });
    }
    return prev(method, payload, signal);
  });

  return { bot, sent, menus, config };
}

test('/stats renders live metrics counters and updates them between calls', async () => {
  const metrics = createMetrics();
  metrics.notificationsSent.inc(12);
  metrics.notificationsFailed.inc(2);
  metrics.eventsSkipped.inc(3);
  metrics.rpcRequests.inc(45);
  metrics.rpcErrors.inc(1);

  const { bot, sent } = harness({ metrics });

  await bot.handleUpdate(commandUpdate('/stats', { updateId: 1 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].parse_mode, 'MarkdownV2');
  assert.deepEqual(sent[0].link_preview_options, { is_disabled: true });
  assert.equal(
    sent[0].text,
    '*Stats*\n' +
      'Notifications: sent 12, failed 2, skipped 3\n' +
      'RPC: calls 45, errors 1\n' +
      'Uptime: 1m 0s',
  );

  // Live updates are visible immediately: no cache, snapshot file or credentials.
  metrics.notificationsSent.inc(4);
  metrics.rpcRequests.inc(5);
  metrics.rpcErrors.inc(2);
  await bot.handleUpdate(commandUpdate('/stats', { updateId: 2 }));

  assert.equal(sent.length, 2);
  assert.equal(
    sent[1].text,
    '*Stats*\n' +
      'Notifications: sent 16, failed 2, skipped 3\n' +
      'RPC: calls 50, errors 3\n' +
      'Uptime: 1m 0s',
  );
});

test('/stats falls back to since-start status counters and shows 0s before poller start', async () => {
  const { bot, sent } = harness({
    status: () =>
      fakeStatus({
        startedAt: 0,
        notificationsSent: 99,
        notificationsFailed: 9,
        eventsSkipped: 8,
        sinceStart: { notificationsSent: 7, notificationsFailed: 1, eventsSkipped: 2 },
      }),
    now: () => 1_700_000_000_000,
  });

  await bot.handleUpdate(commandUpdate('/stats'));

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].text,
    '*Stats*\n' +
      'Notifications: sent 7, failed 1, skipped 2\n' +
      'RPC: calls 0, errors 0\n' +
      'Uptime: 0s',
  );
});

test('statsSnapshotFromDeps ignores non-finite and negative start times', () => {
  const deps = {
    config: fakeConfig(),
    status: () => fakeStatus({ startedAt: Number.NaN }),
    pause: () => 'paused',
    resume: () => 'resumed',
  };
  assert.equal(statsSnapshotFromDeps(deps, 25_000).startedAtMs, 25_000);

  deps.status = () => fakeStatus({ startedAt: -5 });
  assert.equal(statsSnapshotFromDeps(deps, 25_000).startedAtMs, 25_000);
});

test('/stats is silently ignored outside ALLOWED_CHAT_IDS without reading state', async () => {
  let statusCalls = 0;
  const metrics = createMetrics();
  metrics.rpcRequests.inc(1);
  const { bot, sent } = harness({
    config: fakeConfig({ allowedChatIds: [String(CHAT_ID)] }),
    status: () => {
      statusCalls += 1;
      return fakeStatus();
    },
    metrics,
  });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 1, chatId: -100777 }));
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(sent.length, 0);
  assert.equal(statusCalls, 0);
  assert.equal(metrics.rpcRequests.value(), 1);

  await bot.handleUpdate(commandUpdate('/stats', { updateId: 2, chatId: CHAT_ID }));
  assert.equal(sent.length, 1);
  assert.equal(statusCalls, 1);
  assert.match(sent[0].text, /^RPC: calls 1, errors 0$/m);
});

test('/stats shares the per-chat rate limiter and lets the operator bypass it', async () => {
  const rateLimiter = new CommandRateLimiter({ capacity: 1, refillMs: 1_000_000, now: () => 1_000 });
  const { bot, sent } = harness({ rateLimiter });

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 1, userId: 99 }));
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 2, userId: 99 }));
    await bot.handleUpdate(commandUpdate('/stats', { updateId: 3, userId: 42 }));
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(sent.length, 2);
});

test('/stats is advertised in the menu and has a /help stats detail page', async () => {
  const { bot, sent, menus, config } = harness();

  await registerCommands(bot, config);
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].commands.find((c) => c.command === 'stats'), {
    command: 'stats',
    description: 'Notification and RPC counters with process uptime',
  });

  await bot.handleUpdate(commandUpdate('/help stats', { updateId: 2 }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, helpDetailMessage('stats', config));
  assert.match(sent[0].text, /\*Command:\* \/stats/);
  assert.match(sent[0].text, /\*Who can run it:\* Anyone in allowed chats/);
});
