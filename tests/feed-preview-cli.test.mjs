import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  FeedArchiveValidationError,
  readValidatedEventArchive,
  renderOfflineFeedPreview,
  runFeedPreviewCli,
} from "../dist/feed-preview-cli.js";
import { createEventArchive } from "../dist/stellar/archive.js";
import { decodeEvent, dedupeEvents, sortEvents } from "../dist/stellar/decode.js";
import {
  buildScanJsonReport,
  buildScanJsonTarget,
  formatScanJson,
} from "../dist/stellar/events.js";
import { JSON_FEED_VERSION } from "../dist/stellar/feed.js";
import {
  claimChallengedEvent,
  claimCreatedEvent,
  MARKET_CONTRACT,
  SQUAD_CONTRACT,
  squadDepositedEvent,
} from "./fixtures/events.mjs";
import { withTempDataDir } from "./helpers/temp-data.mjs";

const execFileAsync = promisify(execFile);

const VALID_TX = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

function makeArchivedDecodedEvents() {
  const e1 = {
    ...decodeEvent("market", claimCreatedEvent()),
    ledger: 5001,
    txHash: VALID_TX,
    at: 1_700_000_100,
    eventId: "5001-0",
  };
  const e2 = {
    ...decodeEvent("market", claimChallengedEvent({ stake: 25_000_000n })),
    ledger: 5002,
    txHash: VALID_TX,
    at: 1_700_000_200,
    eventId: "5002-0",
  };
  const e3 = {
    ...decodeEvent("squad", squadDepositedEvent({ amount: 50_000_000n, shares: 50_000_000n })),
    contractId: SQUAD_CONTRACT,
    ledger: 5003,
    txHash: VALID_TX,
    at: 1_700_000_300,
    eventId: "5003-0",
  };
  return [e1, e2, e3];
}

test("feed:preview reads a validated event archive directory and writes Atom 1.0 with revived bigint amounts", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append(makeArchivedDecodedEvents());
    await archive.close();

    const chunks = [];
    const errors = [];
    const code = await runFeedPreviewCli(
      [
        "--archive",
        archiveDir,
        "--format",
        "atom",
        "--title",
        "Offline Preview",
        "--self-url",
        "https://mimir.example/feed.atom",
        "--mimir-app-url",
        "https://app.mimir.example",
      ],
      {
        stdout: (s) => chunks.push(s),
        stderr: (s) => errors.push(s),
      },
    );

    assert.equal(code, 0, `unexpected stderr: ${errors.join("")}`);
    const xml = chunks.join("");
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(xml.includes("<title type=\"text\">Offline Preview</title>"));
    assert.ok(xml.includes("https://mimir.example/feed.atom"));
    assert.equal((xml.match(/<entry>/g) ?? []).length, 3);
    // Revived 25_000_000n = 2.5000000 USDC and 50_000_000n = 5.0000000 USDC
    assert.ok(xml.includes("2.5"), "Atom content should include formatted USDC from revived bigint");
    assert.ok(xml.includes("https://app.mimir.example/claims/"), "Atom feed should include Mimir app deep link");
  });
});

test("feed:preview reads a validated archive and writes JSON Feed 1.1 to --out", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("archive-json");
    const outFile = tmp.file("out/preview.json");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append(makeArchivedDecodedEvents());
    await archive.close();

    const code = await runFeedPreviewCli(
      [
        "--archive",
        archiveDir,
        "--format",
        "json",
        "--out",
        outFile,
        "--self-url",
        "https://mimir.example/feed.json",
        "--mimir-app-url",
        "https://app.mimir.example/",
        "--subtitle",
        "Captured Mimir contract events",
      ],
      { stdout: () => {}, stderr: () => {} },
    );

    assert.equal(code, 0);
    const raw = await readFile(outFile, "utf8");
    const doc = JSON.parse(raw);
    assert.equal(doc.version, JSON_FEED_VERSION);
    assert.equal(doc.title, "Mimir Events");
    assert.equal(doc.description, "Captured Mimir contract events");
    assert.equal(doc.feed_url, "https://mimir.example/feed.json");
    assert.equal(doc.home_page_url, "https://app.mimir.example/");
    assert.equal(doc.items.length, 3);
    assert.ok(doc.items[0].url.startsWith("https://stellar.expert/explorer/testnet/tx/"));
    assert.ok(doc.items[0].external_url.startsWith("https://app.mimir.example/claims/"));
    assert.ok(doc.items[2].external_url.startsWith("https://app.mimir.example/squads/"));
  });
});

test("feed:preview reads a validated mimir-scan-v1 JSON report and respects --limit", async () => {
  await withTempDataDir(async (tmp) => {
    const events = makeArchivedDecodedEvents();
    const marketScan = {
      source: "market",
      contractId: MARKET_CONTRACT,
      version: "v1",
      events: sortEvents(dedupeEvents(events.slice(0, 2))),
      cursor: "5002-0",
      latestLedger: 5010,
      oldestLedger: 5000,
      truncated: false,
      pages: 1,
      emptyPages: 0,
      duplicates: 0,
      seenEventIds: [],
      startLedger: 5000,
      startClamped: false,
      timing: { health: { count: 1, totalMs: 5 }, events: { count: 1, totalMs: 10 } },
      lastEventLedger: 5002,
    };
    const squadScan = {
      ...marketScan,
      source: "squad",
      contractId: SQUAD_CONTRACT,
      events: [events[2]],
      lastEventLedger: 5003,
    };

    const report = buildScanJsonReport({
      network: "Test SDF Network ; September 2015",
      rpcUrl: "https://soroban-testnet.stellar.org",
      oldestLedger: 5000,
      latestLedger: 5010,
      targets: [buildScanJsonTarget(marketScan, 1), buildScanJsonTarget(squadScan, 1)],
    });

    const scanFile = tmp.file("scan-report.json");
    await writeFile(scanFile, formatScanJson(report), "utf8");

    const rendered = await renderOfflineFeedPreview({
      archivePath: scanFile,
      format: "json",
      limit: 2,
    });
    const doc = JSON.parse(rendered);
    assert.equal(doc.items.length, 2);
    assert.equal(doc.items[0].id, "tag:mimir,event:5002-0");
    assert.equal(doc.items[1].id, "tag:mimir,event:5003-0");
  });
});

test("feed:preview requires no BOT_TOKEN and performs zero live network requests", async () => {
  await withTempDataDir(async (tmp) => {
    const archiveDir = tmp.file("offline-archive");
    const archive = createEventArchive({ dir: archiveDir });
    await archive.append(makeArchivedDecodedEvents());
    await archive.close();

    // 1. In-process network trap: fail immediately if fetch or http(s).request is called
    const origFetch = globalThis.fetch;
    const origHttpReq = http.request;
    const origHttpsReq = https.request;
    globalThis.fetch = () => {
      throw new Error("Unexpected fetch() during offline feed preview");
    };
    http.request = () => {
      throw new Error("Unexpected http.request() during offline feed preview");
    };
    https.request = () => {
      throw new Error("Unexpected https.request() during offline feed preview");
    };

    try {
      const atom = await renderOfflineFeedPreview({
        archivePath: archiveDir,
        format: "atom",
      });
      assert.ok(atom.includes("<feed"));
    } finally {
      globalThis.fetch = origFetch;
      http.request = origHttpReq;
      https.request = origHttpsReq;
    }

    // 2. Subprocess execution with BOT_TOKEN, TELEGRAM_CHAT_ID, and contract IDs completely absent
    const cliEntry = path.resolve("dist/feed-preview-cli.js");
    const cleanEnv = {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
    };
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliEntry, "--archive", archiveDir, "--format", "json"],
      { env: cleanEnv, cwd: tmp.dir },
    );
    assert.ok(!stderr.includes("[feed:preview]"), `unexpected CLI error: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.items.length, 3);
  });
});

test("feed:preview rejects missing, uninitialized, or malformed archives with explicit validation errors", async () => {
  await withTempDataDir(async (tmp) => {
    // Non-existent archive path
    await assert.rejects(
      () => readValidatedEventArchive(tmp.file("does-not-exist")),
      FeedArchiveValidationError,
    );

    // Empty directory with no events-*.jsonl files
    const emptyDir = tmp.file("empty-dir");
    await mkdir(emptyDir, { recursive: true });
    await assert.rejects(
      () => readValidatedEventArchive(emptyDir),
      /No validated archive files/,
    );

    // Malformed JSONL line
    const corruptJsonl = tmp.file("corrupt.jsonl");
    await writeFile(corruptJsonl, "{not-valid-json\n", "utf8");
    await assert.rejects(
      () => readValidatedEventArchive(corruptJsonl),
      /invalid JSON/,
    );

    // Corrupt bigint field in event payload
    const badBigintJsonl = tmp.file("bad-bigint.jsonl");
    const badEvent = {
      source: "market",
      contractId: MARKET_CONTRACT,
      ledger: 100,
      txHash: VALID_TX,
      eventId: "100-0",
      payload: {
        name: "claim_challenged",
        claimId: 1,
        challenger: "GBMGZ3D6JXIJCALSXQELCS6YUEWJWG5DFXQK5PJ5I7MWI6KVMQJBC5DLPKZI",
        stake: "not-an-integer",
      },
    };
    await writeFile(badBigintJsonl, `${JSON.stringify(badEvent)}\n`, "utf8");
    await assert.rejects(
      () => readValidatedEventArchive(badBigintJsonl),
      /payload\.stake must be an integer/,
    );

    // Unknown JSON report version
    const unknownScan = tmp.file("unknown-scan.json");
    await writeFile(unknownScan, JSON.stringify({ format: "mimir-scan-v99" }), "utf8");
    await assert.rejects(
      () => readValidatedEventArchive(unknownScan),
      /Invalid scan archive/,
    );

    // CLI returns exit code 1 and bounded diagnostic on invalid flags or non-HTTPS URLs
    const errChunks = [];
    const badFormatCode = await runFeedPreviewCli(
      ["--archive", badBigintJsonl, "--format", "rss"],
      { stdout: () => {}, stderr: (s) => errChunks.push(s) },
    );
    assert.equal(badFormatCode, 1);
    assert.match(errChunks.join(""), /Unsupported --format/);

    const badUrlErr = [];
    const badUrlCode = await runFeedPreviewCli(
      ["--archive", badBigintJsonl, "--self-url", "http://insecure.example/feed.atom"],
      { stdout: () => {}, stderr: (s) => badUrlErr.push(s) },
    );
    assert.equal(badUrlCode, 1);
    assert.match(badUrlErr.join(""), /Invalid --self-url/);
  });
});
