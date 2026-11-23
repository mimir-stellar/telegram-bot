/**
 * Persistent retry scheduling across notifier restarts.
 *
 * Covers:
 * - Send journal storing `nextAttemptAt` and `attempts` with pending deliveries
 * - `loadDue()` filtering not-yet-due entries to avoid restart-driven retry bursts
 * - `compact()` preserving `nextAttemptAt` on unresolved entries while dropping resolved ones
 * - Boundary/failure cases (invalid `nextAttemptAt`, corrupt JSONL fields, past/legacy entries)
 * - `createNotifier()` persisting retry schedules on failure and honouring remaining delay on restart
 */

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import { createNotifier } from "../dist/notifications/notifier.js";
import { createSendJournal, retryDelayMs } from "../dist/notifications/send-journal.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

const BASE_CONFIG = {
  botToken: "0000000000:" + "TEST-DO-NOT-USE",
  chatId: "-1001234567890",
  marketChatId: "",
  squadChatId: "",
};

// ── Send journal retry scheduling ────────────────────────────────────────────

test("send journal: stores nextAttemptAt with pending deliveries and survives restart", async () => {
  const dir = await createTempDataDir("mimir-retry-journal-");
  const file = dir.file("journal.jsonl");
  try {
    let clock = 1_700_000_000_000;
    const first = createSendJournal({ filePath: file, now: () => clock });

    await first.recordIntent({
      id: "evt-1",
      source: "market",
      ledger: 100,
      eventName: "claim_created",
      at: clock,
    });
    await first.recordRetry("evt-1", clock + 15_000, 1);

    // Restart: new journal handle over the same file.
    const second = createSendJournal({ filePath: file, now: () => clock + 5_000 });
    const pending = await second.loadPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "evt-1");
    assert.equal(pending[0].nextAttemptAt, clock + 15_000);
    assert.equal(pending[0].attempts, 1);

    // Not due yet at t+5s -> excluded from loadDue() to avoid a restart burst.
    assert.deepEqual(await second.loadDue(clock + 5_000), []);
    assert.equal(retryDelayMs(pending[0].nextAttemptAt, clock + 5_000), 10_000);

    // Due at t+15s -> included in loadDue().
    const due = await second.loadDue(clock + 15_000);
    assert.deepEqual(
      due.map((e) => e.id),
      ["evt-1"],
    );
    assert.equal(retryDelayMs(pending[0].nextAttemptAt, clock + 15_000), 0);
  } finally {
    await dir.cleanup();
  }
});

test("send journal: compact preserves nextAttemptAt on unresolved entries and drops resolved ones", async () => {
  const dir = await createTempDataDir("mimir-retry-compact-");
  const file = dir.file("journal.jsonl");
  try {
    const t0 = 1_700_000_000_000;
    const journal = createSendJournal({ filePath: file, now: () => t0 });

    await journal.recordIntent({
      id: "evt-done",
      source: "market",
      ledger: 101,
      eventName: "claim_created",
      at: t0,
    });
    await journal.recordRetry("evt-done", t0 + 5_000, 1);
    await journal.recordDone("evt-done");

    await journal.recordIntent({
      id: "evt-pending",
      source: "squad",
      ledger: 102,
      eventName: "squad_created",
      at: t0,
    });
    await journal.recordRetry("evt-pending", t0 + 30_000, 2);

    await journal.compact();

    const reloaded = createSendJournal({ filePath: file, now: () => t0 });
    const pending = await reloaded.loadPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, "evt-pending");
    assert.equal(pending[0].nextAttemptAt, t0 + 30_000);
    assert.equal(pending[0].attempts, 2);
    assert.equal((await reloaded.stats()).entries, 1);
  } finally {
    await dir.cleanup();
  }
});

test("send journal: boundary and failure cases for nextAttemptAt", async () => {
  const dir = await createTempDataDir("mimir-retry-boundary-");
  const file = dir.file("journal.jsonl");
  try {
    const t0 = 1_700_000_000_000;
    const journal = createSendJournal({ filePath: file, now: () => t0 });

    // Invalid programmatic values are rejected.
    await assert.rejects(() => journal.recordRetry("evt-bad", Number.NaN, 1), RangeError);
    await assert.rejects(() => journal.recordRetry("evt-bad", -100, 1), RangeError);
    await assert.rejects(() => journal.recordRetry("evt-bad", Number.POSITIVE_INFINITY, 1), RangeError);

    // Legacy entry without nextAttemptAt + corrupt nextAttemptAt on disk load safely as immediately due.
    const lines = [
      JSON.stringify({ kind: "intent", id: "legacy", source: "market", ledger: 1, eventName: "x", at: t0 }),
      JSON.stringify({ kind: "intent", id: "corrupt", source: "market", ledger: 2, eventName: "x", at: t0, nextAttemptAt: "bad" }),
      JSON.stringify({ kind: "intent", id: "past", source: "market", ledger: 3, eventName: "x", at: t0, nextAttemptAt: t0 - 1_000 }),
    ].join("\n") + "\n";
    await writeFile(file, lines, "utf8");

    const due = await journal.loadDue(t0);
    assert.deepEqual(
      due.map((e) => e.id),
      ["legacy", "corrupt", "past"],
    );
    assert.equal(retryDelayMs(undefined, t0), 0);
    assert.equal(retryDelayMs(Number.NaN, t0), 0);
    assert.equal(retryDelayMs(t0 - 500, t0), 0);
  } finally {
    await dir.cleanup();
  }
});

// ── Notifier restart retry scheduling ────────────────────────────────────────

test("notifier: persists nextAttemptAt on failure and honours remaining delay after restart", async () => {
  const dir = await createTempDataDir("mimir-notifier-restart-");
  const file = dir.file("journal.jsonl");
  try {
    let clock = 1_700_000_000_000;
    const sleeps = [];
    const sleep = async (ms) => {
      sleeps.push(ms);
      clock += ms;
    };

    // Run 1: Telegram returns 429 with retry_after=20s.
    const failingBot = {
      api: {
        async sendMessage() {
          const err = new Error("Too Many Requests");
          err.error_code = 429;
          err.parameters = { retry_after: 20 };
          throw err;
        },
      },
    };
    const journal1 = createSendJournal({ filePath: file, now: () => clock });
    const notifier1 = createNotifier(failingBot, BASE_CONFIG, {
      retry: { journal: journal1, now: () => clock, sleep },
    });

    await assert.rejects(
      () => notifier1("hello", "market", { eventRef: { eventId: "evt-42" } }),
      /Too Many Requests/,
    );

    // Process restarts 5 seconds later (15 seconds of backoff still remaining).
    clock += 5_000;
    const sent = [];
    const recoveredBot = {
      api: {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text, at: clock });
        },
      },
    };
    const journal2 = createSendJournal({ filePath: file, now: () => clock });
    const notifier2 = createNotifier(recoveredBot, BASE_CONFIG, {
      retry: { journal: journal2, now: () => clock, sleep },
    });

    await notifier2("hello", "market", { eventRef: { eventId: "evt-42" } });

    // Must have waited the remaining 15_000ms instead of bursting immediately on restart.
    assert.deepEqual(sleeps, [15_000]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].at, 1_700_000_020_000);

    // After success, the pending retry entry is cleared.
    assert.deepEqual(await journal2.loadPending(), []);
  } finally {
    await dir.cleanup();
  }
});

test("notifier: already-due pending delivery sends immediately on restart without extra sleep", async () => {
  const dir = await createTempDataDir("mimir-notifier-due-");
  const file = dir.file("journal.jsonl");
  try {
    let clock = 1_700_000_000_000;
    const journal1 = createSendJournal({ filePath: file, now: () => clock });
    await journal1.recordRetry("evt-due", clock + 2_000, 1);

    // Restart after nextAttemptAt has already passed.
    clock += 5_000;
    const sleeps = [];
    let calls = 0;
    const bot = {
      api: {
        async sendMessage() {
          calls += 1;
        },
      },
    };
    const journal2 = createSendJournal({ filePath: file, now: () => clock });
    const notifier = createNotifier(bot, BASE_CONFIG, {
      retry: {
        journal: journal2,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    await notifier("hello", "market", { eventRef: { eventId: "evt-due" } });
    assert.deepEqual(sleeps, []);
    assert.equal(calls, 1);
  } finally {
    await dir.cleanup();
  }
});

test("notifier: journal read/write failures degrade gracefully without breaking sends", async () => {
  const brokenJournal = {
    async recordIntent() {
      throw new Error("disk full");
    },
    async recordRetry() {
      throw new Error("disk full");
    },
    async recordDone() {
      throw new Error("disk full");
    },
    async loadPending() {
      throw new Error("disk unreadable");
    },
    async loadDue() {
      throw new Error("disk unreadable");
    },
    async compact() {
      throw new Error("disk full");
    },
    async stats() {
      return { entries: 0, bytes: 0 };
    },
  };

  let calls = 0;
  const bot = {
    api: {
      async sendMessage() {
        calls += 1;
      },
    },
  };
  const notifier = createNotifier(bot, BASE_CONFIG, {
    retry: { journal: brokenJournal },
  });

  await notifier("hello", "market", { eventRef: { eventId: "evt-ok" } });
  assert.equal(calls, 1);
});
