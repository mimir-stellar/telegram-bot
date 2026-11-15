/**
 * Focused tests for rejecting dead-letter replay of entries from another network (#768).
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  createDeadLetterQueue,
  DeadLetterNetworkMismatchError,
  isEntryNetworkCompatible,
} from "../dist/deadLetter.js";
import {
  checkNetworkCompatibility,
  listDeadLetters,
  runDlqCli,
} from "../dist/dlq-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

test("flush and replayEntry reject entries from another network and leave them unchanged on disk", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    let clock = 1_700_000_000_000;

    // 1. Enqueue an entry while running on Testnet.
    const testnetQueue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 5,
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      now: () => clock,
      quiet: true,
    });
    await testnetQueue.load();
    const parkedTestnet = await testnetQueue.enqueue({
      source: "market",
      ledger: 101,
      eventName: "claim_created",
      text: "Testnet claim #101",
      error: "Telegram 429",
    });
    assert.equal(parkedTestnet.network, "testnet");
    assert.equal(parkedTestnet.networkPassphrase, TESTNET_PASSPHRASE);

    const beforeRaw = await readFile(filePath, "utf8");

    // 2. Restart under Mainnet configuration: flush must NOT send or mutate the Testnet entry.
    clock += 60_000;
    const mainnetQueue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 5,
      network: "mainnet",
      networkPassphrase: MAINNET_PASSPHRASE,
      now: () => clock,
      quiet: true,
    });
    await mainnetQueue.load();

    const sent = [];
    const flushRes = await mainnetQueue.flush(async (text) => {
      sent.push(text);
    }, 10);

    assert.equal(flushRes.sent, 0);
    assert.equal(flushRes.incompatible, 1);
    assert.equal(flushRes.remaining, 1);
    assert.deepEqual(sent, []);
    assert.equal(
      await readFile(filePath, "utf8"),
      beforeRaw,
      "flush with only incompatible entries must leave the queue file byte-for-byte unchanged",
    );

    // Explicit single-entry replay rejects with DeadLetterNetworkMismatchError and leaves entry untouched.
    await assert.rejects(
      () =>
        mainnetQueue.replayEntry(parkedTestnet.id, async () => {
          sent.push("unexpected");
        }),
      (err) => err instanceof DeadLetterNetworkMismatchError,
    );
    assert.deepEqual(sent, []);
    assert.deepEqual(mainnetQueue.snapshot()[0], parkedTestnet);
  }, "mimir-dlq-net-mismatch-");
});

test("mixed queue replays compatible entries and legacy entries while preserving incompatible entries unchanged", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");

    // Seed a mixed file: 1 incompatible (testnet), 1 compatible (mainnet), 1 legacy (no network fields),
    // and 1 custom network with a different passphrase.
    const incompatibleTestnet = {
      id: "market:10:claim_created:11111111",
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      source: "market",
      ledger: 10,
      eventName: "claim_created",
      text: "Testnet alert",
      attempts: 2,
      lastError: "429",
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
    };
    const incompatibleCustom = {
      id: "squad:11:deposited:22222222",
      enqueuedAt: "2026-01-01T00:01:00.000Z",
      source: "squad",
      ledger: 11,
      eventName: "deposited",
      text: "Custom net alert",
      attempts: 1,
      lastError: "503",
      network: "custom",
      networkPassphrase: "Private Sandbox ; 2026",
    };
    const compatibleMainnet = {
      id: "market:12:market_settled:33333333",
      enqueuedAt: "2026-01-01T00:02:00.000Z",
      source: "market",
      ledger: 12,
      eventName: "market_settled",
      text: "Mainnet alert",
      attempts: 1,
      lastError: "timeout",
      network: "mainnet",
      networkPassphrase: MAINNET_PASSPHRASE,
    };
    const legacyEntry = {
      id: "market:13:claim_resolved:44444444",
      enqueuedAt: "2026-01-01T00:03:00.000Z",
      source: "market",
      ledger: 13,
      eventName: "claim_resolved",
      text: "Legacy alert",
      attempts: 1,
      lastError: "500",
    };

    await writeFile(
      filePath,
      JSON.stringify(
        {
          version: 1,
          updatedAt: "2026-01-01T00:05:00.000Z",
          entries: [
            incompatibleTestnet,
            incompatibleCustom,
            compatibleMainnet,
            legacyEntry,
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const mainnetQueue = createDeadLetterQueue({
      filePath,
      maxEntries: 20,
      maxAttempts: 5,
      networkPassphrase: MAINNET_PASSPHRASE,
      quiet: true,
    });
    await mainnetQueue.load();

    const delivered = [];
    const res = await mainnetQueue.flush(async (text) => {
      delivered.push(text);
    }, 10);

    assert.equal(res.sent, 2);
    assert.equal(res.incompatible, 2);
    assert.equal(res.remaining, 2);
    assert.deepEqual(delivered, ["Mainnet alert", "Legacy alert"]);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.entries, [incompatibleTestnet, incompatibleCustom]);
  }, "mimir-dlq-net-mixed-");
});

test("dlq CLI check-network and list surface network compatibility without mutating disk", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const queue = createDeadLetterQueue({
      filePath,
      maxEntries: 10,
      maxAttempts: 5,
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      quiet: true,
    });
    const entry = await queue.enqueue({
      source: "market",
      ledger: 500,
      eventName: "claim_created",
      text: "Testnet #500",
      error: "429",
    });

    const beforeRaw = await readFile(filePath, "utf8");

    // Compatible check exits 0
    const okOut = [];
    const okCli = await runDlqCli({
      argv: ["check-network", "--network", "testnet", "--json", "--file", filePath],
      stdout: (l) => okOut.push(l),
      stderr: () => {},
    });
    assert.equal(okCli.exitCode, 0);
    const parsedOk = JSON.parse(okOut.join("\n"));
    assert.equal(parsedOk.compatible, 1);
    assert.equal(parsedOk.incompatible, 0);

    // Incompatible check exits 1 and leaves file untouched
    const mismatchOut = [];
    const mismatchCli = await runDlqCli({
      argv: [
        "check-network",
        "--network-passphrase",
        MAINNET_PASSPHRASE,
        "--json",
        "--file",
        filePath,
      ],
      stdout: (l) => mismatchOut.push(l),
      stderr: () => {},
    });
    assert.equal(mismatchCli.exitCode, 1);
    const parsedMismatch = JSON.parse(mismatchOut.join("\n"));
    assert.equal(parsedMismatch.compatible, 0);
    assert.equal(parsedMismatch.incompatible, 1);
    assert.equal(parsedMismatch.incompatibleEntries[0].id, entry.id);
    assert.equal(await readFile(filePath, "utf8"), beforeRaw);

    const listed = await listDeadLetters({
      filePath,
      network: "mainnet",
    });
    assert.equal(listed[0].networkCompatible, false);
    assert.match(listed[0].networkMismatchReason ?? "", /does not match/);

    assert.equal(
      isEntryNetworkCompatible(
        { network: "custom", networkPassphrase: "Net A" },
        { network: "custom", networkPassphrase: "Net B" },
      ).compatible,
      false,
    );
  }, "mimir-dlq-net-cli-");
});
