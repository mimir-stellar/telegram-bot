import assert from "node:assert/strict";
import test from "node:test";

import { createNotifier } from "../dist/bot.js";
import { parseTopicMap, resolveTopicThreadId } from "../dist/notifications/topics.js";

function fakeApi() {
  const calls = [];
  return { calls, api: { sendMessage: async (chatId, text, opts) => { calls.push({ chatId, text, opts }); } } };
}
const base = { chatId: "-100123", marketChatId: "-100123", squadChatId: "-100123", botToken: "t" };

test("parses a mapping", () => {
  const map = parseTopicMap("claims:12, Resolutions:15,squad:20");
  assert.equal(map.get("claims"), 12);
  assert.equal(map.get("resolutions"), 15);
  assert.equal(map.get("squad"), 20);
  assert.equal(parseTopicMap("").size, 0);
  assert.equal(parseTopicMap(undefined).size, 0);
});

test("rejects invalid mappings with a clear message", () => {
  assert.throws(() => parseTopicMap("claims"), /claims/);
  assert.throws(() => parseTopicMap("claims:abc"), /thread id/);
  assert.throws(() => parseTopicMap("claims:0"), /positive integer/);
  assert.throws(() => parseTopicMap("claims:1,claims:2"), /duplicate/);
  assert.throws(() => parseTopicMap(":5"), /invalid topic entry/);
});

test("resolves category to thread id, unmapped to undefined", () => {
  const map = parseTopicMap("claims:12");
  assert.equal(resolveTopicThreadId(map, "claims"), 12);
  assert.equal(resolveTopicThreadId(map, "other"), undefined);
  assert.equal(resolveTopicThreadId(undefined, "claims"), undefined);
  assert.equal(resolveTopicThreadId(map, undefined), undefined);
});

test("notifier sends message_thread_id only when mapped", async () => {
  const { api, calls } = fakeApi();
  const notify = createNotifier({ api }, { ...base, topicMap: parseTopicMap("claims:12,squad:20") });
  await notify("hi", "squad");
  await notify("hi", "market", { category: "claims" });
  await notify("hi", "market");
  assert.equal(calls[0].opts.message_thread_id, 20);
  assert.equal(calls[1].opts.message_thread_id, 12);
  assert.equal("message_thread_id" in calls[2].opts, false);
});

test("without a map the payload has no thread id", async () => {
  const { api, calls } = fakeApi();
  await createNotifier({ api }, base)("hi", "squad");
  assert.deepEqual(Object.keys(calls[0].opts).sort(), ["link_preview_options", "parse_mode"]);
});
