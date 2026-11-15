import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  CRITICAL_IMMEDIATE_EVENTS,
  createPerChatDigestRouter,
} from "../dist/notifications/digest-grouping.js";
import {
  FileChatDigestPreferencesStore,
  MAX_CHAT_DIGEST_INTERVAL_MS,
  MIN_CHAT_DIGEST_INTERVAL_MS,
  ScheduleParseError,
  nextChatDigestFlushMs,
  parseChatDigestIntervalMs,
  parseChatDigestPreference,
} from "../dist/notifications/schedule.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const ADDR = "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI";

let seq = 1;
function makeEvent(source, payload, ledger = 5000 + seq) {
  const id = seq++;
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger,
    txHash: "",
    at: 1_700_000_000 + id,
    eventId: `evt-per-chat-${id}`,
    eventType: "contract",
    transactionIndex: id,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload,
  };
}

test("parseChatDigestPreference validates bounded intervals and destination chat IDs", () => {
  assert.equal(parseChatDigestIntervalMs("every@5m"), MIN_CHAT_DIGEST_INTERVAL_MS);
  assert.equal(parseChatDigestIntervalMs("7d"), MAX_CHAT_DIGEST_INTERVAL_MS);
  assert.equal(parseChatDigestIntervalMs(900_000), 15 * 60 * 1000);

  const immediate = parseChatDigestPreference("-1001234567890", "Immediate");
  assert.equal(immediate.mode, "immediate");
  assert.equal(immediate.destination, "-1001234567890");
  assert.equal(nextChatDigestFlushMs(immediate, null, 1_700_000_000_000), null);

  const channelDaily = parseChatDigestPreference("@mimir_alerts", "daily@08:30");
  assert.equal(channelDaily.mode, "schedule");
  assert.equal(channelDaily.schedule?.kind, "daily");

  // Below 5m minimum
  assert.throws(
    () => parseChatDigestPreference("-100123", "every@4m"),
    ScheduleParseError,
  );
  assert.throws(
    () => parseChatDigestIntervalMs(MIN_CHAT_DIGEST_INTERVAL_MS - 1),
    ScheduleParseError,
  );

  // Above 7d maximum
  assert.throws(
    () => parseChatDigestPreference("-100123", "every@8d"),
    ScheduleParseError,
  );
  assert.throws(
    () => parseChatDigestIntervalMs(MAX_CHAT_DIGEST_INTERVAL_MS + 1),
    ScheduleParseError,
  );

  // Weekly schedule rejected when custom maxIntervalMs < 7d
  assert.throws(
    () =>
      parseChatDigestPreference("-100123", "weekly@mon 09:00", {
        maxIntervalMs: 24 * 60 * 60 * 1000,
      }),
    ScheduleParseError,
  );

  // Invalid destination IDs
  for (const badId of ["", "0", "chat-123", "@abc"]) {
    assert.throws(
      () => parseChatDigestPreference(badId, "every@15m"),
      ScheduleParseError,
      `expected "${badId}" to be rejected`,
    );
  }
});

test("createPerChatDigestRouter flushes per-chat intervals independently and delivers critical events immediately", () => {
  const t0 = Date.UTC(2026, 10, 15, 10, 0, 0);
  const router = createPerChatDigestRouter({
    initialNowMs: t0,
    preferences: {
      "-100111": "every@15m",
      "-100222": "every@2h",
      "-100333": "immediate",
    },
  });

  assert.ok(CRITICAL_IMMEDIATE_EVENTS.includes("claim_resolved"));
  assert.ok(CRITICAL_IMMEDIATE_EVENTS.includes("market_settled"));
  assert.ok(CRITICAL_IMMEDIATE_EVENTS.includes("resolved"));

  const created1 = makeEvent("market", {
    name: "claim_created",
    claimId: 42,
    category: "crypto",
    creator: ADDR,
  });
  const created2 = makeEvent("market", {
    name: "claim_created",
    claimId: 42,
    category: "crypto",
    creator: ADDR,
  });
  const squadDep = makeEvent("squad", {
    name: "deposited",
    marketId: 9,
    user: ADDR,
    side: 1,
    amount: 50_000_000n,
  });

  const step1 = router.ingest([created1, created2, squadDep], t0 + 1_000);
  // Only the "immediate" chat receives routine events right away
  assert.equal(step1.immediateDeliveries.length, 3);
  assert.ok(
    step1.immediateDeliveries.every(
      (d) => d.destination === "-100333" && d.reason === "immediate_preference",
    ),
  );
  assert.equal(router.pendingCount("-100111"), 3);
  assert.equal(router.pendingCount("-100222"), 3);
  assert.equal(router.pendingCount("-100333"), 0);

  // Critical resolution event bypasses digest timers for ALL configured chats immediately
  const critical = makeEvent("market", {
    name: "claim_resolved",
    claimId: 42,
    outcome: 1,
    resolver: ADDR,
  });
  const step2 = router.ingest(critical, t0 + 2_000);
  assert.equal(step2.immediateDeliveries.length, 3);
  assert.deepEqual(
    step2.immediateDeliveries.map((d) => [d.destination, d.reason]),
    [
      ["-100111", "critical_event"],
      ["-100222", "critical_event"],
      ["-100333", "critical_event"],
    ],
  );
  // Pending buffers for routine events remain untouched
  assert.equal(router.pendingCount("-100111"), 3);
  assert.equal(router.pendingCount("-100222"), 3);

  // Before 15m: neither digest chat is due
  assert.deepEqual(router.flushDue(t0 + 14 * 60 * 1000), []);

  // At 15m: only -100111 flushes; -100222 stays buffered
  const flush15m = router.flushDue(t0 + 15 * 60 * 1000);
  assert.equal(flush15m.length, 1);
  assert.equal(flush15m[0].destination, "-100111");
  assert.equal(flush15m[0].events.length, 3);
  assert.equal(flush15m[0].groups.length, 2);
  assert.equal(flush15m[0].droppedOverflow, 0);
  assert.match(flush15m[0].text, /\*Mimir Digest\*/);
  assert.equal(router.pendingCount("-100111"), 0);
  assert.equal(router.pendingCount("-100222"), 3);

  // At 2h: -100222 flushes; -100111 has 0 pending events so emits nothing
  const flush2h = router.flushDue(t0 + 2 * 60 * 60 * 1000);
  assert.equal(flush2h.length, 1);
  assert.equal(flush2h[0].destination, "-100222");
  assert.equal(flush2h[0].events.length, 3);
  assert.equal(router.pendingCount("-100222"), 0);
});

test("createPerChatDigestRouter caps per-chat buffer overflow while keeping critical alerts live", () => {
  const t0 = Date.UTC(2026, 10, 15, 12, 0, 0);
  const router = createPerChatDigestRouter({
    initialNowMs: t0,
    maxPendingPerChat: 2,
    preferences: { "-100999": "every@30m" },
  });

  for (let i = 0; i < 5; i++) {
    router.ingest(
      makeEvent("market", {
        name: "claim_created",
        claimId: 100 + i,
        category: "sports",
        creator: ADDR,
      }),
    );
  }
  assert.equal(router.pendingCount("-100999"), 2);

  // Even when buffer is full, a critical settlement event still routes immediately
  const settled = makeEvent("squad", {
    name: "resolved",
    marketId: 77,
    winner: 1,
    poolA: 100n,
    poolB: 200n,
  });
  const criticalRes = router.ingest(settled);
  assert.equal(criticalRes.immediateDeliveries.length, 1);
  assert.equal(criticalRes.immediateDeliveries[0].reason, "critical_event");

  const flushed = router.flushDue(t0 + 30 * 60 * 1000);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].events.length, 2);
  assert.equal(flushed[0].droppedOverflow, 3);
});

test("FileChatDigestPreferencesStore persists bounded preferences and enforces maxDestinations", async () => {
  await withTempDataDir(async (dir) => {
    const file = dir.file("chat-digest-prefs.json");
    const store = new FileChatDigestPreferencesStore(file, { maxDestinations: 2 });

    await store.setPreference("-100501", "every@15m", 1_700_000_000_000);
    await store.setPreference("@mimir_feed", "daily@06:00");
    await store.recordFlush("-100501", 1_700_000_900_000);

    // 3rd distinct destination exceeds maxDestinations (2)
    await assert.rejects(
      () => store.setPreference("-100503", "every@1h"),
      ScheduleParseError,
    );

    // Updating an existing destination succeeds and reloads cleanly
    await store.setPreference("-100501", "every@30m");
    const reloaded = await new FileChatDigestPreferencesStore(file, {
      maxDestinations: 2,
    }).load();
    assert.equal(reloaded.size, 2);
    assert.equal(reloaded.get("-100501")?.preference.intervalMs, 30 * 60 * 1000);
    assert.equal(reloaded.get("-100501")?.lastFlushMs, 1_700_000_900_000);
    assert.equal(reloaded.get("@mimir_feed")?.preference.mode, "schedule");

    // Out-of-bounds interval persisted on disk fails validation on load
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        chats: { "-100501": { spec: "every@10s", lastFlushMs: null } },
      }),
      "utf-8",
    );
    await assert.rejects(() => store.load(), ScheduleParseError);
  });
});
