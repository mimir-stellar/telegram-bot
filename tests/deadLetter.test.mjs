import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDeadLetterQueue,
  makeEntryId,
} from "../dist/deadLetter.js";

async function withQueue(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-"));
  const filePath = path.join(directory, "dead-letter.json");
  let clock = 1_700_000_000_000;
  const queue = createDeadLetterQueue({
    filePath,
    maxEntries: options.maxEntries ?? 3,
    maxAttempts: options.maxAttempts ?? 3,
    now: () => clock,
  });
  try {
    await queue.load();
    return await run({
      queue,
      filePath,
      directory,
      tick: (ms = 1_000) => {
        clock += ms;
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("enqueue persists a failed send and load restores it after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mimir-dlq-restart-"));
  const filePath = path.join(directory, "dead-letter.json");
  try {
    const first = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_000_000,
    });
    await first.load();
    await first.enqueue({
      source: "market",
      ledger: 42,
      eventName: "claim_cancelled",
      text: "cancelled message",
      error: new Error("Telegram 429"),
    });
    assert.equal(first.stats().depth, 1);
    assert.equal(first.stats().enqueued, 1);

    const raw = await readFile(filePath, "utf8");
    assert.match(raw, /"version": 1/);
    assert.match(raw, /claim_cancelled/);
    assert.equal(raw.includes("BOT_TOKEN"), false);

    const second = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      now: () => 1_700_000_001_000,
    });
    await second.load();
    assert.equal(second.stats().depth, 1);
    assert.equal(second.snapshot()[0].ledger, 42);
    assert.equal(second.snapshot()[0].text, "cancelled message");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("flush replays oldest entries and removes successes", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue({
      source: "market",
      ledger: 1,
      eventName: "claim_cancelled",
      text: "one",
      error: "fail",
    });
    await queue.enqueue({
      source: "market",
      ledger: 2,
      eventName: "claim_cancelled",
      text: "two",
      error: "fail",
    });

    const sent = [];
    const result = await queue.flush(async (text) => {
      sent.push(text);
    }, 10);

    assert.deepEqual(sent, ["one", "two"]);
    assert.equal(result.sent, 2);
    assert.equal(result.remaining, 0);
    assert.equal(queue.stats().replayed, 2);
    assert.equal(queue.stats().depth, 0);
  });
});

test("flush respects budget and keeps the remainder", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue({
      source: "market",
      ledger: 1,
      eventName: "claim_cancelled",
      text: "one",
      error: "fail",
    });
    await queue.enqueue({
      source: "market",
      ledger: 2,
      eventName: "claim_cancelled",
      text: "two",
      error: "fail",
    });

    const sent = [];
    const result = await queue.flush(async (text) => {
      sent.push(text);
    }, 1);

    assert.deepEqual(sent, ["one"]);
    assert.equal(result.sent, 1);
    assert.equal(result.remaining, 1);
    assert.equal(queue.snapshot()[0].text, "two");
  });
});

test("failed replay increments attempts and drops at maxAttempts", async () => {
  await withQueue(async ({ queue }) => {
    await queue.enqueue({
      source: "market",
      ledger: 9,
      eventName: "claim_cancelled",
      text: "poison",
      error: "first",
    });
    // attempts starts at 1 from enqueue; maxAttempts=3 → drop after two more failures
    await queue.flush(async () => {
      throw new Error("still down");
    }, 10);
    assert.equal(queue.stats().depth, 1);
    assert.equal(queue.snapshot()[0].attempts, 2);

    await queue.flush(async () => {
      throw new Error("still down");
    }, 10);
    assert.equal(queue.stats().depth, 0);
    assert.equal(queue.stats().dropped, 1);
  }, { maxAttempts: 3 });
});

test("bounded queue drops oldest when full", async () => {
  await withQueue(async ({ queue }) => {
    for (let ledger = 1; ledger <= 4; ledger++) {
      await queue.enqueue({
        source: "market",
        ledger,
        eventName: "claim_cancelled",
        text: `msg-${ledger}`,
        error: "fail",
      });
    }
    assert.equal(queue.stats().depth, 3);
    assert.equal(queue.stats().dropped, 1);
    assert.deepEqual(
      queue.snapshot().map((e) => e.ledger),
      [2, 3, 4],
    );
  }, { maxEntries: 3 });
});

test("corrupt dead-letter file starts empty without throwing", async () => {
  await withQueue(async ({ queue, filePath }) => {
    await writeFile(filePath, "{not-json", "utf8");
    await queue.load();
    assert.equal(queue.stats().depth, 0);
    await queue.enqueue({
      source: "squad",
      ledger: 7,
      eventName: "claimed",
      text: "ok",
      error: "x",
    });
    assert.equal(queue.stats().depth, 1);
  });
});

test("makeEntryId is stable for identical payloads", () => {
  const a = makeEntryId("market", 1, "claim_cancelled", "hello");
  const b = makeEntryId("market", 1, "claim_cancelled", "hello");
  const c = makeEntryId("market", 1, "claim_cancelled", "other");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("lastError is truncated and never stores secrets from the message path", async () => {
  await withQueue(async ({ queue, filePath }) => {
    const longErr = `fail-${"x".repeat(500)}`;
    await queue.enqueue({
      source: "market",
      ledger: 1,
      eventName: "claim_cancelled",
      text: "safe text",
      error: new Error(longErr),
    });
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(parsed.entries[0].lastError.length <= 201);
    assert.equal(raw.includes("BOT_TOKEN"), false);
    assert.equal(raw.includes("ghp_"), false);
  });
});
