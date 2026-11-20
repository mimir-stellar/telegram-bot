/**
 * Tests for multi-page digest delivery and crash recovery across restarts.
 *
 * Scope:
 *   - FileDigestDeliveryStore: intent, confirmation, uncertain detection on restart,
 *     corrupt line tolerance, compaction
 *   - deliverMultiPageDigest: clean delivery, skipping confirmed pages, handling transport failures
 *   - recoverMultiPageDigest: recovery after restart, avoiding resending confirmed pages,
 *     reporting uncertain sends, inspection mode
 *   - paginateDigestGroups: chunking groups and events into pages
 *   - Scheduler integration with digestStore
 */

import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";

import {
  FileDigestDeliveryStore,
  deliverMultiPageDigest,
  recoverMultiPageDigest,
  createScheduler,
  FileLastRunStore,
} from "../dist/notifications/schedule.js";
import {
  groupDigestEvents,
  paginateDigestGroups,
  createMultiPageDigest,
} from "../dist/notifications/digest-grouping.js";
import { createTempDataDir } from "./helpers/temp-data.mjs";

function makeFakeEvent(id, source = "market", claimOrMarketId = 1) {
  return {
    source,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    version: "v1",
    ledger: 1000 + id,
    txHash: "0".repeat(64),
    at: 1700000000 + id,
    eventId: `evt-${id}`,
    eventType: "contract",
    transactionIndex: id,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload:
      source === "market"
        ? { name: "claim_created", claimId: claimOrMarketId }
        : { name: "market_created", marketId: claimOrMarketId },
  };
}

// ── FileDigestDeliveryStore in Isolation ─────────────────────────────────────

test("FileDigestDeliveryStore: intent followed by confirmation records confirmed status", async () => {
  const dir = await createTempDataDir("mimir-digest-store-");
  try {
    const filePath = dir.file("digest-delivery.jsonl");
    const store = new FileDigestDeliveryStore({ filePath, now: () => 1_700_000_000_000 });

    await store.recordPageIntent({
      digestId: "digest-1",
      destination: "-100123",
      pageIndex: 0,
      totalPages: 3,
    });

    let outcomes = await store.loadDigestOutcomes("digest-1");
    assert.equal(outcomes.get("-100123")?.get(0)?.status, "uncertain");

    await store.recordPageConfirmed({
      digestId: "digest-1",
      destination: "-100123",
      pageIndex: 0,
      totalPages: 3,
    });

    outcomes = await store.loadDigestOutcomes("digest-1");
    assert.equal(outcomes.get("-100123")?.get(0)?.status, "confirmed");
  } finally {
    await dir.cleanup();
  }
});

test("FileDigestDeliveryStore: crash recovery detects unconfirmed intent as uncertain", async () => {
  const dir = await createTempDataDir("mimir-digest-crash-");
  const filePath = dir.file("digest-delivery.jsonl");
  try {
    const initial = new FileDigestDeliveryStore({ filePath, now: () => 1_700_000_000_000 });

    // Page 0 confirmed
    await initial.recordPageIntent({ digestId: "digest-crash", destination: "chat-a", pageIndex: 0, totalPages: 2 });
    await initial.recordPageConfirmed({ digestId: "digest-crash", destination: "chat-a", pageIndex: 0, totalPages: 2 });

    // Page 1 intent recorded, but process crashed before confirmation
    await initial.recordPageIntent({ digestId: "digest-crash", destination: "chat-a", pageIndex: 1, totalPages: 2 });

    // Restart process: create a fresh store instance over the same file
    const restarted = new FileDigestDeliveryStore({ filePath });
    const outcomes = await restarted.loadDigestOutcomes("digest-crash");

    const page0 = outcomes.get("chat-a")?.get(0);
    const page1 = outcomes.get("chat-a")?.get(1);

    assert.equal(page0?.status, "confirmed", "confirmed page survives restart");
    assert.equal(page1?.status, "uncertain", "intent without confirmation is classified as uncertain");

    const incomplete = await restarted.loadIncompleteDigests();
    assert.deepEqual(incomplete, ["digest-crash"], "uncompleted digest is listed as incomplete");
  } finally {
    await dir.cleanup();
  }
});

test("FileDigestDeliveryStore: tolerates missing file, corrupt lines, and handles compaction", async () => {
  const dir = await createTempDataDir("mimir-digest-corrupt-");
  const filePath = dir.file("digest-delivery.jsonl");
  try {
    const store = new FileDigestDeliveryStore({ filePath, maxEntries: 4 });

    // Missing file returns empty outcomes without throwing
    assert.equal((await store.loadIncompleteDigests()).length, 0);

    // Record complete digest 1
    await store.recordPageIntent({ digestId: "d1", destination: "c1", pageIndex: 0, totalPages: 1 });
    await store.recordPageConfirmed({ digestId: "d1", destination: "c1", pageIndex: 0, totalPages: 1 });
    await store.markDigestComplete("d1");

    // Inject corrupted JSON line into the file
    await appendFile(filePath, "CORRUPT_JSON_DATA_GARBAGE\n{\"incomplete\n", "utf8");

    // Record incomplete digest 2
    await store.recordPageIntent({ digestId: "d2", destination: "c1", pageIndex: 0, totalPages: 2 });

    // Reading skips corrupt lines safely
    const incomplete = await store.loadIncompleteDigests();
    assert.deepEqual(incomplete, ["d2"]);

    // Compacting drops completed d1 and corrupt lines, keeping only incomplete d2
    await store.compact();
    const incompleteAfter = await store.loadIncompleteDigests();
    assert.deepEqual(incompleteAfter, ["d2"]);
  } finally {
    await dir.cleanup();
  }
});

// ── Multi-Page Delivery & Recovery ──────────────────────────────────────────

test("deliverMultiPageDigest: clean delivery dispatches all pages to all destinations", async () => {
  const dir = await createTempDataDir("mimir-digest-clean-");
  try {
    const filePath = dir.file("digest-delivery.jsonl");
    const store = new FileDigestDeliveryStore({ filePath });

    const sent = [];
    const report = await deliverMultiPageDigest({
      digest: {
        id: "digest-clean-1",
        pages: ["Page 1: Events", "Page 2: Events", "Page 3: Events"],
      },
      destinations: ["chat-1", "chat-2"],
      store,
      sendPage: async (destination, page, pageIndex, totalPages) => {
        sent.push({ destination, page, pageIndex, totalPages });
      },
    });

    assert.equal(report.completed, true);
    assert.equal(report.deliveredPages.length, 6); // 3 pages * 2 destinations
    assert.equal(report.skippedConfirmed.length, 0);
    assert.equal(report.uncertainSends.length, 0);
    assert.equal(report.failedPages.length, 0);
    assert.equal(sent.length, 6);

    // Incomplete list should now be empty because digest completed
    const incomplete = await store.loadIncompleteDigests();
    assert.equal(incomplete.length, 0);
  } finally {
    await dir.cleanup();
  }
});

test("recovery after restart: avoids resending confirmed pages while reporting uncertain sends", async () => {
  const dir = await createTempDataDir("mimir-digest-recovery-");
  const filePath = dir.file("digest-delivery.jsonl");

  try {
    const initialStore = new FileDigestDeliveryStore({ filePath, now: () => 1000 });

    const digest = {
      id: "digest-restart-drill",
      pages: ["Page 0 (Alpha)", "Page 1 (Beta)", "Page 2 (Gamma)"],
    };

    // Simulate partial delivery before crash:
    // Chat 1:
    //   - Page 0: sent and confirmed
    //   - Page 1: intent written, but crash happens mid-send (unconfirmed)
    //   - Page 2: never started
    await initialStore.recordPageIntent({ digestId: digest.id, destination: "chat-1", pageIndex: 0, totalPages: 3 });
    await initialStore.recordPageConfirmed({ digestId: digest.id, destination: "chat-1", pageIndex: 0, totalPages: 3 });
    await initialStore.recordPageIntent({ digestId: digest.id, destination: "chat-1", pageIndex: 1, totalPages: 3 });

    // Chat 2:
    //   - Page 0: intent written, crash happens mid-send (unconfirmed)
    //   - Page 1: never started
    //   - Page 2: never started
    await initialStore.recordPageIntent({ digestId: digest.id, destination: "chat-2", pageIndex: 0, totalPages: 3 });

    // ──────────────────────────────────────────────────────────────────────────
    // RESTART: Simulate bot process restarting with a fresh store over same file
    // ──────────────────────────────────────────────────────────────────────────
    const restartStore = new FileDigestDeliveryStore({ filePath, now: () => 2000 });

    const sendCalls = [];
    const reportedUncertain = [];

    const recoveryReport = await recoverMultiPageDigest({
      digest,
      destinations: ["chat-1", "chat-2"],
      store: restartStore,
      sendPage: async (destination, page, pageIndex, totalPages) => {
        sendCalls.push({ destination, page, pageIndex, totalPages });
      },
      onUncertainSend: (uncertain) => {
        reportedUncertain.push(uncertain);
      },
    });

    // 1. Confirmed pages were NOT resent
    assert.deepEqual(recoveryReport.skippedConfirmed, [{ destination: "chat-1", pageIndex: 0 }]);
    assert.ok(
      !sendCalls.some((c) => c.destination === "chat-1" && c.pageIndex === 0),
      "Confirmed page (chat-1, page 0) MUST NOT be resent",
    );

    // 2. Uncertain sends were REPORTED and NOT resent
    assert.equal(recoveryReport.uncertainSends.length, 2);
    assert.deepEqual(
      recoveryReport.uncertainSends.map((u) => ({ dest: u.destination, page: u.pageIndex })),
      [
        { dest: "chat-1", page: 1 },
        { dest: "chat-2", page: 0 },
      ],
      "Both in-flight pages prior to restart are reported as uncertain sends",
    );
    assert.equal(reportedUncertain.length, 2, "onUncertainSend callback invoked for each uncertain send");

    assert.ok(
      !sendCalls.some((c) => c.destination === "chat-1" && c.pageIndex === 1),
      "Uncertain page (chat-1, page 1) MUST NOT be blindly resent",
    );
    assert.ok(
      !sendCalls.some((c) => c.destination === "chat-2" && c.pageIndex === 0),
      "Uncertain page (chat-2, page 0) MUST NOT be blindly resent",
    );

    // 3. Unsent pages were delivered
    assert.deepEqual(
      sendCalls.map((c) => ({ dest: c.destination, page: c.pageIndex })),
      [
        { dest: "chat-1", page: 2 },
        { dest: "chat-2", page: 1 },
        { dest: "chat-2", page: 2 },
      ],
      "Only the remaining unattempted pages were sent during recovery",
    );

    assert.equal(recoveryReport.completed, true);

    // After full settlement, running recovery again results in 0 sends
    const followUpCalls = [];
    const followUpReport = await recoverMultiPageDigest({
      digest,
      destinations: ["chat-1", "chat-2"],
      store: restartStore,
      sendPage: async () => {
        followUpCalls.push(true);
      },
    });

    assert.equal(followUpCalls.length, 0, "No subsequent sends once digest is completed");
    assert.equal(followUpReport.completed, true);
  } finally {
    await dir.cleanup();
  }
});

test("recoverMultiPageDigest inspection mode: inspects state without sending", async () => {
  const dir = await createTempDataDir("mimir-digest-inspect-");
  const filePath = dir.file("digest-delivery.jsonl");
  try {
    const store = new FileDigestDeliveryStore({ filePath });
    const digest = { id: "digest-inspect", pages: ["P0", "P1"] };

    await store.recordPageIntent({ digestId: digest.id, destination: "dest-1", pageIndex: 0, totalPages: 2 });
    await store.recordPageConfirmed({ digestId: digest.id, destination: "dest-1", pageIndex: 0, totalPages: 2 });
    await store.recordPageIntent({ digestId: digest.id, destination: "dest-1", pageIndex: 1, totalPages: 2 });

    // Inspect without passing sendPage
    const report = await recoverMultiPageDigest({
      digest,
      destinations: ["dest-1"],
      store,
    });

    assert.equal(report.skippedConfirmed.length, 1);
    assert.equal(report.uncertainSends.length, 1);
    assert.equal(report.deliveredPages.length, 0);
    assert.equal(report.completed, false, "incomplete while pending/uncertain pages exist");
  } finally {
    await dir.cleanup();
  }
});

test("deliverMultiPageDigest: transport failure marks page as failed and keeps digest incomplete", async () => {
  const dir = await createTempDataDir("mimir-digest-fail-");
  try {
    const filePath = dir.file("digest-delivery.jsonl");
    const store = new FileDigestDeliveryStore({ filePath });

    const report = await deliverMultiPageDigest({
      digest: { id: "digest-err", pages: ["Page 0", "Page 1"] },
      destinations: ["chat-1"],
      store,
      sendPage: async (_dest, _page, index) => {
        if (index === 1) throw new Error("Telegram rate limit HTTP 429");
      },
    });

    assert.equal(report.completed, false);
    assert.equal(report.deliveredPages.length, 1);
    assert.equal(report.failedPages.length, 1);
    assert.equal(report.failedPages[0].error, "Telegram rate limit HTTP 429");

    const incomplete = await store.loadIncompleteDigests();
    assert.deepEqual(incomplete, ["digest-err"], "digest remains incomplete after transport failure");
  } finally {
    await dir.cleanup();
  }
});

test("empty pages or destinations boundary cases", async () => {
  const dir = await createTempDataDir("mimir-digest-empty-");
  try {
    const store = new FileDigestDeliveryStore({ filePath: dir.file("digest.jsonl") });

    const reportNoPages = await deliverMultiPageDigest({
      digest: { id: "d-empty-pages", pages: [] },
      destinations: ["c1"],
      store,
      sendPage: async () => {},
    });
    assert.equal(reportNoPages.completed, true);

    const reportNoDest = await deliverMultiPageDigest({
      digest: { id: "d-empty-dest", pages: ["P1"] },
      destinations: [],
      store,
      sendPage: async () => {},
    });
    assert.equal(reportNoDest.completed, true);
  } finally {
    await dir.cleanup();
  }
});

// ── paginateDigestGroups Helper ──────────────────────────────────────────────

test("paginateDigestGroups: chunks groups by maxGroupsPerPage and maxEventsPerPage", () => {
  const events = [
    makeFakeEvent(1, "market", 10),
    makeFakeEvent(2, "market", 10),
    makeFakeEvent(3, "market", 20),
    makeFakeEvent(4, "squad", 30),
    makeFakeEvent(5, "squad", 30),
  ];

  const groups = groupDigestEvents(events);
  assert.equal(groups.length, 3); // market:10 (2 events), market:20 (1 event), squad:30 (2 events)

  // Chunk by max 2 groups per page
  const pagesByGroup = paginateDigestGroups(groups, { maxGroupsPerPage: 2 });
  assert.equal(pagesByGroup.length, 2);
  assert.equal(pagesByGroup[0].length, 2);
  assert.equal(pagesByGroup[1].length, 1);

  // Chunk by max 3 events per page
  const pagesByEvent = paginateDigestGroups(groups, { maxEventsPerPage: 3 });
  assert.equal(pagesByEvent.length, 2);
  assert.equal(pagesByEvent[0].length, 2); // 2 + 1 = 3 events
  assert.equal(pagesByEvent[1].length, 1); // 2 events

  // Empty groups return empty pages
  assert.deepEqual(paginateDigestGroups([], 5), []);

  // createMultiPageDigest produces standard payload
  const multiPage = createMultiPageDigest("digest-test", ["P1", "P2"]);
  assert.equal(multiPage.id, "digest-test");
  assert.deepEqual(multiPage.pages, ["P1", "P2"]);
});

// ── Scheduler Integration ────────────────────────────────────────────────────

test("scheduler with digestStore logs and reports incomplete digests on start", async () => {
  const dir = await createTempDataDir("mimir-sched-digest-");
  try {
    const lastRunStore = new FileLastRunStore(dir.file("last-run"));
    const digestStore = new FileDigestDeliveryStore(dir.file("digest.jsonl"));

    // Seed an incomplete digest
    await digestStore.recordPageIntent({ digestId: "pending-digest", destination: "chat", pageIndex: 0, totalPages: 2 });

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    const scheduler = createScheduler({
      schedule: "daily@09:00",
      lastRunStore,
      digestStore,
      run: async () => {},
    });

    try {
      await scheduler.start();
      assert.ok(
        warnings.some((w) => w.includes("partially delivered digest")),
        "Scheduler logs partially delivered digests on startup",
      );
      await scheduler.stop();
    } finally {
      console.warn = origWarn;
    }
  } finally {
    await dir.cleanup();
  }
});
