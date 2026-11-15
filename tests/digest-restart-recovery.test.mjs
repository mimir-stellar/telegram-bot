import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DigestRecoveryMismatchError,
  deliverMultiPageDigest,
  formatDigestRecoveryReport,
  recoverPartialDigests,
  splitDigestIntoPages,
} from "../dist/notifications/digest-grouping.js";
import { FileDigestRecoveryStore } from "../dist/notifications/schedule.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

function makeEvent(ledger, claimId) {
  return {
    source: "market",
    contractId: "CDUMMY00000000000000000000000000000000000000000000000000",
    version: "v1",
    ledger,
    txHash: "c".repeat(64),
    at: 1_763_193_600 + ledger,
    eventId: `${ledger}-0`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: BigInt(claimId),
      creator: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      category: "crypto",
    },
  };
}

test("recovers partially delivered multi-page digest after abrupt child-process crash without resending confirmed pages", async () => {
  await withTempDataDir(async ({ file }) => {
    const stateFile = file("digest-recovery.json");
    const groupingUrl = new URL("../dist/notifications/digest-grouping.js", import.meta.url).href;
    const scheduleUrl = new URL("../dist/notifications/schedule.js", import.meta.url).href;

    // Crash mid-send on chat-b page 1 after chat-a confirmed pages 0..2 and chat-b confirmed page 0.
    const crashScript = `
      const { deliverMultiPageDigest } = await import(${JSON.stringify(groupingUrl)});
      const { FileDigestRecoveryStore } = await import(${JSON.stringify(scheduleUrl)});
      const store = new FileDigestRecoveryStore(${JSON.stringify(stateFile)});
      await deliverMultiPageDigest({
        store,
        digestId: "daily-2026-11-15",
        destinations: ["-100111", "-100222"],
        pages: ["Page 1 body", "Page 2 body", "Page 3 body"],
        now: () => 1763193600000,
        sendPage: async (dest, _text, ctx) => {
          if (dest === "-100222" && ctx.pageIndex === 1) {
            process.exit(137);
          }
        },
      });
    `;

    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", crashScript], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 137);

    const store = new FileDigestRecoveryStore(stateFile);
    const recoveredSends = [];
    const uncertainReported = [];

    const summaries = await recoverPartialDigests({
      store,
      now: () => 1_763_193_700_000,
      onUncertain: (outcome) => uncertainReported.push(outcome),
      sendPage: async (dest, text, ctx) => {
        recoveredSends.push({ dest, pageIndex: ctx.pageIndex, text });
      },
    });

    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.equal(summary.digestId, "daily-2026-11-15");

    // Confirmed before crash: -100111 pages 0,1,2 and -100222 page 0 => 4 skipped, 0 resent!
    assert.equal(summary.skippedConfirmedPages.length, 4);
    // In-flight during crash: -100222 page 1 => promoted to uncertain, reported, NOT resent!
    assert.equal(summary.uncertainPages.length, 1);
    assert.equal(summary.uncertainPages[0].destination, "-100222");
    assert.equal(summary.uncertainPages[0].pageIndex, 1);
    assert.equal(summary.uncertainPages[0].status, "uncertain");
    assert.equal(uncertainReported.length, 1);

    // Pending before crash: -100222 page 2 => delivered on recovery!
    assert.deepEqual(recoveredSends, [
      { dest: "-100222", pageIndex: 2, text: "Page 3 body" },
    ]);

    const report = formatDigestRecoveryReport(summary);
    assert.match(report, /confirmedSkipped=4/);
    assert.match(report, /uncertain=1 \[-100222#p2\/3\(/);

    // Subsequent restart does nothing because all pages are settled and uncertain send was reported.
    const secondPass = await recoverPartialDigests({
      store,
      sendPage: async () => {
        throw new Error("should not send on settled run");
      },
    });
    assert.equal(secondPass.length, 0);

    // Stored page text bodies are scrubbed once no pending/failed pages remain.
    const persisted = await store.loadRuns();
    assert.equal(persisted[0].pages, undefined);
  });
});

test("retries deterministic failures while reporting timed-out sends as uncertain", async () => {
  await withTempDataDir(async ({ file }) => {
    const store = new FileDigestRecoveryStore(file("digest-recovery.json"));
    const events = [makeEvent(10, 1), makeEvent(11, 2), makeEvent(12, 3)];
    const pages = splitDigestIntoPages(events, { maxPageChars: 95 });
    assert.ok(pages.length >= 2);

    const uncertain = [];
    const first = await deliverMultiPageDigest({
      store,
      digestId: "burst-1",
      destinations: ["-100333"],
      pages: ["P0", "P1", "P2"],
      onUncertain: (u) => uncertain.push(u),
      sendPage: async (_dest, _text, ctx) => {
        if (ctx.pageIndex === 1) {
          const err = new Error("Telegram request timed out");
          err.name = "TimeoutError";
          throw err;
        }
        if (ctx.pageIndex === 2) {
          throw new Error("502 Bad Gateway");
        }
      },
    });

    assert.equal(first.sentPages.length, 1); // P0 confirmed
    assert.equal(first.uncertainPages.length, 1); // P1 timed out -> uncertain
    assert.equal(first.failedPages.length, 1); // P2 502 -> failed

    const retried = [];
    const second = await deliverMultiPageDigest({
      store,
      digestId: "burst-1",
      destinations: ["-100333"],
      pages: ["P0", "P1", "P2"],
      sendPage: async (dest, text, ctx) => {
        retried.push({ dest, pageIndex: ctx.pageIndex, text });
      },
    });

    assert.equal(second.skippedConfirmedPages.length, 1); // P0 skipped
    assert.equal(second.uncertainPages.length, 1); // P1 reported uncertain, not resent
    assert.deepEqual(retried, [{ dest: "-100333", pageIndex: 2, text: "P2" }]);
  });
});

test("rejects mismatched page hashes for an existing digestId and quarantines corrupt state files", async () => {
  await withTempDataDir(async ({ root, file }) => {
    const statePath = file("digest-recovery.json");
    const store = new FileDigestRecoveryStore(statePath, { maxRuns: 2 });

    await deliverMultiPageDigest({
      store,
      digestId: "run-a",
      destinations: ["-1001"],
      pages: ["Alpha", "Beta"],
      sendPage: async () => {},
    });

    await assert.rejects(
      () =>
        deliverMultiPageDigest({
          store,
          digestId: "run-a",
          destinations: ["-1001"],
          pages: ["Alpha", "TAMPERED"],
          sendPage: async () => {},
        }),
      DigestRecoveryMismatchError,
    );

    // Corrupt recovery state on disk is quarantined rather than crashing recovery.
    await fs.writeFile(statePath, "{not-valid-json", "utf-8");
    const recovered = await recoverPartialDigests({
      store,
      sendPage: async () => {},
    });
    assert.deepEqual(recovered, []);
    const entries = await fs.readdir(root);
    assert.ok(entries.some((name) => name.startsWith("digest-recovery.json.corrupt.")));
  });
});
