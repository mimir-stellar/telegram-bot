/**
 * Focused tests for recovering orphaned send-journal entries after configuration changes (#766).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  recoverOrphanedJournalEntries,
} from "../dist/notifications/notifier.js";
import {
  createSendJournal,
  OrphanDecisionRequiredError,
} from "../dist/notifications/send-journal.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

test("inspectRecovery identifies removed routes and changed networks and blocks silent replay", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("send-journal.jsonl");
    const journal = createSendJournal({
      filePath: journalPath,
      now: () => 1_700_000_000_000,
    });

    // 1. Compatible active entry on market / testnet
    await journal.recordIntent({
      id: "evt-active-1",
      source: "market",
      ledger: 1001,
      eventName: "claim_created",
      textHash: "aaaa1111",
      route: "market",
      chatId: "-1001111111",
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      at: 1_700_000_000_000,
    });

    // 2. Orphaned because squad route was removed / chat destination changed
    await journal.recordIntent({
      id: "evt-removed-route-2",
      source: "squad",
      ledger: 1002,
      eventName: "deposited",
      textHash: "bbbb2222",
      route: "squad",
      chatId: "-1002222222",
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      at: 1_700_000_001_000,
    });

    // 3. Orphaned because it was recorded under mainnet while current config is testnet
    await journal.recordIntent({
      id: "evt-changed-net-3",
      source: "market",
      ledger: 1003,
      eventName: "market_settled",
      textHash: "cccc3333",
      route: "market",
      chatId: "-1001111111",
      network: "mainnet",
      networkPassphrase: MAINNET_PASSPHRASE,
      at: 1_700_000_002_000,
    });

    // Raw private chat IDs must never appear in persisted journal JSONL.
    const rawDisk = await readFile(journalPath, "utf8");
    assert.equal(rawDisk.includes("-1001111111"), false);
    assert.equal(rawDisk.includes("-1002222222"), false);

    // Current config: only `market` route active on `testnet`.
    const currentConfig = {
      chatId: "-1001111111",
      activeRoutes: ["market"],
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
    };

    // Attempting replay without explicit decisions throws OrphanDecisionRequiredError
    // and performs zero sends.
    const replayed = [];
    await assert.rejects(
      () =>
        recoverOrphanedJournalEntries({
          journal,
          config: currentConfig,
          replay: async (entry, dest) => {
            replayed.push([entry.id, dest]);
          },
        }),
      (err) =>
        err instanceof OrphanDecisionRequiredError &&
        err.entryId === "evt-removed-route-2" &&
        err.reasons.includes("removed_route"),
    );
    assert.deepEqual(replayed, []);

    // Non-strict inspection without replay leaves orphans quarantined on disk.
    const inspected = await recoverOrphanedJournalEntries({
      journal,
      config: currentConfig,
    });
    assert.deepEqual(
      inspected.activePending.map((e) => e.id),
      ["evt-active-1"],
    );
    assert.equal(inspected.unresolvedOrphans.length, 2);
    assert.deepEqual(inspected.unresolvedOrphans[0].reasons, ["removed_route"]);
    assert.deepEqual(inspected.unresolvedOrphans[1].reasons, ["changed_network"]);
  }, "mimir-journal-orphan-detect-");
});

test("explicit discard and reroute decisions settle or replay orphaned entries and reject invalid target routes", async () => {
  await withTempDataDir(async (dir) => {
    const journalPath = dir.file("send-journal.jsonl");
    const journal = createSendJournal({
      filePath: journalPath,
      now: () => 1_700_000_010_000,
    });

    await journal.recordIntent({
      id: "evt-reroute-1",
      source: "squad",
      ledger: 2001,
      eventName: "deposited",
      textHash: "1111aaaa",
      route: "squad",
      chatId: "-1009990001",
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      at: 1_700_000_010_000,
    });

    await journal.recordIntent({
      id: "evt-discard-2",
      source: "market",
      ledger: 2002,
      eventName: "claim_created",
      textHash: "2222bbbb",
      route: "market",
      chatId: "-1008880002",
      network: "mainnet",
      networkPassphrase: MAINNET_PASSPHRASE,
      at: 1_700_000_011_000,
    });

    const currentConfig = {
      chatId: "-1007770003",
      marketChatId: "-1007770003",
      activeRoutes: ["market", "default"],
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
    };

    // Rerouting to a removed/inactive route ("squad") must fail fast.
    await assert.rejects(
      () =>
        recoverOrphanedJournalEntries({
          journal,
          config: currentConfig,
          decisions: {
            "evt-reroute-1": { action: "reroute", targetRoute: "squad" },
            "evt-discard-2": { action: "discard", reason: "wrong_network" },
          },
          strict: true,
        }),
      (err) => err instanceof OrphanDecisionRequiredError && /not an active configured route/.test(err.message),
    );

    // Explicit reroute to active "market" route + discard of cross-network entry succeeds.
    const delivered = [];
    const recovered = await recoverOrphanedJournalEntries({
      journal,
      config: currentConfig,
      decisions: {
        "evt-reroute-1": {
          action: "reroute",
          targetRoute: "market",
          reason: "consolidated_channel",
        },
        "evt-discard-2": {
          action: "discard",
          reason: "mainnet_migration_discard",
        },
      },
      replay: async (entry, dest) => {
        delivered.push({ id: entry.id, route: dest.route, chatId: dest.chatId });
      },
      strict: true,
    });

    assert.deepEqual(recovered.discardedIds, ["evt-discard-2"]);
    assert.deepEqual(recovered.replayedIds, ["evt-reroute-1"]);
    assert.deepEqual(delivered, [
      { id: "evt-reroute-1", route: "market", chatId: "-1007770003" },
    ]);
    assert.deepEqual(await journal.loadPending(), []);
  }, "mimir-journal-orphan-resolve-");
});
