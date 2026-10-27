import test from 'node:test';
import assert from 'node:assert';
import { statsMessage } from '../dist/commands/stats.js';

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
