/**
 * Focused coverage for redacted dead-letter incident bundle export (#771).
 *
 * Verifies:
 *   - Queue metadata (`depth`, `maxEntries`, `maxAttempts`, `bySource`,
 *     `byReasonCode`, `oldestEnqueuedAt`, `newestEnqueuedAt`) and stable
 *     reason code classification.
 *   - Complete omission of bot credentials, raw message bodies, host file
 *     paths, and private destination identifiers (numeric chat IDs, `@channel`
 *     handles, and non-public route names).
 *   - CLI `dlq bundle [--output PATH] [--json]` file and stdout export, plus
 *     clean handling of missing/empty dead-letter files.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  classifyDeadLetterReasonCode,
  createDeadLetterQueue,
} from "../dist/deadLetter.js";
import { exportDeadLetterBundle, runDlqCli } from "../dist/dlq-cli.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const FAKE_BOT_CRED = ["1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALD", "saw"].join("");
const PRIVATE_GROUP_ID = "-1009876543210";
const PRIVATE_DM_ID = "88776655";
const PRIVATE_CHANNEL = "@mimir_private_ops";

test("classifyDeadLetterReasonCode maps failure descriptions to stable reason codes", () => {
  assert.equal(classifyDeadLetterReasonCode("Telegram 429: Too Many Requests: retry after 12"), "RATE_LIMITED");
  assert.equal(classifyDeadLetterReasonCode("sendMessage timed out after 10000ms"), "TIMEOUT");
  assert.equal(classifyDeadLetterReasonCode("403 Forbidden: bot was blocked by the user"), "AUTH_OR_PERMISSION");
  assert.equal(classifyDeadLetterReasonCode("400 Bad Request: can't parse entities"), "BAD_REQUEST");
  assert.equal(classifyDeadLetterReasonCode("502 Bad Gateway"), "UPSTREAM_UNAVAILABLE");
  assert.equal(classifyDeadLetterReasonCode("TypeError: fetch failed (ECONNRESET)"), "NETWORK_ERROR");
  assert.equal(classifyDeadLetterReasonCode(null), "UNKNOWN");
});

test("incident bundle includes queue metadata and omits credentials and private destinations", async () => {
  await withTempDataDir(async (dir) => {
    const filePath = dir.file("dead-letter.json");
    const outputPath = dir.file("incident-bundle.json");
    let clock = 1_700_000_000_000;

    // Seed hand-crafted file including a custom private destination route name,
    // embedded bot token URL, numeric chat IDs, DM ID, and @channel handle.
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-10-18T12:00:00.000Z",
        entries: [
          {
            id: "market:701:claim_created:11223344",
            enqueuedAt: "2026-10-18T11:58:00.000Z",
            source: "market",
            ledger: 701,
            eventName: "claim_created",
            text: `Confidential body for ${PRIVATE_GROUP_ID} and ${PRIVATE_CHANNEL}`,
            attempts: 2,
            lastError: `POST https://api.telegram.org/bot${FAKE_BOT_CRED}/sendMessage to chat_id=${PRIVATE_GROUP_ID} failed: 429 Too Many Requests`,
          },
          {
            id: `${PRIVATE_CHANNEL}:702:market_resolved:55667788`,
            enqueuedAt: "2026-10-18T11:59:30.000Z",
            source: PRIVATE_CHANNEL,
            ledger: 702,
            eventName: "market_resolved",
            text: `DM alert for ${PRIVATE_DM_ID}`,
            attempts: 4,
            lastError: `403 Forbidden: chat ${PRIVATE_DM_ID} (${PRIVATE_CHANNEL}) not accessible`,
          },
        ],
      }),
      "utf8",
    );

    const prevToken = process.env.BOT_TOKEN;
    const prevChat = process.env.TELEGRAM_CHAT_ID;
    const prevAllowed = process.env.ALLOWED_CHAT_IDS;
    process.env.BOT_TOKEN = FAKE_BOT_CRED;
    process.env.TELEGRAM_CHAT_ID = `${PRIVATE_GROUP_ID},${PRIVATE_DM_ID}`;
    process.env.ALLOWED_CHAT_IDS = PRIVATE_CHANNEL;

    try {
      const stdout = [];
      const stderr = [];
      const { exitCode } = await runDlqCli({
        argv: ["bundle", "--file", filePath, "--output", outputPath, "--json"],
        now: () => clock,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      });

      assert.equal(exitCode, 0);
      assert.equal(stderr.length, 0);

      const fromStdout = JSON.parse(stdout.join("\n"));
      const fromDiskRaw = await readFile(outputPath, "utf8");
      const fromDisk = JSON.parse(fromDiskRaw);
      assert.deepEqual(fromStdout, fromDisk);

      // Metadata & stable reason codes
      assert.equal(fromDisk.schemaVersion, 1);
      assert.equal(fromDisk.queue.depth, 2);
      assert.equal(fromDisk.queue.fileUpdatedAt, "2026-10-18T12:00:00.000Z");
      assert.equal(fromDisk.queue.oldestEnqueuedAt, "2026-10-18T11:58:00.000Z");
      assert.equal(fromDisk.queue.newestEnqueuedAt, "2026-10-18T11:59:30.000Z");
      assert.deepEqual(fromDisk.queue.bySource, { market: 1, custom_route: 1 });
      assert.equal(fromDisk.queue.byReasonCode.RATE_LIMITED, 1);
      assert.equal(fromDisk.queue.byReasonCode.AUTH_OR_PERMISSION, 1);
      assert.equal(fromDisk.entries[0].reasonCode, "RATE_LIMITED");
      assert.equal(fromDisk.entries[1].reasonCode, "AUTH_OR_PERMISSION");
      assert.equal(fromDisk.entries[1].source, "custom_route");
      assert.equal("text" in fromDisk.entries[0], false);

      // Strict redaction: zero credentials, zero private destination IDs, zero file paths
      assert.equal(fromDiskRaw.includes(FAKE_BOT_CRED), false);
      assert.equal(fromDiskRaw.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALD"), false);
      assert.equal(fromDiskRaw.includes(PRIVATE_GROUP_ID), false);
      assert.equal(fromDiskRaw.includes("43210"), false, "even partial chat id suffixes are omitted");
      assert.equal(fromDiskRaw.includes(PRIVATE_DM_ID), false);
      assert.equal(fromDiskRaw.includes(PRIVATE_CHANNEL), false);
      assert.equal(fromDiskRaw.includes(filePath), false);
      assert.equal(fromDiskRaw.includes("Confidential body"), false);
    } finally {
      if (prevToken === undefined) delete process.env.BOT_TOKEN;
      else process.env.BOT_TOKEN = prevToken;
      if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = prevChat;
      if (prevAllowed === undefined) delete process.env.ALLOWED_CHAT_IDS;
      else process.env.ALLOWED_CHAT_IDS = prevAllowed;
    }
  }, "mimir-dlq-bundle-");
});

test("exportDeadLetterBundle handles missing dead-letter file with an empty bundle", async () => {
  await withTempDataDir(async (dir) => {
    const missingPath = dir.file("absent-dead-letter.json");
    const bundle = await exportDeadLetterBundle({
      filePath: missingPath,
      now: () => 1_700_000_005_000,
    });
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.queue.depth, 0);
    assert.equal(bundle.queue.fileUpdatedAt, null);
    assert.equal(bundle.entries.length, 0);

    // In-memory queue method also works directly.
    const queue = createDeadLetterQueue({
      filePath: null,
      maxEntries: 25,
      maxAttempts: 4,
      now: () => 1_700_000_005_000,
      quiet: true,
    });
    assert.equal(queue.incidentBundle().queue.maxEntries, 25);
    assert.equal(queue.incidentBundle().queue.maxAttempts, 4);
  }, "mimir-dlq-bundle-empty-");
});
