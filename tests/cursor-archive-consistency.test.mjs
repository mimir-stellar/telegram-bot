import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  checkCursorConsistency,
  formatCursorConsistencyReport,
} from "../dist/cursor-cli.js";
import { compareCursorWithArchive } from "../dist/poller.js";
import { createEventArchive } from "../dist/stellar/archive.js";
import { formatScanJsonl } from "../dist/stellar/scan-jsonl.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(REPO_ROOT, "dist", "cursor-cli.js");

const MARKET_ID = "C" + "A".repeat(55);
const SQUAD_ID = "C" + "B".repeat(55);
const OTHER_ID = "C" + "D".repeat(55);

function cursorAt(ledger) {
  return `${(BigInt(ledger) << 32n).toString()}-1`;
}

function makeEvent({ source = "market", contractId = MARKET_ID, ledger, index = 1 }) {
  return {
    source,
    contractId,
    version: "v1",
    ledger,
    txHash: `${ledger.toString(16).padStart(64, "0")}`,
    at: 1_750_000_000 + ledger,
    eventId: `${(BigInt(ledger) << 32n).toString()}-${index}`,
    eventType: "contract",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    payload: {
      name: "claim_created",
      claimId: index,
      creator: "G" + "A".repeat(55),
      category: "sports",
    },
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mimir-cursor-check-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("checkCursorConsistency passes on consistent rotated event archive without mutating cursor", async () => {
  await withTempDir(async (dir) => {
    const archiveDir = path.join(dir, "archive");
    const archive = createEventArchive({ dir: archiveDir, maxBytes: 350, maxFiles: 10 });
    await archive.append([
      makeEvent({ source: "market", contractId: MARKET_ID, ledger: 100, index: 1 }),
      makeEvent({ source: "market", contractId: MARKET_ID, ledger: 120, index: 2 }),
    ]);
    await archive.close();

    const cursorPath = path.join(dir, "cursor-state.json");
    const cursorBody = `${JSON.stringify(
      {
        version: 1,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: cursorAt(150), lastEventLedger: 120 },
          squad: { cursor: cursorAt(150), lastEventLedger: null },
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(cursorPath, cursorBody, "utf8");
    const beforeStat = await stat(cursorPath);

    const report = await checkCursorConsistency({
      cursorFile: cursorPath,
      archivePath: archiveDir,
      expectedContracts: { market: MARKET_ID, squad: SQUAD_ID },
    });

    assert.equal(report.consistent, true);
    assert.equal(report.gaps.length, 0);
    assert.equal(report.contradictions.length, 0);
    assert.equal(report.archiveEventsScanned, 2);
    assert.ok(report.archiveFilesScanned >= 1);

    const afterBody = await readFile(cursorPath, "utf8");
    const afterStat = await stat(cursorPath);
    assert.equal(afterBody, cursorBody);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  });
});

test("checkCursorConsistency detects contract identity mismatches and multiple contract IDs", async () => {
  await withTempDir(async (dir) => {
    const archiveFile = path.join(dir, "scan.jsonl");
    const events = [
      makeEvent({ source: "market", contractId: MARKET_ID, ledger: 200, index: 1 }),
      makeEvent({ source: "market", contractId: OTHER_ID, ledger: 210, index: 2 }),
      makeEvent({ source: "squad", contractId: OTHER_ID, ledger: 205, index: 1 }),
    ];
    await writeFile(archiveFile, formatScanJsonl(events), "utf8");

    const cursorPath = path.join(dir, "cursor-state.json");
    await writeFile(
      cursorPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: cursorAt(220), lastEventLedger: 210 },
          squad: { cursor: cursorAt(220), lastEventLedger: 205 },
        },
      }),
      "utf8",
    );

    const report = await checkCursorConsistency({
      cursorFile: cursorPath,
      archivePath: archiveFile,
      expectedContracts: { market: MARKET_ID, squad: SQUAD_ID },
    });

    assert.equal(report.consistent, false);
    const codes = report.contradictions.map((c) => `${c.target}:${c.code}`);
    assert.ok(codes.includes("market:multiple_archive_contracts"));
    assert.ok(codes.includes("market:contract_mismatch"));
    assert.ok(codes.includes("squad:contract_mismatch"));
  });
});

test("checkCursorConsistency reports cursor-behind-archive contradictions and archive gaps without advancing cursor", async () => {
  await withTempDir(async (dir) => {
    const archiveFile = path.join(dir, "scan.jsonl");
    await writeFile(
      archiveFile,
      formatScanJsonl([
        makeEvent({ source: "market", contractId: MARKET_ID, ledger: 300, index: 1 }),
        makeEvent({ source: "market", contractId: MARKET_ID, ledger: 350, index: 2 }),
        makeEvent({ source: "squad", contractId: SQUAD_ID, ledger: 310, index: 1 }),
      ]),
      "utf8",
    );

    // Legacy flat cursor file: check must NOT rewrite it to v1 or advance market from 300 -> 350!
    const cursorPath = path.join(dir, "legacy-cursor.json");
    const legacyRaw = JSON.stringify({
      market: { cursor: cursorAt(300), lastEventLedger: 300 },
      squad: { cursor: cursorAt(400), lastEventLedger: 390 },
    });
    await writeFile(cursorPath, legacyRaw, "utf8");

    const report = await checkCursorConsistency({
      cursorFile: cursorPath,
      archivePath: archiveFile,
      expectedContracts: { market: MARKET_ID, squad: SQUAD_ID },
    });

    assert.equal(report.consistent, false);
    assert.equal(report.cursorSchemaSource, "legacy-flat");

    const marketIssue = report.contradictions.find((i) => i.target === "market");
    assert.ok(marketIssue);
    assert.equal(marketIssue.code, "cursor_behind_archive");
    assert.equal(marketIssue.fromLedger, 300);
    assert.equal(marketIssue.toLedger, 350);

    const squadGap = report.gaps.find((i) => i.target === "squad");
    assert.ok(squadGap);
    assert.equal(squadGap.code, "archive_behind_cursor");
    assert.equal(squadGap.fromLedger, 311);
    assert.equal(squadGap.toLedger, 390);

    // Cursor file remains untouched byte-for-byte
    assert.equal(await readFile(cursorPath, "utf8"), legacyRaw);
  });
});

test("compareCursorWithArchive flags scan window gaps, missing targets, opaque cursors, and mid-span contradictions", () => {
  const opaqueToken = "opaque-non-toid-cursor-value";
  const report = compareCursorWithArchive(
    {
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: {
        market: { cursor: cursorAt(500), lastEventLedger: 450 },
        opaqueTarget: { cursor: opaqueToken, lastEventLedger: null },
      },
    },
    [
      {
        target: "market",
        contractIds: [MARKET_ID],
        eventCount: 2,
        minEventLedger: 400,
        maxEventLedger: 500,
        observedEventLedgers: [400, 500],
        hasCompleteEventList: true,
        windows: [
          { from: 400, to: 420, eventCount: 1 },
          { from: 440, to: 500, eventCount: 1 },
        ],
      },
      {
        target: "squad",
        contractIds: [SQUAD_ID],
        eventCount: 1,
        minEventLedger: 410,
        maxEventLedger: 410,
        observedEventLedgers: [410],
        hasCompleteEventList: true,
      },
    ],
  );

  assert.equal(report.consistent, false);
  const issueKeys = report.issues.map((i) => `${i.severity}:${i.target}:${i.code}`);
  assert.ok(issueKeys.includes("gap:market:archive_window_gap"));
  assert.ok(issueKeys.includes("contradiction:market:last_event_missing_in_archive_span"));
  assert.ok(issueKeys.includes("gap:squad:missing_cursor_target"));
  assert.ok(issueKeys.includes("gap:opaqueTarget:opaque_cursor_unverifiable"));

  const rendered = formatCursorConsistencyReport(report);
  assert.equal(rendered.includes(opaqueToken), false, "formatted output must not leak raw cursor token");
  assert.match(rendered, /cursorLedger=opaque/);
});

test("CLI check subcommand supports mimir-scan-v1 JSON reports and sets exit code on mismatch", async () => {
  await withTempDir(async (dir) => {
    const scanReportPath = path.join(dir, "scan-report.json");
    const cursorPath = path.join(dir, "cursor-state.json");

    await writeFile(
      scanReportPath,
      JSON.stringify({
        format: "mimir-scan-v1",
        network: "testnet",
        rpcUrl: "https://soroban-testnet.stellar.org",
        ledgers: { oldest: 1000, latest: 1200 },
        targets: [
          {
            source: "market",
            contractId: MARKET_ID,
            pages: 1,
            eventCount: 1,
            truncated: false,
            lastEventLedger: 1150,
            cursor: cursorAt(1200),
            startLedger: 1000,
            startClamped: false,
            histogram: { claim_created: 1 },
            events: [
              {
                ledger: 1150,
                txHash: "a".repeat(64),
                eventId: cursorAt(1150),
                summary: "claim #1",
                payload: { name: "claim_created", claimId: 1, creator: "G" + "A".repeat(55), category: "x" },
              },
            ],
          },
          {
            source: "squad",
            contractId: SQUAD_ID,
            pages: 1,
            eventCount: 0,
            truncated: false,
            lastEventLedger: null,
            cursor: cursorAt(1200),
            startLedger: 1000,
            startClamped: false,
            histogram: {},
            events: [],
          },
        ],
      }),
      "utf8",
    );

    await writeFile(
      cursorPath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-29T00:00:00.000Z",
        targets: {
          market: { cursor: cursorAt(1200), lastEventLedger: 1150 },
          squad: { cursor: cursorAt(1200), lastEventLedger: null },
        },
      }),
      "utf8",
    );

    const okRun = await execFileAsync(
      process.execPath,
      [
        CLI_PATH,
        "check",
        "--file",
        cursorPath,
        "--archive",
        scanReportPath,
        "--market-contract",
        MARKET_ID,
        "--squad-contract",
        SQUAD_ID,
        "--json",
      ],
      { cwd: dir },
    );
    const okJson = JSON.parse(okRun.stdout);
    assert.equal(okJson.consistent, true);

    // Contradict the empty squad scan window (1000..1200 had 0 events)
    const badCursorBody = JSON.stringify({
      version: 1,
      updatedAt: "2026-09-29T00:00:00.000Z",
      targets: {
        market: { cursor: cursorAt(1200), lastEventLedger: 1150 },
        squad: { cursor: cursorAt(1200), lastEventLedger: 1100 },
      },
    });
    await writeFile(cursorPath, badCursorBody, "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [CLI_PATH, "check", "--file", cursorPath, "--archive", scanReportPath, "--json"],
        { cwd: dir },
      ),
      (err) => {
        assert.equal(err.code, 1);
        const parsed = JSON.parse(err.stdout);
        assert.equal(parsed.consistent, false);
        assert.equal(parsed.contradictions[0].code, "cursor_contradicts_empty_archive_window");
        return true;
      },
    );

    assert.equal(await readFile(cursorPath, "utf8"), badCursorBody);

    // Also check malformed archive line handling
    const badJsonlDir = path.join(dir, "bad-archive");
    await mkdir(badJsonlDir, { recursive: true });
    await writeFile(path.join(badJsonlDir, "events-1.jsonl"), "{not-valid-json\n", "utf8");
    const badLineReport = await checkCursorConsistency({
      cursorFile: cursorPath,
      archivePath: badJsonlDir,
    });
    assert.equal(badLineReport.consistent, false);
    assert.equal(badLineReport.malformedArchiveLines, 1);
    assert.ok(badLineReport.contradictions.some((c) => c.code === "malformed_archive_line"));
  });
});
