import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { clearSecrets, registerSecret } from "../dist/redact.js";
import {
  createEventArchive,
  formatPrivacyReviewReport,
  reviewArchivePrivacy,
  reviewScanJsonlPrivacy,
} from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const PUBLIC_CONTRACT = "C" + "A".repeat(55);
const PUBLIC_CREATOR = "G" + "B".repeat(55);

function makeCleanEvent(id = 1) {
  return {
    source: "market",
    contractId: PUBLIC_CONTRACT,
    ledger: 5000 + id,
    txHash: "a".repeat(64),
    eventId: `${5000 + id}-1`,
    payload: {
      name: "claim_created",
      claimId: id,
      creator: PUBLIC_CREATOR,
      question: `Will ledger ${5000 + id} finalize on schedule?`,
      deadline: 1700001000,
      feeBps: 100,
    },
  };
}

test("clean public chain archives pass privacy review without false positives", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("clean-archive");
    const archive = createEventArchive({ dir: archiveDir, maxBytes: 300 });
    await archive.append([makeCleanEvent(1), makeCleanEvent(2)]);
    await archive.close();

    const report = await reviewArchivePrivacy(archiveDir);
    assert.equal(report.shareable, true);
    assert.equal(report.findingCount, 0);
    assert.equal(report.filesScanned, 2);
    assert.equal(report.recordsScanned, 2);

    const strictReport = await reviewArchivePrivacy(archiveDir, {
      flagPublicAccountAddresses: true,
    });
    assert.equal(strictReport.shareable, false);
    assert.equal(strictReport.countsByCategory.public_address, 2);
  });
});

test("detects private chat identifiers and secret-shaped values without leaking raw values or calling network", async () => {
  clearSecrets();
  const botToken = ["123456789:AA", "Z".repeat(33)].join("");
  const secretSeed = ["S", "D".repeat(55)].join("");
  const pemHeader = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  const credUrl = ["https://alice:", "hunter22@rpc.example.org/?api", "_key=", "xyz987654"].join("");
  const bearerVal = ["Bear", "er ", "eyJ0eX", "AiOiJKV1QiLCJhbGciOiJIUzI1NiJ9"].join("");
  const registeredCanary = ["custom_canary_", "9988776655"].join("");
  const privateSupergroup = "-1001987654321";
  const privateHandle = "@secret_ops_channel";

  registerSecret(registeredCanary);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Privacy review must never contact external services");
  };

  try {
    const leakedEvent = {
      ...makeCleanEvent(10),
      chatId: privateSupergroup,
      notifyMember: 8877665544,
      botToken,
      payload: {
        name: "claim_created",
        claimId: 10,
        creator: PUBLIC_CREATOR,
        question: `seed=${secretSeed} ${pemHeader} ${credUrl} ${bearerVal} ${registeredCanary} room=${privateHandle} https://t.me/+AbCdEfGhIjKlMnOp`,
        deadline: 1700001000,
        feeBps: 100,
      },
    };

    const jsonl = formatScanJsonl([leakedEvent]);
    const report = reviewScanJsonlPrivacy(jsonl, {
      knownChatIds: ["8877665544"],
    });

    assert.equal(report.shareable, false);
    assert.ok(report.countsByCategory.secret >= 6);
    assert.ok(report.countsByCategory.private_chat_id >= 5);
    assert.ok(report.countsByRule.known_chat_id >= 1);
    assert.ok(report.countsByRule.telegram_bot_token >= 1);
    assert.ok(report.countsByRule.stellar_secret_seed >= 1);
    assert.ok(report.countsByRule.pem_private_key >= 1);
    assert.ok(report.countsByRule.url_credential >= 1);
    assert.ok(report.countsByRule.bearer_token >= 1);
    assert.ok(report.countsByRule.known_secret >= 1);
    assert.ok(report.countsByRule.secret_field >= 1);
    assert.ok(report.countsByRule.chat_id_field >= 1);
    assert.ok(report.countsByRule.telegram_supergroup_id >= 1);
    assert.ok(report.countsByRule.telegram_handle >= 1);
    assert.ok(report.countsByRule.telegram_invite_link >= 1);

    // Ensure neither JSON serialized report nor human text leaks any raw sensitive string.
    const serialized = JSON.stringify(report) + "\n" + formatPrivacyReviewReport(report);
    for (const sensitive of [
      botToken,
      secretSeed,
      "hunter22",
      "xyz987654",
      registeredCanary,
      privateSupergroup,
      privateHandle,
      "AbCdEfGhIjKlMnOp",
    ]) {
      assert.equal(
        serialized.includes(sensitive),
        false,
        `Report must never echo raw sensitive value: ${sensitive.slice(0, 6)}...`,
      );
    }
  } finally {
    globalThis.fetch = origFetch;
    clearSecrets();
  }
});

test("produces byte-identical deterministic reports regardless of JSON property order", () => {
  const secretSeed = ["S", "C".repeat(55)].join("");
  const lineA = JSON.stringify({
    zField: secretSeed,
    chat_id: "-1005555555555",
    aField: "ok",
  });
  const lineB = JSON.stringify({
    aField: "ok",
    chat_id: "-1005555555555",
    zField: secretSeed,
  });

  const repA = reviewScanJsonlPrivacy(lineA + "\n", { sourceName: "sample.jsonl" });
  const repB = reviewScanJsonlPrivacy(lineB + "\n", { sourceName: "sample.jsonl" });

  assert.deepEqual(repA, repB);
  assert.equal(formatPrivacyReviewReport(repA), formatPrivacyReviewReport(repB));
});

test("flags malformed JSON records as non-shareable while still scanning raw line for secrets", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("malformed-archive");
    await mkdir(archiveDir, { recursive: true });
    const botToken = ["987654321:AA", "Q".repeat(33)].join("");

    await writeFile(
      path.join(archiveDir, "events-2026-11-01T00-00-00-000Z-000001.jsonl"),
      `${JSON.stringify(makeCleanEvent(1))}\n{"broken": "${botToken}"\n`,
      "utf8",
    );

    const report = await reviewArchivePrivacy(archiveDir);
    assert.equal(report.shareable, false);
    assert.equal(report.countsByCategory.malformed_record, 1);
    assert.equal(report.countsByRule.telegram_bot_token, 1);
    assert.equal(report.findings[0].line, 2);

    await assert.rejects(() => reviewArchivePrivacy(tmp.file("does-not-exist")));
  });
});
